import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import throughputExtension from "../src/index.ts";

function createHarness({ mode = "tui", hasUI = true } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const widgets = new Map();
	const widgetCalls = [];
	let component;
	const redraw = () => {
		const content = typeof component?.render === "function" ? component.render(4096) : component;
		view.rawWidget = content;
		view.widget = content?.map((line) =>
			line.replace("\u001b[38;2;126;134;174m", "").replace("\u001b[39m", ""),
		);
	};
	const tui = { requestRender() { view.renderRequests += 1; redraw(); } };
	const view = {
		renderRequests: 0,
		widget: undefined,
		rawWidget: undefined,
		widgetOptions: undefined,
		status: undefined,
		notifications: [],
	};
	const ui = {
		setWidget(key, content, options) {
			widgetCalls.push({ key, content, options });
			widgets.delete(key);
			if (content !== undefined) widgets.set(key, content);
			if (key !== "throughput") return;
			component?.dispose?.();
			component = typeof content === "function" ? content(tui, {}) : content;
			redraw();
			view.widgetOptions = options;
		},
		setStatus(_key, content) {
			view.status = content;
		},
		notify(message, type) {
			view.notifications.push({ message, type });
		},
	};
	const ctx = {
		mode,
		ui,
		hasUI,
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

	return { handlers, commands, ctx, view, widgets, widgetCalls, renderAtWidth: (width) => component.render(width) };
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

test("updates a persistent widget without moving it relative to the YOLO banner", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		h.ctx.ui.setWidget("gentle:yolo", ["YOLO ON"]);
		const order = [...h.widgets.keys()];
		setNow(1400);
		usageUpdate(h, 20);
		setNow(2400);
		usageUpdate(h, 40);
		h.handlers.get("message_end")({ message: assistantMessage({ output: 40 }) }, h.ctx);
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		await h.commands.get("tps").handler("reset", h.ctx);
		await h.commands.get("tps").handler("widget", h.ctx);
		assert.equal(h.widgetCalls.filter((call) => call.key === "throughput" && call.content !== undefined).length, 1);
		assert.deepEqual([...h.widgets.keys()], order);
		assert.deepEqual(h.widgets.get("gentle:yolo"), ["YOLO ON"]);
		assert.equal(h.widgetCalls.filter((call) => call.key === "gentle:yolo").length, 1);
		assert.ok(h.view.renderRequests > 0);
		assert.match(h.view.widget[0], /^TPS /);
	});
});

test("removes only its own persistent widget when switching to the footer or shutting down", async () => {
	const h = createHarness();
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	h.ctx.ui.setWidget("gentle:yolo", ["YOLO ON"]);
	await h.commands.get("tps").handler("status", h.ctx);
	assert.equal(h.view.widget, undefined);
	assert.match(h.view.status, /^TPS .* tok\/s\./);
	await h.commands.get("tps").handler("widget", h.ctx);
	assert.match(h.view.widget[0], /^TPS /);
	assert.equal(h.view.status, undefined);
	h.handlers.get("session_shutdown")({}, h.ctx);
	assert.deepEqual([...h.widgets.keys()], ["gentle:yolo"]);
	assert.equal(h.view.widget, undefined);
	assert.equal(h.view.status, undefined);
});

test("preserves the string-array widget path in RPC mode", () => {
	const h = createHarness({ mode: "rpc" });
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	assert.ok(Array.isArray(h.widgetCalls.at(-1).content));
	assert.match(h.view.widget[0], /^TPS /);
});

test("keeps the persistent widget on one width-safe line without registering again", () => {
	const h = createHarness();
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	const calls = h.widgetCalls.length;
	for (const width of [0, 1, 20, 80, 160]) {
		const lines = h.renderAtWidth(width);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= width);
	}
	assert.equal(h.widgetCalls.length, calls);
});

test("creates a new component after session shutdown without retaining old UI callbacks", () => {
	const h = createHarness();
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	h.handlers.get("session_shutdown")({}, h.ctx);
	const renders = h.view.renderRequests;
	h.handlers.get("session_start")({}, h.ctx);
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	assert.match(h.view.widget[0], /^TPS /);
	assert.equal(h.widgetCalls.filter((call) => typeof call.content === "function").length, 2);
	assert.equal(h.view.renderRequests, renders, "the second session mounts instead of repainting a disposed component");
});

test("does not create a terminal component without a UI", () => {
	const h = createHarness({ mode: "print", hasUI: false });
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	assert.equal(h.widgetCalls.length, 0);
	assert.equal(h.view.widget, undefined);
});

