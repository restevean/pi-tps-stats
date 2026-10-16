import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import tpsStatsExtension from "../src/index.ts";

function createHarness({ mode = "tui", hasUI = true, withKeybindings = true } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const widgets = new Map();
	const widgetCalls = [];
	const panels = [];
	const keybindings = {};
	const selections = [];
	const selectCalls = [];
	const themeRoles = new Set();
	const theme = {
		fg(role, text) {
			themeRoles.add(role);
			return text;
		},
	};
	let component;
	const redraw = () => {
		const content = typeof component?.render === "function" ? component.render(4096) : component;
		view.rows = content;
		const text = content?.length ? content.slice(0, -1) : content;
		view.rawWidget = text;
		view.widget = text?.map((line) => line.replace("\u001b[38;2;126;134;174m", "").replace("\u001b[39m", ""));
	};
	const tui = {
		terminal: { rows: 60 },
		requestRender() {
			view.renderRequests += 1;
			redraw();
		},
	};
	const view = {
		renderRequests: 0,
		rows: undefined,
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
			if (key !== "tps-stats") return;
			component?.dispose?.();
			component = typeof content === "function" ? content(tui, {}) : content;
			redraw();
			view.widgetOptions = options;
		},
		select(title, options) {
			selectCalls.push({ title, options });
			return Promise.resolve(selections.shift());
		},
		custom(factory, options) {
			return new Promise((resolve) => {
				panels.push({ component: factory(tui, theme, withKeybindings ? keybindings : undefined, resolve), options });
			});
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

	tpsStatsExtension(pi);
	handlers.get("session_start")({ reason: "startup" }, ctx);

	return {
		tui,
		handlers,
		commands,
		ctx,
		view,
		widgets,
		widgetCalls,
		panels,
		keybindings,
		selections,
		selectCalls,
		themeRoles,
		renderAtWidth: (width) => component.render(width),
		mouse: (event) => component.handleMouse?.(event),
	};
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
		assert.equal(h.widgetCalls.filter((call) => call.key === "tps-stats" && call.content !== undefined).length, 1);
		assert.deepEqual([...h.widgets.keys()], order);
		assert.deepEqual(h.widgets.get("gentle:yolo"), ["YOLO ON"]);
		assert.equal(h.widgetCalls.filter((call) => call.key === "gentle:yolo").length, 1);
		assert.ok(h.view.renderRequests > 0);
		assert.match(h.view.widget[0], /^TPS /);
	});
});

test("leaves one blank row below the TPS line, in widget and RPC mode", () => {
	const h = createHarness();
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	assert.equal(h.view.rows.length, 2);
	assert.ok(h.view.rows[0].startsWith("\u001b[38;2;126;134;174mTPS "));
	assert.equal(h.view.rows[1], "", "the second row is empty");
	const rpc = createHarness({ mode: "rpc" });
	rpc.handlers.get("message_start")({ message: assistantMessage() }, rpc.ctx);
	assert.equal(rpc.view.rows.length, 2);
	assert.equal(rpc.view.rows[1], "");
});

test("mounts an empty widget when the session starts, ahead of the YOLO banner", () => {
	const h = createHarness();
	assert.deepEqual([...h.widgets.keys()], ["tps-stats"]);
	assert.deepEqual(h.renderAtWidth(80), [], "nothing is drawn before the first response");
	assert.deepEqual(h.view.widgetOptions, { placement: "aboveEditor" });
	h.ctx.ui.setWidget("gentle:yolo", ["YOLO ON"]);
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	assert.match(h.view.widget[0], /^TPS /);
	// The host republishes the banner on every permission check; it must stay after TPS.
	h.ctx.ui.setWidget("gentle:yolo", ["YOLO ON"]);
	h.ctx.ui.setWidget("gentle:yolo", ["YOLO ON"]);
	assert.deepEqual([...h.widgets.keys()], ["tps-stats", "gentle:yolo"]);
	assert.equal(h.widgetCalls.filter((call) => call.key === "tps-stats").length, 1);
});

test("off before any response removes the empty mounted widget only", async () => {
	const h = createHarness();
	h.ctx.ui.setWidget("gentle:yolo", ["YOLO ON"]);
	await h.commands.get("tps").handler("off", h.ctx);
	assert.deepEqual([...h.widgets.keys()], ["gentle:yolo"]);
	await h.commands.get("tps").handler("on", h.ctx);
	assert.deepEqual(h.renderAtWidth(80), []);
	assert.equal(h.widgets.has("tps-stats"), true);
});

test("does not mount at session start in status mode, RPC mode or without a UI", async () => {
	const rpc = createHarness({ mode: "rpc" });
	assert.equal(rpc.widgets.size, 0);
	const headless = createHarness({ mode: "print", hasUI: false });
	assert.equal(headless.widgets.size, 0);
	const h = createHarness();
	await h.commands.get("tps").handler("status", h.ctx);
	assert.equal(h.widgets.size, 0, "status mode removes the mounted widget");
	h.handlers.get("session_start")({}, h.ctx);
	assert.equal(h.widgets.size, 0, "status mode is kept across a new session start");
	await h.commands.get("tps").handler("widget", h.ctx);
	assert.deepEqual([...h.widgets.keys()], ["tps-stats"], "switching back mounts it again");
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
		assert.equal(lines.length, 2);
		assert.ok(visibleWidth(lines[0]) <= width);
	}
	assert.equal(h.widgetCalls.length, calls);
});

