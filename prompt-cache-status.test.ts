import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import promptCacheStatusExtension from "./index.ts";
import {
	INACTIVITY_THRESHOLD_MS,
	formatCacheStatus,
	getCacheObservation,
	getInactivityPolicy,
	millisecondsUntilInactive,
} from "./prompt-cache-status.ts";

const NOW = new Date(2026, 8, 19, 14, 3).getTime();
const model = {
	id: "test-codex",
	name: "Test Codex",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
} satisfies Model<"openai-codex-responses">;

const providerCases = [
	{ provider: "anthropic", modelId: "claude-test" },
	{ provider: "google", modelId: "gemini-test" },
	{ provider: "openai", modelId: "gpt-test" },
	{ provider: "openrouter", modelId: "openrouter-test" },
	{ provider: "custom-provider", modelId: "custom-test" },
] as const;

function makeModel(provider: string, id: string): Model<"openai-codex-responses"> {
	return { ...model, provider, id };
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done" }],
		provider: model.provider,
		model: model.id,
		api: model.api,
		stopReason: "stop",
		timestamp: NOW,
		usage: {
			input: 600,
			output: 20,
			cacheRead: 400,
			cacheWrite: 0,
			totalTokens: 1_020,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...overrides,
	};
}

function entries(...messages: AssistantMessage[]): SessionEntry[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `${index}`,
		parentId: index > 0 ? `${index - 1}` : null,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	}));
}

function harness(t: TestContext, mode: ExtensionContext["mode"] = "rpc") {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
	// The only casts are at the mock host boundary. Events and fixtures remain
	// checked against pi's public types; unused host methods are not fabricated.
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const api: Pick<ExtensionAPI, "on"> = {
		on(event, handler) {
			handlers.set(event, handler as (event: never, ctx: ExtensionContext) => unknown);
			return () => { handlers.delete(event); };
		},
	};
	const statuses = new Map<string, string>();
	const notifications: string[] = [];
	let statusUpdates = 0;
	let footerChanges = 0;
	let branch: SessionEntry[] = [];
	const ui = {
		setStatus(key, value) {
			statusUpdates++;
			if (value === undefined) statuses.delete(key);
			else statuses.set(key, value);
		},
		notify(text) { notifications.push(text); },
		setFooter() { footerChanges++; },
	} satisfies Pick<ExtensionContext["ui"], "setStatus" | "notify" | "setFooter">;
	const sessionManager = { getBranch: () => branch } satisfies Pick<ExtensionContext["sessionManager"], "getBranch">;
	const state = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		model: model as ExtensionContext["model"],
		ui,
		sessionManager,
	};
	const ctx = state as unknown as ExtensionContext;
	promptCacheStatusExtension(api as ExtensionAPI);
	async function emit(event: ExtensionEvent): Promise<void> {
		await handlers.get(event.type)?.(event as never, ctx);
	}
	t.after(async () => {
		await emit({ type: "session_shutdown", reason: "quit" });
		t.mock.timers.reset();
	});
	return {
		emit,
		state,
		notifications,
		setBranch: (value: SessionEntry[]) => { branch = value; },
		status: () => statuses.get("prompt-cache-status"),
		statusUpdates: () => statusUpdates,
		footerChanges: () => footerChanges,
	};
}

const start = { type: "session_start", reason: "startup" } as const;
const tree = { type: "session_tree", oldLeafId: "old", newLeafId: "new", fromExtension: false } as const;

test("observations report prompt-token proportions, including zero and full hits", () => {
	assert.deepEqual(getCacheObservation(message(), NOW), { timestamp: NOW, promptTokens: 1_000, cachedPercent: 40 });
	for (const cached of [0, 1_000]) {
		const usage = { ...message().usage, input: 1_000 - cached, cacheRead: cached };
		assert.equal(getCacheObservation(message({ usage }), NOW)?.cachedPercent, cached / 10);
	}
	const usage = { ...message().usage, cacheWrite: 1_000 };
	assert.equal(getCacheObservation(message({ usage }), NOW)?.cachedPercent, 20);
	const splitRetentionUsage = {
		...message().usage,
		input: 500,
		cacheRead: 300,
		cacheWrite: 200,
		cacheWrite1h: 100,
	};
	assert.deepEqual(getCacheObservation(message({ usage: splitRetentionUsage }), NOW), {
		timestamp: NOW,
		promptTokens: 1_000,
		cachedPercent: 30,
	});
});

