import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

export class SetupModal extends Modal {
  constructor(app: App) { super(app); }
  onOpen(): void {
    this.setTitle('连接日常 Chrome');
    const root = this.contentEl;
    root.addClass('mxp-setup');
    root.createEl('p', { text: '插件会自动检测已安装的运行环境。首次使用按下列步骤补齐缺少的组件，再测试连接。' });
    root.createEl('h3', { text: '1. 安装 Node.js 与 Playwright MCP' });
    root.createEl('a', { text: '下载 Node.js', href: 'https://nodejs.org/en/download', attr: { target: '_blank', rel: 'noopener noreferrer' } });
    root.createEl('p', { text: '如果已安装，可以跳过。缺少 MCP 时，在终端运行：' });
    root.createEl('pre').createEl('code', { text: 'npm install -g @playwright/mcp@0.0.83' });
    root.createEl('p', { text: '完成后回到插件设置，点击“重新检测”。通常无需查找或填写程序路径；特殊安装位置可在高级设置中指定。刚安装 Node.js 仍未检测到时，重新启动 Obsidian 后再试。插件不会自动下载、安装或更新这些组件。' });
    root.createEl('h3', { text: '2. 在日常 Chrome 安装 Bridge 扩展' });
    root.createEl('a', { text: '打开官方扩展说明', href: 'https://github.com/microsoft/playwright/blob/main/packages/extension/README.md', attr: { target: '_blank', rel: 'noopener noreferrer' } });
    root.createEl('p', { text: '在同一个 Chrome 用户配置中登录 X，并确认能够新建长文章。' });
    root.createEl('h3', { text: '3. 保存连接凭据' });
    root.createEl('p', { text: '打开 Bridge 扩展，复制 PLAYWRIGHT_MCP_EXTENSION_TOKEN。在插件设置的“浏览器连接凭据”中新建密钥并粘贴，然后点击“测试连接”。凭据由 Obsidian 密钥存储管理，无需创建任何文本文件。有效凭据配置后，后续保存无需逐次点击允许。' });
    new Setting(root).addButton(button => button.setButtonText('知道了').setCta().onClick(() => this.close()));
  }
  onClose(): void { this.contentEl.empty(); }
}
