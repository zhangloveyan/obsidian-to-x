import { Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type MarkdownXPublisher from './main';
import { detectRuntime } from './browser/discovery';
import { renderBrowserSetup } from './ui/setup';

export interface PublisherSettings {
  nodePath: string;
  mcpPath: string;
  secretName: string;
  autoPreview: boolean;
}

export const DEFAULT_SETTINGS: PublisherSettings = {
  nodePath: '', mcpPath: '', secretName: 'markdown-x-publisher-bridge', autoPreview: true
};

export class PublisherSettingTab extends PluginSettingTab {
  private detectionId = 0;
  constructor(app: App, private publisher: MarkdownXPublisher) { super(app, publisher); }

  display(): void {
    const root = this.containerEl;
    root.empty();
    root.addClass('mxp-settings');
    new Setting(root).setName('运行环境').setHeading();
    root.createEl('p', { cls: 'mxp-help', text: '自动查找这台电脑上已安装的 Node.js 和 Playwright MCP，通常无需填写路径。' });
    const runtimeStatus = root.createDiv({ cls: 'mxp-connection-status' });
    runtimeStatus.setAttribute('role', 'status');
    const nodeStatus = runtimeStatus.createDiv({ text: 'Node.js：检测中…' });
    const mcpStatus = runtimeStatus.createDiv({ text: 'Playwright MCP：检测中…' });
    const runtimeHelp = root.createEl('p', { cls: 'mxp-help' });
    const detect = async () => {
      const id = ++this.detectionId;
      nodeStatus.setText('Node.js：检测中…');
      mcpStatus.setText('Playwright MCP：检测中…');
      runtimeHelp.setText('');
      try {
        const found = await detectRuntime(this.publisher.settings);
        if (id !== this.detectionId) return;
        nodeStatus.setText(found.node ? `Node.js：已找到 ${found.node.version}` : 'Node.js：未找到可用安装');
        mcpStatus.setText(found.mcp ? `Playwright MCP：已找到 ${found.mcp.version}` : 'Playwright MCP：未找到可用安装');
        nodeStatus.title = found.node?.path ?? '';
        mcpStatus.title = found.mcp?.path ?? '';
        runtimeHelp.setText(found.issues.length ? found.issues.join(' ') : '环境已就绪。可以配置或测试下方的浏览器连接。');
      } catch (error) {
        if (id !== this.detectionId) return;
        nodeStatus.setText('运行环境检测未完成');
        mcpStatus.setText('');
        runtimeHelp.setText(error instanceof Error ? error.message : String(error));
      }
    };
    new Setting(root).setName('环境检测').setDesc('安装依赖后重新检测；保存文章和测试连接时也会自动查找。')
      .addButton(button => button.setButtonText('重新检测').onClick(async () => {
        button.setDisabled(true);
        try { await detect(); } finally { button.setDisabled(false); }
      }))
      .addButton(button => button.setButtonText('查看配置说明').onClick(() => this.publisher.showSetup()));
    const advanced = root.createEl('details', { cls: 'mxp-runtime-advanced' });
    advanced.createEl('summary', { text: '高级设置：手动指定程序路径' });
    advanced.createEl('p', { cls: 'mxp-help', text: '仅在自动检测失败或需要指定版本时使用，留空恢复自动检测。' });
    const changedPath = () => {
      ++this.detectionId;
      nodeStatus.setText('程序路径已修改');
      mcpStatus.setText('');
      nodeStatus.title = '';
      mcpStatus.title = '';
      runtimeHelp.setText('点击“重新检测”检查新的配置。');
    };
    new Setting(advanced).setName('Node.js 路径').setDesc('可选，node 可执行文件的完整路径。')
      .addText(input => input.setPlaceholder('自动检测').setValue(this.publisher.settings.nodePath)
        .onChange(async value => {
          this.publisher.settings.nodePath = value.trim().replace(/^"|"$/g, ''); changedPath(); await this.publisher.saveSettings();
        }));
    new Setting(advanced).setName('Playwright MCP 路径').setDesc('可选，官方 @playwright/mcp/cli.js 的完整路径。')
      .addText(input => { input.inputEl.addClass('mxp-path'); input.setPlaceholder('自动检测').setValue(this.publisher.settings.mcpPath)
        .onChange(async value => {
          this.publisher.settings.mcpPath = value.trim().replace(/^"|"$/g, ''); changedPath(); await this.publisher.saveSettings();
        }); });
    new Setting(root).setName('浏览器连接').setHeading();
    renderBrowserSetup(root);
    new Setting(root).setName('浏览器连接凭据').setDesc('只需配置一份密钥：点击 Link（关联），新建密钥并粘贴扩展中的 token，保存后即可重复使用。密钥由 Obsidian 管理。')
      .addComponent(el => new SecretComponent(this.app, el).setValue(this.publisher.settings.secretName)
        .onChange(async value => {
          this.publisher.settings.secretName = value ?? '';
          await this.publisher.saveSettings();
          status.setText(this.publisher.connectionSettings().token ? '连接凭据已配置，点击测试确认可用。' : '尚未配置连接凭据。');
        }));
    root.createEl('p', { cls: 'mxp-help', text: 'Change = 更换当前关联的密钥。插件每次只使用选中的这一份；切换 Chrome 用户配置或 token 变化时才需更新或更换，不用为每篇文章新建。列表里的其他密钥也可能供别的插件使用。' });
    const status = root.createDiv({ cls: 'mxp-connection-status', text: this.publisher.connectionSettings().token ? '连接凭据已配置，点击测试确认可用。' : '尚未配置连接凭据。' });
    status.setAttribute('role', 'status');
    new Setting(root).setName('测试连接').setDesc('只检查连接，不创建或发布文章。')
      .addButton(button => button.setButtonText('测试连接').onClick(async () => {
        if (this.publisher.busy) { new Notice('正在保存草稿，请完成后再测试连接。'); return; }
        button.setDisabled(true).setButtonText('连接中…');
        try { status.setText(await this.publisher.testConnection()); }
        catch (error) { status.setText(`连接失败：${error instanceof Error ? error.message : String(error)}`); }
        finally { button.setDisabled(false).setButtonText('测试连接'); }
      }));
    new Setting(root).setName('问题日志').setDesc('查看、复制最近一次连接或保存的阶段、耗时和状态。日志仅保存在本地，不记录正文和连接凭据。')
      .addButton(button => button.setButtonText('查看日志').onClick(() => this.publisher.showDiagnostics()));
    new Setting(root).setName('预览').setHeading();
    new Setting(root).setName('自动刷新').setDesc('编辑当前笔记时同步刷新预览。')
      .addToggle(toggle => toggle.setValue(this.publisher.settings.autoPreview).onChange(async value => {
        this.publisher.settings.autoPreview = value; await this.publisher.saveSettings();
      }));
    root.createEl('p', { cls: 'mxp-help', text: '文章保存到 X 草稿箱。公开发布仍由你在 X 中完成。' });
    void detect();
  }
}
