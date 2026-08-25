import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
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
import type { Engine } from './engine.js';

export async function buildServer(engine: Engine): Promise<void> {
  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, { root: PUBLIC_DIR });
  await app.register(fastifyStatic, {
    root: SHOTS_DIR,
    prefix: '/shots/',
    decorateReply: false,
  });

  app.get('/api/status', async () => ({
    snap: engine.snapshot(),
    time: new Date().toISOString(),
  }));

  app.get('/api/meta', async () => ({ vncUrl: NOVNC_PUBLIC_URL, version: VERSION }));

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
    if (req.url === '/ws') {
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