test("creates a new component after session shutdown without retaining old UI callbacks", () => {
	const h = createHarness();
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	h.handlers.get("session_shutdown")({}, h.ctx);
	assert.equal(h.widgets.has("tps-stats"), false);
	h.handlers.get("session_start")({}, h.ctx);
	assert.equal(h.widgets.has("tps-stats"), true, "the new session mounts its own component");
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	assert.match(h.view.widget[0], /^TPS /);
	assert.equal(h.widgetCalls.filter((call) => typeof call.content === "function").length, 2);
});

test("does not create a terminal component without a UI", () => {
	const h = createHarness({ mode: "print", hasUI: false });
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	assert.equal(h.widgetCalls.length, 0);
	assert.equal(h.view.widget, undefined);
});

test("places the default widget above the prompt editor", () => {
	const { handlers, ctx, view } = createHarness();
	handlers.get("message_start")({ message: assistantMessage() }, ctx);
	assert.deepEqual(view.widgetOptions, { placement: "aboveEditor" });
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
			"TPS 11.4 tok/s. avg 11.4 tok/s, out 33, in 2, cache 0/85,571, cache % 0.0%/100.0%, total 85,606, 2.9s",
		]);
	});
});

test("updates all screenshot fields during streaming without changing the footer", async () => {
	await withFakeClock(async (setNow) => {
		const { handlers, commands, ctx, view } = createHarness();
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		const sendUsage = (output) =>
			handlers.get("message_update")(
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
			"TPS 10.0 tok/s. avg 10.0 tok/s, out 43, in 2, cache 0/85,571, cache % 0.0%/100.0%, total 85,616, 1.0s",
		]);
		assert.deepEqual(view.widgetOptions, { placement: "aboveEditor" });
		assert.equal(view.status, undefined);
		await commands.get("tps").handler("off", ctx);
		assert.equal(view.widget, undefined);
		await commands.get("tps").handler("on", ctx);
		assert.deepEqual(view.widgetOptions, { placement: "aboveEditor" });
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
			"TPS 1000 tok/s. avg 1000 tok/s, out 1,000, in 100, cache 800/100, cache % 80.0%/10.0%, total 2,000, 1.0s",
		]);
		assert.deepEqual(view.widgetOptions, { placement: "aboveEditor" });
		assert.ok(view.rawWidget[0].startsWith("\u001b[38;2;126;134;174m"));
		assert.ok(view.rawWidget[0].endsWith("\u001b[39m"));
		assert.equal(view.status, undefined);
	});
});

test("renders zero cache percentages when there are no prompt tokens", () => {
	const { handlers, ctx, view } = createHarness();
	handlers.get("message_start")({ message: assistantMessage() }, ctx);
	assert.deepEqual(view.widget, [
		"TPS ~0.0 tok/s. avg 0.0 tok/s, out ~0, in 0, cache 0/0, cache % 0.0%/0.0%, total ~0, 0.0s",
	]);
});

test("starts the measurement window only after a second output token", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		assert.deepEqual(view.widget, [
			"TPS ~0.0 tok/s. avg 0.0 tok/s, out ~0, in 0, cache 0/0, cache % 0.0%/0.0%, total ~0, 0.0s",
		]);

		setNow(1200);
		update(harness, "x".repeat(4));
		assert.deepEqual(
			view.widget,
			["TPS ~0.0 tok/s. avg 0.0 tok/s, out ~1, in 0, cache 0/0, cache % 0.0%/0.0%, total ~1, 0.0s"],
			"a single output token does not start the measurement clock",
		);

		setNow(1400);
		update(harness, "x".repeat(4));
		assert.deepEqual(
			view.widget,
			["TPS ~0.0 tok/s. avg 0.0 tok/s, out ~2, in 0, cache 0/0, cache % 0.0%/0.0%, total ~2, 0.0s"],
			"the second output token starts a zero-length window",
		);

		setNow(1600);
		update(harness, "x".repeat(40));
		assert.deepEqual(
			view.widget,
			["TPS ~50.0 tok/s. avg 50.0 tok/s, out ~12, in 0, cache 0/0, cache % 0.0%/0.0%, total ~12, 0.2s"],
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
			["TPS ~0.0 tok/s. avg 0.0 tok/s, out ~1, in 0, cache 0/0, cache % 0.0%/0.0%, total ~1, 0.0s"],
			"the measurement window stays closed after a single token",
		);

		setNow(1500);
		handlers.get("message_end")({ message: assistantMessage({ output: 2 }) }, ctx);
		assert.deepEqual(
			view.widget,
			["TPS 4.0 tok/s. avg 4.0 tok/s, out 2, in 0, cache 0/0, cache % 0.0%/0.0%, total 2, 0.5s"],
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
		assert.deepEqual(view.widget, [
			"TPS ~0.0 tok/s. avg 0.0 tok/s, out ~3, in 0, cache 0/0, cache % 0.0%/0.0%, total ~3, 0.0s",
		]);

		setNow(1500);
		handlers.get("message_end")({ message: assistantMessage({ output: 2 }) }, ctx);
		assert.deepEqual(
			view.widget,
			["TPS 4.0 tok/s. avg 4.0 tok/s, out 2, in 0, cache 0/0, cache % 0.0%/0.0%, total 2, 0.5s"],
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
		assert.deepEqual(view.widget, [
			"TPS 4.0 tok/s. avg 4.0 tok/s, out 2, in 0, cache 0/0, cache % 0.0%/0.0%, total 2, 0.5s",
		]);
	});
});

