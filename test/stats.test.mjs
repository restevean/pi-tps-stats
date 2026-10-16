import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { barChart, fitBars, refRow, renderStatsPanel, summarize } from "../src/stats.ts";

// 100 tok in 1 s (80% cache read, 10% write) and 100 tok in 4 s (50% read, 0% write).
const samples = [
	{ tps: 100, tokens: 100, seconds: 1, input: 100, cacheRead: 800, cacheWrite: 100 },
	{ tps: 25, tokens: 100, seconds: 4, input: 500, cacheRead: 500, cacheWrite: 0 },
];

test("summarizes min, max and weighted averages", () => {
	const s = summarize(samples);
	assert.equal(s.count, 2);
	assert.deepEqual(s.tps, { min: 25, max: 100, avg: 40 }, "200 tokens over 5 s, not the mean 62.5");
	assert.deepEqual(s.cacheRead, { min: 50, max: 80, avg: 65 }, "1300 of 2000 prompt tokens");
	assert.deepEqual(s.cacheWrite, { min: 0, max: 10, avg: 5 }, "100 of 2000 prompt tokens");
});

test("has no summary without samples and reports 0% when there are no prompt tokens", () => {
	assert.equal(summarize([]), undefined);
	const s = summarize([{ tps: 10, tokens: 10, seconds: 1, input: 0, cacheRead: 0, cacheWrite: 0 }]);
	assert.deepEqual(s.cacheRead, { min: 0, max: 0, avg: 0 });
});

test("every bar is two columns wide with one column between bars; only the newest fit", () => {
	assert.deepEqual(fitBars(2, 40), { barWidth: 2, shown: 2 }, "a few responses do not stretch");
	assert.deepEqual(fitBars(10, 40), { barWidth: 2, shown: 10 }, "10 bars and 9 gaps take 29 columns");
	assert.deepEqual(fitBars(14, 40), { barWidth: 2, shown: 13 }, "13 bars and 12 gaps take 38; 14 would need 41");
	assert.deepEqual(fitBars(70, 40), { barWidth: 2, shown: 13 });
	assert.deepEqual(fitBars(5, 0), { barWidth: 2, shown: 0 });
	assert.deepEqual(fitBars(5, 1), { barWidth: 2, shown: 0 }, "a bar that does not fit whole is not drawn");
	assert.deepEqual(fitBars(5, 2), { barWidth: 2, shown: 1 });
	assert.deepEqual(fitBars(0, 40), { barWidth: 2, shown: 0 });
});

test("draws multi-row bars scaled to the maximum, oldest first, with a gap between bars", () => {
	// Two rows tall: 100 fills both rows, 50 fills the bottom one, 25 is half of the bottom one.
	assert.deepEqual(barChart([100, 50], 100, 2, 2), ["██", "██ ██"]);
	assert.deepEqual(barChart([25], 100, 2, 2), ["", "▄▄"]);
	assert.deepEqual(barChart([0, 100], 100, 1, 1), ["▁█"], "a zero stays visible as the smallest bar");
	assert.deepEqual(barChart([5, 5], 0, 1, 1), ["▁▁"], "a zero scale never divides by zero");
	assert.deepEqual(barChart([], 100, 2, 3), ["", "", ""]);
});

test("frames the panel like the Claude usage panel, with a title and a key hint", () => {
	const lines = renderStatsPanel(samples, 80);
	assert.ok(lines[0].startsWith("╭─ ✿ TPS stats · 2 responses "), lines[0]);
	assert.ok(lines[0].endsWith("╮"));
	assert.ok(lines.at(-1).startsWith("╰") && lines.at(-1).endsWith("╯"));
	const hint = lines.at(-2);
	assert.ok(hint.startsWith("│") && hint.endsWith("│") && hint.includes("esc close"), hint);
	for (const line of lines.slice(1, -1)) assert.ok(line.startsWith("│") && line.endsWith("│"), line);
});

test("renders every statistic and both graphs with their axes", () => {
	const text = renderStatsPanel(samples, 80).join("\n");
	for (const expected of [
		"avg 40.0  ┄ max 100  ┄ min 25.0",
		"avg 65.0%",
		"max 80.0%",
		"min 50.0%",
		"cache write   avg 5.0%  max 10.0%  min 0.0%",
		"TPS (tok/s)",
		"cache read %",
		" 100 │",
		"   0 │",
	]) {
		assert.ok(text.includes(expected), `missing ${expected}`);
	}
});

