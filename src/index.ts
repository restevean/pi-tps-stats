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
 * Final summaries also report conservatively available prompt/cache usage and
 * request-boundary-to-first-output timing.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "throughput";
const STATUS_KEY = "throughput";
const WINDOW_MS = 3000;
const UPDATE_INTERVAL_MS = 200;
const CHARS_PER_TOKEN = 4;
const MEASUREMENT_MIN_TOKENS = 2;

type DisplayMode = "widget" | "status";

interface Sample {
	t: number;
	tokens: number;
}

interface StreamingState {
	kind: "streaming";
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

interface PromptMetrics {
	inputTokens: number | undefined;
	cacheReadTokens: number | undefined;
	cacheWriteTokens: number | undefined;
	ttftMs: number | undefined;
	approximatePromptRate: number | undefined;
}

interface FinalState {
	kind: "final";
	outputTokens: number;
	elapsedSec: number;
	averageRate: number;
	peakRate: number;
	model: string;
	prompt: PromptMetrics;
}

type ThroughputState = StreamingState | FinalState;

export default function (pi: ExtensionAPI): void {
	let mode: DisplayMode = "widget";
	let enabled = true;
	let state: ThroughputState | undefined;
	let ui: ExtensionUIContext | undefined;
	let hasUI = false;
	let pendingProviderRequestTime: number | undefined;

	const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
	const fmtRate = (rate: number): string => (rate >= 100 ? rate.toFixed(0) : rate.toFixed(1));
	const fmtTtft = (ms: number): string => (ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(2)}s`);
	const estimatedTokens = (chars: number): number => chars / CHARS_PER_TOKEN;
	const positiveMetric = (value: number): number | undefined =>
		Number.isFinite(value) && value > 0 ? value : undefined;
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

	const promptMetrics = (
		stream: StreamingState,
		usage: { input: number; cacheRead: number; cacheWrite: number },
	): PromptMetrics => {
		const inputTokens = positiveMetric(usage.input);
		const cacheReadTokens = positiveMetric(usage.cacheRead);
		const cacheWriteTokens = positiveMetric(usage.cacheWrite);
		const ttftMs =
			stream.providerRequestTime !== undefined && stream.firstOutputTime !== undefined
				? Math.max(0, stream.firstOutputTime - stream.providerRequestTime)
				: undefined;
		const processedTokens = (inputTokens ?? 0) + (cacheWriteTokens ?? 0);
		const approximatePromptRate =
			processedTokens > 0 && ttftMs !== undefined && ttftMs > 0 ? processedTokens / (ttftMs / 1000) : undefined;
		return { inputTokens, cacheReadTokens, cacheWriteTokens, ttftMs, approximatePromptRate };
	};

	const promptSummary = (prompt: PromptMetrics): string => {
		const parts: string[] = [];
		if (prompt.inputTokens !== undefined) parts.push(`input ${fmt(prompt.inputTokens)} tok`);
		if (prompt.cacheReadTokens !== undefined) parts.push(`cache read ${fmt(prompt.cacheReadTokens)} tok`);
		if (prompt.cacheWriteTokens !== undefined) parts.push(`cache write ${fmt(prompt.cacheWriteTokens)} tok`);
		if (prompt.ttftMs !== undefined) parts.push(`TTFT ${fmtTtft(prompt.ttftMs)}`);
		if (prompt.approximatePromptRate !== undefined) {
			parts.push(`approx. prompt ${fmtRate(prompt.approximatePromptRate)} tok/s`);
		}
		return parts.join(" · ");
	};

	const clearUi = (): void => {
		ui?.setWidget(WIDGET_KEY, undefined);
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
		if (mode === "status") {
			ui?.setWidget(WIDGET_KEY, undefined);
			ui?.setStatus(STATUS_KEY, line);
		} else {
			ui?.setStatus(STATUS_KEY, undefined);
			ui?.setWidget(WIDGET_KEY, [line]);
		}
	};

	const render = (): void => {
		if (!state || !hasUI || !enabled) return;

		if (state.kind === "final") {
			const model = state.model ? ` · ${state.model}` : "";
			const prompt = promptSummary(state.prompt);
			const promptSuffix = prompt ? ` · ${prompt}` : "";
			const line =
				mode === "status"
					? `✓ ${fmt(state.outputTokens)} tok · ${fmtRate(state.averageRate)} tok/s${promptSuffix}`
					: `✓ ${fmt(state.outputTokens)} tok in ${state.elapsedSec.toFixed(1)}s · ${fmtRate(state.averageRate)} tok/s avg · peak ${fmtRate(state.peakRate)} tok/s${promptSuffix}${model}`;
			showLine(line);
			return;
		}

		const now = Date.now();
		const live = rollingRate(state, now);
		state.peakRate = Math.max(state.peakRate, live);
		const elapsedSec = state.measurementStartTime === undefined ? 0 : (now - state.measurementStartTime) / 1000;
		const outputTokens = liveOutputTokens(state);
		const averageRate = elapsedSec > 0 ? measuredOutputTokens(state, outputTokens) / elapsedSec : 0;
		const estimateLabel = state.usesReportedUsage ? "" : "est. ";
		const estimateMark = state.usesReportedUsage ? "" : "~";
		const model = state.model ? ` · ${state.model}` : "";
		const line =
			mode === "status"
				? `⚡ ${estimateLabel}${fmtRate(live)} tok/s · ${estimateMark}${fmt(outputTokens)} tok`
				: `⚡ ${estimateLabel}${fmtRate(live)} tok/s · avg ${fmtRate(averageRate)} tok/s · ${estimateMark}${fmt(outputTokens)} tok · ${elapsedSec.toFixed(1)}s${model}`;
		showLine(line);
	};

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		hasUI = ctx.hasUI;
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
			outputTokens,
			elapsedSec,
			averageRate,
			peakRate,
			model: event.message.responseModel ?? event.message.model,
			prompt: promptMetrics(stream, event.message.usage),
		};
		render();
	});

	pi.registerCommand("throughput", {
		description: "Show live tokens/sec. Args: on|off|widget|status|reset",
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
					mode = arg;
					enabled = true;
					clearUi();
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
						clearUi();
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
					ctx.ui.notify("Usage: /throughput [on|off|widget|status|reset|toggle]", "error");
					return Promise.resolve();
			}
		},
	});
}
