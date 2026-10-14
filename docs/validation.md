# Verification record

Version: **0.1.20**. Updated: **2026-10-14**. Timestamps below use UTC.

## Build and automated checks

A clean `npm ci` and `npm run package` for 0.1.20 passed TypeScript, the production build, whole-project ESLint and **212 tests** on Windows. The installable directory contains the five expected plugin files: `main.js`, `manifest.json`, `styles.css`, `LICENSE` and `THIRD_PARTY_NOTICES.md`. The manual-install ZIP contains only those five files under `markdown-x-publisher/`.

For the 0.1.19 release, a clean `npm ci` and `npm run package` passed on Windows. GitHub's [Ubuntu check](https://github.com/zhangloveyan/obsidian-to-x/actions/runs/38519361208) also passed for release commit `8376c41`. The public [0.1.19 release](https://github.com/zhangloveyan/obsidian-to-x/releases/tag/0.1.19) includes all five plugin files and the manual-install ZIP; all six GitHub asset SHA-256 digests match the locally generated files. Community review subsequently failed on two manually created settings headings; 0.1.20 replaces both with the required native heading API.

The first Linux CI run exposed a missing Node.js `global` alias in two test VM fixtures. Version 0.1.12 supplied that alias inside each VM, preserving isolation from the host global object, and passed GitHub's Ubuntu build, lint and 157 tests. The affected tests still exercise real SDK child-process behavior. It also added an English README with a separate Chinese translation without changing application behavior.

Version 0.1.13 addresses the directory's style checks: Cropper.js CSS is in the standard `styles.css` asset, scoped with `:where(.mxp-crop-modal)` and placed before the existing overrides. Removing that scope reproduces the original dependency CSS without declaration changes; CSS parsing and the eight cover tests passed. The modal test rejects dynamic style elements. The two fixed-style assignments inside the serialized X-page function have narrow ESLint exceptions explaining that Obsidian styles and DOM helpers are unavailable in Chrome. Both relevant Obsidian style rules now run locally. Development lint dependencies were updated and `npm audit` reports no vulnerabilities. The save algorithm and three-refresh media flow remain unchanged.

Version 0.1.14 removes note-property publishing options and the bundled YAML parser. Properties no longer supply a title or cover; the title comes from the first top-level H1 or filename, and a cover is selected in the dialog. The leading property block is excluded from article content without parsing its values. Regression checks cover ignored title/cover fields, invalid property values, filename fallback, absence of automatic covers and explicit cover assets. No live X draft was created for this change.

Version 0.1.15 replaces article creation heuristics with the observed visible, enabled `main button[aria-label="create"]` control. Image submission opens the editor's insert-media dialog and dispatches standard file-input events; it no longer invokes a React upload callback. Unknown local media IDs and categories remain missing until observed, or are inherited from a uniquely matched image whose real values were already recorded. Missing fields stop progression and preserve continuation state. A definite pre-submission failure is retryable; a lost response remains uncertain and cannot cause another file submission.

Version 0.1.18 removes the two `obsidianmd/no-static-styles-assignment` exceptions rejected by community review. The optional X-page save notice now uses a native manual popover without assigning styles. Its appearance follows browser defaults; it remains dismissible and expires after three seconds. The upload and save-verification flow is unchanged. Existing review warnings, including the README language warning, are outside this fix.

The current test suite covers:

- Markdown parsing, hidden comments, UTF-16 formatting ranges, safe links, supported lists/headings and Markdown fallback blocks.
- Serial native uploads, editor remounts, media-ID promotion, delayed saved-media binding, missing/extra/conflicting images and stable confirmation before the next file.
- Timeouts, failed file handoffs, lost submission responses and explicit continuation without duplicate uploads; changed requests, pages and bodies stop continuation.
- Preliminary body saves, lost write responses, image-only articles, repeated sources, conflicting image bytes/MIME, body-image cover reuse, independent covers and final saved-draft verification.
- Runtime discovery, connection lifetime, MCP transport failure classification, diagnostic privacy, preview behavior and cover selection/cropping.