test("places the default widget below the prompt editor", () => {
	const { handlers, ctx, view } = createHarness();
	handlers.get("message_start")({ message: assistantMessage() }, ctx);
	assert.deepEqual(view.widgetOptions, { placement: "belowEditor" });
	assert.equal(view.status, undefined);
});

test("uses the dedicated #7E86AE foreground and resets it after the widget", () => {
	const { handlers, ctx, view } = createHarness();
	handlers.get("message_start")({ message: assistantMessage() }, ctx);
	assert.ok(view.rawWidget[0].startsWith("\u001b[38;2;126;134;174m"));
	assert.ok(view.rawWidget[0].endsWith("\u001b[39m"));
});

test("matches the screenshot field order, full counts, and final response usage", async () => {
	await withFakeClock(async (setNow) => {
		const { handlers, ctx, view } = createHarness();
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		setNow(3900);
		handlers.get("message_end")(
			{ message: assistantMessage({ output: 33, input: 2, cacheRead: 0, cacheWrite: 85571 }) },
			ctx,
		);
		assert.deepEqual(view.widget, [
			"TPS 11.4 tok/s. out 33, in 2, cache 0/85,571, cache % 0.0%/100.0%, total 85,606, 2.9s",
		]);
	});
});

test("updates all screenshot fields during streaming without changing the footer", async () => {
	await withFakeClock(async (setNow) => {
		const { handlers, commands, ctx, view } = createHarness();
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		const sendUsage = (output) => handlers.get("message_update")(
			{
				message: assistantMessage({ output, input: 2, cacheRead: 0, cacheWrite: 85571 }),
				assistantMessageEvent: { type: "text_end", content: "" },
			},
			ctx,
		);
		setNow(1400);
		sendUsage(33);
		setNow(2400);
		sendUsage(43);
		assert.deepEqual(view.widget, [
			"TPS 10.0 tok/s. out 43, in 2, cache 0/85,571, cache % 0.0%/100.0%, total 85,616, 1.0s",
		]);
		assert.deepEqual(view.widgetOptions, { placement: "belowEditor" });
		assert.equal(view.status, undefined);
		await commands.get("tps").handler("off", ctx);
		assert.equal(view.widget, undefined);
		await commands.get("tps").handler("on", ctx);
		assert.deepEqual(view.widgetOptions, { placement: "belowEditor" });
		assert.ok(view.rawWidget[0].startsWith("\u001b[38;2;126;134;174m"));
	});
});

test("shows cache read/write percentages of prompt tokens next to their counts", async () => {
	await withFakeClock(async (setNow) => {
		const { handlers, ctx, view } = createHarness();
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		setNow(2000);
		handlers.get("message_end")(
			{ message: assistantMessage({ output: 1000, input: 100, cacheRead: 800, cacheWrite: 100 }) },
			ctx,
		);
		assert.deepEqual(view.widget, [
			"TPS 1000 tok/s. out 1,000, in 100, cache 800/100, cache % 80.0%/10.0%, total 2,000, 1.0s",
		]);
		assert.deepEqual(view.widgetOptions, { placement: "belowEditor" });
		assert.ok(view.rawWidget[0].startsWith("\u001b[38;2;126;134;174m"));
		assert.ok(view.rawWidget[0].endsWith("\u001b[39m"));
		assert.equal(view.status, undefined);
	});
});

test("renders zero cache percentages when there are no prompt tokens", () => {
	const { handlers, ctx, view } = createHarness();
	handlers.get("message_start")({ message: assistantMessage() }, ctx);
	assert.deepEqual(view.widget, [
		"TPS ~0.0 tok/s. out ~0, in 0, cache 0/0, cache % 0.0%/0.0%, total ~0, 0.0s",
	]);
});

