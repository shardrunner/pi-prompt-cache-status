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

export default function promptCacheStatus(pi: ExtensionAPI): void {
	const observations = new Map<string, CacheObservation>();
	let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

	function clearTimer(): void {
		if (inactivityTimer !== undefined) {
			clearTimeout(inactivityTimer);
			inactivityTimer = undefined;
		}
	}

	function record(provider: string, model: string, observation: CacheObservation): boolean {
		const key = observationKey(provider, model);
		const previous = observations.get(key);
		if (previous && previous.timestamp > observation.timestamp) return false;
		observations.set(key, observation);
		return true;
	}

	function restore(ctx: ExtensionContext): void {
		observations.clear();
		const now = Date.now();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const observation = getCacheObservation(entry.message, now);
			if (observation) record(entry.message.provider, entry.message.model, observation);
		}
	}

	function update(ctx: ExtensionContext): void {
		clearTimer();
		if (!ctx.hasUI) return;
		if (!ctx.model) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const observation = observations.get(observationKey(ctx.model.provider, ctx.model.id));
		const policy = getInactivityPolicy(ctx.model.provider, ctx.model.id);
		const now = Date.now();
		// Plain text lets pi own layout, clipping and theme changes. Never take
		// ownership of the global footer just to display this extension's status.
		ctx.ui.setStatus(STATUS_KEY, formatCacheStatus(observation, now, policy));
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
		const observation = getCacheObservation(event.message, Date.now());
		if (!observation || !record(event.message.provider, event.message.model, observation)) return;
		update(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearTimer();
		observations.clear();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
