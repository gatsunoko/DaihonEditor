import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';

function failure(code, message) { return Object.assign(new Error(message), { code }); }
const ACK_LIMIT = 128;
const ACK_TIMEOUT = 2 * 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sessionIdForToken(token) {
  const bytes = createHash('sha256').update('script-editor-session-v1\0').update(Buffer.from(token, 'hex')).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function timeoutFailure() {
  return failure('EDITOR_TIMEOUT', 'エディタの応答期限が過ぎました。台本のタブを表示すると接続は自動で回復します。反映済みの可能性があるため、台本を再取得してから編集してください。');
}

export class BrowserBridge {
  constructor({ commandTimeout = 30000, sessionTimeout = 5 * 60 * 1000, pollTimeout = 20000 } = {}) {
    this.sessions = new Map();
    this.commandTimeout = commandTimeout;
    this.sessionTimeout = sessionTimeout;
    this.pollTimeout = pollTimeout;
    this.sweeper = setInterval(() => this.prune(), 5000);
    this.sweeper.unref();
  }
  connect({ projectId, title, sessionId, token }) {
    this.prune();
    const hasId = sessionId !== undefined;
    const hasToken = token !== undefined;
    if (hasId !== hasToken || (hasId && (!SESSION_PATTERN.test(sessionId) || !TOKEN_PATTERN.test(token)))) {
      throw failure('INVALID_REQUEST', '再接続には有効な接続IDとトークンの両方が必要です。');
    }
    const known = hasId ? this.sessions.get(sessionId) : null;
    if (known) {
      this.authenticate({ sessionId, token });
      this.expireCommands(known);
      known.projectId = projectId;
      known.title = title;
      known.lastSeen = Date.now();
      // An abandoned long-poll must not consume a command into its old HTTP
      // response. Delivered commands remain pending and are never requeued.
      known.poll?.(false);
      return { sessionId, token };
    }
    if (this.sessions.size >= 32) throw failure('TOO_MANY_SESSIONS', '接続画面が多すぎます。不要なAI接続を解除してください。');
    // A valid derived pair can prove ownership after expiry or a helper restart.
    // Unknown legacy IDs cannot be verified: issue a fresh identity instead of
    // allowing a caller to adopt an arbitrary public session ID.
    if (!hasId || sessionIdForToken(token) !== sessionId) {
      token = randomBytes(32).toString('hex');
      sessionId = sessionIdForToken(token);
    }
    this.sessions.set(sessionId, {
      sessionId, token, projectId, title, lastSeen: Date.now(), queue: [], pending: new Map(), acknowledged: new Map(), poll: null,
    });
    return { sessionId, token };
  }
  prune() {
    for (const session of this.sessions.values()) {
      if (Date.now() - session.lastSeen > this.sessionTimeout) this.remove(session.sessionId);
    }
  }
  list() {
    this.prune();
    return [...this.sessions.values()].map(({ sessionId, projectId, title }) => ({ sessionId, projectId, title }));
  }
  authenticate({ sessionId, token }) {
    const session = this.sessions.get(sessionId);
    const provided = Buffer.from(typeof token === 'string' ? token : '');
    const expected = Buffer.from(session?.token || '');
    if (!session || provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw failure('DISCONNECTED', 'AI接続が解除されました。エディタから再接続してください。');
    return session;
  }
  expireCommands(session) {
    const now = Date.now();
    for (const pending of [...session.pending.values()]) {
      if (now >= pending.deadline) pending.fail(timeoutFailure());
    }
  }
  async poll(args, signal) {
    const session = this.authenticate(args);
    this.expireCommands(session);
    session.lastSeen = Date.now();
    session.projectId = args.projectId;
    session.title = args.title;
    if (session.poll) throw failure('DUPLICATE_POLL', '同じ接続の受信処理が重複しています。');
    if (session.queue.length) return { commands: session.queue.splice(0) };
    return new Promise(resolve => {
      let done = false;
      const finish = (deliver = true) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (session.poll === finish) session.poll = null;
        session.lastSeen = Date.now();
        this.expireCommands(session);
        resolve({ commands: deliver && this.sessions.get(session.sessionId) === session ? session.queue.splice(0) : [] });
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(), this.pollTimeout);
      session.poll = finish;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) finish(false);
    });
  }
  request(sessionId, action, args, signal) {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(failure('DISCONNECTED', '台本が接続されていません。エディタを開き「AI接続」を有効にしてください。'));
    if (session.pending.size >= 16) return Promise.reject(failure('BUSY', '処理中の操作が多すぎます。完了してから再実行してください。'));
    if (signal?.aborted) return Promise.reject(failure('CANCELLED', '操作が中止されました。'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        session.pending.delete(id);
        session.queue = session.queue.filter(c => c.id !== id);
      };
      const fail = error => { clean(); reject(error); };
      const abort = () => fail(failure('CANCELLED', '操作が中止されました。既に反映された可能性があるため、台本を再取得してください。'));
      const deadline = Date.now() + this.commandTimeout;
      const timer = setTimeout(() => fail(timeoutFailure()), this.commandTimeout);
      session.pending.set(id, { deadline, finish: data => { clean(); resolve(data); }, fail });
      session.queue.push({ id, action, args, deadline });
      signal?.addEventListener('abort', abort, { once: true });
      session.poll?.();
    });
  }
  complete(args) {
    const session = this.authenticate(args);
    session.lastSeen = Date.now();
    for (const [id, expiresAt] of session.acknowledged) {
      if (Date.now() >= expiresAt) session.acknowledged.delete(id);
    }
    // A browser may retry only its result report after losing the HTTP ACK.
    // A duplicate cannot resolve a request twice or replace its first result.
    if (session.acknowledged.has(args.commandId)) return {};
    const pending = session.pending.get(args.commandId);
    if (!pending) throw failure('EXPIRED_COMMAND', '操作の応答期限が過ぎました。台本を再取得してください。');
    if (Date.now() >= pending.deadline) {
      pending.fail(timeoutFailure());
      throw failure('EXPIRED_COMMAND', '操作の応答期限が過ぎました。台本を再取得してください。');
    }
    if (!args.error && (!args.result?.project || typeof args.result.revision !== 'string')) throw failure('INVALID_RESULT', 'エディタからの応答が不正です。');
    session.acknowledged.set(args.commandId, Date.now() + ACK_TIMEOUT);
    while (session.acknowledged.size > ACK_LIMIT) session.acknowledged.delete(session.acknowledged.keys().next().value);
    if (args.error) pending.fail(failure(args.error.code || 'EDITOR_ERROR', args.error.message || 'エディタで操作に失敗しました。'));
    else {
      session.projectId = args.result.project.projectId;
      session.title = args.result.project.title;
      pending.finish(args.result);
    }
    return {};
  }
  remove(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    for (const pending of [...session.pending.values()]) pending.fail(failure('DISCONNECTED', 'エディタとの接続が解除されました。反映状況はエディタで確認してください。'));
    session.queue = [];
    session.poll?.(false);
  }
  disconnect(args) { this.authenticate(args); this.remove(args.sessionId); return {}; }
  close() { clearInterval(this.sweeper); for (const id of [...this.sessions.keys()]) this.remove(id); }
}