test("starts the measurement window only after a second output token", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		assert.deepEqual(view.widget, ["TPS ~0.0 tok/s. out ~0, in 0, cache 0/0, cache % 0.0%/0.0%, total ~0, 0.0s"]);

		setNow(1200);
		update(harness, "x".repeat(4));
		assert.deepEqual(
			view.widget,
			["TPS ~0.0 tok/s. out ~1, in 0, cache 0/0, cache % 0.0%/0.0%, total ~1, 0.0s"],
			"a single output token does not start the measurement clock",
		);

		setNow(1400);
		update(harness, "x".repeat(4));
		assert.deepEqual(
			view.widget,
			["TPS ~0.0 tok/s. out ~2, in 0, cache 0/0, cache % 0.0%/0.0%, total ~2, 0.0s"],
			"the second output token starts a zero-length window",
		);

		setNow(1600);
		update(harness, "x".repeat(40));
		assert.deepEqual(
			view.widget,
			["TPS ~50.0 tok/s. out ~12, in 0, cache 0/0, cache % 0.0%/0.0%, total ~12, 0.2s"],
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
			["TPS ~0.0 tok/s. out ~1, in 0, cache 0/0, cache % 0.0%/0.0%, total ~1, 0.0s"],
			"the measurement window stays closed after a single token",
		);

		setNow(1500);
		handlers.get("message_end")({ message: assistantMessage({ output: 2 }) }, ctx);
		assert.deepEqual(
			view.widget,
			["TPS 4.0 tok/s. out 2, in 0, cache 0/0, cache % 0.0%/0.0%, total 2, 0.5s"],
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
		assert.deepEqual(view.widget, ["TPS ~0.0 tok/s. out ~3, in 0, cache 0/0, cache % 0.0%/0.0%, total ~3, 0.0s"]);

		setNow(1500);
		handlers.get("message_end")({ message: assistantMessage({ output: 2 }) }, ctx);
		assert.deepEqual(
			view.widget,
			["TPS 4.0 tok/s. out 2, in 0, cache 0/0, cache % 0.0%/0.0%, total 2, 0.5s"],
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
		assert.deepEqual(view.widget, ["TPS 4.0 tok/s. out 2, in 0, cache 0/0, cache % 0.0%/0.0%, total 2, 0.5s"]);
	});
});

test("keeps a stable final summary through display-mode changes", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, commands, ctx, view } = harness;
		const message = assistantMessage();

		handlers.get("message_start")({ message }, ctx);
		assert.deepEqual(view.widget, ["TPS ~0.0 tok/s. out ~0, in 0, cache 0/0, cache % 0.0%/0.0%, total ~0, 0.0s"]);

		setNow(1200);
		update(harness, "x".repeat(4));

		setNow(1400);
		update(harness, "x".repeat(4), "thinking_delta");

		setNow(2000);
		handlers.get("message_end")({ message: assistantMessage({ output: 300 }) }, ctx);
		const finalWidget = "TPS 497 tok/s. out 300, in 0, cache 0/0, cache % 0.0%/0.0%, total 300, 0.6s";
		assert.deepEqual(view.widget, [finalWidget]);

		setNow(10_000);
		await commands.get("tps").handler("status", ctx);
		assert.equal(view.widget, undefined);
		assert.equal(view.status, finalWidget);

		await commands.get("tps").handler("off", ctx);
		assert.equal(view.status, undefined);
		await commands.get("tps").handler("", ctx);
		assert.equal(view.status, finalWidget, "toggle restores the selected status mode");

		await commands.get("tps").handler("widget", ctx);
		assert.deepEqual(view.widget, [finalWidget], "final values do not decay while idle");

		await commands.get("tps").handler("reset", ctx);
		assert.equal(view.widget, undefined, "reset clears an idle final summary");
		await commands.get("tps").handler("reset", ctx);
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
		assert.deepEqual(view.widget, ["TPS ~0.0 tok/s. out ~1, in 0, cache 0/0, cache % 0.0%/0.0%, total ~1, 0.0s"]);

		setNow(1400);
		update(harness, "x".repeat(4));
		assert.deepEqual(view.widget, ["TPS ~0.0 tok/s. out ~2, in 0, cache 0/0, cache % 0.0%/0.0%, total ~2, 0.0s"]);

		setNow(1600);
		update(harness, "x".repeat(4), "text_delta", 50);
		assert.deepEqual(
			view.widget,
			["TPS 250 tok/s. out 50, in 0, cache 0/0, cache % 0.0%/0.0%, total 50, 0.2s"],
			"the first advancing provider report replaces the heuristic and its rolling samples",
		);

		setNow(1800);
		update(harness, "x".repeat(4), "thinking_delta", 90);
		assert.deepEqual(view.widget, ["TPS 225 tok/s. out 90, in 0, cache 0/0, cache % 0.0%/0.0%, total 90, 0.4s"]);
	});
});

