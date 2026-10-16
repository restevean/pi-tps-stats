/**
 * Live tokens/sec throughput display for the Pi coding agent.
 *
 * The default widget uses one line while streaming and replaces it with a
 * provider-usage summary that remains visible until the next response starts.
 * Live metrics prefer cumulative provider usage when it advances during the
 * stream. Until then, clearly labeled estimates count text, thinking, and
 * tool-call delta characters using a four-characters-per-token heuristic.
 * Throughput measurement starts only after a second output token has been
 * observed, so time-to-first-token latency never dilutes rolling, average, or
 * peak rates; the token counters still report cumulative response output.
 * Final summaries also report the response's input and cache usage. The status
 * mode publishes the same line as the widget.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "throughput";
const STATUS_KEY = "throughput";
// Dedicated throughput foreground token: #7E86AE, independent of the active theme.
const THROUGHPUT_COLOR = "\u001b[38;2;126;134;174m";
const RESET_FOREGROUND = "\u001b[39m";
const WINDOW_MS = 3000;
const UPDATE_INTERVAL_MS = 200;
const CHARS_PER_TOKEN = 4;
const MEASUREMENT_MIN_TOKENS = 2;

type DisplayMode = "widget" | "status";

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

type ThroughputState = StreamingState | FinalState;

export default function (pi: ExtensionAPI): void {
	let mode: DisplayMode = "widget";
	let enabled = true;
	let state: ThroughputState | undefined;
	let ui: ExtensionUIContext | undefined;
	let hasUI = false;
	let pendingProviderRequestTime: number | undefined;
	let customWidgets = false;
	let widgetOwner: object | undefined;
	let widgetContent = "";
	let requestWidgetRender: (() => void) | undefined;

	const fmtRate = (rate: number): string => (rate >= 100 ? rate.toFixed(0) : rate.toFixed(1));
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

	const widgetLine = (
		rate: number,
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
		return `TPS ${estimateMark}${fmtRate(rate)} tok/s. out ${estimateMark}${count(output)}, in ${count(usage.input)}, cache ${count(usage.cacheRead)}/${count(usage.cacheWrite)}, cache % ${percent(usage.cacheRead)}/${percent(usage.cacheWrite)}, total ${estimateMark}${count(total)}, ${elapsedSec.toFixed(1)}s`;
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

	const showLine = (line: string): void => {
		if (!ui) return;
		if (mode === "status") {
			// Same text as the widget; the host owns the status color and strips escapes.
			clearWidget();
			ui.setStatus(STATUS_KEY, line);
			return;
		}

		ui.setStatus(STATUS_KEY, undefined);
		widgetContent = `${THROUGHPUT_COLOR}${line}${RESET_FOREGROUND}`;
		if (!customWidgets) {
			// RPC supports string widgets, not terminal component factories.
			ui.setWidget(WIDGET_KEY, [widgetContent], { placement: "belowEditor" });
			return;
		}
		if (widgetOwner) {
			requestWidgetRender?.();
			return;
		}

		const owner = {};
		widgetOwner = owner;
		ui.setWidget(
			WIDGET_KEY,
			(tui) => {
				requestWidgetRender = () => {
					tui.requestRender();
				};
				return {
					render: (width) => [truncateToWidth(widgetContent, width)],
					invalidate() {
						// Stateless: render() always reads the live content.
					},
					dispose() {
						if (widgetOwner !== owner) return;
						widgetOwner = undefined;
						widgetContent = "";
						requestWidgetRender = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	};

	const render = (): void => {
		if (!state || !hasUI || !enabled) return;

		if (state.kind === "final") {
			showLine(widgetLine(state.averageRate, state.outputTokens, state.elapsedSec, state.usage));
			return;
		}

		const now = Date.now();
		const live = rollingRate(state, now);
		state.peakRate = Math.max(state.peakRate, live);
		const elapsedSec = state.measurementStartTime === undefined ? 0 : (now - state.measurementStartTime) / 1000;
		const outputTokens = liveOutputTokens(state);
		showLine(widgetLine(live, outputTokens, elapsedSec, state.usage, !state.usesReportedUsage));
	};

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		hasUI = ctx.hasUI;
		customWidgets = ctx.mode === "tui";
	});

	pi.on("session_shutdown", () => {
		clearUi();
		state = undefined;
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
			usage: { ...event.message.usage },
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
		stream.usage = { ...event.message.usage };
		stream.model = event.message.responseModel ?? event.message.model;
		const update = event.assistantMessageEvent;
		const now = Date.now();
		const isDelta =
			update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta";
		const chars = isDelta ? update.delta.length : 0;
		if (stream.firstOutputTime === undefined && isFirstOutputEvent(update)) stream.firstOutputTime = now;
		const providerOutput = event.message.usage.output;
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
		const outputTokens = event.message.usage.output;
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
		const averageRate = measuredTokens / Math.max(elapsedSec, 0.001);
		const peakRate = Math.max(stream.peakRate, rollingRate(stream, now), averageRate);
		state = {
			kind: "final",
			usage: { ...event.message.usage },
			outputTokens,
			elapsedSec,
			averageRate,
			peakRate,
			model: event.message.responseModel ?? event.message.model,
		};
		render();
	});

	pi.registerCommand("tps", {
		description: "Show TPS and token usage below the editor. Args: on|off|widget|status|reset",
		handler: (args, ctx) => {
			ui = ctx.ui;
			hasUI = ctx.hasUI;
			const arg = args.trim().toLowerCase();

			if (!arg || arg === "toggle") {
				enabled = !enabled;
				if (enabled) render();
				else clearUi();
				ctx.ui.notify(`Live throughput: ${enabled ? mode : "off"}`, "info");
				return Promise.resolve();
			}

			switch (arg) {
				case "on":
					enabled = true;
					render();
					ctx.ui.notify(`Live throughput: ${mode}`, "info");
					return Promise.resolve();
				case "off":
					enabled = false;
					clearUi();
					ctx.ui.notify("Live throughput: off", "info");
					return Promise.resolve();
				case "widget":
				case "status":
					if (mode !== arg) clearUi();
					mode = arg;
					enabled = true;
					render();
					ctx.ui.notify(`Live throughput: ${mode}`, "info");
					return Promise.resolve();
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
						ctx.ui.notify("Current throughput metrics reset", "info");
					} else if (state?.kind === "final") {
						state = undefined;
						clearUi();
						ctx.ui.notify("Final throughput summary cleared", "info");
					} else {
						ctx.ui.notify("No throughput metrics to reset", "info");
					}
					return Promise.resolve();
				default:
					ctx.ui.notify("Usage: /tps [on|off|widget|status|reset|toggle]", "error");
					return Promise.resolve();
			}
		},
	});
}