test("the graphs use two-column bars, one blank column apart, and six rows", () => {
	const five = Array.from({ length: 5 }, () => ({
		tps: 10,
		tokens: 10,
		seconds: 1,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
	}));
	const lines = renderStatsPanel(five, 80);
	const baseline = lines.find((line) => line.includes("   0 │"));
	const bars = baseline.split("   0 │")[1].replace(/ │$/, "").trimEnd();
	assert.equal(bars, "██ ██ ██ ██ ██", "five responses: five 2-column bars separated by one column");
	assert.equal(lines.length, 23, "frame + two blank + two graphs of six rows + blank + cache write row");
	assert.equal(renderStatsPanel(samples, 80, undefined, 3).length, 17, "a short terminal can ask for three rows");
});

test("finds the row of a reference value, counting from the top", () => {
	assert.equal(refRow(100, 100, 3), 0, "the top of the scale is the first row");
	assert.equal(refRow(25, 100, 3), 2);
	assert.equal(refRow(50, 100, 3), 1);
	assert.equal(refRow(0, 100, 3), 2, "zero sits on the bottom row");
	assert.equal(refRow(5, 0, 3), 2, "a zero scale never divides by zero");
	assert.equal(refRow(500, 100, 3), 0, "values above the scale stay on the top row");
});

test("marks the max and min of each graph with dotted reference lines and a legend", () => {
	const lines = renderStatsPanel(samples, 80);
	const text = lines.join("\n");
	assert.ok(text.includes("TPS (tok/s)  avg 40.0  ┄ max 100  ┄ min 25.0"), "TPS header");
	assert.ok(text.includes("cache read %  avg 65.0%  ┄ max 80.0%  ┄ min 50.0%"), "cache header");
	// TPS: 100 on a 0..100 scale reaches the top row, 25 the bottom one.
	const tpsTop = lines.find((line) => line.includes(" 100 │"));
	assert.ok(tpsTop.includes(" 100 │██┄┄┄"), tpsTop);
	assert.ok(/┄{20}/.test(tpsTop), "the line runs on across the free width");
	// 25 on a 0..100 scale over six rows reaches a quarter of the way: the min line sits on the
	// fifth row from the top, where the second bar's half-block top is.
	const tpsMin = lines.find((line) => line.includes("│██┄▄▄┄┄┄"));
	assert.ok(tpsMin, "the second bar is two columns wide, one column after the first");
	// Cache read: 80% and 50% on a 0..100 scale sit on the first and second rows.
	assert.equal(lines.filter((line) => line.includes("┄┄┄┄┄┄┄┄┄┄")).length, 4, "two reference lines per graph");
});

test("draws a single reference line when the max and the min share a row", () => {
	const one = [{ tps: 40, tokens: 40, seconds: 1, input: 100, cacheRead: 0, cacheWrite: 0 }];
	const lines = renderStatsPanel(one, 80);
	assert.ok(lines.join("\n").includes("TPS (tok/s)  avg 40.0  ┄ max 40.0  ┄ min 40.0"));
	assert.equal(lines.filter((line) => /┄{10}/.test(line)).length, 2, "one line per graph");
});