The page adapters were also extracted from in-memory production bundles and executed in isolated VMs. Checks confirm that serialized browser code executes without host closures, repeated upload tokens submit once, exact file bytes are retained, the cover input is excluded, and navigation or editor replacement stops submission. Ambiguous, disabled or unsuitable dialog inputs are rejected. Removing a known pre-submission blocker allows the same token to be tried safely. These are local simulations, not live X UI tests.

## Settings configuration verification

The 0.1.20 settings changes passed `npm run check` on 2026-10-14 (TypeScript, production build, ESLint and **212 tests**). Nine settings-event tests cover automatic checks of saved paths on reopening, stale-result protection, unavailable directories, busy-state deferral, saves completing across pane navigation, and session test-result display. Six additional plugin lifecycle tests cover in-memory test results, actual configuration-change invalidation, failed credential-save rollback, external secret replacement and unload. The isolated Chromium settings harness passed **16 interaction groups** with no page errors, including the new reopening scenarios. These checks used simulated browser connections; no live X draft was created. Settings headings use Obsidian's native Setting heading API, and the community review's no-manual-HTML-heading rule is now enforced locally.

The local settings update implements the approved empty-first-use form, explicit runtime-path saving, single-token editor, installation tutorial and manifest-derived version footer. Tests cover directory and legacy executable-path compatibility, invalid manual overrides without fallback, independent runtime errors, official MCP package/entry validation, extension installation detection, and the native directory dialog's selection, cancellation and failure behavior.

Plugin lifecycle tests verify that runtime paths become active together only after persistence succeeds, failed writes retain the prior settings and connection, and concurrent preference/credential/browser operations are blocked during a save. Token replacement preserves an existing shared credential, keeps token values out of plugin preferences and restores the previous private value after a persistence failure.

A read-only local check found Node.js, Playwright MCP and the installed official Chrome extension. The existing installed plugin's runtime paths were also accepted by the new folder-based checks. These checks do not establish a live Chrome connection. Native dialog integration was checked against the locally installed Obsidian remote API and isolated dialog fixtures; no real directory dialog or live X upload was opened for this settings change.

An isolated Chromium host ran the production settings module, setup modal and stylesheet with controlled runtime, directory-picker and persistence fixtures. All 11 interaction groups passed with no page errors: first-open behavior, draft paths, invalid saves, folder selection/cancellation, stale detection, secret saving/testing, busy controls, runtime/secret saves finishing after reopening, tutorial actions and responsive layouts. Desktop light/dark and 390px layouts were inspected; they had no horizontal overflow. This verifies the UI with an Obsidian DOM shim, not an actual Obsidian session or account connection.

## Save notice verification

For 0.1.18, a local Chromium page ran the production serialized notification with a synthetic X location. The native popover displayed readable text, retained the article input's focus and left the underlying page available. The close button removed it, repeated calls replaced the previous notice, an older timeout did not remove the replacement, and the replacement disappeared after three seconds. No live X draft was created or saved for this cosmetic change.

## Documentation verification

Version 0.1.17 rewrites the Chinese and English READMEs with installation, setup, usage, format limits and troubleshooting instructions. Four shared images illustrate the workflow. The main image was captured in the actual Windows Obsidian 1.11.7 application with the installed 0.1.16 plugin, using a temporary synthetic article in the left editor and its plugin preview on the right. The three dialog images were captured from production UI components in a local demo host, not from the Obsidian application; the READMEs distinguish those sources. Temporary vault content was removed and the previous note and layout were restored.

All relative README links and image paths were checked. The 0.1.17 package passed the same build, lint and 173-test gate. This release does not change application source or runtime behavior; creating or saving an X draft was not rerun for this documentation update.

## Live DOM upload verification