test("only successful responses with valid usage and timestamps qualify for every provider", () => {
	for (const stopReason of ["stop", "length", "toolUse"] as const) {
		assert.ok(getCacheObservation(message({ stopReason }), NOW));
	}
	for (const stopReason of ["error", "aborted", "pending"] as const) {
		assert.equal(getCacheObservation(message({ stopReason }), NOW), undefined);
	}
	for (const { provider } of providerCases) {
		assert.ok(getCacheObservation(message({ provider }), NOW));
	}
	for (const timestamp of [NaN, Infinity, -1, NOW + 1]) {
		assert.equal(getCacheObservation(message({ timestamp }), NOW), undefined);
	}
	for (const field of ["input", "cacheRead", "cacheWrite"] as const) {
		for (const value of [NaN, Infinity, -1, 0.5]) {
			const usage = { ...message().usage, [field]: value };
			assert.equal(getCacheObservation(message({ usage }), NOW), undefined);
		}
	}
	const usage = { ...message().usage, input: 0, cacheRead: 0 };
	assert.equal(getCacheObservation(message({ usage }), NOW), undefined);
});

test("Muse Spark 1.3 uses its five-minute TTL only for the exact provider/model pair", () => {
	const muse = getInactivityPolicy("openrouter", "meta/muse-spark-1.3-contributor");
	const observation = getCacheObservation(message(), NOW);
	assert.ok(observation);
	assert.equal(muse.thresholdMs, 5 * 60 * 1000);
	assert.equal(millisecondsUntilInactive(observation, NOW, muse), 5 * 60 * 1000);
	assert.equal(millisecondsUntilInactive(observation, NOW + 5 * 60 * 1000 - 1, muse), 1);
	assert.equal(millisecondsUntilInactive(observation, NOW + 5 * 60 * 1000, muse), undefined);
	assert.match(formatCacheStatus(observation, NOW + 5 * 60 * 1000, muse), /inactive 5m\+ \(reported TTL\)/);
	for (const [provider, modelId] of [
		["openrouter", "meta/muse-spark-1.4-contributor"],
		["other", "meta/muse-spark-1.3-contributor"],
	] as const) {
		const policy = getInactivityPolicy(provider, modelId);
		assert.equal(policy.thresholdMs, INACTIVITY_THRESHOLD_MS);
		assert.doesNotMatch(formatCacheStatus(observation, NOW + 5 * 60 * 1000, policy), /inactive/);
	}
});

test("inactivity is an explicit heuristic with an exact threshold", () => {
	const observation = getCacheObservation(message(), NOW);
	assert.ok(observation);
	assert.equal(formatCacheStatus(undefined, NOW), "Prompt cache: no observations");
	assert.equal(formatCacheStatus(observation, NOW), "Prompt cache: last request 14:03; cached 40.0%");
	assert.doesNotMatch(formatCacheStatus(observation, NOW + INACTIVITY_THRESHOLD_MS - 1), /inactive/);
	assert.match(formatCacheStatus(observation, NOW + INACTIVITY_THRESHOLD_MS), /inactive 30m\+ \(heuristic\)/);
	assert.equal(millisecondsUntilInactive(undefined, NOW), undefined);
	assert.equal(millisecondsUntilInactive(observation, NOW), INACTIVITY_THRESHOLD_MS);
	assert.equal(millisecondsUntilInactive(observation, NOW + INACTIVITY_THRESHOLD_MS - 1), 1);
	assert.equal(millisecondsUntilInactive(observation, NOW + INACTIVITY_THRESHOLD_MS), undefined);
	assert.equal(millisecondsUntilInactive(observation, NOW - 100), INACTIVITY_THRESHOLD_MS);
});

for (const stopReason of ["error", "aborted"] as const) {
	test(`${stopReason} responses do not create observations, live or restored`, async (t) => {
		const h = harness(t);
		const failed = message({ stopReason });
		h.setBranch(entries(failed));
		await h.emit(start);
		assert.equal(h.status(), "Prompt cache: no observations");
		await h.emit({ type: "message_end", message: failed });
		assert.equal(h.status(), "Prompt cache: no observations");
		assert.deepEqual(h.notifications, []);
	});
}

test("HTTP success followed by stream failure is not evidence of a successful request", async (t) => {
	const h = harness(t);
	await h.emit(start);
	await h.emit({ type: "after_provider_response", status: 200, headers: {} });
	await h.emit({ type: "message_end", message: message({ stopReason: "error" }) });
	assert.equal(h.status(), "Prompt cache: no observations");
});

