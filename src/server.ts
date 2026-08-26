import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import formBody from '@fastify/formbody';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import net from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { log } from './logger.js';
import { latestCheckpoint } from './checkpoint.js';
import { registerDemoSite } from './demo-site.js';
import * as picker from './picker.js';
import { getPage } from './browser.js';
import { classifyPage } from './classifier.js';
import { readSelectors } from './workflow.js';
import type { Engine } from './engine.js';

const PANEL_USER = process.env.PANEL_USER ?? 'admin';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD ?? '';
const AUTH_ENABLED = PANEL_PASSWORD.length > 0;

const VNC_UPSTREAM = process.env.SEM_VNC_UPSTREAM ?? 'http://127.0.0.1:6080';

function expectedAuthHeader(): string {
  return 'Basic ' + Buffer.from(`${PANEL_USER}:${PANEL_PASSWORD}`).toString('base64');
}

function signToken(exp: number): string {
  return createHmac('sha256', PANEL_PASSWORD).update(`sem${exp}`).digest('hex');
}

function cookieValid(raw: string | undefined): boolean {
  if (!raw) return false;
  const [sig, expStr] = raw.split('.');
  const exp = Number(expStr);
  if (!exp || exp < Date.now()) return false;
  const good = signToken(exp);
  try {
    return sig.length === good.length && timingSafeEqual(Buffer.from(sig), Buffer.from(good));
  } catch {
    return false;
  }
}

