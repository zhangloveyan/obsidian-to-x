import assert from 'node:assert/strict';
import test from 'node:test';
import { assertToolSuccess, browserEnvironment, connectionError, normalizeToken, parseEvaluationResult } from '../src/browser/runtime';

const result = (text: string): unknown => ({ content: [{ type: 'text', text }] });

test('normalizes the extension clipboard format without changing the token', () => {
  assert.equal(normalizeToken('  PLAYWRIGHT_MCP_EXTENSION_TOKEN=abc_def-123\n'), 'abc_def-123');
  assert.equal(normalizeToken(' "abc_def-123" '), 'abc_def-123');
  assert.equal(normalizeToken("PLAYWRIGHT_MCP_EXTENSION_TOKEN='abc_def-123'"), 'abc_def-123');
  assert.equal(normalizeToken('   '), '');
});

test('isolates browser configuration from unrelated inherited MCP options', () => {
  const inherited = { PATH: 'node-path', LOCALAPPDATA: 'profile-root', PLAYWRIGHT_MCP_CDP_ENDPOINT: 'foreign-endpoint',
    PLAYWRIGHT_MCP_USER_DATA_DIR: 'isolated-profile', playwright_mcp_config: 'foreign-config', PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'old', EMPTY: undefined };
  assert.deepEqual(browserEnvironment(inherited, 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=current'), {
    PATH: 'node-path', LOCALAPPDATA: 'profile-root', PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'current',
  });
  assert.equal(inherited.PLAYWRIGHT_MCP_EXTENSION_TOKEN, 'old');
});

test('extracts JSON from Playwright output while ignoring code and page snapshots', () => {
  const value = { text: '中文😀\n### Ran Playwright code', saved: true, nested: [1, null] };
  assert.deepEqual(parseEvaluationResult(result(`### Result\n${JSON.stringify(value, null, 2)}\n\n### Ran Playwright code\ncode\n### Page\nsnapshot`)), value);
  assert.deepEqual(parseEvaluationResult(result('### Result\r\n```json\r\n{"ok":true}\r\n```\r\n### Page\r\nsnapshot')), { ok: true });
});

test('retains primitive results and distinguishes missing data from null', () => {
  for (const value of [null, false, 0, '', '中文']) {
    assert.equal(parseEvaluationResult(result(`### Result\n${JSON.stringify(value)}`)), value);
  }
  assert.equal(parseEvaluationResult(result('### Result\nundefined')), undefined);
  assert.throws(() => parseEvaluationResult(result('### Page\nNo result')), /没有返回/);
  assert.throws(() => parseEvaluationResult(result('### Result\nnot json')), /有效 JSON/);
});

test('does not turn tool failures or malformed MCP responses into successful evaluations', () => {
  assert.throws(() => parseEvaluationResult({ isError: true, content: [{ type: 'text', text: 'Invalid token provided.' }] }), /Invalid token/);
  assert.throws(() => assertToolSuccess(null), /有效响应/);
  assert.throws(() => parseEvaluationResult({ content: 'wrong type' }), /无法识别/);
});

test('connection failures do not reveal credentials and expired tokens request reconfiguration', () => {
  const message = connectionError(new Error('Failed at http://localhost/?token=top-secret&other=1'), 'top-secret').message;
  assert.ok(!message.includes('top-secret'));
  assert.match(message, /已隐藏/);
  assert.match(connectionError(new Error('Invalid token provided.'), 'secret').message, /重新保存/);
  assert.match(connectionError(new Error('Playwright extension did not connect within 30s'), 'secret').message, /重新保存/);
  assert.match(connectionError(new Error('MCP error -32000: Connection closed'), 'secret').message, /MCP_CONNECTION_CLOSED/);
  assert.match(connectionError(new Error('ReadBuffer exceeded maximum size of 10485760 bytes'), 'secret').message, /MCP_MESSAGE_TOO_LARGE/);
});