test("completed messages work without HTTP events; failed follow-ups preserve the observation", async (t) => {
	const h = harness(t);
	await h.emit(start);
	await h.emit({ type: "message_end", message: message() });
	const observed = h.status();
	assert.match(observed ?? "", /cached 40\.0%/);
	await h.emit({ type: "message_end", message: message({ stopReason: "error" }) });
	await h.emit({ type: "message_end", message: { role: "user", content: "Hi", timestamp: NOW } });
	assert.equal(h.status(), observed);
});

for (const { provider, modelId } of providerCases) {
	test(`${provider} observations work live, after restore, and at the 30-minute timer`, async (t) => {
		const h = harness(t);
		const selectedModel = makeModel(provider, modelId);
		const observed = message({
			provider,
			model: modelId,
			usage: {
				...message().usage,
				input: 500,
				cacheRead: 300,
				cacheWrite: 200,
				...(provider === "anthropic" ? { cacheWrite1h: 100 } : {}),
			},
		});
		h.state.model = selectedModel;
		await h.emit(start);
		await h.emit({ type: "message_end", message: observed });
		assert.equal(h.status(), "Prompt cache: last request 14:03; cached 30.0%");
		h.setBranch(entries(observed));
		await h.emit({ type: "session_start", reason: "reload" });
		assert.equal(h.status(), "Prompt cache: last request 14:03; cached 30.0%");
		t.mock.timers.tick(INACTIVITY_THRESHOLD_MS - 1);
		assert.doesNotMatch(h.status() ?? "", /inactive/);
		t.mock.timers.tick(1);
		assert.match(h.status() ?? "", /inactive 30m\+ \(heuristic\)/);
	});
}

test("zero hits update the status without duplicating pi's cache-miss notice", async (t) => {
	const h = harness(t);
	const miss = message({ usage: { ...message().usage, input: 12_345, cacheRead: 0 } });
	await h.emit(start);
	await h.emit({ type: "message_end", message: miss });
	assert.match(h.status() ?? "", /cached 0\.0%/);
	assert.deepEqual(h.notifications, []);
	h.setBranch(entries(miss));
	await h.emit({ type: "session_start", reason: "reload" });
	assert.match(h.status() ?? "", /cached 0\.0%/);
	assert.deepEqual(h.notifications, []);
});

test("the same model id remains isolated by provider for live and restored observations", async (t) => {
	const h = harness(t);
	const sharedModelId = "shared-model";
	const openaiModel = makeModel("openai", sharedModelId);
	const anthropicModel = makeModel("anthropic", sharedModelId);
	const openaiMessage = message({
		provider: "openai",
		model: sharedModelId,
		usage: { ...message().usage, input: 600, cacheRead: 400, cacheWrite: 0 },
	});
	const anthropicMessage = message({
		provider: "anthropic",
		model: sharedModelId,
		usage: { ...message().usage, input: 800, cacheRead: 200, cacheWrite: 0 },
	});
	h.state.model = openaiModel;
	await h.emit(start);
	await h.emit({ type: "message_end", message: openaiMessage });
	await h.emit({ type: "message_end", message: anthropicMessage });
	assert.equal(h.status(), "Prompt cache: last request 14:03; cached 40.0%");
	h.state.model = anthropicModel;
	await h.emit({ type: "model_select", model: anthropicModel, previousModel: openaiModel, source: "set" });
	assert.equal(h.status(), "Prompt cache: last request 14:03; cached 20.0%");
	h.setBranch(entries(openaiMessage, anthropicMessage));
	await h.emit({ type: "session_start", reason: "reload" });
	assert.equal(h.status(), "Prompt cache: last request 14:03; cached 20.0%");
	h.state.model = openaiModel;
	await h.emit({ type: "model_select", model: openaiModel, previousModel: anthropicModel, source: "set" });
	assert.equal(h.status(), "Prompt cache: last request 14:03; cached 40.0%");
});

