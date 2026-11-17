import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../mcp/server.mjs';
import { BrowserBridge } from '../mcp/bridge-host.mjs';

test('real SDK HTTP discovery, local-origin checks, credentials and live request routing', async t => {
  const bridge = new BrowserBridge({ pollTimeout: 100, commandTimeout: 300 });
  const instance = await startServer({ port: 0, bridge });
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.port}`;
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['list_scripts', 'get_script', 'search_script', 'edit_script']);
  assert.equal(tools.find(t => t.name === 'edit_script').annotations.readOnlyHint, false);
  for (const tool of tools) assert.ok(tool.outputSchema);
  assert.deepEqual((await client.callTool({ name: 'list_scripts' })).structuredContent, { scripts: [] });
  const offline = await client.callTool({ name: 'get_script', arguments: { sessionId: 'missing' } });
  assert.equal(offline.isError, true);
  assert.equal(JSON.parse(offline.content[0].text).error.code, 'DISCONNECTED');

  const blocked = await fetch(`${base}/bridge/connect`, { method: 'POST', headers: {
    Origin: 'https://example.com', 'Content-Type': 'application/json', 'X-Script-Editor': '1',
  }, body: JSON.stringify({ projectId: 'p1', title: 'Test' }) });
  assert.equal(blocked.status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/health`, { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject);
  });
  assert.equal(reboundStatus, 403);
  const malformedStatus = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: instance.port, path: '//[/', headers: { Host: `127.0.0.1:${instance.port}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject);
  });
  assert.equal(malformedStatus, 400);
  const preflight = await fetch(`${base}/bridge/connect`, { method: 'OPTIONS', headers: {
    Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-script-editor',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
  const bridgePost = (action, data) => fetch(`${base}/bridge/${action}`, { method: 'POST', headers: {
    Origin: 'null', 'Content-Type': 'application/json', 'X-Script-Editor': '1',
  }, body: JSON.stringify(data) });
  const connect = await bridgePost('connect', { projectId: 'p1', title: 'Test' });
  assert.equal(connect.status, 200);
  const credentials = await connect.json();
  const listed = (await client.callTool({ name: 'list_scripts' })).structuredContent.scripts;
  assert.deepEqual(listed, [{ sessionId: credentials.sessionId, projectId: 'p1', title: 'Test' }]);
  assert.equal(JSON.stringify(listed).includes(credentials.token), false);
  const unauthorized = await bridgePost('poll', { ...credentials, token: '0'.repeat(64), projectId: 'p1', title: 'Test' });
  assert.equal(unauthorized.status, 401);

  const reading = client.callTool({ name: 'get_script', arguments: { sessionId: credentials.sessionId } });
  const poll = await bridgePost('poll', { ...credentials, projectId: 'p1', title: 'Test' });
  const { commands } = await poll.json();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].action, 'get_script');
  assert.ok(commands[0].deadline > Date.now());
  const snapshot = { revision: 'rev1', project: { projectId: 'p1', title: 'Test', sections: [], speakers: {} } };
  assert.equal((await bridgePost('result', { ...credentials, commandId: commands[0].id, result: snapshot })).status, 200);
  assert.deepEqual((await reading).structuredContent, { sessionId: credentials.sessionId, ...snapshot });
  const timeout = await client.callTool({ name: 'get_script', arguments: { sessionId: credentials.sessionId } });
  assert.equal(JSON.parse(timeout.content[0].text).error.code, 'EDITOR_TIMEOUT');
  assert.deepEqual((await bridgePost('poll', { ...credentials, projectId: 'p1', title: 'Test' }).then(r => r.json())).commands, []);
  assert.equal((await bridgePost('disconnect', credentials)).status, 200);
  assert.deepEqual((await client.callTool({ name: 'list_scripts' })).structuredContent, { scripts: [] });
});

test('cancelled or disconnected queued writes cannot be delivered later', async t => {
  const bridge = new BrowserBridge({ commandTimeout: 50, pollTimeout: 20 });
  t.after(() => bridge.close());
  const credentials = bridge.connect({ projectId: 'p1', title: 'Test' });
  const controller = new AbortController();
  const aborted = bridge.request(credentials.sessionId, 'edit_script', {}, controller.signal);
  controller.abort();
  await assert.rejects(aborted, e => e.code === 'CANCELLED');
  assert.deepEqual((await bridge.poll({ ...credentials, projectId: 'p1', title: 'Test' })).commands, []);
  const waiting = bridge.request(credentials.sessionId, 'edit_script', {});
  bridge.disconnect(credentials);
  await assert.rejects(waiting, e => e.code === 'DISCONNECTED');
  assert.deepEqual(bridge.list(), []);
});
