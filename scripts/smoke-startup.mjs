// Run against a built bundle. Prints only safe startup/smoke evidence, never raw Kimi output.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const pluginRoot = resolve(process.argv[2] ?? 'plugins/kimi-delegate');
const settings = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8')).mcpServers['kimi-delegate'];
const temporary = await mkdtemp(join(tmpdir(), 'kimi-startup-smoke-'));
const mode = process.argv[3] ?? 'auto';
const transport = new StdioClientTransport({
  command: process.execPath, args: [join(pluginRoot, 'mcp/server.mjs')], cwd: pluginRoot,
  env: { ...process.env, ...settings.env, ...(mode === 'fixed-failure' ? { KIMI_SERVER_URL: 'http://127.0.0.1:58627', KIMI_SERVER_ARGS: '["web","--no-open","--port","58627"]' } : {}) },
  stderr: 'pipe',
});
// Drain MCP stderr without recording it. Startup output must not reach this channel.
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'kimi-startup-smoke', version: '1.0.0' });
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
  const body = JSON.parse(result.content.find((item) => item.type === 'text').text);
  if (result.isError) {
    console.log(JSON.stringify({ tool: name, code: body.code, exitCode: body.details?.exitCode, diagnosticCodes: body.details?.diagnosticCodes, submissionState: body.details?.submissionState, startupMayStillBeRunning: body.details?.startupMayStillBeRunning }));
    return { error: true, body };
  }
  return { error: false, body };
};
try {
  await client.connect(transport);
  const start = Date.now();
  const recent = await call('kimi_recent_sessions', { pageSize: 1 });
  if (mode === 'fixed-failure') {
    assert.equal(recent.error, true);
    assert.equal(recent.body.code, 'KIMI_STARTUP_FAILED');
    assert.equal(recent.body.details.submissionState, 'not_submitted');
    console.log(JSON.stringify({ fixedFailureMs: Date.now() - start }));
  } else {
    assert.equal(recent.error, false);
    const { body: status } = await call('kimi_bridge_status');
    assert.equal(status.status, 'ready');
    assert.equal(status.authOk, true);
    assert.notEqual(new URL(status.serverUrl).port, '58627');
    console.log(JSON.stringify({ status: status.status, healthzOk: status.healthzOk, authOk: status.authOk, serverUrl: status.serverUrl, serverVersion: status.serverVersion }));
    if (mode !== 'status-only') {
      execFileSync('git', ['init', temporary], { stdio: 'ignore' });
      const task = await call('kimi_delegate_and_wait', {
        cwd: temporary, task: 'Reply with exactly KIMI_AUTO_PORT_OK. Do not use tools, edit files, run commands, or create worktrees.',
        acceptanceCriteria: ['Reply KIMI_AUTO_PORT_OK without changing files'], plan: ['Reply with the marker only'], timeoutMs: 60000,
      });
      assert.equal(task.error, false);
      assert.equal(task.body.wait?.status, 'idle');
      const handoff = await call('kimi_get_handoff', { sessionId: task.body.sessionId });
      assert.equal(handoff.error, false);
      assert.ok(handoff.body.finalMessage.includes('KIMI_AUTO_PORT_OK'));
      const clean = execFileSync('git', ['-C', temporary, 'status', '--porcelain'], { encoding: 'utf8' });
      assert.equal(clean, '');
      console.log(JSON.stringify({ sessionId: task.body.sessionId, promptId: task.body.promptId, wait: task.body.wait?.status, promptWait: task.body.promptWait?.status, markerVerified: true, cleanWorkspace: true }));
    }
  }
} finally {
  await client.close();
  await rm(temporary, { recursive: true, force: true });
}
