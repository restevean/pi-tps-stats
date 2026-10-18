# pi-tps-stats

> **Based on a fork of
> [pi-live-throughput](https://github.com/apetersson/pi-live-throughput)** by
> Andreas Petersson (MIT), forked from version 0.3.0
> (`dcedab3 chore(release): 0.3.0`). This project is independent and is not
> affiliated with or endorsed by the original author.

A single-line live tokens/sec display above the prompt editor for the
[Pi coding agent](https://pi.dev).

Requires pi 1.x. The widget uses a dedicated `#7E86AE` foreground color without
changing the active theme or the rest of the UI.

In terminal mode, the widget is registered once per visible lifetime. Streaming
updates, subsequent responses, and active measurement resets repaint that same
component instead of registering it again. Long lines are truncated to the
terminal width, keeping the TPS text on one row, followed by one blank row. Switching to status mode, hiding
the display, or ending the session removes only this extension's widget.

This prevents TPS updates from moving the widget relative to other
widgets. The widget uses the above-editor area and is mounted, empty, when the
session starts, because Pi lays widgets out in registration order. That keeps it
ahead of widgets another extension registers or republishes later, such as a
status banner. Other extensions still control
their own widgets, and this extension never modifies them or the host. RPC mode
keeps the existing string-array widget path because custom terminal components
are not supported there.

While an assistant response streams, the widget shows these fields in order:
**TPS → session average → output → input → cache read/write → cache read/write % → total → duration**. When streaming
finishes, the final summary remains visible until the next response starts:

```text
TPS 11.4 tok/s, avg 11.4 tok/s, out 33, in 2, cache 0/85,571, cache % 0.0%/100.0%, total 85,606, 2.9s
```

Counts use full integers with English thousands separators. `total` is the sum
of output, input, cache-read, and cache-write tokens for the current response,
not the session. Both modes always show all fields; a zero input/cache field
reflects Pi's normalized usage and does not prove the provider reported a zero.

`cache %` immediately follows the cache counts. Each percentage uses
`input + cacheRead + cacheWrite` as its denominator, excluding output, and is
rounded to one decimal place. For example, input 100, cache read 800, and cache
write 100 produces `80.0%/10.0%`. With no prompt tokens it shows `0.0%/0.0%`.

`avg` is the session average: all output tokens divided by all generation time
since the extension started in this session, including the response in progress.
It is weighted by time, so one long slow response counts more than a short fast
one; it is not the mean of the per-response averages. A resumed session starts
from zero because earlier responses are not replayed. `/tps reset` clears only
the displayed summary or the current measurement, never the session average, and
a new session or `/reload` starts it over.

Live TPS is the rolling rate; final TPS is the average over the measured
generation window. Live figures use Pi's cumulative provider-reported
`usage.output` when it advances. Otherwise text, thinking, and tool-call deltas
provide estimates, identified by `~` before TPS, output, and total. Final counts
always use provider-reported usage. Input/cache fields update when Pi exposes
them, which may be only at completion.

`/tps status` publishes exactly the same line through Pi's status API
instead of a widget. The host decides where a status appears: Gentle Shell shows
it in the side panel under Status → Integrations, not below the input, and
applies its own status color, so `#7E86AE` only applies to the widget.

## Measurement window

Live and final TPS rates start measuring only after a second output
token has been observed. Keeping time-to-first-token out of the measurement
window means the rolling and final average rates describe decoding speed
rather than prompt processing, provider queueing, or network latency. Only
tokens observed after measurement starts contribute to a rate; the token
counters still report the response's cumulative output.

When a response ends before a second output token arrives, or when the measured
window captures less than one full output token, the final summary falls back to
whole-response timing instead of reporting a misleading near-zero rate. Because
provider usage is cumulative, switching from the heuristic estimate to
provider-reported usage adopts the provider's count for the response so far,
which can include the few tokens observed just before the window opened.

The duration at the end of the line is the measured generation window, not
necessarily the whole response time.

## Session statistics

You can also open the panel by **clicking the TPS line** (a left click on the data
row, not on the blank row under it). The click is a widget capability: it is a mouse
event on the widget row, so in status mode, or while the display is off, there is no
row to click. It needs the terminal UI in fullscreen mode, Pi's default, because
regular mode leaves the mouse to the terminal and sends no clicks to extensions;
`/tps stats` always works. There is nothing to click while the line is not drawn:
before the first response starts, and after `/tps reset` has cleared a final summary.
While the line is drawn, a click opens the panel, or reports that there is no data
when no response has been recorded in the statistics yet (aborted, failed and empty
responses are not recorded). With the panel open, a click on the line closes it. The
panel is drawn over the screen, so the click has to land on the part of the line that
the panel does not cover; a click on the panel itself does not close it.

`/tps stats` opens a framed panel, centered on the screen like the Claude usage
panel. Close it with Esc, `q` or Ctrl+C, or with any key you bound to cancel. It is
narrow: 26.25% of the terminal, at least 57 columns. It has one entry per completed
assistant message that produced output since the session started. Aborted, failed or
empty messages, and messages left with less than one token after a `/tps reset`, are
skipped, and are also left out of the `avg` on the widget line. The panel contains:

- Two compact bar graphs with a value axis, one for TPS and one for cache read %,
  drawn oldest to newest. Each message is a bar two columns wide, one blank column apart, and the bars
  are six rows tall; when there are more messages than fit, only the newest are
  drawn, and on a short terminal (under 27 rows) the graphs shrink to three rows. Each graph header carries
  its average, then its maximum and minimum (there is no separate TPS summary row). A blank row separates the title
  from the scope line, and another one the scope line from the first graph.
- **Cache write %**: average, maximum and minimum (the same order as the graph
  headers) on a line below the cache read graph, after one blank row; it has no graph of its
  own.
- A dotted reference line (`┄`) in each graph at the level of its maximum and of
  its minimum, with both values in the graph title. The lines and the bars stop four
  columns before the right border. When the two share a row (for example with a
  single message) only one line is drawn.

**What the panel covers.** The numbers (`avg`, `max`, `min`, the reference lines and
the cache write line) always cover the **whole session**. The bars show only the
**newest responses that fit** the panel width, so the scope line under the title says
so: `Stats: whole session · bars: last 16 of 200`, or `Stats and bars: whole session`
when every response fits. The count in that text is the number of bars drawn.

**Scale.** The TPS graph is scaled to the bars that are drawn: its axis top is the
tallest visible bar, so they use the full height. The header still shows the session
`max` and `min`; a dotted reference line is drawn only when its value falls inside the
visible scale, so a record from an older response that is no longer drawn has no line.
The cache read graph is a percentage and always spans 0 to 100.

The axis labels of both graphs share one gutter, four columns wide, that grows when the
top TPS label is longer, as with a peak of `13550`. The axis stays one straight line, and
the extra columns come out of the bars.

Minimum and maximum are per message. Averages are weighted: TPS is total output
tokens over total generation time, and cache % is total cache tokens over total
prompt tokens (`input + cacheRead + cacheWrite`), not a mean of percentages. The
data lives in memory only; a new session, `/reload` or a resumed session starts
from zero, and `/tps reset` does not clear it. Without terminal components (RPC
mode) the same text is sent as a notification.

## Prompt and cache metrics

Pi normalizes prompt usage into separate `input`, `cacheRead`, and `cacheWrite`
counts. `input` is the uncached, non-cache-write portion; cache-read tokens are
shown separately and are never described as tokens processed by the model.
Because Pi initializes unavailable usage fields to zero, a zero shows as `0`
rather than as confirmed provider data. Time to first token (TTFT) and the
approximate prompt rate are no longer displayed.

## Install

Install a released version, pinned to its tag.

With Gentle Shell, which forwards `install` to Pi against its own home
(`~/.gentle-shell/agent` unless you use `--link`):

```bash
gentle-shell install git:github.com/restevean/pi-tps-stats@v0.1.3
```

With plain Pi, which uses `~/.pi/agent`:

```bash
pi install git:github.com/restevean/pi-tps-stats@v0.1.3
```

Without the `@v0.1.3` suffix the latest `main` is installed, which can change.

Or install a local checkout, with either command:

```bash
gentle-shell install /absolute/path/to/pi-tps-stats
pi install /absolute/path/to/pi-tps-stats
```

Use `/reload` if Pi was already running when you installed or changed the
extension.

## Commands

Run `/tps` on its own to open a menu: move with the arrow keys, pick an action
with Enter, or leave with Esc (nothing changes). Without a terminal UI (print
mode) there is nothing to ask, so a bare `/tps` reports the usage instead and
changes nothing.

The persistent `#7E86AE` widget is enabled above the prompt editor by default.
After reloading the local extension, use `/tps widget` to try it, or
`/tps status` to publish the same text as a status instead.

| Command       | Effect                                                 |
| ------------- | ------------------------------------------------------ |
| `/tps`        | Open a menu of the actions below (arrows, Enter, Esc)  |
| `/tps on`     | Enable the previously selected display mode            |
| `/tps off`    | Hide the display                                       |
| `/tps widget` | Enable the persistent widget above the editor          |
| `/tps status` | Publish the same line as a host status instead         |
| `/tps stats`  | Open a panel with session statistics and graphs        |
| `/tps reset`  | Reset an active measurement or clear the final summary |

## Development

This project uses pnpm only. The verification command checks Prettier formatting,
strict TypeScript compilation, zero-warning ESLint, and the test suite:

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

Apply formatting with `pnpm run format`. Run individual checks with
`pnpm run format:check`, `pnpm run check`, `pnpm run lint`, or `pnpm run test`.

To load the local extension without installing it:

```bash
cd /path/to/pi-tps-stats
gentle-shell -e ./src/index.ts
```

This loads the local source for one invocation without adding it to your
permanent package configuration. Use `pi` instead of `gentle-shell` for plain Pi,
and do not load the npm version alongside the local copy.

## Differences from the original

- The command is `/tps` (the original uses `/throughput`); on its own it opens a
  menu instead of toggling.
- `/tps stats` shows a statistics panel with graphs.
- The widget also shows the session average (`avg`), weighted by generation time.
- The widget renders above the editor in `#7E86AE` and shows one fixed line:
  `TPS`, output, input, cache read/write, `cache %`, total and duration.
- `/tps status` publishes that same line instead of the original compact format.
- The widget is mounted once and repainted in place instead of being registered
  again on every update.
- TTFT and the approximate prompt rate are not displayed.

## Security

The extension reads only the usage counts Pi reports for each assistant message. It
does not read or write files, open network connections, start processes or read
environment variables, and it never shows model text: the screen receives formatted
numbers and fixed messages. A count that is not a finite number is shown as 0 and a
very large one is capped at 10^15. Like any Pi extension it runs with your
permissions, so install it from a pinned tag.

The package has no runtime dependencies and no install scripts, and publishes only
`src`, `README.md` and `LICENSE`. Dependency build scripts are denied in
`pnpm-workspace.yaml`, and the tests enforce all of the above.

## License

Released under the MIT License. The original copyright notice of Andreas
Petersson is retained in [LICENSE](LICENSE), as the license requires, followed by
the notice for the modifications in this fork (restevean).

[MIT](LICENSE)

After `/tps reset` during a response, live and final rates use only output
since the reset. The final token total still describes the complete response.
If provider usage is unavailable at reset time, the earlier output is estimated
from its deltas and subtracted from the final rate calculation.
