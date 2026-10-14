# Architecture and implementation

Current version: **0.1.19**. Product: **Markdown X Publisher** (`markdown-x-publisher`), by Ancle.

## Product scope

The desktop Obsidian plugin previews the current Markdown note and saves an X Article draft through the user's existing Chrome profile. The user reviews the title and cover before saving and publishes manually in X. Supported content includes text, links, inline styles, headings, simple lists, quotes, local or remote images, code fences and GFM tables. Unsupported Markdown structures are preserved as Markdown where possible; structures containing images that cannot be extracted safely are rejected.

The supported environment is desktop Obsidian 1.11.7 or later, Node.js 18 or later, the official Playwright Chrome extension, and a user-installed official Playwright MCP. The tested MCP version is 0.0.83. X must already be signed in and permit the account to create Articles. The plugin neither installs these dependencies nor publishes articles automatically.

## Module responsibilities

| Location | Responsibility |
| --- | --- |
| `src/main.ts`, `src/settings.ts` | Obsidian lifecycle, commands, configuration and connection reuse |
| `src/model.ts`, `src/content/` | Note parsing, image preparation, content types and X wire serialization |
| `src/browser/runtime.ts`, `src/browser/discovery.ts` | Official MCP connection and detection of installed Node/MCP programs |
| `src/browser/extension.ts` | Locate official Playwright extension installation files in standard Chrome profile directories |
| `src/ui/setup.ts`, `src/ui/folder-picker.ts` | Platform-specific configuration tutorial and native installation-folder selection |
| `src/browser/x-page.ts` | Current page/editor inspection, native file submission and media reconciliation |
| `src/browser/article-controls.ts` | Draft creation through the observed X button contract |
| `src/browser/media-upload.ts` | Serial uploads, identity matching, readiness checks and in-memory upload progress |
| `src/browser/x-draft.ts`, `src/browser/x-protocol.ts` | Draft creation, staged writes, continuation and saved-content verification |
| `src/ui/`, `styles.css` | Preview, title/cover dialogs, crop interaction and problem-log display |
| `tests/` | Parser, transport, browser-state, save, continuation and UI regression coverage |
| `scripts/` | Build, dependency notices and release packaging |
| `docs/` | Architecture, release instructions and verification records |

Temporary development artifacts belong in the ignored `work/` directory. Installable files are generated in `dist/markdown-x-publisher/`.

## Draft save flow

1. Parse the note, strip non-code writing comments, prepare requested images and validate title, content, formatting ranges, links and conflicting image sources before opening a draft.
2. Reuse or establish the official MCP connection, open the X Articles list, create a new draft and verify that it is empty. Every page operation checks the intended article identity.
3. For an article requiring media, use `serializeContent` to save the non-image body through the GraphQL adapter. Reload and verify this preliminary body before sending any files.
4. Focus the current editor and open its Insert Media dialog through the toolbar. Deliver each image to the dialog's multiple-file input with standard DOM file events; the separate cover input is never used for body media. Check the draft URL throughout the dialog transition and immediately before dispatch. Record the upload token before assigning files so a lost reply cannot cause duplicate submission.
5. Confirm a file only when all earlier images match unique verified identities, exactly one new image exists, no media entity is pending, every image is bound in the saved article record, and consecutive observations are stable. Missing, extra or conflicting identities stop the save. An unconfirmed upload has a bounded 180-second wait.
6. Reload and reconcile the uploaded media by identity, then serialize the complete body in source order. Write title, final body and optional cover, reload again and run `verifyDraft` against the expected content before reporting success.

Repeated body references to the same source reuse one upload. Selecting a body image as cover retains its body occurrences. An independent cover is uploaded as media but excluded from the final body. Articles without media proceed directly to the final writes and reload verification.

Draft creation uses the visible, enabled `main button[aria-label="create"]` observed on X, with uniqueness and existing-draft checks. It does not inspect translated labels or SVG paths. The upload adapter uses the current toolbar's emoji/insert group and media/GIF menu order, then requires a unique multiple-file input inside the dialog. Unexpected page structure stops the operation before file submission. These UI contracts were observed on the current Chinese X interface; the editor snapshot remains a read-only React/Draft compatibility adapter.

Media local IDs and categories come from actual editor observations. Missing values can be inherited only after a unique match to the same previously observed image. New images with incomplete metadata remain pending and cannot advance the upload queue. No placeholder local ID or default media category is substituted into saved content.

X's GraphQL operations and editor data are web compatibility interfaces rather than a supported public developer API. HTTP success alone is insufficient: persisted content, title, media and cover must pass verification after reload.

## Continuation and connection lifetime

One in-memory save session binds the request fingerprint, draft ID, known body, confirmed media identities and any submitted-but-unconfirmed file. An explicit **Continue current draft** action rechecks the request, page and content. It observes an uncertain upload without transmitting the file again, including after a lost response or rejected callback. Changed content, images, cover or draft identity reject continuation before further writes.

Progress exists only while the save dialog remains open. Closing it or restarting Obsidian discards the checkpoint. The plugin retains a reusable MCP connection after successful saves and resumable interruptions, and releases it on unload, connection-setting changes or unrecoverable connection failure. Each new save creates a separate draft.

## Preview and cover handling

Preview and upload share the parsed note model. A leading note-property block is excluded from article content; its values do not configure publishing. The first top-level H1 supplies the initial title, with the filename as fallback. The save dialog starts without a cover. The interface uses Obsidian theme colors and the plugin's X icon. The cover picker offers note images and a local-file tab; local files remain in memory until saving.