test("keeps a stable final summary through display-mode changes", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, commands, ctx, view } = harness;
		const message = assistantMessage();

		handlers.get("message_start")({ message }, ctx);
		assert.deepEqual(view.widget, [
			"TPS ~0.0 tok/s. avg 0.0 tok/s, out ~0, in 0, cache 0/0, cache % 0.0%/0.0%, total ~0, 0.0s",
		]);

		setNow(1200);
		update(harness, "x".repeat(4));

		setNow(1400);
		update(harness, "x".repeat(4), "thinking_delta");

		setNow(2000);
		handlers.get("message_end")({ message: assistantMessage({ output: 300 }) }, ctx);
		const finalWidget = "TPS 497 tok/s. avg 497 tok/s, out 300, in 0, cache 0/0, cache % 0.0%/0.0%, total 300, 0.6s";
		assert.deepEqual(view.widget, [finalWidget]);

		setNow(10_000);
		await commands.get("tps").handler("status", ctx);
		assert.equal(view.widget, undefined);
		assert.equal(view.status, finalWidget);

		await commands.get("tps").handler("off", ctx);
		assert.equal(view.status, undefined);
		await commands.get("tps").handler("on", ctx);
		assert.equal(view.status, finalWidget, "on restores the selected status mode");

		await commands.get("tps").handler("widget", ctx);
		assert.deepEqual(view.widget, [finalWidget], "final values do not decay while idle");

		await commands.get("tps").handler("reset", ctx);
		assert.equal(view.widget, undefined, "reset clears an idle final summary");
		await commands.get("tps").handler("reset", ctx);
		assert.equal(view.widget, undefined, "idle reset does not create a phantom stream");
		assert.equal(view.notifications.at(-1).message, "No tps-stats metrics to reset");
	});
});

test("switches from estimated deltas to cumulative provider usage", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		handlers.get("message_start")({ message: assistantMessage() }, ctx);

		setNow(1200);
		update(harness, "x".repeat(4));
		assert.deepEqual(view.widget, [
			"TPS ~0.0 tok/s. avg 0.0 tok/s, out ~1, in 0, cache 0/0, cache % 0.0%/0.0%, total ~1, 0.0s",
		]);

		setNow(1400);
		update(harness, "x".repeat(4));
		assert.deepEqual(view.widget, [
			"TPS ~0.0 tok/s. avg 0.0 tok/s, out ~2, in 0, cache 0/0, cache % 0.0%/0.0%, total ~2, 0.0s",
		]);

		setNow(1600);
		update(harness, "x".repeat(4), "text_delta", 50);
		assert.deepEqual(
			view.widget,
			["TPS 250 tok/s. avg 250 tok/s, out 50, in 0, cache 0/0, cache % 0.0%/0.0%, total 50, 0.2s"],
			"the first advancing provider report replaces the heuristic and its rolling samples",
		);

		setNow(1800);
		update(harness, "x".repeat(4), "thinking_delta", 90);
		assert.deepEqual(view.widget, [
			"TPS 225 tok/s. avg 225 tok/s, out 90, in 0, cache 0/0, cache % 0.0%/0.0%, total 90, 0.4s",
		]);
	});
});

test("observes provider usage on updates without content deltas", async () => {
	await withFakeClock(async (setNow) => {
		const harness = createHarness();
		const { handlers, ctx, view } = harness;

		handlers.get("message_start")({ message: assistantMessage() }, ctx);

		setNow(1100);
		usageUpdate(harness, 20);
		assert.deepEqual(view.widget, [
			"TPS 0.0 tok/s. avg 0.0 tok/s, out 20, in 0, cache 0/0, cache % 0.0%/0.0%, total 20, 0.0s",
		]);

		setNow(1150);
		usageUpdate(harness, 30, "toolcall_end");
		assert.deepEqual(
			view.widget,
			["TPS 200 tok/s. avg 200 tok/s, out 30, in 0, cache 0/0, cache % 0.0%/0.0%, total 30, 0.1s"],
			"usage-only events render even inside the normal delta update interval",
		);

		setNow(2000);
		handlers.get("message_end")({ message: assistantMessage({ output: 80 }) }, ctx);
		assert.deepEqual(view.widget, [
			"TPS 66.7 tok/s. avg 66.7 tok/s, out 80, in 0, cache 0/0, cache % 0.0%/0.0%, total 80, 0.9s",
		]);
	});
});

