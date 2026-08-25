import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { log } from './logger.js';

const DEMO_USER = process.env.DEMO_USER ?? 'admin';
const DEMO_PASS = process.env.DEMO_PASS ?? '12345678Ss';
const SESSION_MINUTES = Number(process.env.DEMO_SESSION_MINUTES ?? 10);

interface DemoApp {
  id: number;
  title: string;
  status: string;
  created_at: string;
  accepted_at: string | null;
}

db.exec(`
CREATE TABLE IF NOT EXISTS demo_apps(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  accepted_at TEXT
);
`);

const insDemo = db.prepare('INSERT INTO demo_apps(title,status,created_at) VALUES(?,?,?)');
const allDemo = db.prepare('SELECT * FROM demo_apps ORDER BY id DESC');
const getDemo = db.prepare('SELECT * FROM demo_apps WHERE id=?');
const acceptDemo = db.prepare(
  "UPDATE demo_apps SET status='accepted', accepted_at=? WHERE id=? AND status='pending'"
);
const countPending = db.prepare("SELECT COUNT(*) c FROM demo_apps WHERE status='pending'");

const TITLES = [
  'Оформление визы — физическое лицо',
  'Регистрация ИП',
  'Продление разрешения',
  'Заявление на субсидию',
  'Замена паспорта',
  'Справка о доходах',
  'Регистрация ТС',
  'Лицензия на перевозку',
  'Внесение изменений в ЕГР',
  'Получение ЭЦП',
];

function seed(): void {
  const row = db.prepare('SELECT COUNT(*) c FROM demo_apps').get() as { c: number };
  if (row.c === 0) {
    for (let i = 0; i < 6; i++) addApp();
    log('info', 'SYSTEM', 'Демо-сайт: создан стартовый список заявок');
  }
}

