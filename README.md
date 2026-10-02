# pi-live-throughput

A single-line live tokens/sec display for the [Pi coding agent](https://pi.dev).

Requires pi 1.x. Validated against pi 1.0.0.

While an assistant response streams, the extension shows its rolling throughput,
average throughput, estimated output tokens, elapsed time, and model:

```text
⚡ 92.3 tok/s · avg 84.5 tok/s · 1.2k tok · 14.2s · deepseek-v4-flash
```

When streaming finishes, it replaces the live metrics with a final summary that
stays visible until the next assistant response starts. Prompt fields are added
when Pi exposes usable normalized values:

```text
✓ 512 tok in 2.0s · 256 tok/s avg · peak 319 tok/s · input 1.2k tok · cache read 8.0k tok · TTFT 420ms · approx. prompt 2900 tok/s · deepseek-v4-flash
```

Live figures use Pi's cumulative provider-reported `usage.output` value when it
advances during streaming. Providers that expose usage only after completion
fall back to text, thinking, and tool-call delta estimates, identified by
`est.` rates and `~` token counts. The final token count always uses the
provider-reported value.

## Measurement window

Live and final throughput rates start measuring only after a second output
token has been observed. Keeping time-to-first-token out of the measurement
window means the rolling, average, and peak rates describe decoding speed
rather than prompt processing, provider queueing, or network latency. Only
tokens observed after measurement starts contribute to a rate; the token
counters still report the response's cumulative output.

When a response ends before a second output token arrives, or when the measured
window captures less than one full output token, the final summary falls back to
whole-response timing instead of reporting a misleading near-zero rate. Because
provider usage is cumulative, switching from the heuristic estimate to
provider-reported usage adopts the provider's count for the response so far,
which can include the few tokens observed just before the window opened.

The duration shown next to the final rate is the measured generation window, so
TTFT is reported separately and is never folded into the rate.

## Prompt and cache metrics

Pi normalizes prompt usage into separate `input`, `cacheRead`, and `cacheWrite`
counts. `input` is the uncached, non-cache-write portion; cache-read tokens are
shown separately and are never described as tokens processed by the model.
Because Pi initializes unavailable usage fields to zero, this extension reports
only positive prompt/cache counts rather than presenting a zero as confirmed
provider data.

TTFT (time to first output) is measured from Pi's `before_provider_request`
boundary to the first substantive text, thinking, or tool-call output event. It
is omitted if either boundary is unavailable. TTFT is an end-to-end observation:
it can include network latency, provider queueing and routing, cache lookup, and
model startup, not just model prefill.

`approx. prompt` is a best-effort estimate calculated as
`(input + cacheWrite) / TTFT`. It is shown only when both a positive processed
prompt-token count and a positive TTFT are available. Cache-read tokens are
excluded. The estimate is not true model prefill throughput because its timing
contains the end-to-end latency above.

## Install

Install from npm:

```bash
pi install npm:pi-live-throughput
```

Alternatively, install directly from GitHub:

```bash
pi install git:github.com/apetersson/pi-live-throughput
```

For local development, install the checkout instead:

```bash
pi install /absolute/path/to/pi-live-throughput
```

Use `/reload` if Pi was already running when you installed or changed the
extension.

## Commands

The widget is enabled above the editor by default.

| Command              | Effect                                                 |
| -------------------- | ------------------------------------------------------ |
| `/throughput`        | Toggle the display on or off                           |
| `/throughput on`     | Enable the previously selected display mode            |
| `/throughput off`    | Hide the display                                       |
| `/throughput widget` | Enable the full single-line widget above the editor    |
| `/throughput status` | Enable a compact footer status instead                 |
| `/throughput reset`  | Reset an active measurement or clear the final summary |

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
pi -e ./src/index.ts
```

## License

[MIT](LICENSE)
