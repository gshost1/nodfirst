import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createStore, AppError } from './store.mjs';
import { createWorkflowService, startWorker } from './workflow.mjs';
import { createLocalProvider } from './provider.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const personas = { coordinator: 'Jordan Lee (coordinator)', admin: 'Maya Chen (admin)' };
const staticFiles = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };

export function createApp({ dbPath = process.env.DAYBREAK_DB || resolve(root, '.data/daybreak.sqlite'), provider = createLocalProvider(), worker = true } = {}) {
  const store = createStore(dbPath);
  const service = createWorkflowService(store);
  const sessions = new Map();
  let stopWorker = async () => {};
  function getSession(req, res) {
    const cookie = /(?:^|;\s*)daybreak_session=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    let entry = cookie && sessions.get(cookie);
    if (entry && entry.expiresAt < Date.now()) { sessions.delete(cookie); entry = null; }
    if (!entry) {
      const token = randomBytes(24).toString('hex');
      entry = { role: 'coordinator', actor: personas.coordinator, csrfToken: randomBytes(24).toString('hex'), expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
      if (sessions.size > 1000) sessions.clear();
      sessions.set(token, entry);
      res.setHeader('Set-Cookie', `daybreak_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    }
    return entry;
  }
  function publicSession(session) { return { role: session.role, actor: session.actor, csrfToken: session.csrfToken }; }
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  async function body(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, 'Send this request as JSON.');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new AppError(413, 'The request is too large.'); chunks.push(chunk); }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch { throw new AppError(400, 'The request must contain a JSON object.'); }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const address = server.address();
      const port = typeof address === 'object' ? address.port : 4317;
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!allowedHosts.has(req.headers.host)) throw new AppError(403, 'Use the local Daybreak address shown in your terminal.');
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) throw new AppError(403, 'Requests must come from this local app.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'Cross-site requests are not allowed.');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && staticFiles[url.pathname]) {
        const [file, type] = staticFiles[url.pathname];
        const content = await readFile(resolve(root, 'public', file));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content); return;
      }
      if (!url.pathname.startsWith('/api/')) throw new AppError(404, 'Page not found.');
      const session = getSession(req, res);
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { ...store.state(), session: publicSession(session) });
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, model: { provider: provider.name, model: provider.model, baseUrl: provider.baseUrl, ...await provider.health() } });
      if (req.method !== 'POST') throw new AppError(405, 'This endpoint needs a POST request.');
      if (req.headers['x-csrf-token'] !== session.csrfToken) throw new AppError(403, 'Your session changed. Refresh the page and try again.');
      const input = await body(req);
      if (url.pathname === '/api/session') {
        if (!Object.hasOwn(personas, input.role)) throw new AppError(422, 'Choose coordinator or admin.');
        session.role = input.role; session.actor = personas[input.role];
        return json(res, 200, { session: publicSession(session) });
      }
      if (url.pathname === '/api/employees') return json(res, 201, { employee: service.addEmployee(input, session.actor) });
      const route = /^\/api\/(employees|tasks|workflows|approvals)\/([^/]+)\/(onboard|complete|judgment|decision)$/.exec(url.pathname);
      if (route) {
        const [, resource, recordId, action] = route;
        if (resource === 'employees' && action === 'onboard') return json(res, 200, { workflow: service.onboard(recordId, session.actor) });
        if (resource === 'tasks' && action === 'complete') return json(res, 200, { task: service.completeTask(recordId, session.actor) });
        if (resource === 'workflows' && action === 'judgment') return json(res, 202, { job: service.queueJudgment(recordId, session.actor) });
        if (resource === 'approvals' && action === 'decision') return json(res, 200, service.decide(recordId, input, session));
      }
      throw new AppError(404, 'Endpoint not found.');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (!(error instanceof AppError)) console.error('Request failed:', error.message);
      json(res, error.status || 500, { error: error.status ? error.message : 'The local app encountered an error. Check the terminal and retry.' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server, store, service, provider,
    async listen(port = Number(process.env.PORT || 4317)) {
      await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolvePromise); });
      if (worker) stopWorker = startWorker(service, provider);
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() { await new Promise(resolvePromise => server.close(resolvePromise)); await stopWorker(); store.close(); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp();
  const address = await app.listen();
  console.log(`Daybreak is ready at ${address}\nSynthetic local demo · SQLite persistence · ${app.provider.model} via local Ollama`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return; closing = true;
    await app.close(); process.exit(0);
  });
}
