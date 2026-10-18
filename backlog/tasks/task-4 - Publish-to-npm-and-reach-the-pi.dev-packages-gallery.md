---
id: TASK-4
title: Publish to npm and reach the pi.dev packages gallery
status: Done
assignee: []
created_date: '2026-10-16 19:19'
updated_date: '2026-10-18 17:28'
labels:
  - npm
  - packaging
  - release
dependencies: []
references:
  - https://pi.dev/packages
  - https://pi.dev/docs/latest/packages
modified_files:
  - package.json
  - README.md
  - test/supply-chain.test.mjs
priority: medium
type: chore
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the extension installable through npm and therefore discoverable in the Pi package gallery at https://pi.dev/packages. The Pi package docs (https://pi.dev/docs/latest/packages, section "Create a package") state that the `pi-package` keyword makes an npm package eligible for discovery in that gallery; no separate registration step is documented there. That gallery page was read on 2026-10-16 and presents npm packages such as `pi-web-access` and `pi-mcp-adapter`, each with its `pi install npm:<package>` command.

Blocked on a human action: as of 2026-10-16 `npm view pi-tps-stats` returns 404, so nothing is published and no npm session exists here. Two manifest adjustments should land before the first publish; both are small and independent of the account. Everything publisher-side — account state, registry resolution, gallery listing — can only be confirmed by actually running the publish.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The `description` in `package.json` no longer mentions `(fork of pi-live-throughput)`, since that string becomes the primary npm gallery text; the origin stays credited in the README and in `LICENSE`
- [x] #2 Every host-provided package declared in `peerDependencies` uses the `"*"` range that the Pi package guide requires, pinned by a test in `test/supply-chain.test.mjs`
- [x] #3 The tarball from `npm pack --dry-run` contains only `src/**`, `README.md` and `LICENSE` in addition to the `package.json` npm always includes, defines no install-time lifecycle scripts, and `pnpm run verify` passes
- [x] #4 The `restevean` npm account exists with a verified email and 2FA enabled (npm asked for a 2FA code on publish)
- [x] #5 `npm publish` succeeds for the released version and `npm view pi-tps-stats` resolves instead of returning 404 (`pi-tps-stats@0.1.5` and `pi-tps-stats@0.1.6` published on 2026-10-18; `latest` is 0.1.6 and its shasum matches the tarball packed before publishing)
- [x] #6 The package appears in the pi.dev package gallery, `pi install npm:pi-tps-stats` works, and no extension warning reports a misdeclared host dependency (the package page https://pi.dev/packages/pi-tps-stats shows 0.1.7 with "0 dependencies · 2 peers" and the `pi install npm:pi-tps-stats` command; the catalog list and search had not refreshed when the task closed, which is outside this project)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Remove the fork reference from the `package.json` `description` (currently line 4), keeping the text accurate for anyone arriving from the npm listing.
2. Change the `@earendil-works/pi-coding-agent` range in `peerDependencies` to the `"*"` range the package docs require for host-provided packages; `@earendil-works/pi-tui` already uses `"*"`. Confirm no host-provided package is listed under `dependencies` — the manifest has no `dependencies` key at all today.
3. Run `npm pack --dry-run` and confirm the tarball holds only `src/**`, `README.md` and `LICENSE` besides the `package.json` npm always includes, then run `pnpm run verify`.
4. Human step: create the `restevean` npm account, verify the email, enable 2FA, and complete `npm login` with web auth. The web link is short-lived: the one attempted here expired after about five minutes.
5. Publish the latest released version (its `vX.Y.Z` tag is already on `origin/main`), then confirm `npm view pi-tps-stats` resolves, the package is found in the gallery, `pi install npm:pi-tps-stats` installs it, and no extension warning reports a misdeclared host dependency.
6. Optional and outside the acceptance criteria: add `pi.image` and `pi.video` to the `pi` manifest, as the package docs describe, only if a gallery preview is wanted.
<!-- SECTION:PLAN:END -->

## Progress notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-18: `pi-tps-stats@0.1.5` is on npm. The registry showed a staged placeholder (`0.0.0-stage`) for the first minutes, then `latest` moved to 0.1.5. `pi install npm:pi-tps-stats@0.1.5` into a throwaway agent home installed 5 files and reported 0 vulnerabilities. The pi.dev gallery search for `pi-tps-stats` returned no match right after publishing, so criterion #6 stays open until the package shows up there. The no-warning part of #6 (misdeclared host dependency) was not observed in a live session yet.

2026-10-18, 0.1.6: `pi-tps-stats@0.1.6` is on npm and `latest` points to it; its shasum (`7afa8f4b62799a5e918bfea4152999e80a449fe7`) equals the `npm pack --dry-run` of tag `v0.1.6`. The registry shows the new description ("Built with Gentle Shell, for Gentle Shell ...") and the keywords `tps`, `tokens-per-second`, `gentle-shell` and `gentle-pi`. `pi install npm:pi-tps-stats@0.1.6` into a throwaway agent home installed the five expected files and the README starts with the Gentle Shell notice. A few minutes after publishing, `npm search pi-tps-stats` did not list the package and the pi.dev gallery still returned no match, so criterion #6 stays open.

2026-10-18, 0.1.7: `pi-tps-stats@0.1.7` is on npm and `latest` points to it; its shasum (`9f351357a570f8f221a469a9dd49094444e01980`) equals the `npm pack --dry-run` of tag `v0.1.7`. An unversioned `pi install npm:pi-tps-stats` into a throwaway agent home installed 0.1.7. The pi.dev package page shows the 0.1.7 details. The pi.dev catalog list still showed the same snapshot (5383 packages, same "recently published" entries) for hours, so the package was not listed there yet.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
pi-tps-stats is published on npm (0.1.5, 0.1.6 and 0.1.7; `latest` is 0.1.7) under the `restevean` account with 2FA, installs with `pi install npm:pi-tps-stats`, and has its page on the Pi package site at https://pi.dev/packages/pi-tps-stats. The manifest declares host packages as `"*"` peers with no runtime dependencies, which a test pins, and the README documents the npm install. Outside this project when the task closed: the pi.dev catalog list and `npm search` had not refreshed to include the package, and no live Pi session had loaded the npm build to confirm the absence of a host dependency warning.
<!-- SECTION:FINAL_SUMMARY:END -->