For 0.1.15, one synthetic draft was created in the current Chinese X interface. Two generated PNG images were submitted using the media dialog's multiple-file input. The second submission exercised the same toolbar, menu, dialog and file-event sequence implemented by the adapter. After reloading, the draft still contained its test title, body text and both images. The observed media object supplied an actual local ID and media category.

This verifies the DOM upload sequence against the current X interface. It was a browser-driven developer check, not a complete run of the packaged Obsidian plugin. The synthetic draft remains unpublished for review. No private article content or account-specific draft URL is included here. Other X interface languages and layout variants were not exercised.

## Crop initialization verification

Version 0.1.16 fixes initial crop scaling. A local browser harness using the production crop modal and Cropper.js reproduced a landscape image opening at 104% before the fix. After the fix, 800×440 landscape, 420×800 portrait and 1200×300 wide fixtures all opened centered at 100%, with the shrink button disabled and no empty area inside the frame. Landscape and portrait image widths matched the frame; the wide image matched its height. Manual zoom and movement still worked, applying produced a 620×248 PNG, and reopening restored the exact adjusted canvas and 120% zoom. This used an Obsidian DOM shim and synthetic images; it was not a live Obsidian application check.

## Installed artifacts

The 0.1.20 release build was copied into the existing local plugin directory on 2026-10-14. All five installed SHA-256 hashes matched the package; the existing `data.json` hash was unchanged. Reload the plugin to activate the updated files.

The released 0.1.19 files were copied into the existing local plugin directory on 2026-10-14. All five installed SHA-256 hashes matched the release package; `data.json` was unchanged.

The 2026-10-14 local settings build, still version 0.1.18, was copied into the existing plugin directory. All five installed files matched the packaged SHA-256 hashes, and the existing `data.json` hash was unchanged. It requires reloading the installed plugin to activate; this local update does not represent a new published release.

The 0.1.16 package was copied into the existing Obsidian plugin directory, with all five installed files verified by SHA-256. Existing plugin settings and the enabled-plugin list were unchanged. The earlier 0.1.11 installation was also hash-verified before the user run below. Local machine paths and account-specific draft links are omitted from this public record.

## User-run diagnostic evidence

The installed 0.1.11 plugin's `logs/latest.log` records a real user save starting at **2026-10-12 03:55:32.661 UTC** and reaching `operation.completed` at **03:57:49.292 UTC**, with a recorded elapsed time of **136,630 ms**.

The diagnostic record shows:

- Eight native uploads reached confirmed state, followed by `editor-save-verified` for eight images.
- The preliminary body, title, final body and cover mutations each returned HTTP 200 with no GraphQL errors.
- Three draft reloads completed across preliminary-body verification, media reconciliation and final verification.
- The operation reached the `complete` stage and then recorded successful completion.

An initial `create_entry_missing` result occurred while the article list was loading; the bounded wait subsequently found the create control and the save completed. This was not a terminal operation failure.

This is evidence that the user's installed version completed its real save and internal verification flow. The log review did not inspect the private article or independently compare every rendered paragraph, format, image position and cover against the source. It must not be described as comprehensive visual acceptance.

## Verified scope and remaining limits

Automated checks exercise body-image cover reuse, independent covers, repeated images, interruption recovery and formatting preservation. The user-run log does not establish that every one of those cases occurred in that run. No full visual acceptance matrix has been recorded for this application source, including all supported formatting, live interruption/continuation, closed-Chrome startup, remote image retrieval and display variations. No additional X draft was created for the publication fixes in 0.1.12–0.1.13.

X editor internals and web operations can change independently of the plugin. Users still need an eligible X account and must review the saved draft before publishing. The plugin saves drafts only. Continuation state is held in memory and is lost when the dialog closes or Obsidian restarts. Complex Markdown and Obsidian extension syntax remain subject to the format limits in the [README](../README.md).

Release or Obsidian community-directory availability should be checked through the actual release/submission status; passing local checks does not imply directory approval.
