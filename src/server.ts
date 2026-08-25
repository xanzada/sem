import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import formBody from '@fastify/formbody';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { PUBLIC_DIR, SHOTS_DIR, PORT, HOST, NOVNC_PUBLIC_URL, VERSION } from './config.js';
import { bus } from './bus.js';
import { db } from './db.js';
import {
  getAllSettings,
  setSettingsPatch,
  maskSettings,
  applySecretPlaceholders,
} from './settings.js';
import { analyticsSummary } from './analytics.js';
import { latestCheckpoint } from './checkpoint.js';
import { registerDemoSite } from './demo-site.js';
import type { Engine } from './engine.js';

const PANEL_USER = process.env.PANEL_USER ?? 'admin';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD ?? '';
const AUTH_ENABLED = PANEL_PASSWORD.length > 0;

const VNC_UPSTREAM = process.env.SEM_VNC_UPSTREAM ?? 'http://127.0.0.1:6080';

function expectedAuthHeader(): string {
  return 'Basic ' + Buffer.from(`${PANEL_USER}:${PANEL_PASSWORD}`).toString('base64');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function vncLocalUrl(): string {
  if (NOVNC_PUBLIC_URL) return NOVNC_PUBLIC_URL;
  if (process.env.SEM_VNC_LOCAL === '1') {
    return '/vnc/vnc.html?autoconnect=1&resize=scale&path=vnc/websockify';
  }
  return '';
}

function proxyVncHttp(req: any, reply: any): void {
  reply.hijack();
  const u = new URL(VNC_UPSTREAM);
  const upstreamReq = http.request(
    {
      host: u.hostname,
      port: Number(u.port || 80),
      path: req.raw.url,
      method: req.method,
      headers: { ...req.headers, host: u.host },
    },
    (res) => {
      try {
        reply.raw.writeHead(res.statusCode ?? 502, res.headers);
        res.pipe(reply.raw);
      } catch {
        /* socket gone */
      }
    }
  );
  upstreamReq.on('error', () => {
    try {
      reply.raw.writeHead(502, { 'content-type': 'text/plain' });
      reply.raw.end('noVNC upstream unavailable');
    } catch {
      /* ignore */
    }
  });
  req.raw.pipe(upstreamReq);
}

function tunnelVncWs(req: any, socket: net.Socket, head: Buffer): void {
  const u = new URL(VNC_UPSTREAM);
  const client = net.connect(Number(u.port || 80), u.hostname, () => {
    const lines: string[] = [`GET ${req.url} HTTP/1.1`, `Host: ${u.host}`];
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'connection' || lk === 'upgrade') continue;
      lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    lines.push('Connection: Upgrade', 'Upgrade: websocket');
    client.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length > 0) client.write(head);
  });
  client.pipe(socket);
  socket.pipe(client);
  const kill = (): void => {
    client.destroy();
    socket.destroy();
  };
  client.on('error', kill);
  socket.on('error', kill);
}

export async function buildServer(engine: Engine): Promise<void> {
  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, { root: PUBLIC_DIR });
  await app.register(fastifyStatic, {
    root: SHOTS_DIR,
    prefix: '/shots/',
    decorateReply: false,
  });
  await app.register(formBody);

  registerDemoSite(app);

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/vnc')) {
      proxyVncHttp(req, reply);
      return reply;
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!AUTH_ENABLED) return;
    if (req.url === '/healthz' || req.url.startsWith('/healthz?')) return;
    const hdr = String(req.headers.authorization ?? '');
    if (!safeEqual(hdr, expectedAuthHeader())) {
      reply.code(401).header('www-authenticate', 'Basic realm="SEM panel"');
      return reply.send();
    }
  });

  app.get('/api/status', async () => ({
    snap: engine.snapshot(),
    time: new Date().toISOString(),
  }));

  app.get('/api/meta', async () => ({ vncUrl: vncLocalUrl(), version: VERSION }));

  app.get('/api/settings', async () => maskSettings(getAllSettings()));

  app.post('/api/settings', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    applySecretPlaceholders(body, getAllSettings());
    setSettingsPatch(body);
    engine.applySettings();
    return { ok: true };
  });

  app.get('/api/events', async (req) => {
    const q = (req.query ?? {}) as { limit?: string; category?: string; level?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 80)));
    let sql = 'SELECT id,ts,level,category,message,meta FROM events';
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (q.category) {
      conds.push('category=?');
      params.push(q.category.toUpperCase());
    }
    if (q.level) {
      conds.push('level=?');
      params.push(q.level);
    }
    if (conds.length > 0) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params);
  });

  app.get('/api/analytics', async () => analyticsSummary());

  app.get('/api/checkpoint', async () => latestCheckpoint() ?? null);

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/api/control', async (req, reply) => {
    const { cmd } = ((req.body ?? {}) as { cmd?: string }) ?? {};
    switch (cmd) {
      case 'start':
        await engine.start();
        break;
      case 'stop':
        engine.stop();
        break;
      case 'pause':
        engine.pause();
        break;
      case 'resume':
        engine.resume();
        break;
      case 'test-login':
        return { ok: await engine.testLogin() };
      default:
        reply.code(400);
        return { ok: false, error: 'unknown command' };
    }
    return { ok: true, snap: engine.snapshot() };
  });

  const wss = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (url.startsWith('/vnc')) {
      tunnelVncWs(req as any, socket as any, head as any);
      return;
    }
    if (url === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'status', snap: engine.snapshot() }));
    const onFeed = (item: unknown): void => {
      try {
        ws.send(JSON.stringify({ type: 'feed', item }));
      } catch {
        /* closed */
      }
    };
    const onStatus = (snap: unknown): void => {
      try {
        ws.send(JSON.stringify({ type: 'status', snap }));
      } catch {
        /* closed */
      }
    };
    bus.on('feed', onFeed);
    bus.on('status', onStatus);
    ws.on('close', () => {
      bus.off('feed', onFeed);
      bus.off('status', onStatus);
    });
  });

  await app.listen({ port: PORT, host: HOST });
}