test("status mode shows the same text as the configured widget, live and final", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await h.commands.get("tps").handler("status", h.ctx);
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		assert.equal(
			h.view.status,
			"TPS ~0.0 tok/s. avg 0.0 tok/s, out ~0, in 0, cache 0/0, cache % 0.0%/0.0%, total ~0, 0.0s",
		);
		setNow(2000);
		h.handlers.get("message_end")(
			{ message: assistantMessage({ output: 1000, input: 100, cacheRead: 800, cacheWrite: 100 }) },
			h.ctx,
		);
		const expected =
			"TPS 1000 tok/s. avg 1000 tok/s, out 1,000, in 100, cache 800/100, cache % 80.0%/10.0%, total 2,000, 1.0s";
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
		assert.deepEqual(view.widget, [
			"TPS ~0.0 tok/s. avg 0.0 tok/s, out ~100, in 0, cache 0/0, cache % 0.0%/0.0%, total ~100, 0.0s",
		]);

		setNow(5300);
		await commands.get("tps").handler("reset", ctx);
		assert.deepEqual(view.widget, [
			"TPS ~0.0 tok/s. avg 0.0 tok/s, out ~0, in 0, cache 0/0, cache % 0.0%/0.0%, total ~0, 0.0s",
		]);

		setNow(5500);
		update(harness, "x".repeat(400));
		assert.deepEqual(view.widget, [
			"TPS ~500 tok/s. avg 500 tok/s, out ~100, in 0, cache 0/0, cache % 0.0%/0.0%, total ~100, 0.2s",
		]);

		setNow(6000);
		handlers.get("message_end")({ message: assistantMessage({ output: 500 }) }, ctx);
		assert.deepEqual(view.widget, [
			"TPS 571 tok/s. avg 571 tok/s, out 500, in 0, cache 0/0, cache % 0.0%/0.0%, total 500, 0.7s",
		]);

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
		assert.deepEqual(view.widget, [
			"TPS 100 tok/s. avg 100 tok/s, out 100, in 0, cache 0/0, cache % 0.0%/0.0%, total 100, 1.0s",
		]);
		handlers.get("message_end")({ message: assistantMessage({ output: 200 }) }, ctx);
		assert.deepEqual(view.widget, [
			"TPS 100 tok/s. avg 100 tok/s, out 200, in 0, cache 0/0, cache % 0.0%/0.0%, total 200, 1.0s",
		]);
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
		assert.deepEqual(view.widget, [
			"TPS 0.0 tok/s. avg 0.0 tok/s, out 100, in 0, cache 0/0, cache % 0.0%/0.0%, total 100, 1.0s",
		]);
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
		assert.deepEqual(view.widget, [
			"TPS 100 tok/s. avg 100 tok/s, out 100, in 0, cache 0/0, cache % 0.0%/0.0%, total 100, 1.0s",
		]);
		handlers.get("message_end")({ message: assistantMessage({ output: 250 }) }, ctx);
		assert.deepEqual(view.widget, [
			"TPS 100 tok/s. avg 100 tok/s, out 250, in 0, cache 0/0, cache % 0.0%/0.0%, total 250, 1.0s",
		]);
	});
});

test("session average is total output over total generation time, not a mean of averages", async () => {
	await withFakeClock(async (setNow) => {
		const { handlers, ctx, view } = createHarness();
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		setNow(2000);
		handlers.get("message_end")({ message: assistantMessage({ output: 100 }) }, ctx);
		assert.deepEqual(view.widget, [
			"TPS 100 tok/s. avg 100 tok/s, out 100, in 0, cache 0/0, cache % 0.0%/0.0%, total 100, 1.0s",
		]);
		setNow(3000);
		handlers.get("message_start")({ message: assistantMessage() }, ctx);
		setNow(7000);
		handlers.get("message_end")({ message: assistantMessage({ output: 100 }) }, ctx);
		// 200 tokens over 5.0s = 40.0; a mean of the two averages (100 and 25) would be 62.5.
		assert.deepEqual(view.widget, [
			"TPS 25.0 tok/s. avg 40.0 tok/s, out 100, in 0, cache 0/0, cache % 0.0%/0.0%, total 100, 4.0s",
		]);
	});
});

test("the live line folds the current response into the session average", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		setNow(2000);
		h.handlers.get("message_end")({ message: assistantMessage({ output: 100 }) }, h.ctx);
		setNow(3000);
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		setNow(3500);
		usageUpdate(h, 50);
		setNow(4500);
		usageUpdate(h, 100);
		// Current response: 50 measured tokens in 1.0s. Session: (100 + 50) / (1.0 + 1.0) = 75.0.
		assert.deepEqual(h.view.widget, [
			"TPS 50.0 tok/s. avg 75.0 tok/s, out 100, in 0, cache 0/0, cache % 0.0%/0.0%, total 100, 1.0s",
		]);
	});
});

test("clearing the summary keeps the session average; a new session starts it over", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		setNow(2000);
		h.handlers.get("message_end")({ message: assistantMessage({ output: 100 }) }, h.ctx);
		await h.commands.get("tps").handler("reset", h.ctx);
		assert.equal(h.view.widget, undefined);
		setNow(3000);
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		setNow(5000);
		h.handlers.get("message_end")({ message: assistantMessage({ output: 100 }) }, h.ctx);
		// 200 tokens over 3.0s.
		assert.match(h.view.widget[0], /^TPS 50\.0 tok\/s\. avg 66\.7 tok\/s, /);
		h.handlers.get("session_shutdown")({}, h.ctx);
		h.handlers.get("session_start")({}, h.ctx);
		setNow(6000);
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		setNow(8000);
		h.handlers.get("message_end")({ message: assistantMessage({ output: 100 }) }, h.ctx);
		assert.match(h.view.widget[0], /^TPS 50\.0 tok\/s\. avg 50\.0 tok\/s, /);
	});
});

async function respond(h, setNow, start, end, usage) {
	setNow(start);
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	setNow(end);
	h.handlers.get("message_end")({ message: assistantMessage(usage) }, h.ctx);
}

test("/tps stats says so when there is nothing to show", async () => {
	const h = createHarness();
	await h.commands.get("tps").handler("stats", h.ctx);
	assert.equal(h.panels.length, 0);
	assert.equal(h.view.notifications.at(-1).message, "No completed responses yet");
});

