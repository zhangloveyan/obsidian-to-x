import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { mcpNodeTimers } from '../scripts/mcp-timers.mjs';

for (const persistent of [false, true]) test(`SDK transport closes a ${persistent ? 'persistent' : 'normal'} child with numeric browser timers`, async () => {
  const bundle = await build({
    stdin: { contents: "export { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';", resolveDir: resolve('.') },
    bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [mcpNodeTimers()],
  });
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 0;
  const browserSetTimeout = (callback: () => void, delay = 0): number => {
    const id = ++nextId;
    timers.set(id, setTimeout(() => { timers.delete(id); callback(); }, delay));
    return id;
  };
  const browserClearTimeout = (id: number): void => { clearTimeout(timers.get(id)); timers.delete(id); };
  const context = createContext({
    module: { exports: {} }, require: createRequire(import.meta.url), process, Buffer, console,
    setTimeout: browserSetTimeout, clearTimeout: browserClearTimeout,
  });
  // Match Node's global alias without sharing the host's global object.
  runInContext('globalThis.global = globalThis;', context);
  runInContext(bundle.outputFiles[0]!.text, context);
  const Transport = context.module.exports.StdioClientTransport;
  const source = persistent ? 'process.stdin.resume(); setInterval(() => {}, 60000)' : 'process.stdin.resume()';
  const transport = new Transport({ command: process.execPath, args: ['-e', source], stderr: 'ignore' });
  let pid: number | undefined;
  try {
    await transport.start();
    pid = transport.pid;
    assert.ok(pid, 'the real stdio child process must have started');
    await transport.close();
    await transport.close();
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' }, 'shutdown must actually end the test child process');
    assert.equal(context.setTimeout, browserSetTimeout, 'Obsidian global timers must remain untouched');
    assert.equal(context.clearTimeout, browserClearTimeout);
  } finally {
    for (const timer of timers.values()) clearTimeout(timer);
    await transport.close().catch(() => undefined);
    // Only the synthetic process started by this test may need cleanup on failure.
    if (pid) { try { process.kill(pid, 0); process.kill(pid); } catch { /* Already exited. */ } }
  }
});

test('connection testing preserves a primary failure and distinguishes a shutdown-only failure', async () => {
  const bundle = await build({
    stdin: { contents: "export { testConnection } from './src/browser/runtime';", resolveDir: resolve('.') },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'connection-lifecycle-fixture', setup(builder) {
      builder.onResolve({ filter: /^@modelcontextprotocol\/sdk\/client\/(index|stdio)\.js$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
      builder.onLoad({ filter: /index\.js$/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
        export class Client {
          async connect() {}
          async listTools() { return { tools: ['browser_tabs','browser_navigate','browser_evaluate','browser_press_key'].map(name => ({name})) }; }
          async callTool() { if (globalThis.failOperation) throw new Error('original connection failure'); return { content: [] }; }
          async close() { throw new Error('shutdown failure'); }
        }
      ` }));
      builder.onLoad({ filter: /stdio\.js$/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
        export class StdioClientTransport {}
        export const getDefaultEnvironment = () => ({});
      ` }));
      builder.onLoad({ filter: /[\\/]browser[\\/]discovery\.ts$/ }, () => ({ loader: 'js', contents: `
        export const detectRuntime = async () => ({ node: {path:'fixture-node'}, mcp: {path:'fixture-mcp'}, issues:[] });
      ` }));
    } }],
  });
  const require = createRequire(import.meta.url);
  const context = createContext({
    module: { exports: {} }, process, console, TextEncoder, failOperation: true,
    require: (name: string) => name === 'node:fs/promises' ? { mkdtemp: async () => 'fixture-only' } : require(name),
  });
  runInContext(bundle.outputFiles[0]!.text, context);
  const settings = { nodePath: '', mcpPath: '', token: 'fixture-token' };
  await assert.rejects(context.module.exports.testConnection(settings), /original connection failure/);
  context.failOperation = false;
  await assert.rejects(context.module.exports.testConnection(settings), /浏览器已连接.*shutdown failure/);
});
