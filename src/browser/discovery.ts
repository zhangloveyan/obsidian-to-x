import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PROBE_TIMEOUT = 4_000;
const MINIMUM_NODE_MAJOR = 18;
const PREFERRED_MCP_VERSION = '0.0.83';
export interface InstalledProgram { path: string; version: string; }
export interface RuntimeDetection { node?: InstalledProgram; mcp?: InstalledProgram; issues: string[]; }
export interface RuntimePaths { nodePath: string; mcpPath: string; }

function cleanPath(value: string): string { return value.trim().replace(/^"(.*)"$/, '$1'); }
function environment(name: string): string | undefined {
  const key = Object.keys(process.env).find(key => key.toUpperCase() === name.toUpperCase());
  return key ? process.env[key] : undefined;
}
function unique(values: Array<string | undefined>): string[] {
  const paths = new Map<string, string>();
  for (const value of values) {
    if (!value) continue;
    const path = cleanPath(value);
    if (!path || !isAbsolute(path)) continue;
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (!paths.has(key)) paths.set(key, path);
  }
  return [...paths.values()];
}
function pathDirectories(): string[] { return unique((environment('PATH') ?? '').split(delimiter)); }
function nodeName(): string { return process.platform === 'win32' ? 'node.exe' : 'node'; }

function probeEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith('PLAYWRIGHT_MCP_') && !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())));
}

async function execute(node: string, args: string[]): Promise<string> {
  const { stdout } = await run(node, args, {
    shell: false, windowsHide: true, timeout: PROBE_TIMEOUT, maxBuffer: 64 * 1024,
    encoding: 'utf8', env: probeEnvironment(),
  });
  return stdout.trim();
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(path);
    return (await stat(resolved)).isFile() ? resolved : undefined;
  } catch { return undefined; }
}

