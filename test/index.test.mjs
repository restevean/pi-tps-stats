import assert from "node:assert/strict";
import test from "node:test";

import throughputExtension from "../src/index.ts";

function createHarness() {
	const handlers = new Map();
	const commands = new Map();
	const view = {
		widget: undefined,
		status: undefined,
		notifications: [],
	};
	const ui = {
		setWidget(_key, content) {
			view.widget = content;
		},
		setStatus(_key, content) {
			view.status = content;
		},
		notify(message, type) {
			view.notifications.push({ message, type });
		},
	};
	const ctx = {
		ui,
		hasUI: true,
		model: { id: "configured-model" },
	};
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
	};

	throughputExtension(pi);
	handlers.get("session_start")({ reason: "startup" }, ctx);

	return { handlers, commands, ctx, view };
}

function assistantMessage({
	model = "test-model",
	responseModel,
	input = 0,
	output = 0,
	cacheRead = 0,
	cacheWrite = 0,
} = {}) {
	return {
		role: "assistant",
		model,
		responseModel,
		usage: { input, output, cacheRead, cacheWrite },
	};
}

function providerRequest(harness) {
	harness.handlers.get("before_provider_request")({ type: "before_provider_request", payload: {} }, harness.ctx);
}

function update(harness, delta, type = "text_delta", output = 0) {
	harness.handlers.get("message_update")(
		{
			message: assistantMessage({ output }),
			assistantMessageEvent: { type, delta },
		},
		harness.ctx,
	);
}

function usageUpdate(harness, output, type = "text_end") {
	harness.handlers.get("message_update")(
		{
			message: assistantMessage({ output }),
			assistantMessageEvent: { type, contentIndex: 0, content: "" },
		},
		harness.ctx,
	);
}

async function withFakeClock(run) {
	const originalNow = Date.now;
	let now = 1000;
	Date.now = () => now;
	try {
		await run((value) => {
			now = value;
		});
	} finally {
		Date.now = originalNow;
	}
}

test("starts the measurement window only after a second output token", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		assert.deepEqual(view.widget, ["⚡ est. 0.0 tok/s · avg 0.0 tok/s · ~0 tok · 0.0s · test-model"]);

		setNow(1200);
		update(harness, "x".repeat(4));
		assert.deepEqual(
			view.widget,
			["⚡ est. 0.0 tok/s · avg 0.0 tok/s · ~1 tok · 0.0s · test-model"],
			"a single output token does not start the measurement clock",
		);

		setNow(1400);
		update(harness, "x".repeat(4));
		assert.deepEqual(
			view.widget,
			["⚡ est. 0.0 tok/s · avg 0.0 tok/s · ~2 tok · 0.0s · test-model"],
			"the second output token starts a zero-length window",
		);

		setNow(1600);
		update(harness, "x".repeat(40));
		assert.deepEqual(
			view.widget,
			["⚡ est. 50.0 tok/s · avg 50.0 tok/s · ~12 tok · 0.2s · test-model"],
			"only tokens observed after the second token contribute to the rate",
		);
	});
});

test("falls back to whole-response timing when no second token is observed", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		handlers.get("message_start")({ message: assistantMessage() }, ctx);

		setNow(1200);
		update(harness, "xxxx");
		assert.deepEqual(
			view.widget,
			["⚡ est. 0.0 tok/s · avg 0.0 tok/s · ~1 tok · 0.0s · test-model"],
			"the measurement window stays closed after a single token",
		);

		setNow(1500);
		handlers.get("message_end")({ message: assistantMessage({ output: 2 }) }, ctx);
		assert.deepEqual(
			view.widget,
			["✓ 2 tok in 0.5s · 4.0 tok/s avg · peak 4.0 tok/s · test-model"],
			"the final summary uses whole-response timing when the window never opened",
		);
	});
});

test("falls back to whole-response timing when the provider total does not exceed the baseline", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		handlers.get("message_start")({ message: assistantMessage() }, ctx);

		setNow(1300);
		update(harness, "Hello");
		setNow(1400);
		update(harness, " world");
		assert.deepEqual(view.widget, ["⚡ est. 0.0 tok/s · avg 0.0 tok/s · ~3 tok · 0.0s · test-model"]);

		setNow(1500);
		handlers.get("message_end")({ message: assistantMessage({ output: 2 }) }, ctx);
		assert.deepEqual(
			view.widget,
			["✓ 2 tok in 0.5s · 4.0 tok/s avg · peak 4.0 tok/s · test-model"],
			"a clamped measured numerator falls back instead of reporting 0.0 tok/s",
		);
	});
});

test("falls back to whole-response timing when streamed provider usage ends at the baseline", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		handlers.get("message_start")({ message: assistantMessage() }, ctx);

		setNow(1200);
		usageUpdate(harness, 1);
		setNow(1400);
		usageUpdate(harness, 2);
		setNow(1500);
		handlers.get("message_end")({ message: assistantMessage({ output: 2 }) }, ctx);
		assert.deepEqual(view.widget, ["✓ 2 tok in 0.5s · 4.0 tok/s avg · peak 4.0 tok/s · test-model"]);
	});
});