test("Muse Spark status expires at five minutes and switching models reschedules the timer", async (t) => {
	const h = harness(t);
	const museModel = makeModel("openrouter", "meta/muse-spark-1.3-contributor");
	const museMessage = message({ provider: museModel.provider, model: museModel.id });
	const otherModel = makeModel("openrouter", "meta/muse-spark-1.4-contributor");
	h.state.model = museModel;
	await h.emit(start);
	await h.emit({ type: "message_end", message: museMessage });
	t.mock.timers.tick(5 * 60 * 1000 - 1);
	assert.doesNotMatch(h.status() ?? "", /inactive/);
	t.mock.timers.tick(1);
	assert.match(h.status() ?? "", /inactive 5m\+ \(reported TTL\)/);
	h.state.model = otherModel;
	await h.emit({ type: "model_select", model: otherModel, previousModel: museModel, source: "set" });
	assert.equal(h.status(), "Prompt cache: no observations");
	h.state.model = museModel;
	await h.emit({ type: "model_select", model: museModel, previousModel: otherModel, source: "set" });
	assert.match(h.status() ?? "", /inactive 5m\+ \(reported TTL\)/);
	h.setBranch(entries(museMessage));
	await h.emit({ type: "session_start", reason: "reload" });
	assert.match(h.status() ?? "", /inactive 5m\+ \(reported TTL\)/);
});

test("provider switches preserve independent timer deadlines", async (t) => {
	const h = harness(t);
	const sharedModelId = "shared-model";
	const openaiModel = makeModel("openai", sharedModelId);
	const anthropicModel = makeModel("anthropic", sharedModelId);
	const openaiMessage = message({
		provider: "openai",
		model: sharedModelId,
		usage: { ...message().usage, input: 600, cacheRead: 400, cacheWrite: 0 },
	});
	h.state.model = openaiModel;
	await h.emit(start);
	await h.emit({ type: "message_end", message: openaiMessage });
	t.mock.timers.tick(10 * 60 * 1000);
	h.state.model = anthropicModel;
	await h.emit({ type: "model_select", model: anthropicModel, previousModel: openaiModel, source: "set" });
	const anthropicMessage = message({
		provider: "anthropic",
		model: sharedModelId,
		timestamp: Date.now(),
		usage: { ...message().usage, input: 800, cacheRead: 200, cacheWrite: 0 },
	});
	await h.emit({ type: "message_end", message: anthropicMessage });
	assert.equal(h.status(), "Prompt cache: last request 14:13; cached 20.0%");
	h.state.model = openaiModel;
	await h.emit({ type: "model_select", model: openaiModel, previousModel: anthropicModel, source: "set" });
	assert.equal(h.status(), "Prompt cache: last request 14:03; cached 40.0%");
	t.mock.timers.tick(20 * 60 * 1000 - 1);
	assert.doesNotMatch(h.status() ?? "", /inactive/);
	t.mock.timers.tick(1);
	assert.match(h.status() ?? "", /inactive/);
	h.state.model = anthropicModel;
	await h.emit({ type: "model_select", model: anthropicModel, previousModel: openaiModel, source: "set" });
	assert.doesNotMatch(h.status() ?? "", /inactive/);
	t.mock.timers.tick(10 * 60 * 1000);
	assert.match(h.status() ?? "", /inactive/);
});

test("tree navigation and reload reconstruct the same active-branch observations", async (t) => {
	const h = harness(t);
	h.setBranch(entries(message()));
	await h.emit(start);
	assert.match(h.status() ?? "", /cached 40\.0%/);
	h.setBranch(entries(message({ timestamp: NOW - INACTIVITY_THRESHOLD_MS })));
	await h.emit(tree);
	assert.match(h.status() ?? "", /inactive/);
	const beforeReload = h.status();
	await h.emit({ type: "session_start", reason: "reload" });
	assert.equal(h.status(), beforeReload);
	h.setBranch([]);
	await h.emit(tree);
	assert.equal(h.status(), "Prompt cache: no observations");
});

test("model selection never displays another model's cache usage", async (t) => {
	const h = harness(t);
	h.setBranch(entries(message(), message({ model: "other-model", usage: { ...message().usage, cacheRead: 0 } })));
	await h.emit(start);
	assert.match(h.status() ?? "", /cached 40\.0%/);
	h.state.model = { ...model, id: "other-model" };
	await h.emit({ type: "model_select", model: h.state.model, previousModel: model, source: "set" });
	assert.match(h.status() ?? "", /cached 0\.0%/);
	h.state.model = { ...model, id: "future-model" };
	await h.emit({ type: "model_select", model: h.state.model, previousModel: model, source: "set" });
	assert.equal(h.status(), "Prompt cache: no observations");
	h.state.model = { ...model, provider: "openai" };
	await h.emit({ type: "model_select", model: h.state.model, previousModel: model, source: "set" });
	assert.equal(h.status(), "Prompt cache: no observations");
});

