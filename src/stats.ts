/**
 * Session statistics for the `/tps stats` panel: per-response TPS and cache
 * percentages, their min/max/average, and one-line bar graphs.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface ResponseSample {
	/** Average output tokens per second of one completed response. */
	tps: number;
	/** Output tokens and generation seconds behind {@link tps}. */
	tokens: number;
	seconds: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Range {
	min: number;
	max: number;
	avg: number;
}

export interface Summary {
	count: number;
	tps: Range;
	cacheRead: Range;
	cacheWrite: Range;
}

const BLOCKS = "▁▂▃▄▅▆▇█";
// The longest label, "cache write" / "cache read %"; graphs are sized from it.
const LABEL_WIDTH = 12;

export const formatRate = (rate: number): string => (rate >= 100 ? rate.toFixed(0) : rate.toFixed(1));

const promptTokens = (sample: ResponseSample): number => sample.input + sample.cacheRead + sample.cacheWrite;
const percentOf = (part: number, sample: ResponseSample): number => {
	const total = promptTokens(sample);
	return total > 0 ? (part / total) * 100 : 0;
};

const rangeOf = (values: readonly number[], avg: number): Range => {
	let min = Infinity;
	let max = -Infinity;
	for (const value of values) {
		if (value < min) min = value;
		if (value > max) max = value;
	}
	return { min, max, avg };
};

/**
 * Min and max are per response. Averages are weighted: TPS is total output over
 * total generation time and cache is total cache tokens over total prompt
 * tokens, so a long response counts more than a short one.
 */
export function summarize(samples: readonly ResponseSample[]): Summary | undefined {
	if (samples.length === 0) return undefined;
	let tokens = 0;
	let seconds = 0;
	let prompt = 0;
	let read = 0;
	let write = 0;
	for (const sample of samples) {
		tokens += sample.tokens;
		seconds += sample.seconds;
		prompt += promptTokens(sample);
		read += sample.cacheRead;
		write += sample.cacheWrite;
	}
	return {
		count: samples.length,
		tps: rangeOf(
			samples.map((sample) => sample.tps),
			seconds > 0 ? tokens / seconds : 0,
		),
		cacheRead: rangeOf(
			samples.map((sample) => percentOf(sample.cacheRead, sample)),
			prompt > 0 ? (read / prompt) * 100 : 0,
		),
		cacheWrite: rangeOf(
			samples.map((sample) => percentOf(sample.cacheWrite, sample)),
			prompt > 0 ? (write / prompt) * 100 : 0,
		),
	};
}

export interface PanelStyle {
	frame(text: string): string;
	title(text: string): string;
	text(text: string): string;
	key(text: string): string;
	keyText(text: string): string;
}

const identity = (text: string): string => text;
export const plainStyle: PanelStyle = {
	frame: identity,
	title: identity,
	text: identity,
	key: identity,
	keyText: identity,
};

const BAR_WIDTH = 2;
// One blank column between bars: the smallest gap that keeps equal neighbours apart.
const BAR_GAP = 1;
const GRAPH_HEIGHT = 6;
const REF_CHAR = "┄";
const AXIS_WIDTH = 6;
// Reference lines stop four columns before the border: this plus the one padding column.
const RIGHT_MARGIN = 3;
const MIN_FRAMED_WIDTH = 20;

/** Bars are `BAR_WIDTH` columns wide with `BAR_GAP` between them; only the newest that fit are drawn. */
export function fitBars(count: number, width: number): { barWidth: number; shown: number } {
	const room = Math.max(0, Math.floor(width));
	const fits = Math.floor((room + BAR_GAP) / (BAR_WIDTH + BAR_GAP));
	return { barWidth: BAR_WIDTH, shown: Math.min(count, fits) };
}

/**
 * Vertical bars, one per value, scaled from 0 to `max`, oldest on the left. Rows run top to
 * bottom; every nonzero value, and every zero, keeps at least the smallest bar visible.
 */
export function barChart(values: readonly number[], max: number, barWidth: number, height: number): string[] {
	const gap = barWidth >= 2 ? " " : "";
	const rows: string[] = [];
	for (let row = height - 1; row >= 0; row--) {
		const cells = values.map((value) => {
			const level = max > 0 ? Math.min(1, Math.max(0, value / max)) * height : 0;
			const partial = level - row;
			let block = " ";
			if (partial >= 1) block = BLOCKS[BLOCKS.length - 1] ?? " ";
			else if (partial > 0 || row === 0) {
				const index = Math.max(0, Math.round(partial * BLOCKS.length) - 1);
				block = BLOCKS[Math.min(BLOCKS.length - 1, index)] ?? " ";
			}
			return block.repeat(barWidth);
		});
		rows.push(cells.join(gap).trimEnd());
	}
	return rows;
}

