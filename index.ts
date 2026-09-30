import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type CacheObservation,
	formatCacheStatus,
	getCacheObservation,
	getInactivityPolicy,
	millisecondsUntilInactive,
} from "./prompt-cache-status.ts";

const STATUS_KEY = "prompt-cache-status";

function observationKey(provider: string, model: string): string {
	return JSON.stringify([provider, model]);
}

// Pi 0.99.0's virtual-model marker; its detector is not a public export.
// Keep this check isolated rather than importing host internals.
function isVirtualIdentity(identity: { api: string }): boolean {
	return identity.api === "pi-virtual";
}

export default function promptCacheStatus(pi: ExtensionAPI): void {
	const observations = new Map<string, CacheObservation>();
	let latestPhysical: { provider: string; model: string; observation: CacheObservation } | undefined;
	let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

	function clearTimer(): void {
		if (inactivityTimer !== undefined) {
			clearTimeout(inactivityTimer);
			inactivityTimer = undefined;
		}
	}

	function record(message: AssistantMessage, now: number): boolean {
		if (isVirtualIdentity(message)) return false;
		const observation = getCacheObservation(message, now);
		if (!observation) return false;
		const { provider, model } = message;
		const key = observationKey(provider, model);
		const previous = observations.get(key);
		if (previous && previous.timestamp > observation.timestamp) return false;
		observations.set(key, observation);
		// Track branch history, not a router's previous or next dispatch. Equal
		// request timestamps follow branch/event order, as pair observations do.
		if (!latestPhysical || latestPhysical.observation.timestamp <= observation.timestamp) {
			latestPhysical = { provider, model, observation };
		}
		return true;
	}

	function restore(ctx: ExtensionContext): void {
		observations.clear();
		latestPhysical = undefined;
		const now = Date.now();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			record(entry.message, now);
		}
	}

	function update(ctx: ExtensionContext): void {
		clearTimer();
		if (!ctx.hasUI) return;
		if (!ctx.model) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const virtual = isVirtualIdentity(ctx.model);
		const displayed = virtual ? latestPhysical : {
			provider: ctx.model.provider,
			model: ctx.model.id,
			observation: observations.get(observationKey(ctx.model.provider, ctx.model.id)),
		};
		const observation = displayed?.observation;
		const policy = displayed ? getInactivityPolicy(displayed.provider, displayed.model) : undefined;
		const now = Date.now();
		// Plain text lets pi own layout, clipping and theme changes. Never take
		// ownership of the global footer just to display this extension's status.
		const status = formatCacheStatus(observation, now, policy);
		ctx.ui.setStatus(
			STATUS_KEY,
			virtual && displayed
				? `${status}; latest physical response on branch: ${displayed.provider}/${displayed.model}`
				: status,
		);
		const delay = millisecondsUntilInactive(observation, now, policy);
		if (delay !== undefined) {
			inactivityTimer = setTimeout(() => update(ctx), delay);
			inactivityTimer.unref();
		}
	}

	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
		update(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restore(ctx);
		update(ctx);
	});

	pi.on("model_select", (_event, ctx) => update(ctx));

	// Final messages work for both HTTP and WebSocket transports. HTTP headers
	// alone cannot prove success: a 2xx stream can still fail or be aborted.
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (!record(event.message, Date.now())) return;
		update(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearTimer();
		observations.clear();
		latestPhysical = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