function getCookie(req: any, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function authed(req: any): boolean {
  const c = getCookie(req, 'sem_auth');
  if (cookieValid(c)) return true;
  const hdr = String(req.headers.authorization ?? '');
  if (!hdr) return false;
  const good = expectedAuthHeader();
  try {
    return hdr.length === good.length && timingSafeEqual(Buffer.from(hdr), Buffer.from(good));
  } catch {
    return false;
  }
}

function vncLocalUrl(): string {
  if (NOVNC_PUBLIC_URL) return NOVNC_PUBLIC_URL;
  if (process.env.SEM_VNC_LOCAL === '1') {
    return '/vnc/vnc.html?autoconnect=1&resize=remote&reconnect=1&reconnect_delay=1500&show_dot=1&path=vnc/websockify';
  }
  return '';
}

function stripVncPrefix(url: string): string {
  return url.replace(/^\/vnc\/?/, '/') || '/';
}

function proxyVncHttp(req: any, reply: any): void {
  reply.hijack();
  const u = new URL(VNC_UPSTREAM);
  const upstreamReq = http.request(
    {
      host: u.hostname,
      port: Number(u.port || 80),
      path: stripVncPrefix(req.raw.url ?? '/'),
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
    const lines: string[] = [`GET ${stripVncPrefix(req.url)} HTTP/1.1`, `Host: ${u.host}`];
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
    const u = req.url;
    if (
      u === '/healthz' ||
      u.startsWith('/healthz?') ||
      u.startsWith('/site') ||
      u.startsWith('/vnc') ||
      u === '/login' ||
      u === '/api/login' ||
      u === '/login-form' ||
      u === '/logout' ||
      u === '/icon.svg'
    ) {
      return;
    }
    if (authed(req)) return;
    if (u.startsWith('/api/')) {
      reply.code(401);
      return reply.send();
    }
    return reply.redirect('/login');
  });

  app.get('/login', async (_req, reply) => {
    try {
      const html = await readFile(join(PUBLIC_DIR, 'login.html'), 'utf-8');
      return reply.type('text/html').send(html);
    } catch {
      return reply.code(500).send('login page missing');
    }
  });

  app.post('/api/login', async (req, reply) => {
    const { u, p, remember } = ((req.body ?? {}) as { u?: string; p?: string; remember?: boolean }) ?? {};
    if (u !== PANEL_USER || p !== PANEL_PASSWORD) {
      reply.code(401);
      return { ok: false };
    }
    const exp = Date.now() + (remember === false ? 1 : 30) * 86400000;
    const token = `${signToken(exp)}.${exp}`;
    reply.header(
      'set-cookie',
      `sem_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((exp - Date.now()) / 1000)}`
    );
    return { ok: true };
  });

  app.post('/login-form', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    if (b.username !== PANEL_USER || b.password !== PANEL_PASSWORD) {
      return reply.redirect('/login');
    }
    const exp = Date.now() + (b.remember ? 30 : 1) * 86400000;
    const token = `${signToken(exp)}.${exp}`;
    reply.header(
      'set-cookie',
      `sem_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((exp - Date.now()) / 1000)}`
    );
    return reply.redirect('/');
  });

  app.get('/logout', async (_req, reply) => {
    reply.header('set-cookie', 'sem_auth=; Path=/; HttpOnly; Max-Age=0');
    return reply.redirect('/login');
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

  app.post('/api/stats/reset', async () => {
    const { resetStats } = await import('./analytics.js');
    const r = resetStats();
    log('info', 'CONTROL', `Статистика обнулена (удалено записей: ${r.removed})`);
    bus.emit('status', engine.snapshot());
    return { ok: true, ...r };
  });

  app.get('/api/selectors-health', async () => {
    const s = getAllSettings();
    const snap = engine.snapshot();
    if (s.mode !== 'live' || !s.siteUrl) {
      return { ok: false, reason: 'Боевой режим және сайт адресі керек' };
    }
    if (snap.running && !snap.paused) {
      return { ok: false, reason: 'Бот жұмыс істеп тұр — алдымен ⏸ Пауза басыңыз' };
    }
    try {
      const page = await getPage();
      await page.goto(s.listUrl || s.siteUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await page.waitForTimeout(1500);
      const cls = await classifyPage(page);
      if (cls.kind === 'AUTH') return { ok: false, needsLogin: true };
      const sel = readSelectors();
      const items: { key: string; ok: boolean }[] = [];
      const listRowC = Array.isArray(sel.listRow)
        ? sel.listRow
        : sel.listRow
          ? [sel.listRow]
          : [];
      if (listRowC.length === 0) {
        return {
          ok: false,
          reason: 'Селекторы ещё не обучены — воспользуйтесь 🎯 Режимом обучения (Настройки, выше)',
        };
      }
      let found = false;
      for (const rs of listRowC) {
        try {
          if ((await page.locator(rs).first().count()) > 0) {
            items.push({ key: `listRow: ${rs}`, ok: true });
            found = true;
            break;
          }
        } catch {
          /* next */
        }
      }
      if (listRowC.length > 0 && !found) items.push({ key: 'listRow', ok: false });
      const pendC = Array.isArray(sel.statusPending)
        ? sel.statusPending
        : sel.statusPending
          ? [sel.statusPending]
          : [];
      let pf = false;
      for (const ps of pendC) {
        try {
          if ((await page.locator(ps).first().count()) > 0) {
            pf = true;
            break;
          }
        } catch {
          /* next */
        }
      }
      items.push({ key: 'statusPending', ok: pf });
      return {
        ok: true,
        checkedAt: new Date().toISOString(),
        items,
        note: 'acceptButton / statusAccepted — деталь бетте, жұмыс кезінде тексеріледі',
      };
    } catch (e) {
      return { ok: false, reason: String(e).slice(0, 140) };
    }
  });

  app.get('/api/checkpoint', async () => latestCheckpoint() ?? null);

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/debug/shot', async () => {
    const f = await import('./browser.js').then((m) => m.screenshot('manual'));
    return { ok: !!f, file: f };
  });

  app.get('/api/debug/dump', async () => {
    const page = await import('./browser.js').then((m) => m.getPage());
    return page.evaluate(`(() => ({
      url: location.href,
      title: document.title,
      bodyText: document.body.innerText.slice(0, 1200),
      inputs: [...document.querySelectorAll('input,textarea')].map((i) => ({
        t: i.type, id: i.id, name: i.name, ph: i.placeholder,
      })),
      buttons: [...document.querySelectorAll('button,[role=button]')]
        .map((b) => ({ txt: (b.innerText || '').trim().slice(0, 40), cls: String(b.className).slice(0, 60) }))
        .filter((b) => b.txt)
        .slice(0, 30),
      links: [...document.querySelectorAll('a')]
        .map((a) => ({ txt: a.innerText.trim().slice(0, 30), href: a.getAttribute('href') }))
        .filter((l) => l.txt)
        .slice(0, 30),
      tables: [...document.querySelectorAll('table tbody')]
        .map((t) => ({ rows: t.querySelectorAll('tr').length })),
    }))()`);
  });

  app.post('/api/picker/start', async (req) => {
    const snap = engine.snapshot();
    if (snap.running && !snap.paused) {
      return { ok: false, reason: 'Бот сейчас работает — сначала нажмите ⏸ Пауза или ⏹ Стоп' };
    }
    const { url } = ((req.body ?? {}) as { url?: string }) ?? {};
    return picker.startPicker(url);
  });

  app.post('/api/picker/reinject', async () => picker.reinject());

  app.post('/api/picker/demo', async (req) => {
    const snap = engine.snapshot();
    if (snap.running && !snap.paused) {
      return { ok: false, reason: 'Бот сейчас работает — сначала ⏸ Пауза' };
    }
    const { url, selectors } = ((req.body ?? {}) as {
      url?: string;
      selectors?: string[];
    }) ?? {};
    return picker.demoClicks(url, Array.isArray(selectors) ? selectors : []);
  });

  app.get('/api/picker/picks', async () => {
    await picker.heartbeat();
    return {
      active: picker.isActive(),
      picks: picker.list(),
    };
  });

  app.post('/api/picker/label', async () => ({ ok: true }));

  app.post('/api/picker/save', async () => ({ ok: true, json: '{}' }));

  app.post('/api/picker/save-steps', async () => {
    const { parseSteps } = await import('./workflow.js');
    engine.applySettings();
    return { ok: true, count: parseSteps().length };
  });

  app.get('/api/steps', async () => {
    const { parseSteps } = await import('./workflow.js');
    return { steps: parseSteps() };
  });

  app.post('/api/steps', async (req) => {
    const { steps } = ((req.body ?? {}) as { steps?: unknown }) ?? {};
    if (!Array.isArray(steps)) return { ok: false, error: 'steps array required' };
    setSettingsPatch({ stepsJson: JSON.stringify(steps) });
    engine.applySettings();
    return { ok: true, count: steps.length };
  });

  app.post('/api/picker/stop', async () => picker.stop());

  app.get('/api/ai/state', async () => {
    const { agentState } = await import('./agent.js');
    return agentState();
  });

  app.post('/api/ai/run', async (req) => {
    const { task, maxSteps } = ((req.body ?? {}) as { task?: string; maxSteps?: number }) ?? {};
    const snap = engine.snapshot();
    if (snap.running && !snap.paused) {
      return { ok: false, reason: 'Бот работает по расписанию — сначала ⏸ Пауза или ⏹ Стоп' };
    }
    const { runAiTask } = await import('./agent.js');
    return runAiTask(String(task ?? ''), Math.min(40, Math.max(1, Number(maxSteps ?? 25))));
  });

  app.post('/api/ai/test', async () => {
    const s = getAllSettings();
    if (!s.aiApiKey) return { ok: false, reason: 'Ключ не задан', model: String(s.aiModel) };
    const { testKey } = await import('./gemini.js');
    return testKey({
      key: String(s.aiApiKey),
      model: String(s.aiModel),
      baseUrl: String(s.aiBaseUrl || ''),
    });
  });

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
    const onAgent = (st: unknown): void => {
      try {
        ws.send(JSON.stringify({ type: 'agent', st }));
      } catch {
        /* closed */
      }
    };
    bus.on('agent', onAgent);
    ws.on('close', () => {
      bus.off('feed', onFeed);
      bus.off('status', onStatus);
      bus.off('agent', onAgent);
    });
  });

  await app.listen({ port: PORT, host: HOST });

  /* Пока идёт обучение — сервер сам держит панель на текущей странице VNC
     (после каждого перехода на новую страницу скрипт внедряется заново). */
  const hb = setInterval(() => {
    void picker.heartbeat();
  }, 2000);
  hb.unref?.();
}