test("/tps stats opens a panel with the session statistics and closes with Esc", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await respond(h, setNow, 1000, 2000, { output: 100, input: 100, cacheRead: 800, cacheWrite: 100 });
		await respond(h, setNow, 3000, 7000, { output: 100, input: 500, cacheRead: 500 });
		const open = h.commands.get("tps").handler("stats", h.ctx);
		assert.equal(h.panels.length, 1);
		const text = h.panels[0].component.render(80).join("\n");
		for (const expected of [
			"2 responses",
			"avg 40.0  ┄ max 100  ┄ min 25.0",
			"avg 65.0%",
			"TPS (tok/s)",
			"┄ max 100",
			"██ ██",
		]) {
			assert.ok(text.includes(expected), `missing ${expected}`);
		}
		const rows = h.panels[0].component.render(80);
		assert.ok(
			rows.some((row) => row.includes("\u001b[38;2;126;134;174m")),
			"the body keeps the TPS color",
		);
		assert.deepEqual(h.panels[0].options, {
			overlay: true,
			overlayOptions: { width: "26.25%", minWidth: 56, maxHeight: "90%", anchor: "center" },
		});
		for (const role of ["border", "customMessageLabel", "accent", "dim"]) {
			assert.ok(h.themeRoles.has(role), `uses the theme ${role} token`);
		}
		h.panels[0].component.handleInput("x");
		h.panels[0].component.handleInput("q");
		await open;
	});
});

test("/tps stats survives reset and status mode, and starts over with a new session", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await respond(h, setNow, 1000, 2000, { output: 100 });
		await h.commands.get("tps").handler("reset", h.ctx);
		await h.commands.get("tps").handler("status", h.ctx);
		const open = h.commands.get("tps").handler("stats", h.ctx);
		assert.ok(h.panels[0].component.render(80).join("\n").includes("1 response"));
		h.panels[0].component.handleInput("\u001b");
		await open;
		h.handlers.get("session_shutdown")({}, h.ctx);
		h.handlers.get("session_start")({}, h.ctx);
		await h.commands.get("tps").handler("stats", h.ctx);
		assert.equal(h.panels.length, 1, "no panel for the new, empty session");
		assert.equal(h.view.notifications.at(-1).message, "No completed responses yet");
	});
});

test("/tps stats falls back to a plain notification without terminal components", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness({ mode: "rpc" });
		await respond(h, setNow, 1000, 2000, { output: 100 });
		await h.commands.get("tps").handler("stats", h.ctx);
		assert.equal(h.panels.length, 0);
		assert.ok(h.view.notifications.at(-1).message.includes("TPS (tok/s)  avg 100  ┄ max 100  ┄ min 100"));
	});
});

test("messages without output tokens are not statistics samples", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await respond(h, setNow, 1000, 2000, { output: 100 });
		await respond(h, setNow, 3000, 9000, { output: 0 });
		const open = h.commands.get("tps").handler("stats", h.ctx);
		const text = h.panels[0].component.render(80).join("\n");
		assert.ok(text.includes("1 response"), text);
		assert.ok(text.includes("min 100"), "an empty message does not pull the minimum to 0");
		h.panels[0].component.handleInput("\u001b");
		await open;
		assert.match(h.view.widget[0], /avg 100 tok\/s/, "nor does it dilute the session average");
	});
});

const pick = (h, name) => h.selectCalls.at(-1).options.find((option) => option.startsWith(name));

test("a bare /tps opens a menu with every action instead of acting on its own", async () => {
	const h = createHarness();
	await h.commands.get("tps").handler("", h.ctx);
	assert.equal(h.selectCalls.length, 1);
	assert.equal(h.selectCalls[0].title, "TPS · widget");
	const names = h.selectCalls[0].options.map((option) => option.split(/\s/)[0]);
	assert.deepEqual(names, ["stats", "widget", "status", "on", "off", "reset"]);
	assert.ok(
		h.selectCalls[0].options.every((option) => option.includes("  ")),
		"each option carries a description",
	);
	assert.equal(h.view.notifications.length, 0, "nothing ran and nothing was announced");
	assert.deepEqual([...h.widgets.keys()], ["tps-stats"], "the widget is still mounted");
});

test("cancelling the menu changes nothing", async () => {
	const h = createHarness();
	h.selections.push(undefined);
	await h.commands.get("tps").handler("   ", h.ctx);
	assert.equal(h.view.notifications.length, 0);
	assert.deepEqual([...h.widgets.keys()], ["tps-stats"]);
});

test("the chosen menu entry runs that action", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await respond(h, setNow, 1000, 2000, { output: 100 });
		h.selections.push("off");
		await h.commands.get("tps").handler("", h.ctx);
		assert.equal(h.widgets.size, 0, "off hid the widget");
		assert.equal(h.selectCalls.at(-1).title, "TPS · widget", "the title shows the state before the choice");
		h.selections.push("status");
		await h.commands.get("tps").handler("", h.ctx);
		assert.match(h.view.status, /^TPS /, "status published the line");
		assert.equal(h.selectCalls.at(-1).title, "TPS · off");
		h.selections.push("widget");
		await h.commands.get("tps").handler("", h.ctx);
		assert.ok(h.widgets.has("tps-stats"));
		h.selections.push("stats");
		const open = h.commands.get("tps").handler("", h.ctx);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(h.panels.length, 1, "stats opened the panel");
		h.panels[0].component.handleInput("q");
		await open;
	});
});

test("the menu entries are the full option labels returned by select", async () => {
	const h = createHarness();
	h.selections.push(undefined);
	await h.commands.get("tps").handler("", h.ctx);
	const label = pick(h, "off");
	h.selections.push(label);
	await h.commands.get("tps").handler("", h.ctx);
	assert.ok(label.startsWith("off"), label);
	assert.equal(h.widgets.size, 0, "a full label, not only its first word, selects the action");
});

