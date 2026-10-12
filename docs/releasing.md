# 发布 Markdown X Publisher

本说明按 **2026-10-12** 核对的官方流程整理。源码仓库为 [zhangloveyan/obsidian-to-x](https://github.com/zhangloveyan/obsidian-to-x)，插件 ID 为 `markdown-x-publisher`。发布到 GitHub 和提交社区目录是两个单独动作，准备好产物并不代表已经发布或通过审核。

## 1. 准备源码和版本

仓库根目录保留 `README.md`、`LICENSE`、`manifest.json`、`versions.json`、源码、测试、构建脚本和 `package-lock.json`。应用许可证为 `AGPL-3.0-only`，作者为 `Ancle`。第三方完整许可证由构建生成，随源码和产物保留。

版本号在 `package.json`、`manifest.json` 保持一致，并在 `versions.json` 中记录对应的最低 Obsidian 版本。当前最低版本为 `1.11.7`；插件使用桌面 Node.js 运行时，`isDesktopOnly` 必须保持 `true`。后续提高最低版本时同步核对实际使用的 API。[官方提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)

插件 ID 为 `markdown-x-publisher`。目录收录前检查 ID 是否可用；首次公开使用后保持稳定。仓库名可以不同于插件 ID。

## 2. 验证并打包

```sh
npm ci
npm run package
```

生成的安装目录为：

```text
dist/markdown-x-publisher/
  main.js
  manifest.json
  styles.css
  LICENSE
  THIRD_PARTY_NOTICES.md
```

`scripts/build.mjs` 写出 `work/build-meta.json`；`scripts/notices.mjs` 只为实际贡献到 JavaScript bundle 的依赖收集包名、版本和完整许可证。构建把应用及依赖许可附入 `main.js`。`scripts/mcp-timers.mjs` 仅在构建 SDK 的 stdio 模块时绑定 Node.js 定时器，兼容 Obsidian 界面的浏览器定时器；不修改宿主全局对象或安装的依赖文件。`scripts/package.mjs` 校验版本和内嵌许可，复制明确列出的文件，不打包 `data.json`、密钥、笔记或开发依赖。

发布前对本次版本完成实际 Obsidian 与 Chrome 验收，并在发布说明中如实记录验证平台、应用/MCP/扩展版本和未验证范围。至少核对：首次设置、持久凭据后再次连接、预览、标题封面确认、基础格式、图片、草稿刷新验证以及失败反馈。测试内容使用合成文章。

可将 `dist/markdown-x-publisher/` 压缩为 `markdown-x-publisher-<version>.zip` 供手动安装。ZIP 根目录应包含 `markdown-x-publisher/` 文件夹。打包脚本不安装、启用或上传插件。

## 3. 在 GitHub 开源并创建 Release

向公开仓库 `zhangloveyan/obsidian-to-x` 发布完整、可构建源码，保留许可证与第三方声明。README 中的网络、账号、付费条件、笔记库外程序和文件访问披露应与实现一致；插件不得自动安装依赖或加入遥测。[官方开发者政策](https://docs.obsidian.md/community-directory/developer-policies)

GitHub Release 的 tag 必须与 `manifest.json` 的 `version` 完全一致，例如 `0.1.0`，不要加 `v`。至少单独上传 `dist/markdown-x-publisher/` 中的 `main.js`、`manifest.json`、`styles.css`；另外上传 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和手动安装 ZIP。GitHub 自动生成的源码归档不能替代插件附件。[官方发布步骤](https://docs.obsidian.md/plugins/releasing/submit-plugin)

社区安装器只取标准插件文件，不会自动下载旁边的 LICENSE/NOTICE 文件。因此应使用本项目构建生成的、带完整许可证注释的 `main.js`，不要另行去掉许可注释。发布 tag 对应源码必须能够复现该构建，并按照 AGPL 条款提供相应源码。

本地源码、检查结果和待上传附件整理完毕后，才执行已获授权的 push、Release 创建或社区提交；本说明不自动触发这些动作。

## 4. 提交 Obsidian 社区目录

当前官方入口是 [Obsidian Community](https://community.obsidian.md)，流程为：

1. 用 Obsidian 账号登录，在个人资料中连接自己的 GitHub 账号。
2. 进入 **Plugins → New plugin**，填入真实 GitHub 仓库地址和维护者。
3. 阅读开发者政策，确认维护责任后提交。
4. 按目录显示的审查结果修正问题，必要时递增版本并重新发布 GitHub Release。

具体界面见[账号设置及添加插件](https://docs.obsidian.md/community-directory/set-up-and-claim)。目录读取默认分支 HEAD 的 `manifest.json`，所以该文件和对应 Release 都需准备好。插件通过所需检查并发布后，用户才可在 Obsidian 中安装；独立开发、AGPL 开源或本地测试通过，都不构成一定通过审核的保证。[官方提交与审核说明](https://docs.obsidian.md/plugins/releasing/submit-plugin)

## 5. 后续版本

每次更新按同样步骤验证、更新三处版本信息、重新生成许可证和安装附件，再创建同版本 GitHub Release。首版收录后通常不需每版重新提交插件，但应响应目录后续审查结果。不要在插件内部实现自更新或自动更新外部 MCP 依赖。[官方提交说明](https://docs.obsidian.md/plugins/releasing/submit-plugin) · [开发者政策](https://docs.obsidian.md/community-directory/developer-policies)
