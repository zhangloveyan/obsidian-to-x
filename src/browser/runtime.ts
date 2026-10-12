import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Buffer } from 'node:buffer';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserBridge, ConnectionSettings, DiagnosticSink } from '../model';
import { detectRuntime } from './discovery';
import { classifyDiagnosticError } from '../diagnostics';

const TOKEN_KEY = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN';
const REQUEST_TIMEOUT = 180_000;
const REQUIRED_TOOLS = ['browser_tabs', 'browser_navigate', 'browser_evaluate', 'browser_press_key'];

function emitDiagnostic(diagnostic: DiagnosticSink | undefined, event: string, details: Record<string, string | number | boolean | null> = {}): void {
  try { void Promise.resolve(diagnostic?.(event, details)).catch(() => undefined); }
  catch { /* Logging must not affect browser operations. */ }
}

async function measured<T>(diagnostic: DiagnosticSink | undefined, event: string, details: Record<string, string | number | boolean | null>, operation: () => Promise<T>): Promise<T> {
  const started = Date.now();
  emitDiagnostic(diagnostic, `${event}.started`, details);
  try {
    const result = await operation();
    emitDiagnostic(diagnostic, `${event}.completed`, { ...details, elapsedMs: Math.max(0, Date.now() - started), success: true });
    return result;
  } catch (error) {
    // Raw error messages may embed page content, file names or connection URLs.
    emitDiagnostic(diagnostic, `${event}.failed`, { ...details, ...classifyDiagnosticError(error), elapsedMs: Math.max(0, Date.now() - started), success: false });
    throw error;
  }
}

export function normalizeToken(text: string): string {
  const value = text.trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*/, '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

export function browserEnvironment(inherited: Record<string, string | undefined>, token: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !name.toUpperCase().startsWith('PLAYWRIGHT_MCP_')) result[name] = value;
  }
  result[TOKEN_KEY] = normalizeToken(token);
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function toolText(response: unknown): string {
  if (!record(response) || !Array.isArray(response.content)) throw new Error('浏览器工具返回了无法识别的响应。');
  return response.content
    .filter((item): item is { type: string; text: string } => record(item) && item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text).join('\n');
}

export function assertToolSuccess(response: unknown): void {
  if (!record(response)) throw new Error('浏览器工具没有返回有效响应。');
  if (response.isError === true) throw new Error(toolText(response) || '浏览器操作失败。');
}