Single-level lists with images or multiple paragraphs become explicit numbered or bulleted text paragraphs interleaved with independent image blocks. Only the first paragraph of each item receives the marker; continuation paragraphs do not create extra numbers. Text style and link offsets move with the marker. This keeps visible numbering consistent across preview and X without assuming that X continues native list numbering across media blocks. Simple lists retain their existing native representation. Unsupported image structures still stop parsing, with original source line numbers, surrounding text and specific editing guidance in the preview.

Cover confirmation opens a Cropper.js dialog with a fixed 5:2 frame, dragging and zoom controls. A new image starts centered at the smallest scale that fills the final frame, with the zoom slider at its minimum. Ordinary landscape and portrait images fit the frame width; images wider than 5:2 fit its height to avoid empty margins. Re-cropping retains the original image and crop coordinates within the dialog session. Animated images are decoded to a static first frame. The exported cover is a separate PNG up to 2560 pixels wide; source files and body images remain unchanged. Cover previews and cancelled selections do not trigger uploads.

## Credentials, diagnostics and distribution

The Chrome extension token is stored through Obsidian `SecretStorage`; preferences store only its secret name, never the token value. Existing secret associations remain readable. Saving a replacement uses the plugin's own secret entry, without exposing a shared secret list or changing unrelated entries. Runtime discovery checks installed programs and never runs an installer. The plugin uses official extension mode and does not require a remote debugging port.

The confirmed settings layout has runtime configuration, one browser credential, problem logs, automatic preview refresh, and the current manifest version in the lower-right corner. The runtime heading contains **View setup tutorial (查看配置教程)**. **Auto-detect (自动检测)** sits to the left of **Save configuration (保存配置)** below the path fields. Installation instructions live in `src/ui/setup.ts`, with four steps for Node LTS, the tested MCP version, Chrome extension installation, and copying/saving/testing the token. The tutorial adapts download, terminal-opening and path instructions to Windows, macOS or Linux and includes expandable troubleshooting.

`src/settings.ts` keeps the runtime form separate from persisted settings. On first use both folder fields are empty. Auto-detect validates nonempty paths without replacing them, searches only empty fields and fills discovered directories without saving. Users may type a folder or open the native directory picker through its folder icon; selection updates the same field, and cancellation leaves it unchanged. `src/ui/folder-picker.ts` opens the system dialog and reports failure with a manual-entry alternative. `src/browser/discovery.ts` resolves directories to the Node executable and official MCP entry point while retaining compatibility with previously saved executable paths.

**Save configuration** validates both runtime paths and persists them together before changing the active configuration. Failed checks or persistence retain the entered values and previous active configuration. `src/main.ts` serializes configuration changes with browser operations; runtime, token and preview preference changes use atomic persistence before adopting new settings. The settings UI ignores stale detection results after edits or navigation, and synchronizes newly completed saves when returning to settings without overwriting locally edited fields. Browser tests require the current runtime and token edits to be saved first.

`src/browser/extension.ts` searches standard Chrome channel/profile directories for the official extension ID and readable installation manifests. This reads extension files only, not browser preferences, history, account data or login credentials. **Found** establishes installed files, not extension enablement, token validity or browser usability. Missing extension files do not block runtime-path saving. The separate **Test connection (测试连接)** action establishes the actual Chrome connection through MCP; it neither creates an article nor checks X login or Article permissions.

The credential section contains one masked token input, **Save (保存)** and the separate connection-test button. A saved token is reused; saving does not claim that a connection succeeded. There is no Link/Change selector, key rotation or concurrent use of multiple entries. Secret persistence failures restore the previous stored value, and error messages do not include the submitted token.

Local diagnostics record stages, timing, counts and controlled error categories. Logs exclude article text, file paths, image bytes and credentials, and are bounded to 128 KiB or 1000 entries. There is no telemetry, remote configuration download or self-update mechanism.

The application is licensed under [AGPL-3.0-only](../LICENSE). Build-generated [third-party notices](../THIRD_PARTY_NOTICES.md) retain applicable bundled dependency licenses. Packaging produces `main.js`, `manifest.json`, `styles.css`, `LICENSE` and `THIRD_PARTY_NOTICES.md`; license text is also included in the JavaScript bundle.

## Maintenance and verification

Run `npm run package` to execute TypeScript, production build, ESLint, tests and packaging. Relevant regressions must cover formatting and Unicode boundaries, image identity changes, delayed binding, editor remounts, interrupted uploads, request/page mismatches, cover separation and final reload verification. Serialized browser functions must also execute when extracted from the production bundle.

Settings acceptance covers the first-use empty form, directory selection/cancellation, preservation of typed paths during detection, independent results for the three components, explicit saving before activation, and retention of the old configuration after validation or persistence failure. Exercise editing or leaving settings while detection is pending, returning while a save completes, busy-state mutation guards, and preserving unsaved token input during runtime detection. Verify one-secret migration without plaintext tokens in `data.json`, separate saved/connected states, tutorial links and platform instructions, preview preference persistence, log access and the manifest-derived version footer. Connection success needs a real browser test; locating extension files alone is not evidence of connectivity.

Local simulations establish failure handling and data invariants. Real X runs provide separate compatibility evidence; diagnostic completion must not be presented as an independent visual inspection of every supported format. Current results and remaining limits are recorded in [validation.md](validation.md). Follow [releasing.md](releasing.md) for release packaging and community-directory submission.
