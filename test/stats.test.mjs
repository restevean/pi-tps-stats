import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { barChart, fitBars, formatRate, minimumPanelWidth, refRow, renderStatsPanel, summarize } from "../src/stats.ts";

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

test("derives the narrowest panel width that draws a given number of bars", () => {
	assert.equal(minimumPanelWidth(14), 54, "the first width that draws 14 bars");
	assert.equal(minimumPanelWidth(15), 57, "the first width that draws 15 bars");
});

test("the width that draws 15 bars is exactly one column past the width that draws only 14", () => {
	const many = Array.from({ length: 20 }, (_, index) => ({
		tps: 100 + index,
		tokens: 100,
		seconds: 1,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
	}));
	const scope = (width) => renderStatsPanel(many, width).find((line) => line.includes("bars:"));
	const fifteen = minimumPanelWidth(15);
	assert.ok(scope(fifteen - 1)?.includes("last 14 of 20"), scope(fifteen - 1));
	assert.ok(scope(fifteen)?.includes("last 15 of 20"), scope(fifteen));
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
	assert.equal(lines.length, 24, "frame + blank + scope + blank + two graphs of six rows + blank + cache write row");
	assert.equal(renderStatsPanel(samples, 80, undefined, 3).length, 18, "a short terminal can ask for three rows");
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

test("the full cache header fits at the narrowest panel width, even at 100%", () => {
	const full = [{ tps: 10, tokens: 10, seconds: 1, input: 0, cacheRead: 1000, cacheWrite: 0 }];
	for (const width of [minimumPanelWidth(15), 80]) {
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
	assert.equal(lines[1], blank, "one blank row under the title");
	assert.ok(lines[2].includes("Stats and bars: whole session"), "the scope line follows the blank row");
	assert.equal(lines[3], blank, "one blank row below the scope line");
	assert.ok(lines[4].includes("TPS (tok/s)  avg 40.0  ┄ max 100  ┄ min 25.0"), lines[4]);
});

const many = (count) =>
	Array.from({ length: count }, (_, i) => ({
		tps: 10 + (i % 5),
		tokens: 10,
		seconds: 1,
		input: 100,
		cacheRead: 100,
		cacheWrite: 0,
	}));

// Number of two-column bars drawn on the baseline of the first graph.
const drawnBars = (lines) => {
	const baseline = lines.find((line) => line.includes("   0 │"));
	const bars = baseline.split("   0 │")[1].replace(/ │$/, "").trimEnd();
	return (bars.length + 1) / 3;
};

test("says the bars are the last n responses while the numbers are the whole session", () => {
	const lines = renderStatsPanel(many(200), 60);
	const scope = lines.find((line) => line.includes("Stats: whole session"));
	assert.ok(scope, "a scope line exists");
	assert.ok(scope.includes("Stats: whole session · bars: last 16 of 200"), scope);
	assert.ok(lines[0].includes("200 responses"), "the title still counts the whole session");
	assert.equal(drawnBars(lines), 16, "the number in the text is the number of bars actually drawn");
});

test("the scope line follows the width: more room, more bars, and the text says so", () => {
	for (const width of [56, 80, 120]) {
		const lines = renderStatsPanel(many(500), width);
		const match = lines.join("\n").match(/bars: last (\d+) of 500/);
		assert.ok(match, `${width}: scope line present`);
		assert.equal(Number(match[1]), drawnBars(lines), `${width}: text and drawing agree`);
		for (const line of lines) assert.equal(visibleWidth(line), width, `${width}: ${line}`);
	}
});

test("when every response fits, the scope line says the stats and the bars cover the whole session", () => {
	const text = renderStatsPanel(many(5), 80).join("\n");
	assert.ok(text.includes("Stats and bars: whole session"), text);
	assert.ok(!text.includes("bars: last"), "no 'last n' when nothing is cut");
	const exact = renderStatsPanel(many(16), 60).join("\n");
	assert.ok(exact.includes("Stats and bars: whole session"), "16 bars fit exactly at 60 columns");
	assert.ok(renderStatsPanel(many(17), 60).join("\n").includes("bars: last 16 of 17"), "one more is cut");
});

test("the min, max and avg stay computed over the whole session, not over the drawn bars", () => {
	const old = { tps: 500, tokens: 500, seconds: 1, input: 0, cacheRead: 0, cacheWrite: 0 };
	const lines = renderStatsPanel([old, ...many(200)], 60);
	assert.ok(lines.join("\n").includes("┄ max 500"), "the first response, no longer drawn, still sets the max");
	assert.ok(lines.join("\n").includes("bars: last 16 of 201"));
});

const mk = (tps) => ({ tps, tokens: tps, seconds: 1, input: 100, cacheRead: 100, cacheWrite: 0 });

// What follows the axis in a framed row: "│ label │bars │".
const barsOf = (row) => row.split("│")[2];

// The six bar rows that follow a graph header.
const graphRows = (lines, heading, height = 6) => {
	const start = lines.findIndex((line) => line.includes(heading));
	return lines.slice(start + 1, start + 1 + height);
};

// The axis is the first border after the frame's own.
const axisColumn = (row) => visibleWidth(row.slice(0, row.indexOf("│", 1)));
const tpsSample = (tps) => ({ tps, tokens: 100, seconds: 1, input: 0, cacheRead: 0, cacheWrite: 0 });

test("the value axis is one straight line whatever the width of the top label", () => {
	for (const max of [9, 99.9, 99.96, 999, 9999, 13550, 123456]) {
		const lines = renderStatsPanel([10, max, 20, 30].map(tpsSample), 80);
		const columns = [...graphRows(lines, "TPS (tok/s)"), ...graphRows(lines, "cache read %")].map(axisColumn);
		const expected = 3 + Math.max(4, formatRate(max).length);
		assert.deepEqual(columns, Array(12).fill(expected), `max ${String(max)}: both graphs share one gutter`);
	}
});

test("a top label that fits the usual gutter leaves the layout as it was", () => {
	const lines = renderStatsPanel([10, 9999, 20, 30].map(tpsSample), 80);
	assert.equal(axisColumn(graphRows(lines, "TPS (tok/s)")[0]), 7);
	assert.equal(axisColumn(graphRows(lines, "TPS (tok/s)")[5]), 7);
});

test("a wider top label takes its column from the bars, one fewer at the narrowest panel", () => {
	const many = (last) => Array.from({ length: 20 }, (_, index) => tpsSample(index === 19 ? last : 100 + index));
	const scope = (last) => renderStatsPanel(many(last), minimumPanelWidth(15)).find((line) => line.includes("bars:"));
	assert.ok(scope(9999)?.includes("last 15 of 20"), scope(9999));
	assert.ok(scope(13550)?.includes("last 14 of 20"), scope(13550));
});

test("one blank row separates the scope line from the first graph header", () => {
	for (const list of [many(5), many(200)]) {
		const lines = renderStatsPanel(list, 60);
		const scope = lines.findIndex((line) => line.includes("whole session"));
		assert.equal(lines[scope + 1], `│${" ".repeat(58)}│`, "the row below the scope line is blank");
		assert.ok(lines[scope + 2].includes("TPS (tok/s)"), "and the graph header comes right after");
	}
});

test("the TPS graph is scaled to the bars that are drawn, not to the whole session", () => {
	// One very fast response, then nineteen slow ones: at 56 columns only the last 14 are drawn.
	const lines = renderStatsPanel([mk(200), ...Array.from({ length: 19 }, () => mk(20))], 56);
	const text = lines.join("\n");
	assert.ok(text.includes("bars: last 14 of 20"), text);
	assert.ok(text.includes("avg 29.0  ┄ max 200  ┄ min 20.0"), "the header still reports the whole session");
	const rows = graphRows(lines, "TPS (tok/s)");
	assert.ok(rows[0].includes(" 20.0 │"), "the axis top is the tallest visible bar");
	assert.ok(rows[5].includes("   0 │"));
	assert.ok(!rows.some((row) => row.includes("200")), "the old record no longer sets the axis");
	assert.ok(barsOf(rows[0]).includes("██"), "the visible bars reach the top row");
	assert.ok(
		rows.every((row) => barsOf(row).startsWith("██")),
		"and fill every row",
	);
});

test("a reference line that falls outside the visible scale is not drawn", () => {
	const lines = renderStatsPanel([mk(200), ...Array.from({ length: 19 }, () => mk(20))], 56);
	const rows = graphRows(lines, "TPS (tok/s)");
	assert.ok(rows[0].includes("██┄██"), "the min line (20 = the visible top) runs through the top row");
	assert.ok(
		rows.slice(1).every((row) => !row.includes("┄")),
		"no max line: 200 is outside the 0..20 scale",
	);
});

test("when every response is drawn the scale is the session max, as before", () => {
	const rows = graphRows(renderStatsPanel([mk(100), mk(25)], 80), "TPS (tok/s)");
	assert.ok(rows[0].includes(" 100 │"));
	assert.ok(rows[0].includes("██┄┄┄"), "the max line sits at the top, on the tallest bar");
});

test("the cache read graph keeps its fixed 0 to 100 axis even when bars are cut", () => {
	const lines = renderStatsPanel(many(40), 56);
	assert.ok(lines.join("\n").includes("bars: last 14 of 40"));
	const rows = graphRows(lines, "cache read %");
	assert.ok(rows[0].includes(" 100 │"), "a percentage axis does not rescale");
	// 100 / (100 + 100) = 50%: the bars fill the lower half only.
	assert.ok(!rows[2].includes("█"));
	assert.ok(rows[3].includes("█"));
});

test("scaling to the visible bars survives an all-zero visible window", () => {
	const lines = renderStatsPanel([mk(50), ...Array.from({ length: 19 }, () => mk(0))], 56);
	for (const line of lines) assert.equal(visibleWidth(line), 56, line);
	const rows = graphRows(lines, "TPS (tok/s)");
	assert.ok(rows[0].includes(" 0.0 │"), "no division by zero: the axis top is 0.0");
	assert.ok(barsOf(rows[5]).includes("▁"), "zero bars keep the smallest block");
});

test("a panel too narrow for a single bar draws no bars at all, instead of drawing them all", () => {
	const bars = /[▁▂▃▄▅▆▇█]/;
	// Usable bar area = width - 13; one 2-column bar needs 2, so 15 columns is the first that fits one.
	for (let width = 1; width < 15; width++) {
		const text = renderStatsPanel(many(5), width).join("\n");
		assert.ok(!bars.test(text), `width ${width} drew bars: ${text}`);
	}
	const one = renderStatsPanel(many(5), 15).join("\n");
	assert.ok(bars.test(one), "at 15 columns one bar fits and is drawn");
});

test("the visible TPS scale is also empty when no bar fits, not the session maximum", () => {
	const lines = renderStatsPanel([mk(500), ...Array.from({ length: 4 }, () => mk(10))], 12);
	const axisTop = lines.find((line) => /\b0\.0\b/.test(line) && line.includes("│"));
	assert.ok(axisTop, `with nothing drawn the axis top is 0.0: ${lines.join("\n")}`);
	assert.ok(!lines.some((line) => /\b500\b/.test(line.split("│")[0] ?? "")), "the axis never shows the old record");
});