test("timer expires while idle and newer responses replace the scheduled deadline", async (t) => {
	const h = harness(t);
	await h.emit(start);
	await h.emit({ type: "message_end", message: message() });
	t.mock.timers.tick(INACTIVITY_THRESHOLD_MS - 1);
	assert.doesNotMatch(h.status() ?? "", /inactive/);
	await h.emit({ type: "message_end", message: message({ timestamp: Date.now() }) });
	t.mock.timers.tick(1);
	assert.doesNotMatch(h.status() ?? "", /inactive/);
	t.mock.timers.tick(INACTIVITY_THRESHOLD_MS - 1);
	assert.match(h.status() ?? "", /inactive/);
	const updates = h.statusUpdates();
	t.mock.timers.tick(INACTIVITY_THRESHOLD_MS * 2);
	assert.equal(h.statusUpdates(), updates, "expired status must not schedule a repeating timer");
});

test("older events cannot replace newer observations", async (t) => {
	const h = harness(t);
	await h.emit(start);
	await h.emit({ type: "message_end", message: message() });
	await h.emit({ type: "message_end", message: message({ timestamp: NOW - INACTIVITY_THRESHOLD_MS }) });
	assert.doesNotMatch(h.status() ?? "", /inactive/);
});

test("shutdown clears status and timers, and is idempotent", async (t) => {
	const h = harness(t);
	await h.emit(start);
	await h.emit({ type: "message_end", message: message() });
	await h.emit({ type: "session_shutdown", reason: "reload" });
	assert.equal(h.status(), undefined);
	await h.emit({ type: "session_shutdown", reason: "quit" });
	const updates = h.statusUpdates();
	t.mock.timers.tick(INACTIVITY_THRESHOLD_MS * 2);
	assert.equal(h.statusUpdates(), updates);
});

test("switching providers with no observation cancels the pending timer", async (t) => {
	const h = harness(t);
	await h.emit(start);
	await h.emit({ type: "message_end", message: message() });
	h.state.model = { ...model, provider: "openai" };
	await h.emit({ type: "model_select", model: h.state.model, previousModel: model, source: "set" });
	const updates = h.statusUpdates();
	t.mock.timers.tick(INACTIVITY_THRESHOLD_MS * 2);
	assert.equal(h.statusUpdates(), updates);
	assert.equal(h.status(), "Prompt cache: no observations");
});

test("a replacement session discards observations from the previous session", async (t) => {
	const h = harness(t);
	h.setBranch(entries(message()));
	await h.emit(start);
	await h.emit({ type: "session_shutdown", reason: "new" });
	h.setBranch([]);
	await h.emit({ type: "session_start", reason: "new" });
	assert.equal(h.status(), "Prompt cache: no observations");
	const updates = h.statusUpdates();
	t.mock.timers.tick(INACTIVITY_THRESHOLD_MS);
	assert.equal(h.statusUpdates(), updates);
});

test("unrelated provider responses are not shown for the selected model", async (t) => {
	const h = harness(t);
	h.state.model = undefined;
	await h.emit(start);
	await h.emit({ type: "message_end", message: message({ provider: "openai" }) });
	assert.equal(h.status(), undefined);
	assert.deepEqual(h.notifications, []);
	h.state.model = model;
	await h.emit({ type: "model_select", model, previousModel: undefined, source: "set" });
	assert.equal(h.status(), "Prompt cache: no observations");
});

for (const mode of ["tui", "rpc", "print", "json"] as const) {
	test(`${mode} respects UI capabilities and never replaces the footer`, async (t) => {
		const h = harness(t, mode);
		await h.emit(start);
		await h.emit({ type: "message_end", message: message() });
		await h.emit({ type: "message_end", message: message({ usage: { ...message().usage, cacheRead: 0 } }) });
		assert.equal(h.footerChanges(), 0);
		if (mode === "print" || mode === "json") {
			assert.equal(h.statusUpdates(), 0);
			assert.deepEqual(h.notifications, []);
			t.mock.timers.tick(INACTIVITY_THRESHOLD_MS * 2);
			assert.equal(h.statusUpdates(), 0);
		} else {
			assert.match(h.status() ?? "", /cached 0\.0%/);
			assert.deepEqual(h.notifications, []);
		}
	});
}