test("an explicit argument skips the menu, and a removed action is refused", async () => {
	const h = createHarness();
	await h.commands.get("tps").handler("on", h.ctx);
	assert.equal(h.selectCalls.length, 0);
	const notifications = h.view.notifications.length;
	await h.commands.get("tps").handler("toggle", h.ctx);
	assert.equal(h.selectCalls.length, 0, "an argument never falls back to the menu");
	assert.equal(h.view.notifications.length, notifications + 1, "the refused action reports once");
	assert.equal(
		h.view.notifications.at(-1).message,
		"Usage: /tps [stats|widget|status|on|off|reset]",
		"a removed action names the supported ones",
	);
	assert.equal(h.view.notifications.at(-1).type, "error");
	assert.deepEqual([...h.widgets.keys()], ["tps-stats"], "a refused action leaves the display untouched");
	await h.commands.get("tps").handler("status", h.ctx);
	assert.equal(h.selectCalls.length, 0, "a supported argument still runs directly");
});

test("the menu, the usage message and the command help list the same actions in the same order", async () => {
	const h = createHarness();
	await h.commands.get("tps").handler("", h.ctx);
	const menuActions = h.selectCalls[0].options.map((option) => option.split(/\s/)[0]);
	h.selections.push(undefined);
	await h.commands.get("tps").handler("bogus", h.ctx);
	const usage = h.view.notifications.at(-1).message;
	const listed = usage.slice(usage.indexOf("[") + 1, usage.lastIndexOf("]")).split("|");
	assert.deepEqual(listed, menuActions, "the refusal names exactly the menu actions, in menu order");
	assert.ok(h.commands.get("tps").description.endsWith(listed.join("|")), "the command help ends with the same list");
});

test("without a UI a bare /tps never opens a menu and reports the usage", async () => {
	const h = createHarness({ mode: "print", hasUI: false });
	await h.commands.get("tps").handler("", h.ctx);
	assert.equal(h.selectCalls.length, 0);
	assert.equal(h.view.notifications.length, 1, "the usage is the only report");
	assert.equal(h.view.notifications[0].message, "Usage: /tps [stats|widget|status|on|off|reset]");
	assert.equal(h.view.notifications[0].type, "error");
	assert.equal(h.widgets.size, 0, "a refused bare /tps mounts nothing");
});

// Let queued promise callbacks (a closed panel, a rejected open) run.
const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

const click = (overrides = {}) => ({
	type: "click",
	button: "left",
	x: 5,
	y: 0,
	screenX: 5,
	screenY: 30,
	width: 80,
	height: 2,
	shift: false,
	...overrides,
});

test("a left click on the TPS line opens the statistics panel", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await respond(h, setNow, 1000, 2000, { output: 100 });
		const result = h.mouse(click());
		assert.equal(result?.handled, true, "the click is consumed");
		assert.equal(h.panels.length, 1, "the panel opened");
		assert.ok(h.panels[0].component.render(80).join("\n").includes("TPS (tok/s)"));
		h.panels[0].component.handleInput("q");
	});
});

test("only a left click on the data row opens the panel", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await respond(h, setNow, 1000, 2000, { output: 100 });
		for (const event of [
			click({ y: 1 }),
			click({ button: "right" }),
			click({ button: "middle" }),
			click({ type: "press" }),
			click({ type: "release" }),
			click({ type: "move", button: "none" }),
			click({ type: "wheel", button: "none" }),
		]) {
			assert.equal(h.mouse(event), undefined, JSON.stringify(event));
		}
		assert.equal(h.panels.length, 0, "none of them opened the panel");
	});
});

test("clicking before there is anything to show does nothing", () => {
	const h = createHarness();
	assert.deepEqual(h.renderAtWidth(80), [], "the widget is mounted but empty");
	assert.equal(h.mouse(click()), undefined);
	assert.equal(h.panels.length, 0);
	assert.equal(h.view.notifications.length, 0);
});

test("a click while a response streams with no finished response says there is no data", () => {
	const h = createHarness();
	h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
	assert.equal(h.mouse(click())?.handled, true);
	assert.equal(h.panels.length, 0);
	assert.equal(h.view.notifications.at(-1).message, "No completed responses yet");
});

test("a second click while the panel is open does not open another one, and it reopens after closing", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await respond(h, setNow, 1000, 2000, { output: 100 });
		h.mouse(click());
		assert.equal(h.mouse(click())?.handled, true, "still consumed");
		assert.equal(h.panels.length, 1, "only one panel");
		h.panels[0].component.handleInput("\u001b");
		await flush();
		h.mouse(click());
		assert.equal(h.panels.length, 2, "a new panel after closing the first");
		h.panels[1].component.handleInput("q");
	});
});

test("a failing panel does not leave the click handler stuck", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await respond(h, setNow, 1000, 2000, { output: 100 });
		const original = h.ctx.ui.custom;
		h.ctx.ui.custom = () => Promise.reject(new Error("boom"));
		h.mouse(click());
		await flush();
		assert.match(h.view.notifications.at(-1).message, /Could not open the TPS panel/);
		h.ctx.ui.custom = original;
		h.mouse(click());
		assert.equal(h.panels.length, 1, "the next click works");
		h.panels[0].component.handleInput("q");
	});
});

test("the source carries no trace of the original name: keys, messages and comments say tps-stats", () => {
	const dir = join(import.meta.dirname, "..", "src");
	for (const file of readdirSync(dir)) {
		assert.doesNotMatch(readFileSync(join(dir, file), "utf8"), /throughput/i, `src/${file}`);
	}
});

