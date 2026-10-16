---
id: TASK-2
title: Report prompt cache and prefill performance metrics
status: Done
assignee: []
created_date: '2026-08-20 18:57'
updated_date: '2026-08-20 19:27'
labels:
  - prompt
  - cache
  - metrics
dependencies: []
references:
  - 'https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts'
modified_files:
  - src/index.ts
  - README.md
priority: medium
type: enhancement
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Expose the prompt-side performance information available through Pi's normalized usage data. Report prompt and cache token counts, time to first output, and a clearly labeled best-effort prompt-processing TPS estimate without implying that network and provider queue latency are true model prefill time.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The extension reports normalized input, cache-read, and cache-write token counts when the provider supplies them and omits unavailable metrics cleanly
- [x] #2 The extension measures time to first output from the provider request boundary and reports it as TTFT
- [x] #3 A prompt-processing TPS estimate is shown only when the required token and timing data are available and is clearly labeled approximate
- [x] #4 Cache-read tokens are reported separately and are not presented as tokens processed by the model
- [x] #5 Documentation defines the prompt-processing estimate and explains that TTFT can include network, queueing, routing, cache lookup, and model startup time
- [x] #6 Automated tests cover cached, uncached, partially reported, and unavailable provider metrics
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Anchor each assistant request at Pi's `before_provider_request` hook, consume that boundary at the matching assistant `message_start`, and capture TTFT only on the first substantive streamed output event.
2. Derive final prompt metrics conservatively from Pi's normalized usage: show only positive finite uncached input, cache-read, and cache-write counts; keep cache reads separate; omit zero placeholders because normalized usage cannot distinguish an unavailable field from a reported zero.
3. Compute a clearly labeled approximate prompt-processing rate only from uncached input plus cache-write tokens and a positive TTFT, excluding cache-read tokens and documenting that the timing includes non-model latency.
4. Extend widget/status summaries, README semantics, and the event harness; add cached, uncached, partial, unavailable, request-boundary, and no-output coverage; run `pnpm run verify`.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Caller verification: pnpm run verify passed TypeScript checking and all 8 Node tests; validated correlated worker/reviewer envelopes, confirmed cache reads are excluded from the approximate rate, and confirmed the clean reviewed implementation SHA 35e25f6340cc6b5968b6f93765e6fe35d6e0f8b2.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Final summaries now report available normalized input/cache usage, end-to-end TTFT, and a clearly labeled approximate prompt-processing rate that excludes cache reads. README limitations are explicit. Verified with pnpm run verify (8/8 tests), correlated xhigh gpt-5.6-sol final review, and a clean reviewed implementation SHA.
<!-- SECTION:FINAL_SUMMARY:END -->

## Review findings — gpt56-final — 2026-08-20T19:24:45Z

Run: task-2-35e25f6-20260820T192042Z
Task: TASK-2
Attempt: 1
Reviewer: pi/openai-codex/gpt-5.6-sol/gpt56-final (xhigh, final)
Verdict: ALL GOOD
Implementation SHA: 35e25f6340cc6b5968b6f93765e6fe35d6e0f8b2
Validation:
- `pnpm run verify` — passed (`tsc --noEmit`; 8/8 Node tests)
- Independent inline Node harness assertions for cache-only exclusion, empty-delta TTFT handling, cache-write-only TPS, and status rendering — passed
- `git diff --check 35e25f6340cc6b5968b6f93765e6fe35d6e0f8b2^ 35e25f6340cc6b5968b6f93765e6fe35d6e0f8b2` — passed
AC evidence:
- #1 — verified — final normalized positive finite input/cache-read/cache-write fields render independently, while zero/unavailable fields are omitted; cached, uncached, partial, and unavailable assertions passed
- #2 — verified — `before_provider_request` records the request boundary, the matching assistant stream consumes it, and the first substantive output records TTFT; request-boundary, empty-delta, and no-output assertions passed
- #3 — verified — `approx. prompt` requires positive uncached input or cache-write tokens plus positive TTFT and is visibly labeled approximate; unit and independent cache-write-only assertions passed
- #4 — verified — cache reads render in a separate field and are excluded from the processed-token numerator; cached and cache-only exclusion assertions passed
- #5 — verified — README defines `(input + cacheWrite) / TTFT` and explicitly covers network, queueing, routing, cache lookup, and model startup latency
- #6 — verified — automated tests cover cached, uncached, partially reported, unavailable, request-boundary, and no-output cases
Previous findings:
- None
Findings:
- None