export async function inspectNode(configured: string): Promise<InstalledProgram> {
  const input = cleanPath(configured);
  const candidates = isAbsolute(input) ? [input]
    : /^(node|node\.exe)$/i.test(input) ? pathDirectories().map(directory => join(directory, nodeName())) : [];
  for (const candidate of candidates) {
    const path = await existingFile(candidate);
    if (!path) continue;
    let version: string;
    try { version = await execute(path, ['--version']); }
    catch { throw new Error('指定的 Node.js 无法运行，请检查程序路径。'); }
    const match = /^v(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/.exec(version);
    if (!match) throw new Error('指定程序没有返回有效的 Node.js 版本。');
    if (Number(match[1]) < MINIMUM_NODE_MAJOR) throw new Error('需要 Node.js 18 或更新版本，请更新 Node.js。');
    return { path, version };
  }
  throw new Error('找不到指定的 Node.js。请更正高级设置中的路径，或清空路径后自动检测。');
}

/** Validate package identity and declared executable; never run an arbitrary JavaScript candidate. */
export async function inspectMcp(configured: string): Promise<InstalledProgram> {
  const input = cleanPath(configured);
  if (!isAbsolute(input) || !['.js', '.mjs', '.cjs'].includes(extname(input).toLowerCase())) {
    throw new Error('手动指定 MCP 时，请选择官方 @playwright/mcp 的 JavaScript 入口绝对路径。');
  }
  const entry = await existingFile(input);
  if (!entry) throw new Error('找不到指定的 Playwright MCP 文件。请更正高级设置中的路径，或清空路径后自动检测。');
  let directory = dirname(entry);
  for (let level = 0; level < 6; level++) {
    let contents: string | undefined;
    try { contents = await readFile(join(directory, 'package.json'), 'utf8'); } catch { /* Search the containing package. */ }
    if (contents !== undefined) {
      let manifest: { name?: unknown; version?: unknown; bin?: unknown };
      try { manifest = JSON.parse(contents) as typeof manifest; }
      catch { throw new Error('Playwright MCP 的包信息损坏，请重新检查已安装的程序。'); }
      if (manifest?.name !== '@playwright/mcp' || typeof manifest.version !== 'string') break;
      const bin = manifest.bin;
      const commands = typeof bin === 'string' ? [bin]
        : bin && typeof bin === 'object' ? Object.values(bin).filter((value): value is string => typeof value === 'string') : [];
      for (const command of commands) {
        if (await existingFile(resolve(directory, command)) === entry) return { path: entry, version: manifest.version };
      }
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('所选文件不是官方 @playwright/mcp 包声明的 CLI 入口。');
}

async function installedVersions(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && /^v?\d+\.\d+\.\d+$/.test(entry.name))
      .map(entry => entry.name).sort((left, right) => right.localeCompare(left, 'en', { numeric: true })).slice(0, 5)
      .map(version => join(directory, version, process.platform === 'win32' ? '' : 'bin', nodeName()));
  } catch { return []; }
}

async function findNode(): Promise<InstalledProgram | undefined> {
  const home = homedir();
  const paths: Array<string | undefined> = [
    ...pathDirectories().map(directory => join(directory, nodeName())),
    /^node(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : undefined,
  ];
  if (process.platform === 'win32') {
    for (const key of ['NVM_SYMLINK', 'NODE_HOME']) {
      const directory = environment(key);
      if (directory) paths.push(join(directory, nodeName()));
    }
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
      const directory = environment(key);
      if (directory) paths.push(join(directory, 'nodejs', nodeName()));
    }
    const local = environment('LOCALAPPDATA');
    if (local) paths.push(join(local, 'Programs', 'nodejs', nodeName()));
    const nvm = environment('NVM_HOME');
    if (nvm) paths.push(...await installedVersions(nvm));
  } else {
    paths.push('/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node', join(home, '.volta', 'bin', 'node'));
    paths.push(...await installedVersions(join(home, '.nvm', 'versions', 'node')));
  }
  for (const candidate of unique(paths)) {
    if (!await existingFile(candidate)) continue;
    try { return await inspectNode(candidate); } catch { /* An automatic candidate may be an obsolete install. */ }
  }
  return undefined;
}

function neighboringModuleRoots(): string[] {
  // In the installed CommonJS bundle __dirname is the plugin directory.
  let directory = typeof __dirname === 'string' ? __dirname : process.cwd();
  const roots: string[] = [];
  for (let depth = 0; depth < 5; depth++) {
    roots.push(join(directory, 'node_modules'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return roots;
}

function conventionalModuleRoots(node?: InstalledProgram): string[] {
  const locations = [...pathDirectories()];
  if (node) locations.unshift(dirname(node.path));
  const roots = locations.flatMap(directory => [join(directory, 'node_modules'), join(dirname(directory), 'lib', 'node_modules')]);
  const roaming = environment('APPDATA');
  if (roaming) roots.push(join(roaming, 'npm', 'node_modules'));
  const prefix = environment('npm_config_prefix');
  if (prefix) roots.push(join(prefix, 'node_modules'), join(prefix, 'lib', 'node_modules'));
  return unique(roots);
}

async function packageFromRoots(roots: string[]): Promise<InstalledProgram | undefined> {
  let fallback: InstalledProgram | undefined;
  for (const root of unique(roots)) {
    try {
      const installed = await inspectMcp(join(root, '@playwright', 'mcp', 'cli.js'));
      if (installed.version === PREFERRED_MCP_VERSION) return installed;
      fallback ??= installed;
    }
    catch { /* Only valid installed packages qualify for automatic detection. */ }
  }
  return fallback;
}

async function npmLocations(node: InstalledProgram, roots: string[]): Promise<{ root?: string; cache?: string }> {
  for (const root of roots) {
    const cli = await existingFile(join(root, 'npm', 'bin', 'npm-cli.js'));
    if (!cli) continue;
    try {
      const manifest = JSON.parse(await readFile(join(root, 'npm', 'package.json'), 'utf8')) as { name?: unknown };
      if (manifest.name !== 'npm') continue;
      const flags = ['--ignore-scripts', '--no-update-notifier'];
      const [globalResult, cacheResult] = await Promise.allSettled([
        execute(node.path, [cli, 'root', '-g', ...flags]),
        execute(node.path, [cli, 'config', 'get', 'cache', ...flags]),
      ]);
      const globalRoot = globalResult.status === 'fulfilled' && isAbsolute(globalResult.value) ? globalResult.value : undefined;
      const cache = cacheResult.status === 'fulfilled' && isAbsolute(cacheResult.value) ? cacheResult.value : undefined;
      return { root: globalRoot, cache };
    } catch { /* Try another already-installed npm; no shell shims or installers. */ }
  }
  return {};
}

async function cachedPackage(cache: string): Promise<InstalledProgram | undefined> {
  const directory = join(cache, '_npx');
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f\d]{8,64}$/i.test(entry.name))
      .map(entry => entry.name);
  } catch { return undefined; }
  const recent = await Promise.all(names.map(async name => {
    const folder = join(directory, name);
    return { folder, modified: await stat(folder).then(value => value.mtimeMs).catch(() => 0) };
  }));
  recent.sort((left, right) => right.modified - left.modified);
  return packageFromRoots(recent.slice(0, 64).map(item => join(item.folder, 'node_modules')));
}

async function findMcp(node?: InstalledProgram): Promise<InstalledProgram | undefined> {
  const nearby = await packageFromRoots(neighboringModuleRoots());
  if (nearby?.version === PREFERRED_MCP_VERSION) return nearby;
  let fallback = nearby;
  const roots = conventionalModuleRoots(node);
  const conventional = await packageFromRoots(roots);
  if (conventional?.version === PREFERRED_MCP_VERSION) return conventional;
  fallback ??= conventional;
  const npm = node ? await npmLocations(node, roots) : {};
  if (npm.root) {
    const global = await packageFromRoots([npm.root]);
    if (global?.version === PREFERRED_MCP_VERSION) return global;
    fallback ??= global;
  }
  const local = environment('LOCALAPPDATA');
  const roaming = environment('APPDATA');
  const caches = unique([npm.cache, environment('npm_config_cache'), local ? join(local, 'npm-cache') : undefined,
    roaming ? join(roaming, 'npm-cache') : undefined, join(homedir(), '.npm')]);
  for (const cache of caches) {
    const cached = await cachedPackage(cache);
    if (cached?.version === PREFERRED_MCP_VERSION) return cached;
    fallback ??= cached;
  }
  return fallback;
}

export async function detectRuntime(settings: RuntimePaths): Promise<RuntimeDetection> {
  const detection: RuntimeDetection = { issues: [] };
  if (settings.nodePath.trim()) {
    try { detection.node = await inspectNode(settings.nodePath); }
    catch (error) { detection.issues.push(error instanceof Error ? error.message : 'Node.js 路径验证失败。'); }
  } else {
    detection.node = await findNode();
    if (!detection.node) detection.issues.push('没有找到可用的 Node.js 18 或更新版本。请先安装 Node.js，再点击重新检测；通常无需手填路径。');
  }
  if (settings.mcpPath.trim()) {
    try { detection.mcp = await inspectMcp(settings.mcpPath); }
    catch (error) { detection.issues.push(error instanceof Error ? error.message : 'Playwright MCP 路径验证失败。'); }
  } else {
    detection.mcp = await findMcp(detection.node);
    if (!detection.mcp) detection.issues.push('没有找到已安装的 Playwright MCP。请按安装说明安装一次，然后重新检测；插件不会自动下载或安装。');
  }
  return detection;
}