test("observes provider usage on updates without content deltas", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		handlers.get("message_start")({ message: assistantMessage() }, ctx);

		setNow(1100);
		usageUpdate(harness, 20);
		assert.deepEqual(view.widget, ["TPS 0.0 tok/s. out 20, in 0, cache 0/0, cache % 0.0%/0.0%, total 20, 0.0s"]);

		setNow(1150);
		usageUpdate(harness, 30, "toolcall_end");
		assert.deepEqual(
			view.widget,
			["TPS 200 tok/s. out 30, in 0, cache 0/0, cache % 0.0%/0.0%, total 30, 0.1s"],
			"usage-only events render even inside the normal delta update interval",
		);

		setNow(2000);
		handlers.get("message_end")({ message: assistantMessage({ output: 80 }) }, ctx);
		assert.deepEqual(view.widget, ["TPS 66.7 tok/s. out 80, in 0, cache 0/0, cache % 0.0%/0.0%, total 80, 0.9s"]);
	});
});

test("status mode shows the same text as the configured widget, live and final", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await h.commands.get("tps").handler("status", h.ctx);
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		assert.equal(h.view.status, "TPS ~0.0 tok/s. out ~0, in 0, cache 0/0, cache % 0.0%/0.0%, total ~0, 0.0s");
		setNow(2000);
		h.handlers.get("message_end")(
			{ message: assistantMessage({ output: 1000, input: 100, cacheRead: 800, cacheWrite: 100 }) },
			h.ctx,
		);
		const expected = "TPS 1000 tok/s. out 1,000, in 100, cache 800/100, cache % 80.0%/10.0%, total 2,000, 1.0s";
		assert.equal(h.view.status, expected);
		assert.equal(h.view.widget, undefined, "status mode does not also register the widget");
		await h.commands.get("tps").handler("widget", h.ctx);
		assert.equal(h.view.status, undefined);
		assert.deepEqual(h.view.widget, [expected], "both modes render identical text");
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
		assert.deepEqual(view.widget, ["TPS ~0.0 tok/s. out ~100, in 0, cache 0/0, cache % 0.0%/0.0%, total ~100, 0.0s"]);

		setNow(5300);
		await commands.get("tps").handler("reset", ctx);
		assert.deepEqual(view.widget, ["TPS ~0.0 tok/s. out ~0, in 0, cache 0/0, cache % 0.0%/0.0%, total ~0, 0.0s"]);

		setNow(5500);
		update(harness, "x".repeat(400));
		assert.deepEqual(view.widget, ["TPS ~500 tok/s. out ~100, in 0, cache 0/0, cache % 0.0%/0.0%, total ~100, 0.2s"]);

		setNow(6000);
		handlers.get("message_end")({ message: assistantMessage({ output: 500 }) }, ctx);
		assert.deepEqual(view.widget, ["TPS 571 tok/s. out 500, in 0, cache 0/0, cache % 0.0%/0.0%, total 500, 0.7s"]);

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
		await commands.get("tps").handler("reset", ctx);
		setNow(3000);
		usageUpdate(harness, 200);
		assert.deepEqual(view.widget, ["TPS 100 tok/s. out 100, in 0, cache 0/0, cache % 0.0%/0.0%, total 100, 1.0s"]);
		handlers.get("message_end")({ message: assistantMessage({ output: 200 }) }, ctx);
		assert.deepEqual(view.widget, ["TPS 100 tok/s. out 200, in 0, cache 0/0, cache % 0.0%/0.0%, total 200, 1.0s"]);
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
		await commands.get("tps").handler("reset", ctx);
		setNow(3000);
		handlers.get("message_end")({ message: assistantMessage({ output: 100 }) }, ctx);
		assert.deepEqual(view.widget, ["TPS 0.0 tok/s. out 100, in 0, cache 0/0, cache % 0.0%/0.0%, total 100, 1.0s"]);
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
		await commands.get("tps").handler("reset", ctx);
		setNow(2500);
		update(harness, "x".repeat(200));
		setNow(3000);
		await commands.get("tps").handler("reset", ctx);
		setNow(4000);
		usageUpdate(harness, 250);
		assert.deepEqual(view.widget, ["TPS 100 tok/s. out 100, in 0, cache 0/0, cache % 0.0%/0.0%, total 100, 1.0s"]);
		handlers.get("message_end")({ message: assistantMessage({ output: 250 }) }, ctx);
		assert.deepEqual(view.widget, ["TPS 100 tok/s. out 250, in 0, cache 0/0, cache % 0.0%/0.0%, total 250, 1.0s"]);
	});
});
