import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const PLAYWRIGHT_EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
export interface ChromeExtensionDetection { found: boolean; path?: string; profile?: string; version?: string; }

function environment(name: string): string | undefined {
  const key = Object.keys(process.env).find(key => key.toUpperCase() === name.toUpperCase());
  return key ? process.env[key] : undefined;
}

/** Chrome's standard user-data locations. No browser preferences or account data are read. */
export function chromeUserDataDirectories(): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    const local = environment('LOCALAPPDATA') || join(home, 'AppData', 'Local');
    return ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome SxS'].map(channel => join(local, 'Google', channel, 'User Data'));
  }
  if (process.platform === 'darwin') {
    return ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome Canary']
      .map(channel => join(home, 'Library', 'Application Support', 'Google', channel));
  }
  const configuration = environment('CHROME_CONFIG_HOME') || environment('XDG_CONFIG_HOME') || join(home, '.config');
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable'].map(channel => join(configuration, channel));
}

async function profileDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^(?:Default|Profile \d+)$/.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true })).slice(0, 64);
  } catch { return []; }
}

async function installedInProfile(root: string, profile: string): Promise<ChromeExtensionDetection | undefined> {
  const extension = join(root, profile, 'Extensions', PLAYWRIGHT_EXTENSION_ID);
  try {
    const versions = (await readdir(extension, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^\d+(?:\.\d+){0,3}(?:_\d+)?$/.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left, 'en', { numeric: true })).slice(0, 8);
    for (const versionDirectory of versions) {
      const path = join(extension, versionDirectory);
      try {
        const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as {
          manifest_version?: unknown; version?: unknown;
        } | null;
        if (!manifest || ![2, 3].includes(Number(manifest.manifest_version)) || typeof manifest.version !== 'string'
          || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) continue;
        return { found: true, path, profile, version: manifest.version };
      } catch { /* Missing or incomplete versions do not establish that the extension was found. */ }
    }
  } catch { /* This profile does not contain a readable installation. */ }
  return undefined;
}

/** Locate installed files only; connection tests separately establish whether Chrome can use them. */
export async function detectChromeExtension(userDataDirectories = chromeUserDataDirectories()): Promise<ChromeExtensionDetection> {
  const roots = [...new Set(userDataDirectories.filter(root => isAbsolute(root)))].slice(0, 16);
  for (const root of roots) {
    for (const profile of await profileDirectories(root)) {
      const found = await installedInProfile(root, profile);
      if (found) return found;
    }
  }
  return { found: false };
}
