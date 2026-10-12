import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';
import type * as ChildProcess from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import type { BrowserBridge, ConnectionSettings, DiagnosticSink } from '../src/model';

// Synthetic JSON-RPC peer only; it never loads Playwright or opens a browser.
const echoSource = `
  const { createInterface } = require('node:readline');
  const echo = process.argv[process.argv.indexOf('--codegen') + 1] !== 'none';
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stdio-echo-fixture', version: '1.0.0' } };
    else if (request.method === 'tools/list') result = { tools: ['browser_tabs', 'browser_navigate', 'browser_evaluate', 'browser_press_key'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    else if (request.method === 'tools/call') {
      const expression = request.params.arguments.function ?? '';
      result = { content: [{ type: 'text', text: '### Result\\ntrue' + (echo ? '\\n### Ran Playwright code\\n' + expression : '') }] };
    } else return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  });
`;
const LARGE_BYTES = 13 * 1024 * 1024;

async function sdkFixture(disableEcho = false) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['-e', echoSource, ...(disableEcho ? ['--', '--codegen', 'none'] : [])], stderr: 'ignore' });
  const client = new Client({ name: 'stdio-regression', version: '1.0.0' }, {});
  const errors: Error[] = [];
  client.onerror = error => errors.push(error);
  await client.connect(transport, { timeout: 5000 });
  return { client, errors };
}

test('real SDK rejects an oversized code echo with ReadBuffer overflow then Connection closed', { timeout: 15000 }, async () => {
  const { client, errors } = await sdkFixture();
  try {
    await assert.rejects(client.callTool({ name: 'browser_evaluate', arguments: { function: 'x'.repeat(LARGE_BYTES) } }, undefined, { timeout: 10000 }),
      (error: unknown) => error instanceof Error && error.message === 'MCP error -32000: Connection closed');
    assert.ok(errors.some(error => /ReadBuffer exceeded maximum size of 10485760 bytes/.test(error.message)));
  } finally { await client.close(); }
});

test('a 13 MiB request with code echo disabled returns a small result and keeps the SDK connection usable', { timeout: 15000 }, async () => {
  const { client, errors } = await sdkFixture(true);
  try {
    const response = await client.callTool({ name: 'browser_evaluate', arguments: { function: 'x'.repeat(LARGE_BYTES) } }, undefined, { timeout: 10000 });
    assert.deepEqual(response.content, [{ type: 'text', text: '### Result\ntrue' }]);
    const final = await client.callTool({ name: 'browser_evaluate', arguments: { function: 'done' } }, undefined, { timeout: 5000 });
    assert.deepEqual(final.content, [{ type: 'text', text: '### Result\ntrue' }]);
    assert.equal(errors.length, 0);
  } finally { await client.close(); }
});

test('production runtime records the real SDK buffer error without logging its payload or reducing it to an unexplained close', { timeout: 15000 }, async () => {
  const bundle = await build({
    entryPoints: ['src/browser/runtime.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'synthetic-stdio-runtime', setup(builder) {
      builder.onLoad({ filter: /[\\/]browser[\\/]discovery\.ts$/ }, () => ({ loader: 'js', contents: `
        export const detectRuntime = async () => ({node:{path:process.execPath,version:process.version},mcp:{path:'synthetic-mcp-only',version:'0.0.83'},issues:[]});
      ` }));
    } }],
  });
  const require = createRequire(import.meta.url);
  const childProcess = require('node:child_process') as typeof ChildProcess;
  const context = createContext({
    module: { exports: {} }, process, Buffer, console, TextEncoder, TextDecoder, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    require: (name: string) => {
      if (name === 'node:fs/promises') return { mkdtemp: async () => resolve('.') };
      // Force the old echo behavior to exercise runtime.onerror even though
      // production now starts official MCP with --codegen none.
      if (name === 'node:child_process' || name === 'child_process') return { ...childProcess,
        spawn: (_command: string, _args: string[], options: ChildProcess.SpawnOptions) => childProcess.spawn(process.execPath, ['-e', echoSource], options) };
      return require(name);
    },
  });
  runInContext(bundle.outputFiles[0]!.text, context);
  const connect = context.module.exports.connectBrowser as (settings: ConnectionSettings, diagnostic: DiagnosticSink) => Promise<BrowserBridge>;
  const events: Array<{ event: string; details?: Parameters<DiagnosticSink>[1] }> = [];
  const bridge = await connect({ nodePath: '', mcpPath: '', token: 'synthetic-credential-only' }, (event, details) => events.push({ event, details }));
  try {
    await assert.rejects(bridge.evaluate(`private-payload-marker${'x'.repeat(LARGE_BYTES)}`), /MCP_MESSAGE_TOO_LARGE/);
    assert.ok(events.some(item => item.event === 'mcp.transport.failed' && item.details?.code === 'transport_message_too_large'));
    assert.ok(events.some(item => item.event === 'mcp.transport.closed' && item.details?.expected === false));
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('private-payload-marker'));
    assert.ok(!serialized.includes('synthetic-credential-only'));
    assert.ok(!serialized.includes('synthetic-mcp-only'));
  } finally { await bridge.close(); }
});
