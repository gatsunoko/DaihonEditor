import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { BrowserBridge } from './bridge-host.mjs';
import { createMcpServer } from './tools.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE_ID = createHash('sha256').update(ROOT.toLowerCase()).digest('hex');
export const DEFAULT_PORT = 39041;
const MAX_BODY = 8 * 1024 * 1024;
const credentials = z.object({ sessionId: z.string().uuid(), token: z.string().regex(/^[0-9a-f]{64}$/) });
const metadata = { projectId: z.string().min(1).max(200), title: z.string().max(10000) };
const schemas = {
  connect: z.object(metadata).extend(credentials.shape).partial({ sessionId: true, token: true }).strict()
    .refine(value => (value.sessionId === undefined) === (value.token === undefined), 'Both sessionId and token are required to resume'),
  poll: credentials.extend(metadata).strict(),
  disconnect: credentials.strict(),
  result: credentials.extend({ commandId: z.string().uuid(), result: z.object({
    project: z.object({ projectId: z.string(), title: z.string() }).passthrough(), revision: z.string(),
  }).passthrough().optional(), error: z.object({ code: z.string().max(100), message: z.string().max(10000) }).strict().optional() }).strict()
    .refine(value => Boolean(value.result) !== Boolean(value.error), 'Exactly one result or error is required'),
};
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']],
  ['/mcp/project-edits.js', ['mcp/project-edits.js', 'text/javascript']],
  ['/mcp/browser-bridge.js', ['mcp/browser-bridge.js', 'text/javascript']],
]);
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('JSONで送信してください。'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('リクエストが大きすぎます。章ごとに操作してください。'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSONが不正です。'), { status: 400 }); }
}

export async function startServer({ port = DEFAULT_PORT, bridge = new BrowserBridge() } = {}) {
  const instanceId = randomUUID();
  const transports = new Set();
  const server = http.createServer(async (req, res) => {
    const activePort = server.address()?.port || port;
    const hosts = [`127.0.0.1:${activePort}`, `localhost:${activePort}`];
    if (!hosts.includes(req.headers.host)) return json(res, 403, { error: { code: 'FORBIDDEN_HOST', message: 'ローカル接続だけを受け付けます。' } });
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${activePort}`); }
    catch { return json(res, 400, { error: { code: 'INVALID_REQUEST', message: '接続先URLが不正です。' } }); }
    const origin = req.headers.origin;
    const isBridge = url.pathname.startsWith('/bridge/');
    const allowedOrigin = !origin || hosts.some(h => origin === `http://${h}`) || (isBridge && origin === 'null');
    if (!allowedOrigin) return json(res, 403, { error: { code: 'FORBIDDEN_ORIGIN', message: 'このページからの接続は許可されていません。' } });
    if (isBridge && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Script-Editor');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      // Chromium's local-network preflight for file:// editors.
      if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (isBridge && req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { app: 'script-editor-mcp', version: '1.0.0', workspaceId: WORKSPACE_ID, instanceId, bridgeProtocolVersion: 2 });
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POSTを使用してください。' } });
        const body = await readJson(req);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const mcp = createMcpServer(bridge);
        transports.add(transport);
        res.once('close', () => { transports.delete(transport); void mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (isBridge) {
        if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POSTを使用してください。' } });
        if (req.headers['x-script-editor'] !== '1') return json(res, 403, { error: { code: 'FORBIDDEN', message: 'エディタから接続してください。' } });
        const action = url.pathname.slice('/bridge/'.length);
        if (!Object.hasOwn(schemas, action)) return json(res, 404, { error: { code: 'NOT_FOUND', message: '接続先がありません。' } });
        const args = schemas[action].parse(await readJson(req));
        const controller = new AbortController();
        res.once('close', () => controller.abort());
        const result = action === 'poll' ? await bridge.poll(args, controller.signal)
          : action === 'result' ? bridge.complete(args) : bridge[action](args);
        if (!res.destroyed) json(res, 200, result);
        return;
      }
      const asset = assets.get(url.pathname);
      if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
        const bytes = await readFile(path.join(ROOT, asset[0]));
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'Content-Length': bytes.length });
        res.end(req.method === 'HEAD' ? undefined : bytes);
        return;
      }
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'ページがありません。' } });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      json(res, error.status || (error instanceof z.ZodError ? 400 : error.code === 'DISCONNECTED' ? 401 : 400), {
        error: { code: error.code || 'INVALID_REQUEST', message: error instanceof z.ZodError ? '接続リクエストの形式が不正です。' : error.message },
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server, bridge, port: server.address().port,
    close: async () => {
      bridge.close();
      await Promise.allSettled([...transports].map(t => t.close()));
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.SCRIPT_EDITOR_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SCRIPT_EDITOR_PORTは1024〜65535で指定してください。');
  const instance = await startServer({ port });
  console.error(`台本エディタ: http://127.0.0.1:${instance.port}/  MCP: http://127.0.0.1:${instance.port}/mcp`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await instance.close(); process.exit(0); });
}