test("keeps a stable final summary through display-mode changes", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, commands, ctx, view } = harness;
		const message = assistantMessage();

		handlers.get("message_start")({ message }, ctx);
		assert.deepEqual(view.widget, ["⚡ est. 0.0 tok/s · avg 0.0 tok/s · ~0 tok · 0.0s · test-model"]);

		setNow(1200);
		update(harness, "x".repeat(4));

		setNow(1400);
		update(harness, "x".repeat(4), "thinking_delta");

		setNow(2000);
		handlers.get("message_end")({ message: assistantMessage({ output: 300 }) }, ctx);
		const finalWidget = "✓ 300 tok in 0.6s · 497 tok/s avg · peak 497 tok/s · test-model";
		assert.deepEqual(view.widget, [finalWidget]);

		setNow(10_000);
		await commands.get("throughput").handler("status", ctx);
		assert.equal(view.widget, undefined);
		assert.equal(view.status, "✓ 300 tok · 497 tok/s");

		await commands.get("throughput").handler("off", ctx);
		assert.equal(view.status, undefined);
		await commands.get("throughput").handler("", ctx);
		assert.equal(view.status, "✓ 300 tok · 497 tok/s", "toggle restores the selected status mode");

		await commands.get("throughput").handler("widget", ctx);
		assert.deepEqual(view.widget, [finalWidget], "final values do not decay while idle");

		await commands.get("throughput").handler("reset", ctx);
		assert.equal(view.widget, undefined, "reset clears an idle final summary");
		await commands.get("throughput").handler("reset", ctx);
		assert.equal(view.widget, undefined, "idle reset does not create a phantom stream");
		assert.equal(view.notifications.at(-1).message, "No throughput metrics to reset");
	});
});

test("switches from estimated deltas to cumulative provider usage", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		handlers.get("message_start")({ message: assistantMessage() }, ctx);

		setNow(1200);
		update(harness, "x".repeat(4));
		assert.deepEqual(view.widget, ["⚡ est. 0.0 tok/s · avg 0.0 tok/s · ~1 tok · 0.0s · test-model"]);

		setNow(1400);
		update(harness, "x".repeat(4));
		assert.deepEqual(view.widget, ["⚡ est. 0.0 tok/s · avg 0.0 tok/s · ~2 tok · 0.0s · test-model"]);

		setNow(1600);
		update(harness, "x".repeat(4), "text_delta", 50);
		assert.deepEqual(
			view.widget,
			["⚡ 250 tok/s · avg 250 tok/s · 50 tok · 0.2s · test-model"],
			"the first advancing provider report replaces the heuristic and its rolling samples",
		);

		setNow(1800);
		update(harness, "x".repeat(4), "thinking_delta", 90);
		assert.deepEqual(view.widget, ["⚡ 225 tok/s · avg 225 tok/s · 90 tok · 0.4s · test-model"]);
	});
});

test("observes provider usage on updates without content deltas", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		handlers.get("message_start")({ message: assistantMessage() }, ctx);

		setNow(1100);
		usageUpdate(harness, 20);
		assert.deepEqual(view.widget, ["⚡ 0.0 tok/s · avg 0.0 tok/s · 20 tok · 0.0s · test-model"]);

		setNow(1150);
		usageUpdate(harness, 30, "toolcall_end");
		assert.deepEqual(
			view.widget,
			["⚡ 200 tok/s · avg 200 tok/s · 30 tok · 0.1s · test-model"],
			"usage-only events render even inside the normal delta update interval",
		);

		setNow(2000);
		handlers.get("message_end")({ message: assistantMessage({ output: 80 }) }, ctx);
		assert.deepEqual(view.widget, ["✓ 80 tok in 0.9s · 66.7 tok/s avg · peak 200 tok/s · test-model"]);
	});
});

test("reports cached prompt metrics and excludes cache reads from approximate processing", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		providerRequest(harness);
		setNow(1100);
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		setNow(1300);
		update(harness, "first output");
		setNow(2000);
		handlers.get("message_end")(
			{ message: assistantMessage({ input: 200, output: 50, cacheRead: 800, cacheWrite: 100 }) },
			ctx,
		);

		assert.deepEqual(view.widget, [
			"✓ 50 tok in 0.7s · 67.1 tok/s avg · peak 67.1 tok/s · input 200 tok · cache read 800 tok · cache write 100 tok · TTFT 300ms · approx. prompt 1000 tok/s · test-model",
		]);
		assert.doesNotMatch(
			view.widget[0],
			/approx\. prompt 3\.7k tok\/s/,
			"cache reads are not treated as processed tokens",
		);
	});
});

test("reports uncached input and request-boundary TTFT without cache placeholders", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		providerRequest(harness);
		setNow(1200);
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		setNow(1500);
		update(harness, "first output");
		setNow(2000);
		handlers.get("message_end")({ message: assistantMessage({ input: 600, output: 40 }) }, ctx);

		assert.match(view.widget[0], /input 600 tok · TTFT 500ms · approx\. prompt 1200 tok\/s/);
		assert.doesNotMatch(view.widget[0], /cache (read|write)/);
	});
});

