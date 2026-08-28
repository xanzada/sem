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
import { analyticsSummary, resetStats } from './analytics.js';
import { log } from './logger.js';
import { getPage } from './browser.js';
import { collectDom } from './dom.js';
import { listRules, activateRule, deactivateAll, deleteRule, activeRule } from './rules.js';
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

function getCookie(req: { headers: Record<string, unknown> }, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function authed(req: { headers: Record<string, unknown> }): boolean {
  if (cookieValid(getCookie(req, 'sem_auth'))) return true;
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
    /* resize=scale, а не remote: Xvfb за x11vnc отказывает в изменении
     * разрешения, и тогда noVNC показывает только левый верхний угол экрана. */
    return '/vnc/vnc.html?autoconnect=1&resize=scale&reconnect=1&reconnect_delay=1500&show_dot=1&quality=6&compression=2&path=vnc/websockify';
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
  await app.register(fastifyStatic, { root: SHOTS_DIR, prefix: '/shots/', decorateReply: false });
  await app.register(formBody);

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
      u.startsWith('/vnc') ||
      u === '/login' ||
      u === '/api/login' ||
      u === '/login-form' ||
      u === '/logout' ||
      u === '/icon.svg' ||
      u === '/manifest.webmanifest'
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

  /* ---------------- вход в панель ---------------- */

  app.get('/login', async (_req, reply) => {
    try {
      const html = await readFile(join(PUBLIC_DIR, 'login.html'), 'utf-8');
      return reply.type('text/html').send(html);
    } catch {
      return reply.code(500).send('login page missing');
    }
  });

  app.post('/api/login', async (req, reply) => {
    const { u, p, remember } =
      ((req.body ?? {}) as { u?: string; p?: string; remember?: boolean }) ?? {};
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

  /* ---------------- состояние ---------------- */

  app.get('/api/status', async () => {
    /* Адрес берём напрямую из браузера: он важен и когда наблюдение выключено,
     * иначе оператор не видит, на какой странице он остановился. */
    let pageUrl = '';
    try {
      pageUrl = (await getPage()).url();
    } catch {
      pageUrl = '';
    }
    const snap = engine.snapshot();
    return {
      snap: { ...snap, watchUrl: snap.watchUrl || pageUrl },
      rule: activeRule(),
      time: new Date().toISOString(),
    };
  });

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
    const q = (req.query ?? {}) as { limit?: string; category?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 80)));
    let sql = 'SELECT id,ts,level,category,message,meta FROM events';
    const params: (string | number)[] = [];
    if (q.category) {
      sql += ' WHERE category=?';
      params.push(q.category.toUpperCase());
    }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params);
  });

  app.get('/api/analytics', async () => analyticsSummary());

  app.post('/api/stats/reset', async () => {
    const r = resetStats();
    log('info', 'CONTROL', `Статистика обнулена (удалено записей: ${r.removed})`);
    bus.emit('status', engine.snapshot());
    return { ok: true, ...r };
  });

  app.get('/healthz', async () => ({ ok: true }));

  /* ---------------- обучение и правила ---------------- */

  /* Модель вызывается РОВНО один раз здесь. Дальше работа идёт внутри страницы. */
  app.post('/api/learn', async (req) => {
    const { task } = ((req.body ?? {}) as { task?: string }) ?? {};
    const text = String(task ?? '').trim();
    if (text) setSettingsPatch({ taskText: text });
    const { learnRule } = await import('./learn.js');
    const r = await learnRule(text || String(getAllSettings().taskText || ''));
    if (r.ok) engine.applySettings();
    return r;
  });

  app.get('/api/rules', async () => ({ rules: listRules(), active: activeRule() }));

  app.post('/api/rules/activate', async (req) => {
    const { id } = ((req.body ?? {}) as { id?: string }) ?? {};
    if (!id) return { ok: false, reason: 'id required' };
    activateRule(String(id));
    engine.applySettings();
    log('info', 'CONTROL', 'Активировано другое правило');
    return { ok: true, active: activeRule() };
  });

  app.post('/api/rules/off', async () => {
    deactivateAll();
    engine.applySettings();
    return { ok: true };
  });

  app.post('/api/rules/delete', async (req) => {
    const { id } = ((req.body ?? {}) as { id?: string }) ?? {};
    if (!id) return { ok: false, reason: 'id required' };
    deleteRule(String(id));
    engine.applySettings();
    return { ok: true, rules: listRules() };
  });

  /* ---------------- наблюдение ---------------- */

  app.post('/api/watch/start', async () => {
    await engine.start();
    return { ok: engine.snapshot().running, snap: engine.snapshot() };
  });

  app.post('/api/watch/stop', async () => {
    engine.stop();
    return { ok: true, snap: engine.snapshot() };
  });

  /* ---------------- диагностика без модели ---------------- */

  /* Открыть страницу из панели — так удобнее, чем печатать адрес в VNC.
   * Дальше оператор доводит страницу до нужного шага вручную. */
  app.post('/api/tools/open', async (req) => {
    const { url } = ((req.body ?? {}) as { url?: string }) ?? {};
    const target = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, reason: 'нужен адрес http(s)://' };
    if (engine.snapshot().running) {
      return { ok: false, reason: 'Сначала остановите наблюдение — переход сбросил бы страницу' };
    }
    try {
      const page = await getPage();
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40000 });
      log('info', 'CONTROL', `Открыта страница: ${target.slice(0, 140)}`);
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') };
    } catch (e) {
      return { ok: false, reason: String(e).slice(0, 160) };
    }
  });

  /* Что именно «видит» бот на странице — нужно при разборе, почему правило
   * не сработало. Квота API при этом не тратится. */
  app.get('/api/tools/inspect', async () => {
    const page = await getPage();
    const els = await collectDom(page);
    /* Күзетшінің ішкі күйі: неге ұстамағанын тек осыдан көруге болады. */
    const watch = await page
      .evaluate(
        `(() => {
          const W = window['__semWatch'];
          if (!W) return { present: false };
          return {
            present: true,
            armed: W.state.armed,
            busy: W.state.busy,
            scans: W.state.scans,
            pendingHits: (W.pending ? W.pending() : -1),
            doneKeys: W.state.doneKeys ? W.state.doneKeys.size : -1,
            cfg: W.cfg || null,
            lastError: W.state.lastError || null,
          };
        })()`
      )
      .catch((e) => ({ present: false, error: String(e).slice(0, 120) }));
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      viewport: page.viewportSize() ?? { width: 0, height: 0 },
      count: els.length,
      watcher: watch,
      elements: els,
    };
  });

  /* Проверка правила «вживую»: ищем текст сейчас, без клика.
   * Логика совпадения та же, что у наблюдателя (границы слова), иначе
   * диагностика показывала бы не то, что реально сработает. */
  app.post('/api/tools/probe', async (req) => {
    const b = (req.body ?? {}) as { text?: string; scope?: string };
    const needle = String(b.text ?? '').trim();
    if (!needle) return { ok: false, reason: 'text required' };
    const page = await getPage();
    const found = (await page
      .evaluate(
        `(() => {
          const scope = ${JSON.stringify(b.scope ?? '')};
          let roots = [document.body];
          if (scope) {
            try {
              const l = [...document.querySelectorAll(scope)];
              if (l.length) roots = l;
            } catch {}
          }
          const needle = ${JSON.stringify(needle.toLowerCase())};
          const LETTER = /[\\p{L}\\p{N}]/u;
          const hasNeedle = (text) => {
            let from = 0;
            for (;;) {
              const i = text.indexOf(needle, from);
              if (i < 0) return false;
              const before = i === 0 ? '' : text[i - 1];
              const after = text[i + needle.length] || '';
              if ((!before || !LETTER.test(before)) && (!after || !LETTER.test(after))) return true;
              from = i + 1;
            }
          };
          const out = [];
          for (const root of roots) {
            const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let n = w.currentNode;
            while (n && out.length < 10) {
              const tag = n.tagName;
              if (tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'NOSCRIPT' && n.childElementCount <= 2) {
                const t = (n.textContent || '').replace(/\\s+/g, ' ').trim();
                if (t && hasNeedle(t.toLowerCase())) {
                  const r = n.getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) out.push({ text: t.slice(0, 90), y: Math.round(r.top) });
                }
              }
              n = w.nextNode();
            }
          }
          return out;
        })()`
      )
      .catch(() => [])) as { text: string; y: number }[];
    return { ok: true, matches: found, count: found.length };
  });

  /* Живая проверка робота: на страницу добавляется временный блок с текстом
   * из правила, кнопкой и кнопками подтверждения. Наблюдатель должен поймать
   * его и пройти всю цепочку — так видно, что механизм работает, ещё до
   * появления настоящего слота. Блок удаляется сам и ничего не отправляет. */
  app.post('/api/tools/simulate', async () => {
    const r = activeRule();
    if (!r) return { ok: false, reason: 'Сначала обучите робота' };
    if (!engine.snapshot().running) {
      return { ok: false, reason: 'Сначала запустите наблюдение — иначе ловить некому' };
    }
    const page = await getPage();
    const clickLabel = r.clickText || 'Записаться';
    /* Растау қадамдарын да қоямыз: әйтпесе тест «расталмады» деп бітеді. */
    const confirmLabels = r.confirm
      .map((s) => String(s.text ?? '').trim())
      .filter(Boolean)
      .slice(0, 4);
    try {
      await page.evaluate(
        `(() => {
          document.querySelectorAll('[data-sem-sim]').forEach((n) => n.remove());
          const box = document.createElement('div');
          box.setAttribute('data-sem-sim', '1');
          box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;'
            + 'background:#0b1017;color:#e8eef6;border:2px solid #22c55e;border-radius:10px;'
            + 'padding:10px 12px;font:13px system-ui;max-width:60vw';
          const row = document.createElement('div');
          const t = document.createElement('span');
          t.textContent = ${JSON.stringify(r.watchText)};
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = ${JSON.stringify(clickLabel)};
          b.style.cssText = 'margin-left:10px;padding:4px 10px;cursor:pointer';
          row.appendChild(t);
          row.appendChild(b);
          box.appendChild(row);

          const labels = ${JSON.stringify(confirmLabels)};
          /* Растау түймелері клик болғаннан кейін ғана пайда болады — нақты
           * модаль сияқты, сондықтан тізбектің шынымен өтетіні тексеріледі. */
          b.addEventListener('click', () => {
            b.textContent = 'нажато ✓';
            b.disabled = true;
            const modal = document.createElement('div');
            modal.setAttribute('data-sem-sim', '1');
            modal.style.cssText = box.style.cssText.replace('bottom:12px', 'bottom:90px');
            labels.forEach((lab) => {
              const cb = document.createElement('button');
              cb.type = 'button';
              cb.textContent = lab;
              cb.style.cssText = 'margin:0 6px;padding:4px 10px;cursor:pointer';
              cb.addEventListener('click', () => { cb.textContent = lab + ' ✓'; cb.disabled = true; });
              modal.appendChild(cb);
            });
            if (labels.length) document.body.appendChild(modal);
            setTimeout(() => modal.remove(), 20000);
          });

          document.body.appendChild(box);
          setTimeout(() => box.remove(), 20000);
          return true;
        })()`
      );
      log('info', 'CONTROL', `🧪 Проверка вживую: добавлен блок «${r.watchText}» + ${confirmLabels.length} шаг(ов) подтверждения`);
      return { ok: true, watchText: r.watchText, clickText: clickLabel, confirm: confirmLabels };
    } catch (e) {
      return { ok: false, reason: String(e).slice(0, 160) };
    }
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

  app.get('/api/models', async () => {
    const s = getAllSettings();
    if (!s.aiApiKey) return { ok: false, reason: 'Ключ не задан', models: [] };
    const { listModels } = await import('./gemini.js');
    return listModels({ key: String(s.aiApiKey), baseUrl: String(s.aiBaseUrl || '') });
  });

  /* ---------------- websocket ---------------- */

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
