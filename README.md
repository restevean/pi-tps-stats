# pi-tps-stats

> **Based on a fork of
> [pi-live-throughput](https://github.com/apetersson/pi-live-throughput)** by
> Andreas Petersson (MIT), forked from version 0.3.0
> (`dcedab3 chore(release): 0.3.0`). This project is independent and is not
> affiliated with or endorsed by the original author.


A single-line live tokens/sec display below the prompt editor for the
[Pi coding agent](https://pi.dev).

Requires pi 1.x. The widget uses a dedicated `#7E86AE` foreground color without
changing the active theme or the rest of the UI.

In terminal mode, the widget is registered once per visible lifetime. Streaming
updates, subsequent responses, and active measurement resets repaint that same
component instead of registering it again. Long lines are truncated to the
terminal width, keeping the widget on one row. Switching to status mode, hiding
the display, or ending the session removes only this extension's widget.

This prevents throughput updates from moving the widget relative to other
widgets. TPS uses the below-editor area, separate from the above-editor YOLO
banner. This placement is a visual trial, not a verified fix for duplicated
YOLO rendering; other extensions still control their own widgets.
The extension never modifies YOLO state, its banner, or Gentle Shell. RPC mode
keeps the existing string-array widget path because custom terminal components
are not supported there.

While an assistant response streams, the widget shows these fields in order:
**TPS → output → input → cache read/write → cache read/write % → total → duration**. When streaming
finishes, the final summary remains visible until the next response starts:

```text
TPS 11.4 tok/s. out 33, in 2, cache 0/85,571, cache % 0.0%/100.0%, total 85,606, 2.9s
```

Counts use full integers with English thousands separators. `total` is the sum
of output, input, cache-read, and cache-write tokens for the current response,
not the session. Both modes always show all fields; a zero input/cache field
reflects Pi's normalized usage and does not prove the provider reported a zero.

`cache %` immediately follows the cache counts. Each percentage uses
`input + cacheRead + cacheWrite` as its denominator, excluding output, and is
rounded to one decimal place. For example, input 100, cache read 800, and cache
write 100 produces `80.0%/10.0%`. With no prompt tokens it shows `0.0%/0.0%`.

Live TPS is the rolling throughput; final TPS is the average over the measured
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

Live and final throughput rates start measuring only after a second output
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

## Prompt and cache metrics

Pi normalizes prompt usage into separate `input`, `cacheRead`, and `cacheWrite`
counts. `input` is the uncached, non-cache-write portion; cache-read tokens are
shown separately and are never described as tokens processed by the model.
Because Pi initializes unavailable usage fields to zero, a zero shows as `0`
rather than as confirmed provider data. Time to first token (TTFT) and the
approximate prompt rate are no longer displayed.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/restevean/pi-tps-stats
```

Or install a local checkout:

```bash
pi install /absolute/path/to/pi-tps-stats
```

Use `/reload` if Pi was already running when you installed or changed the
extension.

## Commands

The persistent `#7E86AE` widget is enabled below the prompt editor by default.
After reloading the local extension, use `/tps widget` to try it, or
`/tps status` to publish the same text as a status instead.

| Command              | Effect                                                 |
| -------------------- | ------------------------------------------------------ |
| `/tps`               | Toggle the display on or off                           |
| `/tps on`            | Enable the previously selected display mode            |
| `/tps off`           | Hide the display                                       |
| `/tps widget`        | Enable the persistent widget below the editor          |
| `/tps status`        | Publish the same line as a host status instead         |
| `/tps reset`         | Reset an active measurement or clear the final summary |

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

- The command is `/tps` (the original uses `/throughput`).
- The widget renders below the editor in `#7E86AE` and shows one fixed line:
  `TPS`, output, input, cache read/write, `cache %`, total and duration.
- `/tps status` publishes that same line instead of the original compact format.
- The widget is mounted once and repainted in place instead of being registered
  again on every update.
- TTFT and the approximate prompt rate are not displayed.

## License

Released under the MIT License. The original copyright notice of Andreas
Petersson is retained in [LICENSE](LICENSE), as the license requires.


[MIT](LICENSE)

After `/tps reset` during a response, live and final rates use only output
since the reset. The final token total still describes the complete response.
If provider usage is unavailable at reset time, the earlier output is estimated
from its deltas and subtracted from the final rate calculation.
