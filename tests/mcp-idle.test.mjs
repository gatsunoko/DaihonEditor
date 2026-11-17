import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BrowserBridge } from '../mcp/bridge-host.mjs';
import { startServer } from '../mcp/server.mjs';

const metadata = { projectId: 'idle-project', title: '台本' };
const snapshot = { project: { ...metadata, sections: [], speakers: {} }, revision: 'revision-before-idle' };

function makeBridge(t, options) {
  const bridge = new BrowserBridge(options);
  t.after(() => bridge.close());
  return bridge;
}

function stoppedSignal() {
  return AbortSignal.abort();
}

test('ordinary background idleness no longer drops a session after 45 seconds', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000000 });
  const bridge = makeBridge(t);
  const credentials = bridge.connect(metadata);
  t.mock.timers.tick(45001);
  assert.deepEqual(bridge.list(), [{ sessionId: credentials.sessionId, ...metadata }]);
  t.mock.timers.tick(5 * 60 * 1000 - 45001 + 1);
  bridge.prune();
  assert.deepEqual(bridge.list(), []);
});

test('authenticated resume recreates the same logical session after idle pruning', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000000 });
  const bridge = makeBridge(t, { sessionTimeout: 100 });
  const credentials = bridge.connect(metadata);
  t.mock.timers.tick(101);
  bridge.prune();
  await assert.rejects(bridge.poll({ ...credentials, ...metadata }), error => error.code === 'DISCONNECTED');
  const resumed = bridge.connect({ ...credentials, ...metadata, title: '復帰した台本' });
  assert.deepEqual(resumed, credentials);
  assert.deepEqual(bridge.list(), [{ sessionId: credentials.sessionId, ...metadata, title: '復帰した台本' }]);
  const reading = bridge.request(credentials.sessionId, 'get_script', {});
  const { commands } = await bridge.poll({ ...credentials, ...metadata });
  assert.equal(commands.length, 1);
  bridge.complete({ ...credentials, commandId: commands[0].id, result: snapshot });
  assert.deepEqual(await reading, snapshot);
});

test('a new host accepts proof of the same session identity without restoring old writes', async t => {
  const first = makeBridge(t);
  const credentials = first.connect(metadata);
  const oldWrite = first.request(credentials.sessionId, 'edit_script', { change: 'must not replay' });
  const rejection = assert.rejects(oldWrite, error => error.code === 'DISCONNECTED');
  const delivered = (await first.poll({ ...credentials, ...metadata })).commands[0];
  first.close();
  await rejection;

  const replacement = makeBridge(t);
  assert.deepEqual(replacement.connect({ ...credentials, ...metadata }), credentials);
  assert.deepEqual(await replacement.poll({ ...credentials, ...metadata }, stoppedSignal()), { commands: [] });
  assert.throws(() => replacement.complete({ ...credentials, commandId: delivered.id, result: snapshot }), error => error.code === 'EXPIRED_COMMAND');
  const reading = replacement.request(credentials.sessionId, 'get_script', {});
  const command = (await replacement.poll({ ...credentials, ...metadata })).commands[0];
  assert.equal(command.action, 'get_script');
  replacement.complete({ ...credentials, commandId: command.id, result: snapshot });
  assert.deepEqual(await reading, snapshot);
});

test('known-session resume closes an abandoned poll empty and never redelivers an already delivered edit', async t => {
  const bridge = makeBridge(t);
  const credentials = bridge.connect(metadata);
  const oldPoll = bridge.poll({ ...credentials, ...metadata });
  assert.deepEqual(bridge.connect({ ...credentials, ...metadata }), credentials);
  assert.deepEqual(await oldPoll, { commands: [] });

  const writing = bridge.request(credentials.sessionId, 'edit_script', { change: 'one delivery' });
  const command = (await bridge.poll({ ...credentials, ...metadata })).commands[0];
  assert.equal(command.action, 'edit_script');
  bridge.connect({ ...credentials, ...metadata });
  assert.deepEqual(await bridge.poll({ ...credentials, ...metadata }, stoppedSignal()), { commands: [] });
  bridge.complete({ ...credentials, commandId: command.id, result: snapshot });
  assert.deepEqual(await writing, snapshot);
});

test('resume preserves an undelivered live request once without reconstructing commands', async t => {
  const bridge = makeBridge(t);
  const credentials = bridge.connect(metadata);
  const writing = bridge.request(credentials.sessionId, 'edit_script', { change: 'waiting for browser' });
  bridge.connect({ ...credentials, ...metadata });
  const commands = (await bridge.poll({ ...credentials, ...metadata })).commands;
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].args, { change: 'waiting for browser' });
  assert.deepEqual(await bridge.poll({ ...credentials, ...metadata }, stoppedSignal()), { commands: [] });
  bridge.complete({ ...credentials, commandId: commands[0].id, result: snapshot });
  await writing;
});

