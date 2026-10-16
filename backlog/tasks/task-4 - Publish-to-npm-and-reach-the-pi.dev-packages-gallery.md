---
id: TASK-4
title: Publish to npm and reach the pi.dev packages gallery
status: To Do
assignee: []
created_date: '2026-10-16 19:19'
updated_date: '2026-10-16 19:25'
labels:
  - npm
  - packaging
  - release
dependencies: []
references:
  - https://pi.dev/packages
  - https://pi.dev/docs/latest/packages
modified_files: []
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
- [ ] #1 The `description` in `package.json` no longer mentions `(fork of pi-live-throughput)`, since that string becomes the primary npm gallery text
- [ ] #2 Every host-provided package declared in `peerDependencies` uses the documented `"*"` range, so a version-constrained range cannot fail installation when the host moves a major version
- [ ] #3 The tarball from `npm pack --dry-run` contains only `src/**`, `README.md` and `LICENSE` in addition to the `package.json` npm always includes, defines no install-time lifecycle scripts, and `pnpm run verify` passes
- [ ] #4 The `restevean` npm account exists with a verified email and 2FA enabled
- [ ] #5 `npm publish` succeeds for the released version and `npm view pi-tps-stats` resolves instead of returning 404
- [ ] #6 The package appears in the pi.dev package gallery, `pi install npm:pi-tps-stats` works, and no extension warning reports a misdeclared host dependency
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
