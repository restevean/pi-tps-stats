/**
 * Live tokens/sec (TPS) display for the Pi coding agent.
 *
 * The default widget uses one line while streaming and replaces it with a
 * provider-usage summary that remains visible until the next response starts.
 * Live metrics prefer cumulative provider usage when it advances during the
 * stream. Until then, clearly labeled estimates count text, thinking, and
 * tool-call delta characters using a four-characters-per-token heuristic.
 * The measurement starts only after a second output token has been
 * observed, so time-to-first-token latency never dilutes rolling, average, or
 * peak rates; the token counters still report cumulative response output.
 * Final summaries also report the response's input and cache usage. The status
 * mode publishes the same line as the widget.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { formatRate, minimumPanelWidth, renderStatsPanel, type PanelStyle, type ResponseSample } from "./stats.ts";

const WIDGET_KEY = "tps-stats";
const STATUS_KEY = "tps-stats";
// Dedicated foreground color #7E86AE, independent of the active theme.
const TPS_COLOR = "\u001b[38;2;126;134;174m";
const RESET_FOREGROUND = "\u001b[39m";
const WINDOW_MS = 3000;
const UPDATE_INTERVAL_MS = 200;
const CHARS_PER_TOKEN = 4;
const MEASUREMENT_MIN_TOKENS = 2;
// The stats panel floor: room for fifteen bars. The width is derived from the bar geometry
// in stats.ts, so it cannot drift from what the panel actually draws.
const PANEL_BARS = 15;

type DisplayMode = "widget" | "status";

// Usage counts reach us from the provider through the host. Anything that is not a finite
// number becomes 0 (it is never coerced, so no hostile toString/valueOf runs) and huge
// values are capped, so the screen only ever shows plain, bounded numbers.
const MAX_COUNT = 1e15;
const safeCount = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_COUNT, Math.max(0, value)) : 0;
const readUsage = (usage: unknown): PromptUsage & { output: number } => {
	const raw = (usage ?? {}) as Record<string, unknown>;
	// Each field on its own: a getter that throws costs that field, not the whole handler.
	const field = (key: string): number => {
		try {
			return safeCount(raw[key]);
		} catch {
			return 0;
		}
	};
	return {
		input: field("input"),
		output: field("output"),
		cacheRead: field("cacheRead"),
		cacheWrite: field("cacheWrite"),
	};
};

interface Sample {
	t: number;
	tokens: number;
}

interface PromptUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

interface StreamingState {
	kind: "streaming";
	usage: PromptUsage;
	responseStartTime: number;
	providerRequestTime: number | undefined;
	firstOutputTime: number | undefined;
	measurementStartTime: number | undefined;
	measurementBaseline: number;
	totalChars: number;
	providerOutputBaseline: number;
	lastProviderOutput: number;
	reportedOutputTokens: number;
	usesReportedUsage: boolean;
	samples: Sample[];
	peakRate: number;
	lastRender: number;
	model: string;
}

interface FinalState {
	kind: "final";
	usage: PromptUsage;
	outputTokens: number;
	elapsedSec: number;
	averageRate: number;
	peakRate: number;
	model: string;
}

type StatsState = StreamingState | FinalState;

export default function (pi: ExtensionAPI): void {
	let mode: DisplayMode = "widget";
	let enabled = true;
	let state: StatsState | undefined;
	// Session totals over completed responses, weighted by time: total output tokens
	// divided by total generation seconds (not a mean of per-response averages).
	let sessionTokens = 0;
	let sessionSeconds = 0;
	// One entry per completed response, for /tps stats. Cleared with the session.
	let samples: ResponseSample[] = [];
	let ui: ExtensionUIContext | undefined;
	let hasUI = false;
	let pendingProviderRequestTime: number | undefined;
	let customWidgets = false;
	let widgetOwner: object | undefined;
	let widgetContent = "";
	let requestWidgetRender: (() => void) | undefined;
	// True while the stats panel is open, so a click on the line cannot stack a second one.
	let panelOpen = false;

	const fmtRate = formatRate;
	const estimatedTokens = (chars: number): number => chars / CHARS_PER_TOKEN;
	const isFirstOutputEvent = (update: { type: string; delta?: string; content?: string }): boolean => {
		switch (update.type) {
			case "text_start":
			case "thinking_start":
			case "toolcall_start":
			case "toolcall_end":
				return true;
			case "text_delta":
			case "thinking_delta":
			case "toolcall_delta":
				return (update.delta?.length ?? 0) > 0;
			case "text_end":
			case "thinking_end":
				return (update.content?.length ?? 0) > 0;
			default:
				return false;
		}
	};

	const sessionRate = (extraTokens = 0, extraSeconds = 0): number => {
		const seconds = sessionSeconds + extraSeconds;
		return seconds > 0 ? (sessionTokens + extraTokens) / seconds : 0;
	};

	const widgetLine = (
		rate: number,
		averageRate: number,
		output: number,
		elapsedSec: number,
		usage: PromptUsage,
		estimated = false,
	): string => {
		const count = (value: number): string => Math.round(value).toLocaleString("en-US");
		const estimateMark = estimated ? "~" : "";
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		const total = output + promptTokens;
		const percent = (tokens: number): string => `${(promptTokens > 0 ? (tokens / promptTokens) * 100 : 0).toFixed(1)}%`;
		return `TPS ${estimateMark}${fmtRate(rate)} tok/s. avg ${fmtRate(averageRate)} tok/s, out ${estimateMark}${count(output)}, in ${count(usage.input)}, cache ${count(usage.cacheRead)}/${count(usage.cacheWrite)}, cache % ${percent(usage.cacheRead)}/${percent(usage.cacheWrite)}, total ${estimateMark}${count(total)}, ${elapsedSec.toFixed(1)}s`;
	};

	const clearWidget = (): void => {
		ui?.setWidget(WIDGET_KEY, undefined);
		widgetOwner = undefined;
		widgetContent = "";
		requestWidgetRender = undefined;
	};

	const clearUi = (): void => {
		clearWidget();
		ui?.setStatus(STATUS_KEY, undefined);
	};

	const rollingRate = (stream: StreamingState, now: number): number => {
		if (stream.measurementStartTime === undefined) return 0;
		const windowStart = Math.max(stream.measurementStartTime, now - WINDOW_MS);
		stream.samples = stream.samples.filter((sample) => sample.t >= windowStart);
		const elapsedMs = now - windowStart;
		if (elapsedMs <= 0 || stream.samples.length === 0) return 0;
		const tokens = stream.samples.reduce((sum, sample) => sum + sample.tokens, 0);
		return tokens / (elapsedMs / 1000);
	};

	const liveOutputTokens = (stream: StreamingState): number =>
		stream.usesReportedUsage ? stream.reportedOutputTokens : estimatedTokens(stream.totalChars);

	const measuredOutputTokens = (stream: StreamingState, total: number): number => {
		if (stream.measurementStartTime === undefined) return 0;
		return Math.max(0, total - stream.measurementBaseline);
	};

	const startMeasurementIfReady = (stream: StreamingState, now: number): boolean => {
		if (stream.measurementStartTime !== undefined) return false;
		const total = liveOutputTokens(stream);
		if (total < MEASUREMENT_MIN_TOKENS) return false;
		stream.measurementStartTime = now;
		stream.measurementBaseline = total;
		stream.samples = [];
		stream.peakRate = 0;
		return true;
	};

	// Mounted as early as the session starts (empty, zero rows): Pi lays widgets out in
	// registration order, and the host republishes its own banner later, so this
	// keeps the TPS line ahead of it. Repainting never re-registers.
	const ensureWidget = (): void => {
		if (!ui || !hasUI || !enabled || mode !== "widget" || !customWidgets || widgetOwner) return;
		const owner = {};
		widgetOwner = owner;
		ui.setWidget(
			WIDGET_KEY,
			(tui) => {
				requestWidgetRender = () => {
					tui.requestRender();
				};
				return {
					// One blank row separates the TPS line from whatever the host draws below it.
					render: (width) => (widgetContent ? [truncateToWidth(widgetContent, width), ""] : []),
					invalidate() {
						// Stateless: render() always reads the live content.
					},
					// Fullscreen mode routes clicks here; regular mode leaves the mouse to the terminal.
					// Only a left click on the TPS row counts, not the blank row below it.
					handleMouse(event: TuiMouseEvent) {
						if (event.type !== "click" || event.button !== "left" || event.y !== 0 || !widgetContent) {
							return undefined;
						}
						if (!panelOpen && ui) {
							const target = ui;
							showStats(target).catch(() => {
								target.notify("Could not open the TPS panel", "warning");
							});
						}
						return { handled: true };
					},
					dispose() {
						if (widgetOwner !== owner) return;
						widgetOwner = undefined;
						widgetContent = "";
						requestWidgetRender = undefined;
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	};

	const showLine = (line: string): void => {
		if (!ui) return;
		if (mode === "status") {
			// Same text as the widget; the host owns the status color and strips escapes.
			clearWidget();
			ui.setStatus(STATUS_KEY, line);
			return;
		}

		ui.setStatus(STATUS_KEY, undefined);
		widgetContent = `${TPS_COLOR}${line}${RESET_FOREGROUND}`;
		if (!customWidgets) {
			// RPC supports string widgets, not terminal component factories.
			ui.setWidget(WIDGET_KEY, [widgetContent, ""], { placement: "aboveEditor" });
			return;
		}
		if (widgetOwner) {
			requestWidgetRender?.();
			return;
		}
		ensureWidget();
	};

	const render = (): void => {
		if (!state || !hasUI || !enabled) return;

		if (state.kind === "final") {
			showLine(widgetLine(state.averageRate, sessionRate(), state.outputTokens, state.elapsedSec, state.usage));
			return;
		}

		const now = Date.now();
		const live = rollingRate(state, now);
		state.peakRate = Math.max(state.peakRate, live);
		const elapsedSec = state.measurementStartTime === undefined ? 0 : (now - state.measurementStartTime) / 1000;
		const outputTokens = liveOutputTokens(state);
		const measured = measuredOutputTokens(state, outputTokens);
		showLine(
			widgetLine(
				live,
				sessionRate(measured, elapsedSec),
				outputTokens,
				elapsedSec,
				state.usage,
				!state.usesReportedUsage,
			),
		);
	};

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		hasUI = ctx.hasUI;
		customWidgets = ctx.mode === "tui";
		sessionTokens = 0;
		sessionSeconds = 0;
		samples = [];
		ensureWidget();
	});

	pi.on("session_shutdown", () => {
		clearUi();
		state = undefined;
		sessionTokens = 0;
		sessionSeconds = 0;
		samples = [];
		pendingProviderRequestTime = undefined;
		ui = undefined;
		hasUI = false;
	});

	pi.on("before_provider_request", () => {
		pendingProviderRequestTime = Date.now();
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		ui = ctx.ui;
		hasUI = ctx.hasUI;
		const now = Date.now();
		state = {
			kind: "streaming",
			usage: readUsage(event.message.usage),
			responseStartTime: now,
			providerRequestTime: pendingProviderRequestTime,
			firstOutputTime: undefined,
			measurementStartTime: undefined,
			measurementBaseline: 0,
			totalChars: 0,
			providerOutputBaseline: 0,
			lastProviderOutput: 0,
			reportedOutputTokens: 0,
			usesReportedUsage: false,
			samples: [],
			peakRate: 0,
			lastRender: now,
			model: event.message.responseModel ?? event.message.model,
		};
		pendingProviderRequestTime = undefined;
		render();
	});

	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant" || state?.kind !== "streaming") return;
		ui = ctx.ui;
		hasUI = ctx.hasUI;
		const stream = state;
		const usage = readUsage(event.message.usage);
		stream.usage = usage;
		stream.model = event.message.responseModel ?? event.message.model;
		const update = event.assistantMessageEvent;
		const now = Date.now();
		const isDelta =
			update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta";
		const chars = isDelta ? update.delta.length : 0;
		if (stream.firstOutputTime === undefined && isFirstOutputEvent(update)) stream.firstOutputTime = now;
		const providerOutput = usage.output;
		let providerAdvanced = false;
		let switchedToReportedUsage = false;

		if (Number.isFinite(providerOutput) && providerOutput > stream.lastProviderOutput) {
			const previousOutput = Math.max(stream.lastProviderOutput, stream.providerOutputBaseline);
			stream.lastProviderOutput = providerOutput;
			if (providerOutput > stream.providerOutputBaseline) {
				providerAdvanced = true;
				if (!stream.usesReportedUsage) {
					stream.usesReportedUsage = true;
					stream.samples = [];
					stream.peakRate = 0;
					switchedToReportedUsage = true;
				}
				stream.reportedOutputTokens = providerOutput - stream.providerOutputBaseline;
				stream.samples.push({ t: now, tokens: providerOutput - previousOutput });
			}
		}

		if (chars > 0) {
			stream.totalChars += chars;
			if (!stream.usesReportedUsage) stream.samples.push({ t: now, tokens: estimatedTokens(chars) });
		}

		if (switchedToReportedUsage && stream.measurementStartTime !== undefined) stream.measurementBaseline = 0;
		const startedMeasurement = startMeasurementIfReady(stream, now);

		const usageOnlyUpdate = providerAdvanced && !isDelta;
		if (
			startedMeasurement ||
			switchedToReportedUsage ||
			usageOnlyUpdate ||
			(chars > 0 && now - stream.lastRender >= UPDATE_INTERVAL_MS)
		) {
			stream.lastRender = now;
			render();
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || state?.kind !== "streaming") return;
		ui = ctx.ui;
		hasUI = ctx.hasUI;
		const now = Date.now();
		const stream = state;
		const usage = readUsage(event.message.usage);
		const outputTokens = usage.output;
		const windowOutputTokens = Math.max(0, outputTokens - stream.providerOutputBaseline);
		let measurementStart = stream.measurementStartTime ?? stream.responseStartTime;
		let measuredTokens =
			stream.measurementStartTime === undefined ? windowOutputTokens : measuredOutputTokens(stream, windowOutputTokens);
		if (measuredTokens < 1) {
			// The window captured less than a full output token, for example a final provider
			// total at or below the estimated baseline. Fall back to response timing
			// (or reset timing after a reset), retaining the pre-reset token exclusion.
			measurementStart = stream.responseStartTime;
			measuredTokens = windowOutputTokens;
		}
		const elapsedSec = (now - measurementStart) / 1000;
		const generationSeconds = Math.max(elapsedSec, 0.001);
		const averageRate = measuredTokens / generationSeconds;
		// Two filters keep the statistics comparable. Less than one measured token is not a
		// speed measurement: an empty message, or a /tps reset after which no more output
		// arrived (including the fraction an estimated baseline can leave), would pull the
		// minimum down and dilute the averages. And a response Pi reports as aborted or failed
		// is left out: a fragment of a rate curve is not a comparable sample. Every other
		// reason in pi-ai's StopReason union is counted: "stop", "length", "toolUse",
		// "pending" and "deferred" (the token filter above drops one that carries no output),
		// and so is a reason missing from the union, rather than silently emptying the
		// statistics.
		// The widget line still shows that final window either way.
		const abortedOrFailed = event.message.stopReason === "aborted" || event.message.stopReason === "error";
		if (measuredTokens >= 1 && !abortedOrFailed) {
			sessionTokens += measuredTokens;
			sessionSeconds += generationSeconds;
			samples.push({
				tps: averageRate,
				tokens: measuredTokens,
				seconds: generationSeconds,
				input: usage.input,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			});
		}
		const peakRate = Math.max(stream.peakRate, rollingRate(stream, now), averageRate);
		state = {
			kind: "final",
			usage,
			outputTokens,
			elapsedSec,
			averageRate,
			peakRate,
			model: event.message.responseModel ?? event.message.model,
		};
		render();
	});

	const showStats = async (panelUi: ExtensionUIContext): Promise<void> => {
		if (samples.length === 0) {
			panelUi.notify("No completed responses yet", "info");
			return;
		}
		if (!customWidgets) {
			panelUi.notify(renderStatsPanel(samples, 80).join("\n"), "info");
			return;
		}
		const snapshot = [...samples];
		panelOpen = true;
		try {
			await openPanel(panelUi, snapshot);
		} finally {
			panelOpen = false;
		}
	};

	const openPanel = async (panelUi: ExtensionUIContext, snapshot: readonly ResponseSample[]): Promise<void> => {
		await panelUi.custom<undefined>(
			(tui, theme, keybindings, done) => {
				// Same tokens as the Claude usage panel; a theme without them falls back to plain text.
				const themed = typeof (theme as { fg?: unknown } | undefined)?.fg === "function";
				const fg = (role: string) => (text: string) => (themed ? theme.fg(role as never, text) : text);
				const style: PanelStyle = {
					frame: fg("border"),
					title: fg("customMessageLabel"),
					text: (text) => `${TPS_COLOR}${text}${RESET_FOREGROUND}`,
					key: fg("accent"),
					keyText: fg("dim"),
				};
				// A short terminal gets shorter graphs so the centered panel still fits.
				const rows = (tui as { terminal?: { rows?: number } }).terminal?.rows;
				const graphHeight = typeof rows === "number" && rows < 27 ? 3 : undefined;
				// The host's cancel binding; a host that does not pass its keybindings just has none.
				const isBoundToCancel = (data: string): boolean => {
					try {
						return keybindings.matches(data, "tui.select.cancel");
					} catch {
						return false;
					}
				};
				return {
					render: (width) => renderStatsPanel(snapshot, width, style, graphHeight),
					handleInput(data) {
						// Esc, q and Ctrl+C like Pi's own selectors, plus whatever the user bound to cancel.
						const cancel =
							matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || isBoundToCancel(data);
						if (cancel) done(undefined);
					},
					invalidate() {
						// Stateless: render() always reads the snapshot.
					},
				};
			},
			// Centered like the Claude usage panel, at about a third of its width.
			{
				overlay: true,
				overlayOptions: {
					width: "26.25%",
					minWidth: minimumPanelWidth(PANEL_BARS),
					maxHeight: "90%",
					anchor: "center",
				},
			},
		);
	};

	// Shown by a bare /tps. The label is "<action>  <description>"; the action is its first word.
	const MENU: readonly (readonly [string, string])[] = [
		["stats", "Statistics panel with graphs"],
		["widget", "Line above the editor"],
		["status", "Same line as a host status"],
		["on", "Show the display"],
		["off", "Hide the display"],
		["reset", "Clear the summary or restart the measurement"],
	];
	const MENU_LABELS = MENU.map(([action, description]) => `${action.padEnd(6)}  ${description}`);
	// One action list feeds all three renderings: the menu labels, the usage message and the command help.
	const ACTIONS = MENU.map(([action]) => action).join("|");

	/** Reported for an unknown argument, and for a bare /tps with no UI to ask with. */
	const USAGE = `Usage: /tps [${ACTIONS}]`;

	/** The action chosen from the menu, undefined if cancelled. */
	const chooseAction = async (ctx: ExtensionCommandContext): Promise<string | undefined> => {
		const choice = await ctx.ui.select(`TPS · ${enabled ? mode : "off"}`, MENU_LABELS);
		return choice?.split(/\s/)[0];
	};

	const run = (arg: string, ctx: ExtensionCommandContext): Promise<void> => {
		switch (arg) {
			case "on":
				enabled = true;
				ensureWidget();
				render();
				ctx.ui.notify(`tps-stats: ${mode}`, "info");
				return Promise.resolve();
			case "off":
				enabled = false;
				clearUi();
				ctx.ui.notify("tps-stats: off", "info");
				return Promise.resolve();
			case "widget":
			case "status":
				if (mode !== arg) clearUi();
				mode = arg;
				enabled = true;
				ensureWidget();
				render();
				ctx.ui.notify(`tps-stats: ${mode}`, "info");
				return Promise.resolve();
			case "stats":
				return showStats(ctx.ui);
			case "reset":
				if (state?.kind === "streaming") {
					const now = Date.now();
					state.responseStartTime = now;
					state.measurementStartTime = now;
					state.measurementBaseline = 0;
					state.providerOutputBaseline =
						state.lastProviderOutput > 0
							? state.lastProviderOutput
							: state.providerOutputBaseline + estimatedTokens(state.totalChars);
					state.totalChars = 0;
					state.reportedOutputTokens = 0;
					state.samples = [];
					state.peakRate = 0;
					state.lastRender = now;
					render();
					ctx.ui.notify("Current tps-stats measurement reset", "info");
				} else if (state?.kind === "final") {
					state = undefined;
					clearUi();
					ctx.ui.notify("Final tps-stats summary cleared", "info");
				} else {
					ctx.ui.notify("No tps-stats metrics to reset", "info");
				}
				return Promise.resolve();
			default:
				ctx.ui.notify(USAGE, "error");
				return Promise.resolve();
		}
	};

	pi.registerCommand("tps", {
		description: `Show TPS and token usage. Run it alone for a menu, or add: ${ACTIONS}`,
		handler: async (args, ctx) => {
			ui = ctx.ui;
			hasUI = ctx.hasUI;
			const typed = args.trim().toLowerCase();
			// With no UI there is no menu to ask with, so a bare /tps must not guess an action.
			if (!typed && !ctx.hasUI) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			const arg = typed || (await chooseAction(ctx));
			if (arg === undefined) return;
			await run(arg, ctx);
		},
	});
}
