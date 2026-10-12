import { context } from 'esbuild';
import { builtinModules } from 'node:module';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateNotices } from './notices.mjs';
import { mcpNodeTimers } from './mcp-timers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const build = await context({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'], outfile: 'main.js', bundle: true,
  format: 'cjs', platform: 'node', target: 'es2022', treeShaking: true,
  external: ['obsidian', 'electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)],
  minify: false, sourcemap: watch ? 'inline' : false, legalComments: 'inline', metafile: true,
  loader: { '.css': 'text' },
  banner: { js: '/* Markdown X Publisher — Copyright 2026 Ancle. AGPL-3.0-only. See LICENSE and THIRD_PARTY_NOTICES.md. */' },
  plugins: [mcpNodeTimers(), {
    name: 'release-licenses',
    setup(builder) {
      builder.onEnd(async result => {
        if (result.errors.length || !result.metafile) return;
        await mkdir(join(root, 'work'), { recursive: true });
        await writeFile(join(root, 'work', 'build-meta.json'), `${JSON.stringify(result.metafile, null, 2)}\n`, 'utf8');
        const { text } = await generateNotices({ root });
        const license = await readFile(join(root, 'LICENSE'), 'utf8');
        // Community installation downloads main.js without adjacent license files.
        const comment = value => value.trimEnd().split(/\r?\n/).map(line => `// ${line}`).join('\n');
        await appendFile(join(root, 'main.js'), `\n// Application license\n${comment(license)}\n\n// Bundled dependency licenses\n${comment(text)}\n`, 'utf8');
      });
    },
  }],
});
await build.rebuild();
if (watch) await build.watch(); else await build.dispose();