function addApp(): void {
  const t = TITLES[Math.floor(Math.random() * TITLES.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  insDemo.run(`${t} №${num}`, 'pending', new Date().toISOString());
}

export function startDemoFeed(intervalMs = 45000): void {
  seed();
  setInterval(() => {
    try {
      if ((countPending.get() as { c: number }).c < 20 && Math.random() < 0.8) addApp();
    } catch {
      /* ignore */
    }
  }, intervalMs);
}

const sessions = new Map<string, { user: string; last: number }>();

function parseCookies(req: { headers: Record<string, string | string[] | undefined> }): Record<string, string> {
  const raw = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'string') return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:#0d1420;color:#e7edf5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.wrap{width:100%;max-width:640px}
.card{background:#141c2b;border:1px solid #22304a;border-radius:16px;padding:22px}
h1{font-size:19px;margin:0 0 4px}
.sub{color:#8b98a9;font-size:13px;margin-bottom:18px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:#8b98a9;padding:8px;border-bottom:1px solid #22304a;font-weight:600}
td{padding:9px 8px;border-bottom:1px solid #1b2536}
.badge{padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700}
.pending{background:rgba(234,179,8,.15);color:#fde68a}
.accepted{background:rgba(34,197,94,.15);color:#86efac}
.btn{display:inline-block;background:#3568e0;color:#fff;text-decoration:none;border:none;border-radius:10px;padding:11px 20px;font-size:14.5px;font-weight:700;cursor:pointer}
input{width:100%;padding:12px;border-radius:10px;border:1px solid #2a3a58;background:#0e1523;color:#fff;margin:6px 0 12px;font-size:14.5px;outline:none}
label{font-size:12.5px;color:#8b98a9;font-weight:600}
.err{color:#ff8080;font-size:13px;margin:-4px 0 10px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
a{color:#7fb0ff}
`;

function layout(inner: string, title = 'Служба заявок'): string {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>${STYLE}</style></head><body><div class="wrap">${inner}</div></body></html>`;
}

export function registerDemoSite(app: FastifyInstance): void {
  app.get('/site/login', async (req, reply) => {
    const body = `
<div class="card" style="max-width:380px;margin:40px auto">
<h1>🔐 Вход в систему</h1>
<div class="sub">Служба обработки заявок — демонстрационный стенд</div>
<form method="post" action="/site/login">
<label>Логин</label><input name="username" autocomplete="username">
<label>Пароль</label><input name="password" type="password" autocomplete="current-password">
<button class="btn" type="submit" style="width:100%">Войти</button>
</form></div>`;
    return reply.type('text/html').send(layout(body, 'Вход'));
  });

  app.post('/site/login', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    if (b.username !== DEMO_USER || b.password !== DEMO_PASS) {
      const body = `
<div class="card" style="max-width:380px;margin:40px auto">
<h1>🔐 Вход в систему</h1>
<div class="err">Неверный логин или пароль</div>
<form method="post" action="/site/login">
<label>Логин</label><input name="username" value="${String(b.username ?? '').replace(/[<>&"]/g, '')}">
<label>Пароль</label><input name="password" type="password">
<button class="btn" type="submit" style="width:100%">Войти</button>
</form></div>`;
      return reply.code(401).type('text/html').send(layout(body, 'Вход'));
    }
    const sid = randomUUID();
    sessions.set(sid, { user: b.username, last: Date.now() });
    reply.header('set-cookie', `sid=${sid}; Path=/site; HttpOnly; SameSite=Lax`);
    return reply.redirect('/site/apps');
  });

  app.get('/site/check', async (req, reply) => {
    const next = String((req.query as Record<string, string>).next ?? '/site/apps');
    reply.header('set-cookie', `chk=${Date.now()}; Path=/site; HttpOnly; SameSite=Lax`);
    const body = `
<div class="card" style="max-width:420px;margin:60px auto;text-align:center">
<h1>Just a moment…</h1>
<div class="sub">Проверка браузера перед доступом к сайту.<br>Это займёт несколько секунд.</div>
<div style="font-size:34px;margin:18px 0">🛡️</div>
<div class="sub" id="cnt"></div>
<script>
let s=7;const el=document.getElementById('cnt');
const t=setInterval(()=>{s--;el.textContent='Пожалуйста, подождите: '+s+' с';
if(s<=0){clearInterval(t);location.href=${JSON.stringify(next)};}},1000);
el.textContent='Пожалуйста, подождите: 7 с';
</script></div>`;
    return reply.type('text/html').send(layout(body, 'Проверка браузера'));
  });

  const requireAuth = async (req: any, reply: any): Promise<void> => {
    const sid = parseCookies(req).sid;
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) return reply.redirect('/site/login');
    if (Date.now() - s.last > SESSION_MINUTES * 60000) {
      sessions.delete(sid);
      log('warn', 'AUTH', 'Демо-сайт: сессия истекла по таймауту неактивности');
      return reply.redirect('/site/login');
    }
    s.last = Date.now();
  };

  app.get('/site/apps', { preHandler: [requireAuth] } as never, async (req, reply) => {
    const chk = parseCookies(req).chk;
    const lastCheck = Number(chk ?? 0);
    if (Date.now() - lastCheck > 150000 && Math.random() < 0.4) {
      return reply.redirect('/site/check?next=%2Fsite%2Fapps');
    }
    const rows = allDemo.all() as DemoApp[];
    const trs = rows
      .map(
        (r) => `<tr><td>#${r.id}</td><td>${r.title}</td>
<td><span class="badge ${r.status}">${r.status === 'pending' ? 'В обработке' : 'Принята'}</span></td>
<td><a class="open" href="/site/apps/${r.id}">Открыть</a></td></tr>`
      )
      .join('');
    const body = `
<div class="card"><div class="top"><h1 style="margin:0">📋 Заявки</h1>
<span class="sub">${rows.length} всего · ${rows.filter((r) => r.status === 'pending').length} в обработке</span></div>
<table id="appsTable"><thead><tr><th>ID</th><th>Тип</th><th>Статус</th><th></th></tr></thead>
<tbody>${trs}</tbody></table></div>`;
    return reply.type('text/html').send(layout(body));
  });

  app.get('/site/apps/:id', { preHandler: [requireAuth] } as never, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = getDemo.get(Number(id)) as DemoApp | undefined;
    if (!r) return reply.code(404).send('not found');
    const pendingBlock =
      r.status === 'pending'
        ? `<form method="post" action="/site/apps/${r.id}/accept" style="margin-top:18px">
<button class="btn" id="acceptBtn" type="submit">✅ Принять заявку</button></form>`
        : `<div class="badge accepted" style="display:inline-block;margin-top:16px;padding:8px 16px">Заявка принята ✓ ${r.accepted_at ? new Date(r.accepted_at).toLocaleString('ru-RU') : ''}</div>`;
    const body = `
<div class="card"><a href="/site/apps">← К списку</a>
<h1>${r.title}</h1>
<div class="sub">Заявка #${r.id} · создана ${new Date(r.created_at).toLocaleString('ru-RU')}</div>
<div>Статус: <span class="badge ${r.status}" id="statusBadge">${r.status === 'pending' ? 'В обработке' : 'Принята'}</span></div>
${pendingBlock}</div>`;
    return reply.type('text/html').send(layout(body, `Заявка #${id}`));
  });

  app.post('/site/apps/:id/accept', { preHandler: [requireAuth] } as never, async (req, reply) => {
    const { id } = req.params as { id: string };
    acceptDemo.run(new Date().toISOString(), Number(id));
    return reply.redirect(`/site/apps/${Number(id)}`);
  });
}
