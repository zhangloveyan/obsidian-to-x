import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { cleanRuntimeDirectory, detectRuntime, inspectMcp, inspectNode } from '../src/browser/discovery';

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
  assert.equal(detected.node?.directory, dirname(await realpath(process.execPath)));
  assert.equal(detected.mcp?.path, await realpath(installedMcp));
  assert.equal(detected.mcp?.directory, dirname(await realpath(installedMcp)));
});

test('installation folders are accepted and resolve to the executable entries used at runtime', async () => {
  const detected = await detectRuntime({ nodePath: `"${dirname(process.execPath)}"`, mcpPath: `"${dirname(installedMcp)}"` });
  assert.deepEqual(detected.issues, []);
  assert.equal(detected.node?.path, await realpath(process.execPath));
  assert.equal(detected.node?.directory, dirname(await realpath(process.execPath)));
  assert.equal(detected.mcp?.path, await realpath(installedMcp));
  assert.equal(detected.mcp?.directory, dirname(await realpath(installedMcp)));
});

test('invalid manual overrides are reported instead of falling back to available installations', async () => {
  const detected = await detectRuntime({ nodePath: resolve('work/missing-node-executable'), mcpPath: resolve('work/missing-mcp-cli.js') });
  assert.equal(detected.node, undefined);
  assert.equal(detected.mcp, undefined);
  assert.equal(detected.issues.length, 2);
  assert.equal(detected.nodeIssue, detected.issues[0]);
  assert.equal(detected.mcpIssue, detected.issues[1]);
  assert.match(detected.issues.join('\n'), /清空路径后自动检测/);
});

test('wrong existing folders are rejected without replacing them with discovered installations', async () => {
  const detected = await detectRuntime({ nodePath: resolve('tests'), mcpPath: resolve('node_modules/@playwright') });
  assert.equal(detected.node, undefined);
  assert.equal(detected.mcp, undefined);
  assert.match(detected.nodeIssue ?? '', /安装文件夹/);
  assert.match(detected.mcpIssue ?? '', /mcp 文件夹/);
  assert.doesNotMatch(detected.issues.join('\n'), /高级设置/);
});

test('one invalid override does not prevent the other component being inspected', async () => {
  const detected = await detectRuntime({ nodePath: resolve('tests'), mcpPath: dirname(installedMcp) });
  assert.equal(detected.node, undefined);
  assert.equal(detected.mcp?.path, await realpath(installedMcp));
  assert.equal(detected.issues.length, 1);
  assert.equal(detected.mcpIssue, undefined);
});

test('MCP folder validation uses the declared nested CLI and rejects entries outside its package', async context => {
  const root = await mkdtemp(join(tmpdir(), 'markdown-x-publisher-discovery-'));
  context.after(async () => {
    assert.equal(dirname(root), tmpdir());
    assert.ok(basename(root).startsWith('markdown-x-publisher-discovery-'));
    await rm(root, { recursive: true });
  });
  await mkdir(join(root, 'bin'));
  const entry = join(root, 'bin', 'start.js');
  await writeFile(entry, 'throw new Error("Validation must not execute the CLI");');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version: '1.2.3', bin: { 'playwright-mcp': './bin/start.js' } }));
  for (const configured of [root, entry]) {
    const detected = await inspectMcp(configured);
    assert.equal(detected.path, await realpath(entry));
    assert.equal(detected.directory, await realpath(root));
    assert.equal(detected.version, '1.2.3');
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version: '1.2.3', bin: installedMcp }));
  await assert.rejects(inspectMcp(root), /不是官方/);
});

test('saved legacy entry paths can be displayed as installation folders', () => {
  assert.equal(cleanRuntimeDirectory(` "${process.execPath}" `, 'node'), dirname(process.execPath));
  assert.equal(cleanRuntimeDirectory(installedMcp, 'mcp'), dirname(installedMcp));
  assert.equal(cleanRuntimeDirectory(dirname(installedMcp), 'mcp'), dirname(installedMcp));
  assert.equal(cleanRuntimeDirectory('', 'node'), '');
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