export function parseEvaluationResult<T>(response: unknown): T {
  assertToolSuccess(response);
  const text = toolText(response).replace(/\r\n/g, '\n');
  const heading = /^### Result\s*\n/m.exec(text);
  if (!heading) throw new Error('浏览器没有返回脚本执行结果。');
  const body = text.slice(heading.index + heading[0].length);
  const nextHeading = /^### [^\n]+$/m.exec(body);
  let serialized = (nextHeading ? body.slice(0, nextHeading.index) : body).trim();
  if (/^```(?:json)?\n/.test(serialized) && serialized.endsWith('\n```')) {
    serialized = serialized.replace(/^```(?:json)?\n/, '').slice(0, -4).trim();
  }
  if (serialized === 'undefined') return undefined as T;
  try {
    return JSON.parse(serialized) as T;
  } catch {
    throw new Error('浏览器返回的执行结果不是有效 JSON。');
  }
}

export function connectionError(error: unknown, token: string): Error {
  let message = error instanceof Error ? error.message : '浏览器连接失败。';
  const secret = normalizeToken(token);
  if (secret) message = message.split(secret).join('[已隐藏]');
  message = message.replace(/([?&]token=)[^\s&"']+/gi, '$1[已隐藏]')
    .replace(/(PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*)[^\s"']+/gi, '$1[已隐藏]');
  if (/invalid token|token.*(?:match|invalid)|(?:match|invalid).*token|extension did not connect|extension.*timed?\s*out/i.test(message)) {
    return new Error('浏览器连接凭据未通过验证或扩展未响应。请在日常 Chrome 的 Playwright 扩展中复制当前连接凭据，重新保存后测试连接。');
  }
  if (/timed?\s*out|request timeout/i.test(message)) {
    return new Error('浏览器连接或操作超时。请确认日常 Chrome 中已安装 Playwright 扩展，并重新检查连接凭据。');
  }
  if (/ReadBuffer exceeded maximum size|MCP_MESSAGE_TOO_LARGE/.test(message)) {
    return new Error('MCP_MESSAGE_TOO_LARGE: 图片或正文传输超过连接消息限制，保存未完成。');
  }
  if (/Connection closed|\bEPIPE\b|Not connected/i.test(message)) {
    return new Error('MCP_CONNECTION_CLOSED: 浏览器连接在保存过程中断开，请查看日志中的失败阶段。');
  }
  return new Error(message);
}

export async function connectBrowser(settings: ConnectionSettings, diagnostic?: DiagnosticSink): Promise<BrowserBridge> {
  const token = normalizeToken(settings.token);
  if (!token) {
    emitDiagnostic(diagnostic, 'mcp.connection.failed', { stage: 'credentials', code: 'connection_credentials_missing' });
    throw new Error('请先配置浏览器连接凭据，再测试连接。');
  }
  const installed = await measured(diagnostic, 'runtime.detect', {}, async () => {
    const found = await detectRuntime(settings);
    if (!found.node || !found.mcp) throw new Error(found.issues.join('\n'));
    return { node: found.node, mcp: found.mcp };
  });
  const version = (value: string): string => /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value) ? value : 'unknown';
  emitDiagnostic(diagnostic, 'runtime.versions', { nodeVersion: version(installed.node.version), mcpVersion: version(installed.mcp.version) });
  const directory = await mkdtemp(join(tmpdir(), 'markdown-x-publisher-'));
  const transport = new StdioClientTransport({
    command: installed.node.path,
    // MCP otherwise echoes the evaluated source, including image bytes, back
    // in its response. Large articles exceed the SDK's 10 MiB read buffer.
    args: [installed.mcp.path, '--extension', '--browser', 'chrome', '--codegen', 'none', '--output-dir', directory],
    env: browserEnvironment(getDefaultEnvironment(), token),
    // The official SDK uses shell:false and windowsHide:true on Windows.
    // Discard server diagnostics: connection URLs can contain the token.
    stderr: 'ignore',
    cwd: directory,
  });
  const client = new Client({ name: 'markdown-x-publisher', version: '0.1.8' }, { capabilities: {} });
  let closing: Promise<void> | undefined;
  let messageTooLarge = false;
  client.onerror = error => {
    const category = classifyDiagnosticError(error);
    if (category.code === 'transport_message_too_large') messageTooLarge = true;
    emitDiagnostic(diagnostic, 'mcp.transport.failed', category);
  };
  client.onclose = () => emitDiagnostic(diagnostic, 'mcp.transport.closed', { expected: Boolean(closing) });
  const close = (): Promise<void> => {
    // SDK shutdown ends only this local MCP process; it never closes Chrome.
    closing ??= measured(diagnostic, 'mcp.close', {}, () => client.close());
    return closing;
  };
  try {
    await measured(diagnostic, 'mcp.initialize', {}, () => client.connect(transport, { timeout: REQUEST_TIMEOUT }));
    const available = new Set<string>();
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await measured(diagnostic, 'mcp.tools.list', {}, () => client.listTools(cursor ? { cursor } : {}, { timeout: REQUEST_TIMEOUT }));
      for (const tool of page.tools) available.add(tool.name);
      cursor = page.nextCursor;
      if (cursor && visited.has(cursor)) throw new Error('Playwright MCP 工具列表分页重复。');
      if (cursor) visited.add(cursor);
    } while (cursor);
    const missing = REQUIRED_TOOLS.filter(name => !available.has(name));
    if (missing.length) throw new Error(`Playwright MCP 缺少必要工具：${missing.join('、')}。请检查安装版本。`);
    emitDiagnostic(diagnostic, 'mcp.connection.ready', { toolCount: available.size });
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      try {
        const tool = /^browser_[a-z_]{1,60}$/.test(name) ? name : 'unsupported';
        const argumentBytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
        return await measured(diagnostic, 'mcp.tool', { tool, argumentBytes }, async () => {
          if (closing) throw new Error('浏览器连接已经关闭。');
          if (!available.has(name)) throw new Error(`Playwright MCP 不支持工具：${name}。`);
          const response = await client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT });
          assertToolSuccess(response);
          return response;
        });
      } catch (error) {
        throw connectionError(messageTooLarge ? new Error('MCP_MESSAGE_TOO_LARGE') : error, token);
      }
    };
    return {
      call,
      async evaluate<T>(expression: string): Promise<T> {
        const response = await call('browser_evaluate', { function: expression });
        try { return parseEvaluationResult<T>(response); }
        catch (error) {
          emitDiagnostic(diagnostic, 'mcp.evaluate.failed', { tool: 'browser_evaluate', code: 'invalid_result' });
          throw error;
        }
      },
      close,
    };
  } catch (error) {
    emitDiagnostic(diagnostic, 'mcp.connection.failed', { stage: 'initialize' });
    await close().catch(() => undefined);
    throw connectionError(error, token);
  }
}

export async function testConnection(settings: ConnectionSettings, diagnostic?: DiagnosticSink): Promise<string> {
  const browser = await connectBrowser(settings, diagnostic);
  try {
    // Listing tabs establishes the Bridge connection without navigating or editing a page.
    await browser.call('browser_tabs', { action: 'list' });
  } catch (error) {
    // A shutdown failure must not replace the actual connection error.
    await browser.close().catch(() => undefined);
    throw error;
  }
  try { await browser.close(); }
  catch (error) { throw new Error(`浏览器已连接，但本地连接未正常关闭：${connectionError(error, settings.token).message}`); }
  return '已连接日常 Chrome，连接凭据有效。以后保存草稿无需重复允许连接。';
}
