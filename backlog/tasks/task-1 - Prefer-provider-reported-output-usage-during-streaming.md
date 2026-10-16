---
id: TASK-1
title: Prefer provider-reported output usage during streaming
status: Done
assignee: []
created_date: '2026-08-20 18:57'
updated_date: '2026-08-20 19:14'
labels:
  - streaming
  - metrics
dependencies: []
references:
  - >-
    https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#message_start--message_update--message_end
modified_files:
  - src/index.ts
priority: high
type: enhancement
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Improve the live TPS display so it uses Pi's cumulative provider-reported output usage whenever a provider exposes it during message streaming. Preserve a clearly identified estimate for providers that report usage only when the response completes, while keeping the final provider usage authoritative.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Live output token counts and rates use cumulative provider-reported output usage whenever it is available and advances during streaming
- [x] #2 The extension falls back to an explicitly identifiable estimate when live provider usage is unavailable or remains zero
- [x] #3 Usage updates are observed even when they arrive on stream events without a text, thinking, or tool-call delta
- [x] #4 The message-end output count and average remain based on final provider-reported usage
- [x] #5 Automated tests cover live reported usage, heuristic fallback, and transition from estimated to reported values
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Track both heuristic delta-derived output and cumulative `message.usage.output` while streaming, switching permanently to provider-reported values after a positive advancing report and processing usage on every message-update event type.
2. Represent rolling samples in tokens so rates and totals share the active source; visibly prefix heuristic live counts/rates with `~`, while leaving reported and final values unqualified.
3. Preserve reset semantics with a provider-usage baseline, and keep message-end totals/averages authoritative from final provider usage.
4. Extend the event harness and tests for heuristic fallback, live provider usage, usage-only events, estimated-to-reported transition, and final authority; run `pnpm run verify`.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Caller verification: pnpm run verify passed TypeScript checking and all 4 Node tests; validated the correlated worker/reviewer envelopes and confirmed the clean reviewed implementation SHA caef8c05299237e54b27d11cd4043c4b4d4aa092.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Live TPS now prefers cumulative provider-reported output usage, clearly labels heuristic fallback, processes usage-only updates, and retains authoritative final usage. Verified with pnpm run verify (4/4 tests), correlated xhigh gpt-5.6-sol final review, and a clean reviewed implementation SHA.
<!-- SECTION:FINAL_SUMMARY:END -->

## Review findings — gpt56-final — 2026-08-20T19:11:02Z

Run: task-1-caef8c0-20260820T1905Z
Task: TASK-1
Attempt: 1
Reviewer: pi/openai-codex/gpt-5.6-sol/gpt56-final (xhigh, final)
Verdict: ALL GOOD
Implementation SHA: caef8c05299237e54b27d11cd4043c4b4d4aa092
Validation:
- `pnpm run verify` — passed (`tsc --noEmit`; 4/4 Node tests)
- Inline Node harness assertions for estimated fallback, usage-only transition, reported reset baseline, and final authority — passed
- `git diff --check caef8c05299237e54b27d11cd4043c4b4d4aa092^ caef8c05299237e54b27d11cd4043c4b4d4aa092` — passed
AC evidence:
- #1 — verified — advancing cumulative `message.usage.output` replaces heuristic totals, average, rolling samples, and peak source; transition assertions passed
- #2 — verified — zero/unavailable usage retains `est.` rates and `~` token totals; fallback assertions passed
- #3 — verified — usage is processed before event-type narrowing and usage-only `thinking_end`/`toolcall_start` assertions passed
- #4 — verified — `message_end` reads final `usage.output` directly and computes the final average from it; final-authority assertions passed
- #5 — verified — automated tests cover heuristic fallback, live cumulative usage, usage-only updates, and estimated-to-reported transition
Previous findings:
- None
Findings:
- None
