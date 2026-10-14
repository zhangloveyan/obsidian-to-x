import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PROBE_TIMEOUT = 4_000;
const MINIMUM_NODE_MAJOR = 18;
const PREFERRED_MCP_VERSION = '0.0.83';
export interface InstalledProgram { path: string; directory: string; version: string; }
export interface RuntimeDetection { node?: InstalledProgram; mcp?: InstalledProgram; nodeIssue?: string; mcpIssue?: string; issues: string[]; }
export interface RuntimePaths { nodePath: string; mcpPath: string; }

function cleanPath(value: string): string { return value.trim().replace(/^"(.*)"$/, '$1'); }
/** Present saved legacy entry paths as folders; filesystem validation still happens on detection/save. */
export function cleanRuntimeDirectory(value: string, kind: 'node' | 'mcp'): string {
  const path = cleanPath(value);
  if (!isAbsolute(path)) return path;
  const isEntry = kind === 'node' ? /^(node|node\.exe)$/i.test(basename(path)) : /\.(?:js|mjs|cjs)$/i.test(path);
  return isEntry ? dirname(path) : path;
}
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

async function existingDirectory(path: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(path);
    return (await stat(resolved)).isDirectory() ? resolved : undefined;
  } catch { return undefined; }
}

export async function inspectNode(configured: string): Promise<InstalledProgram> {
  const input = cleanPath(configured);
  const directory = isAbsolute(input) ? await existingDirectory(input) : undefined;
  const candidates = isAbsolute(input) ? [directory ? join(directory, nodeName()) : input]
    : /^(node|node\.exe)$/i.test(input) ? pathDirectories().map(directory => join(directory, nodeName())) : [];
  for (const candidate of candidates) {
    const path = await existingFile(candidate);
    if (!path) continue;
    let version: string;
    try { version = await execute(path, ['--version']); }
    catch { throw new Error('这个位置的 Node.js 无法运行，请重新选择安装文件夹，或重新安装 Node.js。'); }
    const match = /^v(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/.exec(version);
    if (!match) throw new Error('指定程序没有返回有效的 Node.js 版本。');
    if (Number(match[1]) < MINIMUM_NODE_MAJOR) throw new Error('需要 Node.js 18 或更新版本，请更新 Node.js。');
    return { path, directory: dirname(path), version };
  }
  throw new Error('找不到指定的 Node.js。请选择包含 Node.js 程序的安装文件夹，或清空路径后自动检测。');
}

/** Validate package identity and declared executable; never run an arbitrary JavaScript candidate. */
export async function inspectMcp(configured: string): Promise<InstalledProgram> {
  const input = cleanPath(configured);
  if (!isAbsolute(input)) {
    throw new Error('请选择 Playwright MCP 的安装文件夹，或填写完整路径（绝对路径）。');
  }
  const selectedDirectory = await existingDirectory(input);
  const entry = selectedDirectory ? undefined : await existingFile(input);
  if (!selectedDirectory && (!entry || !['.js', '.mjs', '.cjs'].includes(extname(entry).toLowerCase()))) {
    throw new Error('找不到指定的 Playwright MCP。请选择 @playwright 文件夹中的 mcp 文件夹，或清空路径后自动检测。');
  }
  let directory = selectedDirectory ?? dirname(entry!);
  for (let level = 0; level < (selectedDirectory ? 1 : 6); level++) {
    let contents: string | undefined;
    try { contents = await readFile(join(directory, 'package.json'), 'utf8'); } catch { /* Search the containing package. */ }
    if (contents !== undefined) {
      let manifest: { name?: unknown; version?: unknown; bin?: unknown };
      try { manifest = JSON.parse(contents) as typeof manifest; }
      catch { throw new Error('这个文件夹中的 Playwright MCP 文件已损坏，请重新安装。'); }
      if (manifest?.name !== '@playwright/mcp' || typeof manifest.version !== 'string') break;
      const bin = manifest.bin;
      const commands = typeof bin === 'string' ? [bin]
        : bin && typeof bin === 'object' ? Object.values(bin).filter((value): value is string => typeof value === 'string') : [];
      for (const command of commands) {
        const declaredEntry = await existingFile(resolve(directory, command));
        if (!declaredEntry || !['.js', '.mjs', '.cjs'].includes(extname(declaredEntry).toLowerCase())) continue;
        const inside = relative(directory, declaredEntry);
        if (inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)) continue;
        if (!entry || declaredEntry === entry) return { path: declaredEntry, directory, version: manifest.version };
      }
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('所选位置不是官方 Playwright MCP 的安装文件夹或启动文件。请选择 @playwright 文件夹中的 mcp 文件夹。');
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
      const installed = await inspectMcp(join(root, '@playwright', 'mcp'));
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
    catch (error) { detection.nodeIssue = error instanceof Error ? error.message : '无法检查 Node.js 安装文件夹，请重新选择。'; }
  } else {
    detection.node = await findNode();
    if (!detection.node) detection.nodeIssue = '未找到可用的 Node.js。请按配置教程安装，再点击“自动检测”。';
  }
  if (settings.mcpPath.trim()) {
    try { detection.mcp = await inspectMcp(settings.mcpPath); }
    catch (error) { detection.mcpIssue = error instanceof Error ? error.message : '无法检查 Playwright MCP 安装文件夹，请重新选择。'; }
  } else {
    detection.mcp = await findMcp(detection.node);
    if (!detection.mcp) detection.mcpIssue = '未找到 Playwright MCP。请按配置教程安装，再点击“自动检测”。';
  }
  if (detection.nodeIssue) detection.issues.push(detection.nodeIssue);
  if (detection.mcpIssue) detection.issues.push(detection.mcpIssue);
  return detection;
}