test('known tokens cannot be replaced and arbitrary public IDs cannot be adopted', t => {
  const bridge = makeBridge(t);
  const credentials = bridge.connect(metadata);
  const wrongToken = credentials.token === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  assert.throws(() => bridge.connect({ ...credentials, ...metadata, token: wrongToken, title: 'Unauthorized' }), error => error.code === 'DISCONNECTED');
  assert.deepEqual(bridge.list(), [{ sessionId: credentials.sessionId, ...metadata }]);

  const unknownId = randomUUID();
  const fresh = bridge.connect({ ...metadata, sessionId: unknownId, token: wrongToken });
  assert.notEqual(fresh.sessionId, unknownId);
  assert.notEqual(fresh.token, wrongToken);
  for (const partial of [
    { sessionId: credentials.sessionId }, { token: credentials.token },
    { sessionId: 'not-a-session', token: credentials.token },
    { sessionId: credentials.sessionId, token: 'z'.repeat(64) },
  ]) assert.throws(() => bridge.connect({ ...metadata, ...partial }), error => error.code === 'INVALID_REQUEST');
});

test('active legacy IDs remain valid, while an unverifiable legacy ID receives fresh credentials', t => {
  const bridge = makeBridge(t);
  const original = bridge.connect(metadata);
  // Recreate an existing session issued by the previous random-UUID host.
  const legacy = { ...original, sessionId: randomUUID() };
  const state = bridge.sessions.get(original.sessionId);
  bridge.sessions.delete(original.sessionId);
  state.sessionId = legacy.sessionId;
  bridge.sessions.set(legacy.sessionId, state);
  assert.deepEqual(bridge.connect({ ...legacy, ...metadata }), legacy);
  bridge.disconnect(legacy);
  const fresh = bridge.connect({ ...legacy, ...metadata });
  assert.notEqual(fresh.sessionId, legacy.sessionId);
  assert.notEqual(fresh.token, legacy.token);
});

test('the 30-second command window tolerates a short background pause but still expires old writes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000000 });
  const bridge = makeBridge(t);
  const credentials = bridge.connect(metadata);
  const reading = bridge.request(credentials.sessionId, 'get_script', {});
  t.mock.timers.tick(9000);
  const command = (await bridge.poll({ ...credentials, ...metadata })).commands[0];
  assert.equal(command.deadline, 1030000);
  t.mock.timers.tick(20000);
  bridge.complete({ ...credentials, commandId: command.id, result: snapshot });
  assert.deepEqual(await reading, snapshot);

  const writing = bridge.request(credentials.sessionId, 'edit_script', { change: 'expired' });
  const timeout = assert.rejects(writing, error => error.code === 'EDITOR_TIMEOUT' && /自動で回復/.test(error.message));
  const stale = (await bridge.poll({ ...credentials, ...metadata })).commands[0];
  t.mock.timers.tick(30000);
  await timeout;
  bridge.connect({ ...credentials, ...metadata });
  assert.deepEqual(await bridge.poll({ ...credentials, ...metadata }, stoppedSignal()), { commands: [] });
  assert.throws(() => bridge.complete({ ...credentials, commandId: stale.id, result: snapshot }), error => error.code === 'EXPIRED_COMMAND');
});

test('wall-clock deadlines also reject expired delivery and results before delayed timers run', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const bridge = makeBridge(t);
  const credentials = bridge.connect(metadata);
  const queued = bridge.request(credentials.sessionId, 'edit_script', {});
  const queuedTimeout = assert.rejects(queued, error => error.code === 'EDITOR_TIMEOUT');
  t.mock.timers.setTime(1030001);
  assert.deepEqual(await bridge.poll({ ...credentials, ...metadata }, stoppedSignal()), { commands: [] });
  await queuedTimeout;

  const delivered = bridge.request(credentials.sessionId, 'edit_script', {});
  const deliveredTimeout = assert.rejects(delivered, error => error.code === 'EDITOR_TIMEOUT');
  const command = (await bridge.poll({ ...credentials, ...metadata })).commands[0];
  t.mock.timers.setTime(command.deadline);
  assert.throws(() => bridge.complete({ ...credentials, commandId: command.id, result: snapshot }), error => error.code === 'EXPIRED_COMMAND');
  await deliveredTimeout;
});