test("omits unavailable and partially reported prompt metrics cleanly", async () => {
	await withFakeClock(async (setNow) => {
		const partial = createHarness();
		partial.handlers.get("message_start")({ message: assistantMessage() }, partial.ctx);
		setNow(1500);
		partial.handlers.get("message_end")({ message: assistantMessage({ input: 250, output: 10 }) }, partial.ctx);
		assert.match(partial.view.widget[0], /input 250 tok/);
		assert.doesNotMatch(partial.view.widget[0], /cache|TTFT|approx\. prompt/);

		setNow(2000);
		const unavailable = createHarness();
		providerRequest(unavailable);
		setNow(2200);
		unavailable.handlers.get("message_start")({ message: assistantMessage() }, unavailable.ctx);
		setNow(2400);
		update(unavailable, "first output");
		setNow(3000);
		unavailable.handlers.get("message_end")({ message: assistantMessage({ output: 10 }) }, unavailable.ctx);
		assert.match(unavailable.view.widget[0], /TTFT 400ms/);
		assert.doesNotMatch(unavailable.view.widget[0], /input|cache|approx\. prompt/);
	});
});

test("omits TTFT and approximate prompt rate when no output arrives", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		providerRequest(harness);
		setNow(1100);
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		setNow(2000);
		handlers.get("message_end")({ message: assistantMessage({ input: 300 }) }, ctx);

		assert.match(view.widget[0], /input 300 tok/);
		assert.doesNotMatch(view.widget[0], /TTFT|approx\. prompt/);
	});
});

test("ignores empty deltas and resets only the active measurement window", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, commands, ctx, view } = harness;

		setNow(5000);
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		const initialLine = view.widget;

		setNow(5100);
		update(harness, "");
		assert.deepEqual(view.widget, initialLine, "empty deltas do not add an estimated token");

		setNow(5200);
		update(harness, "x".repeat(400), "toolcall_delta");
		assert.deepEqual(view.widget, ["⚡ est. 0.0 tok/s · avg 0.0 tok/s · ~100 tok · 0.0s · test-model"]);

		setNow(5300);
		await commands.get("throughput").handler("reset", ctx);
		assert.deepEqual(view.widget, ["⚡ est. 0.0 tok/s · avg 0.0 tok/s · ~0 tok · 0.0s · test-model"]);

		setNow(5500);
		update(harness, "x".repeat(400));
		assert.deepEqual(view.widget, ["⚡ est. 500 tok/s · avg 500 tok/s · ~100 tok · 0.2s · test-model"]);

		setNow(6000);
		handlers.get("message_end")({ message: assistantMessage({ output: 500 }) }, ctx);
		assert.deepEqual(view.widget, ["✓ 500 tok in 0.7s · 571 tok/s avg · peak 571 tok/s · test-model"]);

		handlers.get("session_shutdown")({ reason: "quit" }, ctx);
		assert.equal(view.widget, undefined);
		assert.equal(view.status, undefined);
	});
});

test("streaming reset excludes earlier reported tokens from final average and peak", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, commands, ctx, view } = harness;
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		setNow(1500);
		usageUpdate(harness, 100);
		setNow(2000);
		await commands.get("throughput").handler("reset", ctx);
		setNow(3000);
		usageUpdate(harness, 200);
		assert.deepEqual(view.widget, ["⚡ 100 tok/s · avg 100 tok/s · 100 tok · 1.0s · test-model"]);
		handlers.get("message_end")({ message: assistantMessage({ output: 200 }) }, ctx);
		assert.deepEqual(view.widget, ["✓ 200 tok in 1.0s · 100 tok/s avg · peak 100 tok/s · test-model"]);
	});
});

test("streaming reset with no later output does not fall back to pre-reset tokens", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, commands, ctx, view } = harness;
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		setNow(1500);
		usageUpdate(harness, 100);
		setNow(2000);
		await commands.get("throughput").handler("reset", ctx);
		setNow(3000);
		handlers.get("message_end")({ message: assistantMessage({ output: 100 }) }, ctx);
		assert.deepEqual(view.widget, ["✓ 100 tok in 1.0s · 0.0 tok/s avg · peak 0.0 tok/s · test-model"]);
	});
});

test("repeated resets before provider usage preserve the estimated pre-reset baseline", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, commands, ctx, view } = harness;
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		setNow(1500);
		update(harness, "x".repeat(400));
		setNow(2000);
		await commands.get("throughput").handler("reset", ctx);
		setNow(2500);
		update(harness, "x".repeat(200));
		setNow(3000);
		await commands.get("throughput").handler("reset", ctx);
		setNow(4000);
		usageUpdate(harness, 250);
		assert.deepEqual(view.widget, ["⚡ 100 tok/s · avg 100 tok/s · 100 tok · 1.0s · test-model"]);
		handlers.get("message_end")({ message: assistantMessage({ output: 250 }) }, ctx);
		assert.deepEqual(view.widget, ["✓ 250 tok in 1.0s · 100 tok/s avg · peak 100 tok/s · test-model"]);
	});
});
