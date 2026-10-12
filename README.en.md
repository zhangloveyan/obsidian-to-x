# Markdown X Publisher

[简体中文](README.md)

Preview Markdown notes in Obsidian, review the title and cover, and save them as X Article drafts using your existing Chrome profile and X login. You publish manually in X. Desktop only. Built by Ancle; licensed under AGPL-3.0-only.

## Requirements

- Desktop Obsidian **1.11.7 or later**. Mobile and tablet clients are not supported.
- Your regular Google Chrome profile with the [official Playwright extension](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md) installed.
- Node.js 18 or later; a supported LTS version is recommended.
- The official `@playwright/mcp`, installed by you. The currently supported version is **0.0.83**.
- An X account signed in to that Chrome profile, with permission to create Articles. X controls account eligibility and subscription requirements; see [X Articles help](https://help.x.com/en/using-x/articles).

The plugin is free. It does not require an X Developer API key, a model API key, or a paid MCP service. It saves through the signed-in X website using a web compatibility adapter, **not the official X developer API**. Changes to X's website or internal data format may require plugin updates. Check the saved draft's layout in X.

## Installation

### Install from Community plugins

Directory page: [Markdown X Publisher](https://community.obsidian.md/plugins/markdown-x-publisher).

As of October 12, 2026, version `0.1.13` has been submitted but has not passed the directory's automated review, so installation from Community plugins is not yet available. Once review is complete and installation is enabled, follow these steps. For now, use manual installation below.

1. Open Obsidian **Settings → Community plugins** and follow the prompts to enable community plugins.
2. Select **Browse** and search for **Markdown X Publisher**.
3. Open its details, select **Install**, then **Enable**.

### Manual installation

1. Download `markdown-x-publisher-<version>.zip` from [GitHub Releases](https://github.com/zhangloveyan/obsidian-to-x/releases). Extract it and place the `markdown-x-publisher` folder in your vault's `.obsidian/plugins/` directory.
2. Confirm that the folder directly contains `main.js`, `manifest.json`, `styles.css`, `LICENSE`, and `THIRD_PARTY_NOTICES.md`.
3. Reload the plugin list in Obsidian, then enable **Markdown X Publisher** under **Settings → Community plugins**.

To build from source, run `npm ci` followed by `npm run package` and use `dist/markdown-x-publisher/`. Availability in the community directory depends on Obsidian's review.

## First-time setup

### 1. Install Node.js and MCP

Install Node.js from the [official website](https://nodejs.org/en/download), then run this command yourself in a terminal:

```sh
npm install -g @playwright/mcp@0.0.83
```

Skip components you already have. When you open the plugin settings, the plugin detects installed Node.js and official MCP programs and displays their status and versions. After installation, click **Re-detect (重新检测)**. If a newly installed Node.js is still missing, restart Obsidian so it can read the updated environment.

Paths are normally detected automatically. For an unusual installation location or a specific version, expand **Advanced: manually specify program paths (高级设置：手动指定程序路径)**:

- **Node.js path (Node.js 路径)**: optionally enter the full path to `node` or `node.exe`.
- **Playwright MCP path (Playwright MCP 路径)**: optionally enter the full path to the official `@playwright/mcp/cli.js`.

Leave both fields empty for automatic detection. Connection tests and saves also detect these programs; you do not need to copy detected paths into settings. Invalid manual paths produce an error rather than silently selecting another program.

The plugin only runs programs you have installed. It does not run `npm install` or `npx`, or install or update itself, MCP, or the browser extension.

### 2. Configure your regular Chrome profile

Follow the [official extension instructions](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md). Sign in to X in the same Chrome profile and confirm that the website offers the option to create an Article.

Connections always use Chrome extension mode. The plugin does not create a separate browser profile or require Chrome's remote debugging port. The official connection flow may launch Chrome if it is closed, using your regular profile.

### 3. Save the connection credential

1. Open the Playwright extension's status page in Chrome.
2. Copy its `PLAYWRIGHT_MCP_EXTENSION_TOKEN` value. The complete `PLAYWRIGHT_MCP_EXTENSION_TOKEN=...` text is also accepted.
3. In **Browser connection credential (浏览器连接凭据)** in the plugin settings, use Obsidian's secret control to create a secret, paste the value, and select that secret.
4. Click **Test connection (测试连接)**. This checks the browser connection without creating an article.

Obsidian `SecretStorage` manages the token. Plugin preferences store only the secret name, not the token in `data.json`; no credential text file is needed. After a valid token is configured, later connections do not require repeated Allow clicks. The extension may briefly show its connection page on the first connection, after a plugin reload, or when reconnecting. It then continues automatically using the [official automatic connection mechanism](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md#bypassing-the-connection-approval-dialog).

Connection tests and consecutive saves share one MCP connection. Successful saves retain it and reuse its controlled X tab. The credential belongs to a particular Chrome profile: save it again after switching profiles, resetting the extension token, or clearing extension data. If the X login expires, sign in again on the website.

## Save an article

1. Open the Markdown note you want to send.
2. Click the **X ribbon icon**, or run **Preview X article (预览 X 文章)**. The preview tab and file context menu use the same icon.
3. Review the preview and click its save button.
4. Edit the title in the dialog and click **Select cover (选择封面)**. Choose a thumbnail under **Article images (文章图片)**, or use **Local images (本地图片)** to select an image anywhere on your computer. Click **Confirm (确认)** to open **Edit media (编辑媒体)**. Drag the image and use the zoom slider inside the fixed **5:2** crop frame. Click **Apply (应用)** to update the cover preview, or go back to choose another image. A cover is optional and can be cleared.
5. Click **Save to draft (保存到草稿)** and wait for upload, saving, and reload verification to finish.
6. Open the draft in X, review it, and publish manually when ready.

You can also run **Save to X draft (保存到 X 草稿)** or use a Markdown file's context menu. Title and cover changes apply only to this draft and do not modify the source note. A selected local cover stays in memory: selecting or cancelling it does not upload it or copy it into the vault. Upload starts only after the final **Save to draft** action. Success notices disappear automatically; no permanent banner covers the top of X.

Consecutive saves reuse the controlled X tab but create a new draft each time. Official MCP lists only tabs controlled by its current connection and does not automatically take over other Chrome tabs. The first save after restarting Obsidian, reloading the plugin, or losing the connection may create a new X tab.

### Cover cropping

**Re-crop (重新裁剪)** retains the original image and crop position for the current dialog session. GIF and animated WebP covers use their first frame. Cropping exports a separate 5:2 PNG up to 2560 pixels wide, leaving body images and source files unchanged. Crop results stay in memory and are neither written back to the note nor retained after the dialog closes.

Preview and upload use the same conversion result. Obsidian `%% comments %%` and HTML comments outside code are removed so hidden writing notes are not uploaded. Literal comment markers inside code are preserved. Unclosed or ambiguous comments produce an explicit error.

### Continue an interrupted save

If a save fails after progress has been captured, the dialog offers **Continue current draft (继续当前草稿)**. Keep the dialog and corresponding X draft open. Continuation checks the request, draft, and existing content, reuses confirmed uploads, and continues the remaining steps. A submitted but unconfirmed image is observed without sending the file again.

Progress lives only in the current dialog's memory. Closing the dialog or restarting Obsidian discards it. Changes to the body, images, or current draft page stop continuation to protect existing content. Sending a request is never treated as proof of a successful save.

### Image uploads and problem logs

Articles with media first save the body without images and reload to verify it. Images are then uploaded one at a time through X's native upload flow. After all uploads finish, the plugin reloads to reconcile media, saves the complete body in source order with the title and cover, and reloads again to verify the full draft. Text appears first; image count, size, and network speed affect completion time.

Each upload and check resolves the current editor and tracks previously confirmed media identities. The next upload starts only when earlier images remain uniquely identifiable, exactly one new image exists, no upload is pending, all images are bound to the saved draft, and repeated checks are stable. Ambiguous identities cause an error rather than a positional guess. Using a body image as the cover preserves its body occurrence.

Open **View log (查看日志)** in the save dialog or plugin settings, or run **View problem log (查看问题日志)** to view and copy the latest operation log. It includes stages, image and browser-operation timings, image counts, request sizes, and failure categories. Readiness counts help distinguish unfinished native uploads from state-detection problems. During a save, click **Refresh (刷新)** to update the display.

Logs are stored only in the plugin's `logs/latest.log`, limited to 128 KiB or 1000 entries. A new save or connection test replaces the previous log. Logs omit article text, titles, file paths, image data, and connection credentials. Past failures that were not logged cannot be reconstructed. Copy the log after a failure before testing the connection or retrying.

## Supported content and limits

| Content | Handling |
| --- | --- |
| Paragraphs, Chinese text, emoji, links | Converted to X Article text |
| Bold, italic, strikethrough, and combinations | Text style ranges preserved |
| First- and second-level body headings | Converted to native X headings |
| Deeper headings | Folded into X's second heading level in both preview and upload |
| Simple quotes, unordered lists, ordered lists starting at 1 | Converted to native text blocks |
| Nested lists, other starting numbers, complex structures | Original Markdown retained; rendering may differ from Obsidian |
| Fenced code, GFM tables | Saved as X Markdown content blocks |
| Body images and covers | PNG, JPEG, GIF, WebP; plugin limit of 20 MB per image |
| Obsidian image embeds | `![[image.png]]` supported; custom display dimensions are not guaranteed |

Vault images and directly downloadable HTTP(S) image URLs are supported. Images remain subject to X's own format, size, and account restrictions. Custom fonts, text colors, arbitrary font sizes, video uploads, multiple accounts, and automatic public posting are not supported. Dataview, task-plugin syntax, scripts, and complex HTML may not render as they do in Obsidian.

Images inside unsupported Markdown structures, article titles, or raw HTML produce an explicit request to adjust the layout rather than silently saving an incomplete article. Move such images into separate paragraphs before saving.

The preview helps check content; it is not a pixel-exact copy of X's editor. Use the saved X draft to check final layout. See the [verification record](docs/validation.md) for the tested scope and remaining checks.

## Privacy and data access

- No telemetry, advertising, remote configuration downloads, or model-service calls. The plugin does not collect vault content for training or analytics.
- Only the note content, body images, and cover you choose to save are sent to X. Other notes are not uploaded in bulk. Chrome keeps your existing signed-in session; the plugin does not ask for your X password or API key.
- Previewing or downloading HTTP(S) images contacts their source websites. Saving contacts X and its media services. Opening documentation or setup links visits the linked websites.
- Runtime detection checks PATH, common Node/npm installation locations, nearby `node_modules`, and npm caches for official MCP. It may run installed Node/npm programs to query versions, global locations, and cache directories. It does not scan the entire disk or run installation commands.
- Running local MCP reads the detected or manually configured Node/MCP program paths, MCP package metadata, and runtime dependencies. It launches a local subprocess and creates a system-temporary directory prefixed `markdown-x-publisher-`. MCP may write page snapshots, operation output, or diagnostic files there; these can contain information from the current article.
- Obsidian APIs read the current note and its referenced vault images. The system file picker reads only the local cover you explicitly select. The plugin does not scan Chrome profile directories, extract browser credential files, or read other AI clients' settings.
- The browser token is read from Obsidian's secret storage and passed only to the local MCP subprocess. It is excluded from logs and release packages. The official extension controls browser access; protect the token as a browser-access credential.
- The local MCP connection stays available after successful saves or resumable failures so later operations can reuse its X tab. Disabling or uninstalling the plugin, changing connection settings, an unrecoverable failure, or reconnecting an invalid connection releases the old connection. This does not close Chrome or existing drafts. Later operations use the current connection settings.

## Development

```sh
npm ci
npm run dev
```

```sh
npm run check
npm run package
```

`check` runs the build, type checks, lint, and tests. `package` creates the installable `dist/markdown-x-publisher/`. The build generates `THIRD_PARTY_NOTICES.md` from esbuild's actual dependency inputs and appends the full application and dependency licenses to `main.js`, so standard three-file plugin downloads also include license notices.

Source is organized under `src/content/`, `src/browser/`, and `src/ui/`. Temporary development files belong in `work/`; release artifacts belong in `dist/`. See [release instructions](docs/releasing.md). Live browser verification uses test articles by default; reproducing a user issue uses a specified article only within that user's authorization and saves it as a draft.

## License

Copyright © 2026 Ancle. Licensed under the [GNU Affero General Public License v3.0 only](LICENSE), SPDX identifier `AGPL-3.0-only`. Bundled open-source dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

This independent community project is not officially affiliated with X, Obsidian, or Microsoft.