test("the user-facing messages are labelled tps-stats", async () => {
	const h = createHarness();
	await h.commands.get("tps").handler("off", h.ctx);
	await h.commands.get("tps").handler("on", h.ctx);
	await h.commands.get("tps").handler("reset", h.ctx);
	assert.deepEqual(
		h.view.notifications.map((entry) => entry.message),
		["tps-stats: off", "tps-stats: widget", "No tps-stats metrics to reset"],
	);
});

test("a short terminal shrinks the graphs so the centered panel still fits in 90% of the height", async () => {
	await withFakeClock(async (setNow) => {
		const heights = [];
		for (const rows of [26, 27]) {
			const h = createHarness();
			h.tui.terminal.rows = rows;
			await respond(h, setNow, 1000, 2000, { output: 100 });
			const open = h.commands.get("tps").handler("stats", h.ctx);
			heights.push(h.panels[0].component.render(80).length);
			h.panels[0].component.handleInput("q");
			await open;
		}
		assert.deepEqual(heights, [18, 24], "26 rows get 3-row graphs; 27 rows (24 / 0.9) get the full panel");
	});
});

test("a reset that leaves no measured output is not a statistics sample", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await respond(h, setNow, 1000, 2000, { output: 100 });
		// Second message: 100 tokens arrive, the user resets, and nothing more is produced.
		setNow(3000);
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		setNow(3500);
		usageUpdate(h, 100);
		setNow(4000);
		await h.commands.get("tps").handler("reset", h.ctx);
		setNow(5000);
		h.handlers.get("message_end")({ message: assistantMessage({ output: 100 }) }, h.ctx);
		assert.match(h.view.widget[0], /^TPS 0\.0 tok\/s\. avg 100 tok\/s, /, "the line still shows the empty window");
		const open = h.commands.get("tps").handler("stats", h.ctx);
		const text = h.panels[0].component.render(80).join("\n");
		assert.ok(text.includes("1 response"), `only the first message counts: ${text}`);
		assert.ok(text.includes("avg 100  ┄ max 100  ┄ min 100"), "the 0 tok/s window did not pull the minimum down");
		h.panels[0].component.handleInput("q");
		await open;
	});
});

test("a reset followed by more output still records that message, measured after the reset", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await respond(h, setNow, 1000, 2000, { output: 100 });
		setNow(3000);
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		setNow(3500);
		usageUpdate(h, 100);
		setNow(4000);
		await h.commands.get("tps").handler("reset", h.ctx);
		setNow(5000);
		usageUpdate(h, 200);
		h.handlers.get("message_end")({ message: assistantMessage({ output: 200 }) }, h.ctx);
		const open = h.commands.get("tps").handler("stats", h.ctx);
		assert.ok(h.panels[0].component.render(80).join("\n").includes("2 responses"));
		h.panels[0].component.handleInput("q");
		await open;
	});
});

test("an estimated-mode reset that leaves less than one token is not a statistics sample", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		await respond(h, setNow, 1000, 2000, { output: 100 });
		setNow(3000);
		h.handlers.get("message_start")({ message: assistantMessage() }, h.ctx);
		setNow(3500);
		// 402 characters estimate 100.5 tokens; the provider later reports 101, so 0.5 is left.
		update(h, "x".repeat(402));
		setNow(4000);
		await h.commands.get("tps").handler("reset", h.ctx);
		setNow(5000);
		h.handlers.get("message_end")({ message: assistantMessage({ output: 101 }) }, h.ctx);
		const open = h.commands.get("tps").handler("stats", h.ctx);
		const text = h.panels[0].component.render(80).join("\n");
		assert.ok(text.includes("1 response"), `half a token is not a measurement: ${text}`);
		assert.match(h.view.widget[0], /avg 100 tok\/s, /, "and it does not touch the session average");
		h.panels[0].component.handleInput("q");
		await open;
	});
});

const hostile = (usage) => ({ role: "assistant", model: "m", usage });

test("hostile usage values never reach the screen as NaN, Infinity or huge numbers", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		h.handlers.get("message_start")({ message: hostile(zero) }, h.ctx);
		setNow(1500);
		h.handlers.get("message_update")(
			{
				message: hostile({ ...zero, output: Number.POSITIVE_INFINITY }),
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			},
			h.ctx,
		);
		assert.doesNotMatch(h.view.widget[0], /NaN|Infinity/, "a streamed Infinity is ignored");
		setNow(2000);
		h.handlers.get("message_end")(
			{ message: hostile({ input: Number.NaN, output: 100, cacheRead: -5, cacheWrite: 1e308 }) },
			h.ctx,
		);
		const line = h.view.widget[0];
		assert.doesNotMatch(line, /NaN|Infinity|e\+|-\d/, line);
		assert.ok(line.length < 160, `bounded length: ${line}`);
		assert.match(
			line,
			/in 0, cache 0\/1,000,000,000,000,000, cache % 0\.0%\/100\.0%/,
			"NaN and negatives become 0, huge values are capped",
		);
		const open = h.commands.get("tps").handler("stats", h.ctx);
		const text = h.panels[0].component.render(80).join("\n");
		assert.doesNotMatch(text, /NaN|Infinity|e\+/, "the panel is clean too");
		h.panels[0].component.handleInput("q");
		await open;
	});
});

test("usage values of the wrong type are treated as zero and never coerced", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		const trap = {
			valueOf() {
				throw new Error("valueOf must not be called");
			},
			toString() {
				throw new Error("toString must not be called");
			},
		};
		h.handlers.get("message_start")({ message: hostile({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }, h.ctx);
		setNow(2000);
		h.handlers.get("message_end")(
			{ message: hostile({ input: trap, output: 50, cacheRead: "7", cacheWrite: null }) },
			h.ctx,
		);
		assert.match(h.view.widget[0], /out 50, in 0, cache 0\/0, /, h.view.widget[0]);
	});
});

