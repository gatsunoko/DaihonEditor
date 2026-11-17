import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(thisFile), '..');

if (process.argv.includes('--proxy-fixture')) {
  // Capture only helpers this isolated proxy starts, so every detached process
  // can be cleaned up without touching a user's running editor server.
  const realSpawn = childProcess.spawn;
  childProcess.spawn = function (command, args, options) {
    const child = realSpawn(command, args, options);
    child.once('spawn', () => {
      if (args?.[0] === path.join(root, 'mcp/server.mjs')) {
        process.stderr.write(`STARTUP_TEST_HELPER ${JSON.stringify({
          pid: child.pid, port: options.env.SCRIPT_EDITOR_PORT,
          detached: options.detached, windowsHide: options.windowsHide,
        })}\n`);
      }
    });
    return child;
  };
  syncBuiltinESMExports();
  await import('../mcp/stdio.mjs');
} else if (process.argv.includes('--backend-fixture')) {
  const { startServer, WORKSPACE_ID } = await import('../mcp/server.mjs');
  const { BrowserBridge } = await import('../mcp/bridge-host.mjs');
  const bridge = new BrowserBridge();
  const stats = { initializations: 0, discoveries: 0, calls: 0, edits: 0, healthChecks: 0 };
  let dropEdits = Number(process.env.STARTUP_TEST_DROP_EDITS || 0);
  let dropDiscoveries = 0;
  let holdEdits = false;
  let heldEdits = [];
  let healthOverride = {};
  let currentToolResponse;
  const instance = await startServer({ port: Number(process.env.SCRIPT_EDITOR_PORT), bridge });
  bridge.request = async (_sessionId, action, args) => {
    if (action === 'edit_script') {
      stats.edits += 1;
      process.send?.({ event: 'edit-received', edits: stats.edits });
      if (dropEdits > 0) {
        dropEdits -= 1;
        // Simulate an operation committed by the editor whose HTTP result is
        // lost. A proxy retry would execute this edit twice.
        currentToolResponse.destroy();
      }
      if (holdEdits) await new Promise(resolve => heldEdits.push(resolve));
    }
    return {
      project: { projectId: 'fixture-project', title: args?.operations?.[0]?.title || 'Fixture' },
      revision: 'fixture-revision', changed: action === 'edit_script',
    };
  };
  const handlers = instance.server.listeners('request');
  instance.server.removeAllListeners('request');
  instance.server.on('request', (req, res) => {
    if (req.url === '/health') {
      stats.healthChecks += 1;
      if (Object.keys(healthOverride).length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ app: 'script-editor-mcp', workspaceId: WORKSPACE_ID, ...healthOverride }));
        return;
      }
    }
    if (req.url === '/mcp' && req.method === 'POST') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const message = JSON.parse(raw);
        if (message.method === 'initialize') stats.initializations += 1;
        if (message.method === 'tools/list') {
          stats.discoveries += 1;
          if (dropDiscoveries > 0) {
            dropDiscoveries -= 1;
            res.destroy();
          }
        }
        if (message.method === 'tools/call') {
          stats.calls += 1;
          currentToolResponse = res;
        }
      });
    }
    for (const handler of handlers) handler(req, res);
  });
  process.on('message', async message => {
    if (message.action === 'configure') {
      if (message.healthOverride !== undefined) healthOverride = message.healthOverride;
      if (message.dropDiscoveries !== undefined) dropDiscoveries = message.dropDiscoveries;
      if (message.holdEdits !== undefined) holdEdits = message.holdEdits;
      if (message.releaseEdits) {
        for (const resolve of heldEdits) resolve();
        heldEdits = [];
      }
    }
    if (message.action === 'stop') {
      await instance.close();
      process.exit(0);
    }
    process.send?.({ event: 'reply', requestId: message.requestId, ...stats });
  });
  process.send?.({ event: 'ready', port: instance.port });
} else {
  const { test } = await import('node:test');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const expectedTools = ['list_scripts', 'get_script', 'search_script', 'edit_script'];
  const edit = {
    name: 'edit_script', arguments: {
      sessionId: 'fixture-session', projectId: 'fixture-project', expectedRevision: 'fixture-revision',
      operations: [{ op: 'set_title', title: 'Applied once' }],
    },
  };

  async function waitFor(check, message, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(message);
  }

  async function freePort() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    assert.notEqual(port, 39041, 'tests must never use the production default port');
    return port;
  }

  async function health(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500), redirect: 'error' });
      return await response.json();
    } catch { return null; }
  }

  async function stopPid(pid) {
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  async function startProxy(t, port) {
    const helpers = [];
    let stderr = '';
    let pending = '';
    const client = new Client({ name: 'startup-recovery-test', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [thisFile, '--proxy-fixture'], cwd: root,
      env: { ...process.env, SCRIPT_EDITOR_PORT: String(port) }, stderr: 'pipe',
    });
    transport.stderr.on('data', chunk => {
      stderr += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith('STARTUP_TEST_HELPER ')) helpers.push(JSON.parse(line.slice('STARTUP_TEST_HELPER '.length)));
      }
    });
    t.after(async () => {
      await client.close();
      for (const helper of helpers) await stopPid(helper.pid);
      if (helpers.length) await waitFor(async () => !(await health(port)), `test helper on ${port} did not stop`);
    });
    await client.connect(transport, { timeout: 10000 });
    return { client, transport, helpers, stderr: () => stderr };
  }

  async function startBackend(t, port, env = {}) {
    const child = childProcess.spawn(process.execPath, [thisFile, '--backend-fixture'], {
      cwd: root, env: { ...process.env, ...env, SCRIPT_EDITOR_PORT: String(port) },
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let sequence = 0;
    let stderr = '';
    let ready = false;
    const replies = new Map();
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => {
      if (message.event === 'ready') ready = true;
      if (message.event === 'reply') replies.set(message.requestId, message);
    });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, `backend ${child.pid} did not stop`);
      }
    });
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`backend exited: ${stderr}`);
      return ready;
    }, 'test backend did not start');
    async function command(data) {
      const requestId = ++sequence;
      child.send({ ...data, requestId });
      return waitFor(() => replies.get(requestId), `test backend did not reply to ${data.action}`);
    }
    return { command, stats: () => command({ action: 'stats' }) };
  }

  test('a live stdio proxy starts an isolated helper again after it stops', { timeout: 30000 }, async t => {
    const port = await freePort();
    const proxy = await startProxy(t, port);
    assert.deepEqual((await proxy.client.listTools()).tools.map(tool => tool.name), expectedTools);
    assert.equal(proxy.helpers.length, 1, proxy.stderr());
    assert.equal(proxy.helpers[0].port, String(port));
    assert.equal(proxy.helpers[0].detached, true);
    assert.equal(proxy.helpers[0].windowsHide, true);
    const firstHealth = await health(port);
    assert.ok(firstHealth?.instanceId);

    await stopPid(proxy.helpers[0].pid);
    await waitFor(async () => !(await health(port)), 'first helper did not stop');
    assert.deepEqual((await proxy.client.listTools()).tools.map(tool => tool.name), expectedTools);
    assert.equal(proxy.helpers.length, 2, proxy.stderr());
    assert.notEqual(proxy.helpers[0].pid, proxy.helpers[1].pid);
    assert.notEqual((await health(port)).instanceId, firstHealth.instanceId);
    assert.deepEqual((await proxy.client.callTool({ name: 'list_scripts' })).structuredContent, { scripts: [] });
  });

  test('an edit with a lost result is forwarded once, returns uncertainty, and is never replayed during recovery', { timeout: 20000 }, async t => {
    const port = await freePort();
    const backend = await startBackend(t, port, { STARTUP_TEST_DROP_EDITS: '1' });
    const proxy = await startProxy(t, port);
    await proxy.client.listTools();
    const before = await backend.stats();
    const result = await proxy.client.callTool(edit);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'UPSTREAM_CONNECTION_LOST');
    assert.match(JSON.parse(result.content[0].text).error.message, /再実行していません/);
    assert.deepEqual((await proxy.client.listTools()).tools.map(tool => tool.name), expectedTools);
    assert.deepEqual((await proxy.client.callTool({ name: 'list_scripts' })).structuredContent, { scripts: [] });
    const after = await backend.stats();
    assert.equal(after.edits, 1);
    assert.equal(after.calls, before.calls + 2, 'one edit and one explicit list_scripts call');
    assert.equal(after.initializations, before.initializations + 1, 'the failed SDK client must be replaced');
    assert.equal(proxy.helpers.length, 0, 'a healthy existing backend must be reused');
  });

  test('read-only discovery retries once with a fresh SDK client after a dead transport', { timeout: 20000 }, async t => {
    const port = await freePort();
    const backend = await startBackend(t, port);
    const proxy = await startProxy(t, port);
    await proxy.client.listTools();
    const before = await backend.command({ action: 'configure', dropDiscoveries: 1 });
    assert.deepEqual((await proxy.client.listTools()).tools.map(tool => tool.name), expectedTools);
    const after = await backend.stats();
    assert.equal(after.discoveries, before.discoveries + 2);
    assert.equal(after.initializations, before.initializations + 1);
    assert.equal(after.calls, 0);
    assert.equal(proxy.helpers.length, 0);
  });

  test('every forward rechecks workspace identity and never starts over an unrelated service', { timeout: 20000 }, async t => {
    const port = await freePort();
    const backend = await startBackend(t, port);
    const proxy = await startProxy(t, port);
    await proxy.client.listTools();
    for (const healthOverride of [{ workspaceId: 'another-workspace' }, { app: 'unrelated-service' }]) {
      await backend.command({ action: 'configure', healthOverride });
      await assert.rejects(proxy.client.listTools(), /別のサービス/);
      await assert.rejects(proxy.client.callTool(edit), /別のサービス/);
    }
    await backend.command({ action: 'configure', healthOverride: {} });
    assert.deepEqual((await proxy.client.listTools()).tools.map(tool => tool.name), expectedTools);
    const stats = await backend.stats();
    assert.equal(stats.calls, 0);
    assert.equal(stats.edits, 0);
    assert.equal(proxy.helpers.length, 0);
  });

  test('rediscovery after instance change leaves an already pending edit intact', { timeout: 20000 }, async t => {
    const port = await freePort();
    const backend = await startBackend(t, port);
    const proxy = await startProxy(t, port);
    await proxy.client.listTools();
    await backend.command({ action: 'configure', holdEdits: true });
    const pendingEdit = proxy.client.callTool(edit);
    await waitFor(async () => (await backend.stats()).edits === 1, 'edit was not forwarded');
    const before = await backend.command({ action: 'configure', healthOverride: { instanceId: 'replacement-test-instance' } });
    assert.deepEqual((await proxy.client.listTools()).tools.map(tool => tool.name), expectedTools);
    await backend.command({ action: 'configure', releaseEdits: true });
    const result = await pendingEdit;
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.changed, true);
    const after = await backend.stats();
    assert.equal(after.edits, 1);
    assert.equal(after.initializations, before.initializations + 1);
  });
}
