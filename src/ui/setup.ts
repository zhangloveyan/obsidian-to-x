import { Modal, Notice, Platform } from 'obsidian';
import type { App } from 'obsidian';

const MCP_INSTALL_COMMAND = 'npm install -g @playwright/mcp@0.0.83';
const EXTENSION_URL = 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm';

function externalLink(root: HTMLElement, text: string, href: string, cls?: string): void {
  root.createEl('a', {
    text, href, cls,
    attr: { target: '_blank', rel: 'noopener noreferrer' },
  });
}

function step(root: HTMLElement, number: number, title: string): HTMLElement {
  const section = root.createDiv({ cls: 'mxp-setup-step' });
  section.createSpan({ cls: 'mxp-setup-step-number', text: String(number), attr: { 'aria-hidden': 'true' } });
  section.createEl('h3', { text: title });
  return section;
}

function question(root: HTMLElement, title: string): HTMLElement {
  const details = root.createEl('details');
  details.createEl('summary', { text: title });
  return details.createDiv({ cls: 'mxp-setup-detail-body' });
}

function appendCode(root: HTMLElement, text: string): void {
  root.createEl('code', { text });
}

export class SetupModal extends Modal {
  constructor(app: App) { super(app); }

  onOpen(): void {
    this.setTitle('配置教程');
    const root = this.contentEl;
    root.empty();
    root.addClass('mxp-setup');
    root.createDiv({ cls: 'mxp-setup-platform', text: Platform.isWin ? 'Windows' : Platform.isMacOS ? 'macOS' : 'Linux' });
    root.createEl('p', {
      cls: 'mxp-setup-intro',
      text: '首次使用按下面四步配置。设置中已显示“已找到”的项目，可以跳过安装。',
    });

    this.renderNodeStep(root);
    this.renderMcpStep(root);
    this.renderExtensionStep(root);
    this.renderConnectionStep(root);
    this.renderTroubleshooting(root);

    const footer = root.createDiv({ cls: 'mxp-setup-footer' });
    const sources = footer.createDiv({ cls: 'mxp-setup-sources' });
    externalLink(sources, 'MCP 官方说明 ↗', 'https://github.com/microsoft/playwright-mcp');
    externalLink(sources, '扩展官方说明 ↗', 'https://github.com/microsoft/playwright/blob/main/packages/extension/README.md');
    const back = footer.createEl('button', { cls: 'mod-cta', text: '返回设置', attr: { type: 'button' } });
    back.addEventListener('click', () => this.close());
  }

  private renderNodeStep(root: HTMLElement): void {
    const section = step(root, 1, '安装 Node.js');
    section.createEl('p', { cls: 'mxp-setup-purpose', text: '它用来运行插件连接浏览器时需要的程序。' });
    externalLink(section, '打开 Node.js 下载页面 ↗', 'https://nodejs.org/en/download', 'mxp-setup-link');
    const list = section.createEl('ol', { cls: 'mxp-setup-instructions' });
    if (Platform.isWin || Platform.isMacOS) {
      list.createEl('li', {
        text: Platform.isWin
          ? '选择 Windows 和 LTS（长期支持版），下载 .msi 安装程序。'
          : '选择 macOS 和 LTS（长期支持版），下载 .pkg 安装程序。',
      });
      list.createEl('li', { text: '双击下载的文件，按提示完成安装，保留默认选项即可。' });
    } else {
      list.createEl('li', { text: '选择 Linux 和 LTS（长期支持版），按照下载页面对应的安装说明完成安装。' });
    }
  }

  private renderMcpStep(root: HTMLElement): void {
    const section = step(root, 2, '安装 Playwright MCP');
    section.createEl('p', { cls: 'mxp-setup-purpose', text: '它是安装在电脑上的工具，负责让插件连接并操作浏览器。' });
    const list = section.createEl('ol', { cls: 'mxp-setup-instructions' });
    this.renderTerminalInstruction(list.createEl('li'));
    list.createEl('li', { text: '复制下面的命令，粘贴到刚打开的窗口中，再按回车。' });

    const command = section.createDiv({ cls: 'mxp-setup-command' });
    command.createEl('pre').createEl('code', { text: MCP_INSTALL_COMMAND });
    const actions = command.createDiv({ cls: 'mxp-setup-command-actions' });
    actions.createSpan({ text: '使用本插件已验证的版本' });
    const copy = actions.createEl('button', { text: '复制安装命令', attr: { type: 'button' } });
    copy.addEventListener('click', () => {
      void this.copyInstallCommand(copy);
    });
    section.createEl('p', { text: '等待命令执行结束，回到设置点击“自动检测”。看到 Node.js 和 Playwright MCP 都显示“已找到”后，点击“保存配置”。显示“已保存”后，继续下一步。' });
  }

