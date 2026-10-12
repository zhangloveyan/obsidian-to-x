import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { detectRuntime, inspectMcp, inspectNode } from '../src/browser/discovery';

const installedMcp = resolve('node_modules/@playwright/mcp/cli.js');

test('detects a runnable Node and the locally installed official MCP without configured paths', async () => {
  const detected = await detectRuntime({ nodePath: '', mcpPath: '' });
  assert.deepEqual(detected.issues, []);
  assert.match(detected.node?.version ?? '', /^v\d+\.\d+\.\d+/);
  assert.equal(detected.mcp?.path, await realpath(installedMcp));
  assert.equal(detected.mcp?.version, '0.0.83');
});

test('explicit valid paths are accepted, including quoted paths with spaces', async () => {
  const detected = await detectRuntime({ nodePath: `"${process.execPath}"`, mcpPath: `"${installedMcp}"` });
  assert.deepEqual(detected.issues, []);
  assert.equal(detected.node?.path, await realpath(process.execPath));
  assert.equal(detected.mcp?.path, await realpath(installedMcp));
});

test('invalid manual overrides are reported instead of falling back to available installations', async () => {
  const detected = await detectRuntime({ nodePath: resolve('work/missing-node-executable'), mcpPath: resolve('work/missing-mcp-cli.js') });
  assert.equal(detected.node, undefined);
  assert.equal(detected.mcp, undefined);
  assert.equal(detected.issues.length, 2);
  assert.match(detected.issues.join('\n'), /清空路径后自动检测/);
});

test('MCP validation rejects unrelated packages and files not declared as CLI entries', async () => {
  await assert.rejects(inspectMcp(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')), /不是官方/);
  await assert.rejects(inspectMcp(resolve('node_modules/@playwright/mcp/index.js')), /不是官方/);
  await assert.rejects(inspectMcp('node_modules/@playwright/mcp/cli.js'), /绝对路径/);
});

test('relative or shell-shaped Node overrides never execute a shell', async () => {
  await assert.rejects(inspectNode('node --version'), /找不到指定/);
  await assert.rejects(inspectNode('node; echo hidden'), /找不到指定/);
  await assert.rejects(inspectNode('./node'), /找不到指定/);
});
