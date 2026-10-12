# Verification record

Version: **0.1.16**. Updated: **2026-10-12**. Timestamps below use UTC.

## Build and automated checks

`npm run package` passed TypeScript, the production build, whole-project ESLint and **173 tests**. The installable directory contains the five expected plugin files: `main.js`, `manifest.json`, `styles.css`, `LICENSE` and `THIRD_PARTY_NOTICES.md`.

The first Linux CI run exposed a missing Node.js `global` alias in two test VM fixtures. Version 0.1.12 supplied that alias inside each VM, preserving isolation from the host global object, and passed GitHub's Ubuntu build, lint and 157 tests. The affected tests still exercise real SDK child-process behavior. It also added an English README with a separate Chinese translation without changing application behavior.

Version 0.1.13 addresses the directory's style checks: Cropper.js CSS is in the standard `styles.css` asset, scoped with `:where(.mxp-crop-modal)` and placed before the existing overrides. Removing that scope reproduces the original dependency CSS without declaration changes; CSS parsing and the eight cover tests passed. The modal test rejects dynamic style elements. The two fixed-style assignments inside the serialized X-page function have narrow ESLint exceptions explaining that Obsidian styles and DOM helpers are unavailable in Chrome. Both relevant Obsidian style rules now run locally. Development lint dependencies were updated and `npm audit` reports no vulnerabilities. The save algorithm and three-refresh media flow remain unchanged.

Version 0.1.14 removes note-property publishing options and the bundled YAML parser. Properties no longer supply a title or cover; the title comes from the first top-level H1 or filename, and a cover is selected in the dialog. The leading property block is excluded from article content without parsing its values. Regression checks cover ignored title/cover fields, invalid property values, filename fallback, absence of automatic covers and explicit cover assets. No live X draft was created for this change.

Version 0.1.15 replaces article creation heuristics with the observed visible, enabled `main button[aria-label="create"]` control. Image submission opens the editor's insert-media dialog and dispatches standard file-input events; it no longer invokes a React upload callback. Unknown local media IDs and categories remain missing until observed, or are inherited from a uniquely matched image whose real values were already recorded. Missing fields stop progression and preserve continuation state. A definite pre-submission failure is retryable; a lost response remains uncertain and cannot cause another file submission.

The current test suite covers:

- Markdown parsing, hidden comments, UTF-16 formatting ranges, safe links, supported lists/headings and Markdown fallback blocks.
- Serial native uploads, editor remounts, media-ID promotion, delayed saved-media binding, missing/extra/conflicting images and stable confirmation before the next file.
- Timeouts, failed file handoffs, lost submission responses and explicit continuation without duplicate uploads; changed requests, pages and bodies stop continuation.
- Preliminary body saves, lost write responses, image-only articles, repeated sources, conflicting image bytes/MIME, body-image cover reuse, independent covers and final saved-draft verification.
- Runtime discovery, connection lifetime, MCP transport failure classification, diagnostic privacy, preview behavior and cover selection/cropping.

The page adapters were also extracted from in-memory production bundles and executed in isolated VMs. Checks confirm that serialized browser code executes without host closures, repeated upload tokens submit once, exact file bytes are retained, the cover input is excluded, and navigation or editor replacement stops submission. Ambiguous, disabled or unsuitable dialog inputs are rejected. Removing a known pre-submission blocker allows the same token to be tried safely. These are local simulations, not live X UI tests.

## Live DOM upload verification

For 0.1.15, one synthetic draft was created in the current Chinese X interface. Two generated PNG images were submitted using the media dialog's multiple-file input. The second submission exercised the same toolbar, menu, dialog and file-event sequence implemented by the adapter. After reloading, the draft still contained its test title, body text and both images. The observed media object supplied an actual local ID and media category.

This verifies the DOM upload sequence against the current X interface. It was a browser-driven developer check, not a complete run of the packaged Obsidian plugin. The synthetic draft remains unpublished for review. No private article content or account-specific draft URL is included here. Other X interface languages and layout variants were not exercised.

## Crop initialization verification

Version 0.1.16 fixes initial crop scaling. A local browser harness using the production crop modal and Cropper.js reproduced a landscape image opening at 104% before the fix. After the fix, 800×440 landscape, 420×800 portrait and 1200×300 wide fixtures all opened centered at 100%, with the shrink button disabled and no empty area inside the frame. Landscape and portrait image widths matched the frame; the wide image matched its height. Manual zoom and movement still worked, applying produced a 620×248 PNG, and reopening restored the exact adjusted canvas and 120% zoom. This used an Obsidian DOM shim and synthetic images; it was not a live Obsidian application check.

## Installed artifacts

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
