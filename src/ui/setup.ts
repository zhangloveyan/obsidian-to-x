import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

export function renderBrowserSetup(root: HTMLElement): void {
  root.createEl('p', { cls: 'mxp-help', text: '电脑上的 Playwright MCP 和 Chrome 浏览器扩展都需要安装。请使用平时登录 X 的那个 Chrome 用户配置。' });
  const steps = root.createEl('ol', { cls: 'mxp-browser-steps' });
  const install = steps.createEl('li');
  install.appendText('用 Chrome 打开 ');
  install.createEl('a', {
    text: 'Playwright 扩展商店安装页面',
    href: 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm',
    attr: { target: '_blank', rel: 'noopener noreferrer' },
  });
  install.appendText('，点击“添加至 Chrome”。');
  steps.createEl('li', { text: '安装后，点击 Chrome 工具栏的“扩展程序”（拼图图标），打开 Playwright 扩展。' });
  steps.createEl('li', { text: '在扩展状态页复制 PLAYWRIGHT_MCP_EXTENSION_TOKEN，回到插件设置保存连接密钥。' });
  root.createEl('a', {
    text: '查看官方扩展说明', href: 'https://github.com/microsoft/playwright/blob/main/packages/extension/README.md',
    attr: { target: '_blank', rel: 'noopener noreferrer' },
  });
}

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
    root.createEl('h3', { text: '2. 在日常 Chrome 安装 Playwright 扩展' });
    renderBrowserSetup(root);
    root.createEl('p', { text: '在这个 Chrome 用户配置中登录 X，并确认能够新建长文章。' });
    root.createEl('h3', { text: '3. 保存连接凭据' });
    root.createEl('p', { text: '在插件设置的“浏览器连接凭据”中，点击 Link（关联），新建一份密钥，粘贴刚复制的 token 并保存，然后点击“测试连接”。日常使用只需配置一份，有效凭据会重复使用。' });
    root.createEl('p', { text: 'Change 表示更换当前关联的密钥。只有切换 Chrome 用户配置或 token 变化时，才需要更新或更换；不用为每篇文章新建密钥。凭据仍由 Obsidian 密钥存储管理。' });
    new Setting(root).addButton(button => button.setButtonText('知道了').setCta().onClick(() => this.close()));
  }
  onClose(): void { this.contentEl.empty(); }
}
