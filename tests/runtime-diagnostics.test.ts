import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import type { BrowserBridge, ConnectionSettings, DiagnosticSink } from '../src/model';

const settings = { nodePath: 'private-node-path', mcpPath: 'private-mcp-path', token: 'private-connection-token' };

async function fixture() {
  const bundle = await build({
    stdin: { contents: "export { connectBrowser, testConnection } from './src/browser/runtime';", resolveDir: resolve('.') },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'runtime-diagnostics-fixture', setup(builder) {
      builder.onResolve({ filter: /^@modelcontextprotocol\/sdk\/client\/(index|stdio)\.js$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
      builder.onLoad({ filter: /index\.js$/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
        export class Client {
          async connect() {}
          async listTools() { return { tools: ['browser_tabs','browser_navigate','browser_evaluate','browser_press_key'].map(name => ({name})) }; }
          async callTool() {
            if (globalThis.mode === 'oversized') {
              this.onerror?.(new Error('ReadBuffer exceeded maximum size of 10485760 bytes'));
              this.onclose?.();
              throw new Error('MCP error -32000: Connection closed');
            }
            if (globalThis.mode === 'ambiguous') throw new Error('Error: MXP_CREATE_AMBIGUOUS: 未找到唯一的新建文章入口（找到 2 个），private article detail');
            if (globalThis.mode === 'failure') throw new Error('source failure: private article payload');
            if (globalThis.mode === 'invalid') return { content: [{type:'text',text:'private invalid response'}] };
            return { content: [{type:'text',text:'### Result\\n"private article result"'}] };
          }
          async close() {}
        }
      ` }));
      builder.onLoad({ filter: /stdio\.js$/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
        export class StdioClientTransport { constructor(options) { globalThis.transportArgs = options.args; } }
        export const getDefaultEnvironment = () => ({});
      ` }));
      builder.onLoad({ filter: /[\\/]browser[\\/]discovery\.ts$/ }, () => ({ loader: 'js', contents: `
        export const detectRuntime = async () => ({node:{path:'private-node-path',version:'v22.14.0'},mcp:{path:'private-mcp-path',version:'0.0.83'},issues:[]});
      ` }));
    } }],
  });
  const require = createRequire(import.meta.url);
  const context = createContext({
    module: { exports: {} }, process, console, TextEncoder, mode: 'success',
    require: (name: string) => name === 'node:fs/promises' ? { mkdtemp: async () => 'private-temp-path' } : require(name),
  });
  runInContext(bundle.outputFiles[0]!.text, context);
  return { context, connect: context.module.exports.connectBrowser as (settings: ConnectionSettings, diagnostic?: DiagnosticSink) => Promise<BrowserBridge>,
    test: context.module.exports.testConnection as (settings: ConnectionSettings, diagnostic?: DiagnosticSink) => Promise<string> };
}

test('runtime disables code echo and logs timing without paths, credentials, expressions or results', async () => {
  const { connect, context } = await fixture();
  const events: Array<{ event: string; details?: Parameters<DiagnosticSink>[1] }> = [];
  const bridge = await connect(settings, (event, details) => events.push({ event, details }));
  assert.equal(context.transportArgs[context.transportArgs.indexOf('--codegen') + 1], 'none');
  assert.equal(await bridge.evaluate('() => "private expression"'), 'private article result');
  await bridge.call('browser_navigate', { url: 'https://example.com/private?credential=private-argument' });
  await bridge.close();
  const serialized = JSON.stringify(events);
  for (const value of ['private-node-path', 'private-mcp-path', 'private-connection-token', 'private-temp-path', 'private expression', 'private article result', 'private-argument']) {
    assert.ok(!serialized.includes(value), `log must omit ${value}`);
  }
  assert.ok(events.some(item => item.event === 'runtime.versions' && item.details?.mcpVersion === '0.0.83'));
  assert.ok(events.some(item => item.event === 'mcp.tool.completed' && item.details?.tool === 'browser_evaluate' && typeof item.details.elapsedMs === 'number'));
  assert.ok(events.some(item => item.event === 'mcp.tool.started' && typeof item.details?.argumentBytes === 'number'));
  assert.ok(events.some(item => item.event === 'mcp.close.completed'));
});

test('preserves the buffer overflow cause when the following connection-closed error rejects the tool', async () => {
  const { connect, context } = await fixture();
  const events: Array<{ event: string; details?: Parameters<DiagnosticSink>[1] }> = [];
  const bridge = await connect(settings, (event, details) => events.push({ event, details }));
  context.mode = 'oversized';
  await assert.rejects(bridge.evaluate('private expression'), /MCP_MESSAGE_TOO_LARGE/);
  assert.ok(events.some(item => item.event === 'mcp.transport.failed' && item.details?.code === 'transport_message_too_large'));
  assert.ok(events.some(item => item.event === 'mcp.transport.closed' && item.details?.expected === false));
  assert.ok(!JSON.stringify(events).includes('private'));
  await bridge.close();
});

test('tool and parse failures are logged without hiding the operation error or leaking raw responses', async () => {
  const { connect, context } = await fixture();
  const events: Array<{ event: string; details?: Parameters<DiagnosticSink>[1] }> = [];
  const bridge = await connect(settings, (event, details) => events.push({ event, details }));
  context.mode = 'failure';
  await assert.rejects(bridge.call('browser_tabs', { action: 'list' }), /source failure: private article payload/);
  assert.ok(events.some(item => item.event === 'mcp.tool.failed' && item.details?.success === false));
  context.mode = 'invalid';
  await assert.rejects(bridge.evaluate('private expression'), /没有返回/);
  assert.ok(events.some(item => item.event === 'mcp.evaluate.failed' && item.details?.code === 'invalid_result'));
  assert.ok(!JSON.stringify(events).includes('private'));
  await bridge.close();
});

test('a broken diagnostic callback cannot break connection, tool calls or shutdown', async () => {
  const { test: check } = await fixture();
  assert.match(await check(settings, () => { throw new Error('diagnostic sink failed'); }), /已连接日常 Chrome/);
  assert.match(await check(settings, async () => { throw new Error('async diagnostic sink failed'); }), /已连接日常 Chrome/);
});

test('the first failed tool call records an actionable category and count without its raw text', async () => {
  const { connect, context } = await fixture();
  const events: Array<{ event: string; details?: Parameters<DiagnosticSink>[1] }> = [];
  const bridge = await connect(settings, (event, details) => events.push({ event, details }));
  context.mode = 'ambiguous';
  await assert.rejects(bridge.evaluate('private expression'), /找到 2 个/);
  const failure = events.find(item => item.event === 'mcp.tool.failed');
  assert.equal(failure?.details?.code, 'create_entry_ambiguous');
  assert.equal(failure?.details?.count, 2);
  assert.ok(!JSON.stringify(events).includes('private'));
  await bridge.close();
});
