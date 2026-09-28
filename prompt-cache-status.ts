import type { AssistantMessage } from "@earendil-works/pi-ai";

// A personal reminder threshold, not a claim about server-side cache retention.
export const INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;

export interface InactivityPolicy {
	thresholdMs: number;
	label: string;
}

const defaultPolicy: InactivityPolicy = { thresholdMs: INACTIVITY_THRESHOLD_MS, label: "30m+ (heuristic)" };
const museSparkPolicy: InactivityPolicy = { thresholdMs: 5 * 60 * 1000, label: "5m+ (reported TTL)" };

export function getInactivityPolicy(provider: string, model: string): InactivityPolicy {
	return provider === "openrouter" && model === "meta/muse-spark-1.3-contributor" ? museSparkPolicy : defaultPolicy;
}

export interface CacheObservation {
	timestamp: number;
	promptTokens: number;
	cachedPercent: number;
}

/** The same evidence rules apply to live responses and restored history. */
export function getCacheObservation(message: AssistantMessage, now: number): CacheObservation | undefined {
	if (
		!["stop", "length", "toolUse"].includes(message.stopReason) ||
		!Number.isFinite(message.timestamp) ||
		message.timestamp < 0 ||
		message.timestamp > now
	) {
		return undefined;
	}

	const { input, cacheRead, cacheWrite } = message.usage;
	const counts = [input, cacheRead, cacheWrite];
	if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) return undefined;
	const promptTokens = input + cacheRead + cacheWrite;
	if (!Number.isSafeInteger(promptTokens) || promptTokens === 0) return undefined;

	return {
		timestamp: message.timestamp,
		promptTokens,
		cachedPercent: (cacheRead / promptTokens) * 100,
	};
}

/** No timer is needed for absent or already inactive observations. */
export function millisecondsUntilInactive(
	observation: CacheObservation | undefined,
	now: number,
	policy: InactivityPolicy = defaultPolicy,
): number | undefined {
	if (!observation) return undefined;
	const remaining = policy.thresholdMs - Math.max(0, now - observation.timestamp);
	return remaining > 0 ? remaining : undefined;
}

export function formatCacheStatus(
	observation: CacheObservation | undefined,
	now: number,
	policy: InactivityPolicy = defaultPolicy,
): string {
	if (!observation) return "Prompt cache: no observations";
	const date = new Date(observation.timestamp);
	const pad = (value: number): string => String(value).padStart(2, "0");
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const inactive = millisecondsUntilInactive(observation, now, policy) === undefined;
	return `Prompt cache: last request ${time}; cached ${observation.cachedPercent.toFixed(1)}%${
		inactive ? `; inactive ${policy.label}` : ""
	}`;
}
