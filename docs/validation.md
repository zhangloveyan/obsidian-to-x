# Verification record

Version: **0.1.12**. Updated: **2026-10-12**. Timestamps below use UTC.

## Build and automated checks

`npm run package` passed TypeScript, the production build, whole-project ESLint and **157 tests**. The installable directory contains the five expected plugin files: `main.js`, `manifest.json`, `styles.css`, `LICENSE` and `THIRD_PARTY_NOTICES.md`.

The first Linux CI run exposed a missing Node.js `global` alias in two test VM fixtures. Version 0.1.12 supplies that alias inside each VM, preserving isolation from the host global object. The affected tests still exercise real SDK child-process behavior. This release also provides an English README with a separate Chinese translation; it changes no application source or save/reload behavior from 0.1.11.

The current test suite covers:

- Markdown parsing, hidden comments, UTF-16 formatting ranges, safe links, supported lists/headings and Markdown fallback blocks.
- Serial native uploads, editor remounts, media-ID promotion, delayed saved-media binding, missing/extra/conflicting images and stable confirmation before the next file.
- Timeouts, rejected callbacks, lost submission responses and explicit continuation without duplicate uploads; changed requests, pages and bodies stop continuation.
- Preliminary body saves, lost write responses, image-only articles, repeated sources, conflicting image bytes/MIME, body-image cover reuse, independent covers and final saved-draft verification.
- Runtime discovery, connection lifetime, MCP transport failure classification, diagnostic privacy, preview behavior and cover selection/cropping.

The native page adapter was also extracted from an in-memory production bundle and executed in an isolated VM. Checks confirmed that serialized browser code executes without host closures, repeated upload tokens submit once, exact file bytes are retained, and a token cannot submit to another draft. These are local simulations, not live X UI tests.

## Installed artifacts

The 0.1.11 package was installed and its five files verified by SHA-256 before the user run below. Local machine paths and account-specific draft links are omitted from this public record.

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

Automated checks exercise body-image cover reuse, independent covers, repeated images, interruption recovery and formatting preservation. The user-run log does not establish that every one of those cases occurred in that run. No full visual acceptance matrix has been recorded for this application source, including all supported formatting, live interruption/continuation, closed-Chrome startup, remote image retrieval and display variations. No additional X draft was created for the documentation and test-fixture changes in 0.1.12.

X editor internals and web operations can change independently of the plugin. Users still need an eligible X account and must review the saved draft before publishing. The plugin saves drafts only. Continuation state is held in memory and is lost when the dialog closes or Obsidian restarts. Complex Markdown and Obsidian extension syntax remain subject to the format limits in the [README](../README.md).

Release or Obsidian community-directory availability should be checked through the actual release/submission status; passing local checks does not imply directory approval.
