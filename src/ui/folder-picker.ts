interface FolderDialogOptions {
  title: string;
  defaultPath?: string;
  properties: ['openDirectory'];
}

interface DesktopRemote {
  dialog: {
    showOpenDialog(window: object, options: FolderDialogOptions): Promise<{
      canceled: boolean;
      filePaths: string[];
    }>;
  };
  getCurrentWindow(): object;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isDesktopRemote(value: unknown): value is DesktopRemote {
  return isRecord(value) && isRecord(value.dialog)
    && typeof value.dialog.showOpenDialog === 'function'
    && typeof value.getCurrentWindow === 'function';
}

function desktopRemote(): DesktopRemote {
  // Obsidian supplies these modules; only resolve them after a user opens the picker.
  if (typeof require === 'function') {
    const loadModule: (name: string) => unknown = require;
    try {
      const electron = loadModule('electron');
      if (isRecord(electron) && isDesktopRemote(electron.remote)) return electron.remote;
    } catch { /* Some desktop versions expose only the separate remote module. */ }
    try {
      const remote = loadModule('@electron/remote');
      if (isDesktopRemote(remote)) return remote;
    } catch { /* Report an unavailable picker without mistaking it for a missing runtime. */ }
  }
  throw new Error('当前 Obsidian 无法打开系统文件夹选择窗口，请直接填写文件夹路径。');
}

export async function chooseRuntimeFolder(title: string, currentPath: string): Promise<string | null> {
  const remote = desktopRemote();
  try {
    const result = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), {
      title,
      ...(currentPath ? { defaultPath: currentPath } : {}),
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  } catch {
    throw new Error('无法打开系统文件夹选择窗口。请重试，或直接填写文件夹路径。');
  }
}