  private renderTerminalInstruction(root: HTMLElement): void {
    if (Platform.isWin) {
      root.appendText('同时按键盘上的 ');
      root.createEl('kbd', { text: 'Win' });
      root.appendText(' + ');
      root.createEl('kbd', { text: 'R' });
      root.appendText('，输入 ');
      appendCode(root, 'cmd');
      root.appendText('，按回车。');
    } else if (Platform.isMacOS) {
      root.appendText('同时按 ');
      root.createEl('kbd', { text: '⌘' });
      root.appendText(' + ');
      root.createEl('kbd', { text: '空格' });
      root.appendText('，搜索“终端”并打开。');
    } else {
      root.appendText('从电脑的应用列表中打开“终端”。');
    }
  }

  private async copyInstallCommand(button: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(MCP_INSTALL_COMMAND);
      button.setText('已复制');
      new Notice('安装命令已复制。', 2500);
    } catch {
      new Notice('未能复制，请选中上方的安装命令并手动复制。', 5000);
    }
  }

  private renderExtensionStep(root: HTMLElement): void {
    const section = step(root, 3, '在 Chrome 中安装 Playwright 扩展');
    section.createEl('p', { text: '打开你平时登录 X 的那个 Chrome 窗口，在这个窗口中打开下面的安装页面。' });
    externalLink(section, '打开扩展安装页面 ↗', EXTENSION_URL, 'mxp-setup-link');
    const list = section.createEl('ol', { cls: 'mxp-setup-instructions' });
    list.createEl('li', { text: '确认扩展名称为 Playwright Extension，点击“添加至 Chrome”，再按提示添加。' });
    list.createEl('li', { text: '安装完成后，点击 Chrome 右上角的拼图图标，在扩展列表里打开 Playwright。' });
    section.createDiv({ cls: 'mxp-setup-note', text: '如果链接打开在其他浏览器，请把网址复制到 Chrome 的地址栏，再按回车。' });
  }

  private renderConnectionStep(root: HTMLElement): void {
    const section = step(root, 4, '复制密钥，保存并测试连接');
    const list = section.createEl('ol', { cls: 'mxp-setup-instructions' });
    const token = list.createEl('li');
    token.appendText('在刚打开的扩展页面找到 ');
    appendCode(token, 'PLAYWRIGHT_MCP_EXTENSION_TOKEN');
    token.appendText('，复制它对应的密钥值。');
    list.createEl('li', { text: '回到 Obsidian 的本插件设置，把密钥粘贴到“连接密钥”，点击“保存”。' });
    list.createEl('li', { text: '保持 Chrome 打开，点击“测试连接”。' });
    section.createEl('p', { cls: 'mxp-setup-success', text: '✓ 显示“已连接到 Chrome”后，浏览器连接就配置好了。' });
    section.createEl('p', { cls: 'mxp-setup-purpose', text: '以后可以继续使用已保存的密钥，无需每篇文章重新填写。' });
    section.createDiv({ cls: 'mxp-setup-note', text: '使用前，请在这个 Chrome 窗口中登录 X，并确认你的账号能新建长文章。连接测试只检查插件能否连上 Chrome。' });
  }

  private renderTroubleshooting(root: HTMLElement): void {
    const section = root.createDiv({ cls: 'mxp-setup-trouble' });
    section.createEl('h2', { text: '遇到问题时' });
    const detection = question(section, '手动填写后再点“自动检测”，路径会被覆盖吗？');
    detection.createEl('p', { text: '已填写的路径只会被检查，不会被替换；空白项才会自动查找并填入。' });
    detection.createEl('p', { text: '输入、选择或自动找到的路径，都要点击“保存配置”后才会生效。保存时会检查两个目录；失败时保留你的输入，原有配置继续有效。' });
    detection.createEl('p', { text: '运行环境有未保存的修改时，请先保存配置，再测试浏览器连接。' });

    const paths = question(section, '已经安装了，为什么仍显示“未找到”？');
    paths.createEl('p', { text: '刚安装 Node.js 时，先退出并重新打开 Obsidian，再点击“自动检测”。' });
    paths.createEl('p', { text: '如果仍未找到，点击输入框右侧的文件夹图标选择安装文件夹，也可以粘贴完整路径。选中后的效果与手动输入相同；取消选择不会改动路径。' });
    const node = paths.createEl('p');
    node.createEl('strong', { text: 'Node.js：' });
    node.appendText('在刚才的命令窗口输入 ');
    appendCode(node, Platform.isWin ? 'where node' : 'command -v node');
    node.appendText(`，按回车。复制结果中 ${Platform.isWin ? 'node.exe' : 'node'} 前面的文件夹路径。`);
    paths.createEl('pre', { text: Platform.isWin
      ? '例如：C:\\Program Files\\nodejs\\node.exe\n填写：C:\\Program Files\\nodejs'
      : '例如：/usr/local/bin/node\n填写：/usr/local/bin' });

    const mcp = paths.createEl('p');
    mcp.createEl('strong', { text: 'Playwright MCP：' });
    mcp.appendText('输入 ');
    appendCode(mcp, 'npm root -g');
    mcp.appendText('，按回车。在返回的路径后面加上 ');
    appendCode(mcp, Platform.isWin ? '\\@playwright\\mcp' : '/@playwright/mcp');
    mcp.appendText('，将完整路径填入设置。');
    paths.createEl('pre', { text: Platform.isWin
      ? '例如：C:\\Users\\你的用户名\\AppData\\Roaming\\npm\\node_modules\n填写：C:\\Users\\你的用户名\\AppData\\Roaming\\npm\\node_modules\\@playwright\\mcp'
      : '例如：/usr/local/lib/node_modules\n填写：/usr/local/lib/node_modules/@playwright/mcp' });
    paths.createEl('p', { text: '这些只是路径示例，请使用你电脑上显示的结果。改好后点击“保存配置”，插件会检查两个目录，通过后一起生效。需要重新自动查找某一项时，清空那一项再点击“自动检测”。' });
    const extension = paths.createEl('p');
    extension.createEl('strong', { text: '扩展未找到：' });
    extension.appendText('在 Chrome 地址栏输入 ');
    appendCode(extension, 'chrome://extensions');
    extension.appendText('，按回车，检查列表里是否有 Playwright。若能看到它，可先保存密钥并测试连接，确认实际是否能连上。');

    const npm = question(section, Platform.isWin
      ? '安装命令提示“npm 不是内部或外部命令”'
      : '安装命令提示“npm: command not found”');
    npm.createEl('p', { text: Platform.isWin
      ? '确认第一步已完成 Node.js 安装。关闭命令窗口，重新按 Win + R 打开 cmd，再运行安装命令。'
      : '确认第一步已完成 Node.js 安装。关闭终端窗口，重新打开终端，再运行安装命令。' });
    npm.createEl('p', { text: Platform.isWin || Platform.isMacOS
      ? '若仍提示找不到 npm，重新运行 Node.js 安装程序并保留默认选项，然后再试。'
      : '若仍提示找不到 npm，请返回 Node.js 下载页面，检查安装步骤是否全部完成。' });

    const connection = question(section, '密钥已经保存，测试连接仍然失败');
    const checks = connection.createEl('ol');
    checks.createEl('li', { text: '打开平时登录 X 的 Chrome，保持窗口开启。' });
    const enabled = checks.createEl('li');
    enabled.appendText('在地址栏输入 ');
    appendCode(enabled, 'chrome://extensions');
    enabled.appendText('，确认 Playwright 的开关已打开。');
    checks.createEl('li', { text: '在这个 Chrome 窗口里重新打开 Playwright 扩展，复制密钥，回到插件保存，再测试。' });
    connection.createEl('p', { text: '如果你在 Chrome 中使用多个用户，请从右上角的头像菜单，切换到登录 X 的那个用户，再打开扩展复制密钥。' });
    connection.createEl('p', { text: '仍然失败时，点击设置页的“查看日志”，查看本次失败的具体记录。' });
  }

  onClose(): void { this.contentEl.empty(); }
}