/** Row, counted from the top, where a bar of `value` on a 0..`scale` axis reaches its top. */
export function refRow(value: number, scale: number, height: number): number {
	const level = scale > 0 ? Math.min(1, Math.max(0, value / scale)) * height : 0;
	return Math.min(height - 1, Math.max(0, height - Math.ceil(level)));
}

const percent = (value: number): string => `${value.toFixed(1)}%`;

const fit = (text: string, width: number): string => {
	const clipped = truncateToWidth(text, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};

/**
 * The framed panel, like the Claude usage panel: a rounded frame with a title on the top
 * edge, a key hint and one-row-per-statistic summary above two tall bar graphs. Every line
 * is exactly `width` columns wide (or at most `width` when it is too narrow to frame).
 */
export function renderStatsPanel(
	samples: readonly ResponseSample[],
	width: number,
	style: PanelStyle = plainStyle,
	graphHeight = GRAPH_HEIGHT,
): string[] {
	const summary = summarize(samples);
	if (!summary) return [];
	const clip = (line: string): string => truncateToWidth(line, Math.max(0, width), "");
	const inner = width - 2;
	const content = inner - 2;
	const title = `✿ TPS stats · ${String(summary.count)} ${summary.count === 1 ? "response" : "responses"}`;

	// TPS and cache read have a graph, so their numbers live in that graph's header; cache
	// write has none, so it keeps a row of its own below the cache read graph.
	// Same order as the graph headers: average, then maximum, then minimum.
	const cw = summary.cacheWrite;
	const cacheWriteLine = `${"cache write".padEnd(LABEL_WIDTH)}  avg ${percent(cw.avg)}  max ${percent(cw.max)}  min ${percent(cw.min)}`;

	// Both graphs share one width, so one count: the text below and the bars always agree.
	const area = Math.max(0, content - AXIS_WIDTH - RIGHT_MARGIN);
	const { barWidth, shown } = fitBars(samples.length, area);
	// The numbers cover the whole session; the bars only the newest responses that fit.
	const scope =
		shown < samples.length
			? `Stats: whole session · bars: last ${String(shown)} of ${String(samples.length)}`
			: "Stats and bars: whole session";

	const graph = (
		heading: string,
		values: readonly number[],
		scale: number,
		top: string,
		range: Range,
		format: (value: number) => string,
	): string[] => {
		const rows = barChart(values.slice(-shown), scale, barWidth, graphHeight);
		// The reference lines sit at the rows where the session's highest and lowest value reach.
		// A value above the axis (an old response that is no longer drawn) has no row, so no line.
		const refs = new Set(
			[range.max, range.min].filter((value) => value <= scale).map((value) => refRow(value, scale, graphHeight)),
		);
		const last = rows.length - 1;
		return [
			`${heading}  avg ${format(range.avg)}  ${REF_CHAR} max ${format(range.max)}  ${REF_CHAR} min ${format(range.min)}`,
			...rows.map((bars, index) => {
				const body = refs.has(index) ? bars.padEnd(area).replaceAll(" ", REF_CHAR) : bars;
				const label = index === 0 ? top : index === last ? "0" : "";
				return `${label.padStart(AXIS_WIDTH - 2)} │${body}`;
			}),
		];
	};
	// The TPS axis follows the bars that are drawn, so they use the full height. The cache
	// graph is a percentage, so its 0..100 axis stays fixed.
	const visibleTpsMax = Math.max(0, ...samples.slice(-shown).map((sample) => sample.tps));
	const bodyLines = [
		"",
		scope,
		"",
		...graph(
			"TPS (tok/s)",
			samples.map((sample) => sample.tps),
			visibleTpsMax,
			formatRate(visibleTpsMax),
			summary.tps,
			formatRate,
		),
		"",
		...graph(
			"cache read %",
			samples.map((sample) => percentOf(sample.cacheRead, sample)),
			100,
			"100",
			summary.cacheRead,
			percent,
		),
		"",
		cacheWriteLine,
		"",
	];

	if (width < MIN_FRAMED_WIDTH) return [title, ...bodyLines.filter(Boolean)].map(clip);
	const edge = (text: string): string => `${style.frame("│")} ${text} ${style.frame("│")}`;
	const rule = (length: number): string => "─".repeat(Math.max(0, length));
	// "╭─ " + title + " " + rule + "╮" must add up to exactly `width`.
	const shownTitle = truncateToWidth(title, Math.max(0, inner - 3), "");
	const titleRoom = Math.max(0, inner - 3 - visibleWidth(shownTitle));
	const top = `${style.frame("╭─ ")}${style.title(shownTitle)}${style.frame(` ${rule(titleRoom)}╮`)}`;
	const keys = `${style.key("esc")} ${style.keyText("close")}`;
	return [
		top,
		...bodyLines.map((line) => edge(style.text(fit(line, content)))),
		edge(fit(keys, content)),
		style.frame(`╰${rule(inner)}╯`),
	];
}