test("null or missing usage is treated as zero", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		const m = (usage) => ({ role: "assistant", model: "m", usage });
		h.handlers.get("message_start")({ message: m(null) }, h.ctx);
		h.handlers.get("message_update")(
			{ message: m(undefined), assistantMessageEvent: { type: "text_delta", delta: "hi" } },
			h.ctx,
		);
		setNow(2000);
		h.handlers.get("message_end")({ message: m({ output: 10n, input: new Number(5) }) }, h.ctx);
		assert.match(h.view.widget[0], /out 0, in 0, cache 0\/0, /, h.view.widget[0]);
	});
});

test("capped usage over a 1 ms response stays plain", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		const m = (usage) => ({ role: "assistant", model: "m", usage });
		h.handlers.get("message_start")({ message: m({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }, h.ctx);
		setNow(1001);
		h.handlers.get("message_end")(
			{ message: m({ input: 1e300, output: 1e300, cacheRead: 1e300, cacheWrite: 1e300 }) },
			h.ctx,
		);
		assert.doesNotMatch(h.view.widget[0], /NaN|Infinity|e\+/, h.view.widget[0]);
		assert.match(h.view.widget[0], /total 4,000,000,000,000,000, /, h.view.widget[0]);
	});
});

test("a usage getter that throws does not break the handler; that field is zero", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		const usage = {
			output: 80,
			cacheRead: 20,
			cacheWrite: 0,
			get input() {
				throw new Error("getter must not break the extension");
			},
		};
		h.handlers.get("message_start")(
			{ message: { role: "assistant", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
			h.ctx,
		);
		setNow(2000);
		assert.doesNotThrow(() =>
			h.handlers.get("message_end")({ message: { role: "assistant", model: "m", usage } }, h.ctx),
		);
		assert.match(h.view.widget[0], /out 80, in 0, cache 20\/0, /, h.view.widget[0]);
	});
});

// Opens the stats panel and reports whether it closed after the given key.
const closesOn = async (h, setNow, key) => {
	await respond(h, setNow, 1000, 2000, { output: 100 });
	let closed = false;
	const open = h.commands.get("tps").handler("stats", h.ctx);
	open.then(() => {
		closed = true;
	});
	const panel = h.panels.at(-1).component;
	panel.handleInput(key);
	await flush();
	// Read the answer before the cleanup below, which closes the panel on purpose.
	const closedByKey = closed;
	if (!closedByKey) {
		panel.handleInput("q");
		await open;
	}
	return closedByKey;
};

test("Ctrl+C closes the stats panel, like Pi's own selectors, in both key encodings", async () => {
	for (const key of ["\u0003", "\u001b[99;5u"]) {
		await withFakeClock(async (setNow) => {
			assert.equal(await closesOn(createHarness(), setNow, key), true, JSON.stringify(key));
		});
	}
});

test("Esc and q still close the panel, and other keys do not", async () => {
	for (const [key, expected] of [
		["\u001b", true],
		["q", true],
		["x", false],
		["\r", false],
		["\u0004", false],
		["Q", false],
	]) {
		await withFakeClock(async (setNow) => {
			assert.equal(await closesOn(createHarness(), setNow, key), expected, JSON.stringify(key));
		});
	}
});

test("the panel also closes on the user's configured cancel binding", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		h.keybindings.matches = (data, id) => id === "tui.select.cancel" && data === "z";
		assert.equal(await closesOn(h, setNow, "z"), true, "the remapped key cancels");
	});
	await withFakeClock(async (setNow) => {
		assert.equal(await closesOn(createHarness(), setNow, "z"), false, "without a binding, z does nothing");
	});
});

test("Ctrl+C in modifyOtherKeys and with the caps-lock bit also closes the panel", async () => {
	for (const key of ["\u001b[27;5;99~", "\u001b[99;69u"]) {
		await withFakeClock(async (setNow) => {
			assert.equal(await closesOn(createHarness(), setNow, key), true, JSON.stringify(key));
		});
	}
});

test("Ctrl+Shift+C is not Ctrl+C and does not close the panel", async () => {
	await withFakeClock(async (setNow) => {
		assert.equal(await closesOn(createHarness(), setNow, "\u001b[99;6u"), false);
	});
});

test("a keybindings manager that throws, answers a non-boolean or is missing never breaks the panel", async () => {
	const hosts = {
		throws: (h) => {
			h.keybindings.matches = () => {
				throw new Error("boom");
			};
			return h;
		},
		truthy: (h) => {
			h.keybindings.matches = () => "yes";
			return h;
		},
		missing: () => createHarness({ withKeybindings: false }),
	};
	for (const [name, make] of Object.entries(hosts)) {
		for (const [key, expected] of [
			["\u001b", true],
			["q", true],
			["\u0003", true],
			["x", name === "truthy"],
		]) {
			await withFakeClock(async (setNow) => {
				assert.equal(await closesOn(make(createHarness()), setNow, key), expected, `${name} ${JSON.stringify(key)}`);
			});
		}
	}
});

test("the panel asks the host for the tui.select.cancel binding and nothing else", async () => {
	await withFakeClock(async (setNow) => {
		const h = createHarness();
		const ids = [];
		h.keybindings.matches = (_data, id) => {
			ids.push(id);
			return false;
		};
		await closesOn(h, setNow, "x");
		assert.deepEqual([...new Set(ids)], ["tui.select.cancel"]);
	});
});