test("every line is exactly as wide as the panel, and never wider on tiny widths", () => {
	for (const width of [20, 40, 80, 200]) {
		for (const line of renderStatsPanel(samples, width)) assert.equal(visibleWidth(line), width, line);
	}
	for (const width of [1, 5, 10, 19]) {
		for (const line of renderStatsPanel(samples, width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
	}
});

test("applies the style to the frame, the title, the body and the keys", () => {
	const paint = (code) => (text) => `\u001b[${code}m${text}\u001b[39m`;
	const style = { frame: paint(31), title: paint(32), text: paint(33), key: paint(34), keyText: paint(35) };
	const lines = renderStatsPanel(samples, 80, style);
	assert.ok(lines[0].includes("\u001b[31m╭─ ") && lines[0].includes("\u001b[32m✿ TPS stats · 2 responses"));
	assert.ok(
		lines.some((line) => line.includes("\u001b[33m") && line.includes("min 25.0")),
		"the graph header is body text",
	);
	assert.ok(lines.some((line) => line.includes("\u001b[34mesc") && line.includes("\u001b[35mclose")));
	for (const line of lines) assert.equal(visibleWidth(line), 80, "style codes never count as width");
});

test("keeps the newest bars of both graphs when there are more responses than columns", () => {
	const many = Array.from({ length: 200 }, (_, i) => ({
		tps: 10,
		tokens: 10,
		seconds: 1,
		input: 1,
		cacheRead: i < 199 ? 0 : 1,
		cacheWrite: 0,
	}));
	const lines = renderStatsPanel(many, 60);
	assert.ok(lines[0].includes("200 responses"));
	for (const line of lines) assert.equal(visibleWidth(line), 60, line);
	const bars = (line) => line.slice(line.indexOf("│ ") + 2, line.lastIndexOf(" │")).trimEnd();
	const bottoms = lines.filter((line) => line.includes("   0 │")).map(bars);
	assert.equal(bottoms.length, 2, "one baseline per graph");
	assert.ok(bottoms[0].endsWith("█"), "TPS graph keeps its newest bar");
	assert.ok(bottoms[1].endsWith("█"), "the newest response (50% cache read) is still drawn");
	assert.ok(bottoms[1].includes("▁"), "older responses without cache keep the smallest bar");
	assert.ok(!lines.join("\n").includes("..."), "nothing is truncated with an ellipsis");
});

test("the cache read statistics live in its graph header, not in a summary row", () => {
	const lines = renderStatsPanel(samples, 80);
	assert.ok(!lines.some((line) => /cache read\s+min/.test(line)), "no separate cache read row");
	assert.ok(lines.some((line) => line.includes("cache read %  avg 65.0%  ┄ max 80.0%  ┄ min 50.0%")));
	const header = lines.find((line) => line.includes("cache read %"));
	assert.ok(header.indexOf("avg") < header.indexOf("max"), "avg comes before max");
	assert.ok(header.indexOf("max") < header.indexOf("min"), "max comes before min");
});

test("keeps the cache write line below the cache read graph, after one blank row", () => {
	const lines = renderStatsPanel(samples, 80);
	const baselines = lines.map((line, index) => (line.includes("   0 │") ? index : -1)).filter((i) => i >= 0);
	assert.equal(baselines.length, 2);
	assert.equal(
		lines[baselines[1] + 1],
		`│${" ".repeat(78)}│`,
		"one blank row separates the graph from the cache write line",
	);
	assert.ok(lines[baselines[1] + 2].includes("cache write   avg 5.0%  max 10.0%  min 0.0%"), lines[baselines[1] + 2]);
	assert.equal(lines.filter((line) => line.includes("cache write")).length, 1);
});

test("the full cache header fits at the narrowest overlay width, even at 100%", () => {
	const full = [{ tps: 10, tokens: 10, seconds: 1, input: 0, cacheRead: 1000, cacheWrite: 0 }];
	for (const width of [56, 80]) {
		const text = renderStatsPanel(full, width).join("\n");
		assert.ok(text.includes("cache read %  avg 100.0%  ┄ max 100.0%  ┄ min 100.0%"), `${width}: header truncated`);
	}
});

test("the TPS graph header carries its average before the max and min, like the cache one", () => {
	const header = renderStatsPanel(samples, 80).find((line) => line.includes("TPS (tok/s)"));
	assert.ok(header.includes("TPS (tok/s)  avg 40.0  ┄ max 100  ┄ min 25.0"), header);
	assert.ok(header.indexOf("avg") < header.indexOf("max") && header.indexOf("max") < header.indexOf("min"));
});

test("the reference lines stop exactly four spaces before the panel border", () => {
	for (const width of [56, 80, 120]) {
		const lines = renderStatsPanel(samples, width);
		const refLines = lines.filter((line) => /┄{10}/.test(line));
		assert.equal(refLines.length, 4, `${width}: two reference lines per graph`);
		for (const line of refLines) {
			assert.ok(line.endsWith("┄    │"), `${width}: ${line}`);
			assert.ok(!line.endsWith("┄     │"), `${width}: more than four spaces: ${line}`);
		}
		for (const line of lines) assert.equal(visibleWidth(line), width, line);
	}
});

test("there is no TPS summary row: the panel opens with the TPS graph header", () => {
	const lines = renderStatsPanel(samples, 80);
	assert.ok(!lines.some((line) => /^│ TPS\s+min/.test(line)), "no 'TPS  min .. max .. avg .. tok/s' row");
	assert.ok(!lines.join("\n").includes("tok/s  "), "no row with the tok/s unit");
	const blank = `│${" ".repeat(78)}│`;
	assert.equal(lines[1], blank, "a blank row under the title");
	assert.equal(lines[2], blank, "and a second one");
	assert.ok(lines[3].includes("TPS (tok/s)  avg 40.0  ┄ max 100  ┄ min 25.0"), lines[3]);
});