test('duplicate result acknowledgments retain the first result and require the original token', async t => {
  const bridge = makeBridge(t);
  const credentials = bridge.connect(metadata);
  const reading = bridge.request(credentials.sessionId, 'get_script', {});
  const command = (await bridge.poll({ ...credentials, ...metadata })).commands[0];
  const report = { ...credentials, commandId: command.id, result: snapshot };
  assert.deepEqual(bridge.complete(report), {});
  assert.deepEqual(await reading, snapshot);
  const replacement = { ...snapshot, project: { ...snapshot.project, title: 'Must not replace the first result' }, revision: 'other' };
  assert.deepEqual(bridge.complete({ ...report, result: replacement }), {});
  assert.equal(bridge.list()[0].title, snapshot.project.title);
  assert.throws(() => bridge.complete({ ...report, token: '0'.repeat(64) }), error => error.code === 'DISCONNECTED');
});

test('error reports are acknowledged once and duplicate reports cannot turn them into success', async t => {
  const bridge = makeBridge(t);
  const credentials = bridge.connect(metadata);
  const writing = bridge.request(credentials.sessionId, 'edit_script', {});
  const rejected = assert.rejects(writing, error => error.code === 'CONFLICT');
  const command = (await bridge.poll({ ...credentials, ...metadata })).commands[0];
  assert.deepEqual(bridge.complete({ ...credentials, commandId: command.id, error: { code: 'CONFLICT', message: 'Changed locally' } }), {});
  await rejected;
  assert.deepEqual(bridge.complete({ ...credentials, commandId: command.id, result: { ...snapshot, project: { ...metadata, title: 'Wrong' } } }), {});
  assert.equal(bridge.list()[0].title, metadata.title);
});

test('result acknowledgment history is bounded and expires after two minutes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000000 });
  const bridge = makeBridge(t);
  const credentials = bridge.connect(metadata);
  const reports = [];
  for (let index = 0; index < 129; index++) {
    const reading = bridge.request(credentials.sessionId, 'get_script', {});
    const command = (await bridge.poll({ ...credentials, ...metadata })).commands[0];
    const report = { ...credentials, commandId: command.id, result: snapshot };
    bridge.complete(report);
    await reading;
    reports.push(report);
  }
  assert.throws(() => bridge.complete(reports[0]), error => error.code === 'EXPIRED_COMMAND');
  assert.deepEqual(bridge.complete(reports.at(-1)), {});
  t.mock.timers.tick(2 * 60 * 1000);
  assert.throws(() => bridge.complete(reports.at(-1)), error => error.code === 'EXPIRED_COMMAND');
});

test('explicit disconnect rejects pending operations and resumes with no old queued writes', async t => {
  const bridge = makeBridge(t);
  const credentials = bridge.connect(metadata);
  const writing = bridge.request(credentials.sessionId, 'edit_script', {});
  const rejected = assert.rejects(writing, error => error.code === 'DISCONNECTED');
  bridge.disconnect(credentials);
  await rejected;
  assert.deepEqual(bridge.list(), []);
  assert.deepEqual(bridge.connect({ ...credentials, ...metadata }), credentials);
  assert.deepEqual(await bridge.poll({ ...credentials, ...metadata }, stoppedSignal()), { commands: [] });
});

test('known resume fits within the session cap and expired entries free their slots', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000000 });
  const bridge = makeBridge(t, { sessionTimeout: 100 });
  const credentials = Array.from({ length: 32 }, () => bridge.connect(metadata));
  assert.throws(() => bridge.connect(metadata), error => error.code === 'TOO_MANY_SESSIONS');
  assert.deepEqual(bridge.connect({ ...credentials[0], ...metadata }), credentials[0]);
  t.mock.timers.tick(101);
  assert.deepEqual(bridge.connect({ ...credentials[0], ...metadata }), credentials[0]);
  assert.equal(bridge.list().length, 1);
});

test('HTTP connect accepts paired resume credentials and rejects malformed or unauthorized requests', async t => {
  const bridge = makeBridge(t);
  const instance = await startServer({ port: 0, bridge });
  t.after(() => instance.close());
  assert.notEqual(instance.port, 39041);
  const post = data => fetch(`http://127.0.0.1:${instance.port}/bridge/connect`, {
    method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json', 'X-Script-Editor': '1' },
    body: JSON.stringify(data),
  });
  const first = await post(metadata);
  assert.equal(first.status, 200);
  const credentials = await first.json();
  const resumed = await post({ ...credentials, ...metadata, title: '再開' });
  assert.equal(resumed.status, 200);
  assert.deepEqual(await resumed.json(), credentials);
  assert.equal((await post({ ...metadata, sessionId: credentials.sessionId })).status, 400);
  assert.equal((await post({ ...metadata, ...credentials, token: 'z'.repeat(64) })).status, 400);
  assert.equal((await post({ ...metadata, ...credentials, token: '0'.repeat(64) })).status, 401);
  assert.equal(bridge.list()[0].title, '再開');
});
