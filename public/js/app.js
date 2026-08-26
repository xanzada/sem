'use strict';

const $ = (sel) => document.querySelector(sel);
const STATE_COLORS = {
  RUNNING: '#22c55e',
  STARTING: '#38bdf8',
  WAITING: '#eab308',
  AUTH_REQUIRED: '#f59e0b',
  SECURITY_VERIFICATION_WAIT: '#38bdf8',
  MANUAL_REVIEW: '#f97316',
  ERROR: '#ef4444',
  STOPPED: '#6b7280',
};
const CAT_ICONS = { SYSTEM: '⚙️', CONTROL: '🎛', WORKFLOW: '📋', AUTH: '🔐', SECURITY: '🛡' };

let snap = null;
let chart = null;
let ws = null;
let wsTimer = null;
let journalCategory = '';
let speedSaveTimer = null;

/* ---------- helpers ---------- */
function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function fmtUptime(sec) {
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/* ---------- status rendering ---------- */
function renderStatus() {
  if (!snap) return;
  const color = STATE_COLORS[snap.state] || '#6b7280';
  const working = ['RUNNING', 'STARTING'].includes(snap.state);
  const broken = ['ERROR'].includes(snap.state);

  $('#stateRu').textContent = `${snap.emoji} ${snap.stateRu}`;
  $('#stateShort').textContent = snap.stateRu.toLowerCase();
  $('#stepText').textContent = snap.step || '—';
  $('#todayNum').textContent = snap.processedToday;
  $('#currentAppPill').textContent = `Заявка: ${snap.currentAppId ? '#' + snap.currentAppId : '—'}`;
  $('#sincePill').textContent = `В состоянии: ${fmtTime(snap.since)} · аптайм ${fmtUptime(snap.uptimeSec)}`;
  $('#modeBadge').textContent = snap.mode === 'simulation' ? 'ДЕМО' : 'БОЕВОЙ';

  document.querySelectorAll('.big-orb span, .big-orb i, .orb-core, .orb-ring').forEach((el) => {
    el.style.background = color;
    el.style.borderColor = color;
  });
  $('#bigOrb').classList.toggle('working', working);
  $('#bigOrb').classList.toggle('broken', broken);
  $('#brandOrb').classList.toggle('pulse', working);

  document.documentElement.style.setProperty('--status-color', color);
  $('#btnStart').disabled = snap.running && !snap.paused;
  $('#btnPause').disabled = !snap.running;
  $('#btnPause').textContent = snap.paused ? '▶' : '⏸';
  $('#speedRange').value = snap.speed;
  $('#speedVal').textContent = '×' + Number(snap.speed);

  const attention = ['AUTH_REQUIRED', 'MANUAL_REVIEW', 'ERROR', 'SECURITY_VERIFICATION_WAIT']
    .includes(snap.state) && snap.state !== 'SECURITY_VERIFICATION_WAIT';
  const vncAlert = ['AUTH_REQUIRED', 'MANUAL_REVIEW', 'ERROR'].includes(snap.state);
  document.querySelectorAll('.nav-btn[data-tab="vnc"]').forEach((b) => b.classList.toggle('alert', vncAlert));
}

function feedItemEl(item) {
  const div = document.createElement('div');
  div.className = `feed-item ${item.level} ${item.category}`;
  const t = document.createElement('span');
  t.className = 'fi-time';
  t.textContent = fmtTime(item.ts);
  const m = document.createElement('span');
  m.className = 'fi-msg';
  let msg = item.message || '';
  let shotHtml = '';
  try {
    const meta = item.meta ? JSON.parse(item.meta) : null;
    if (meta && meta.screenshot) {
      shotHtml = `<img class="shot-thumb" loading="lazy" src="/shots/${meta.screenshot}">`;
    }
  } catch { /* plain */ }
  m.innerHTML = `${CAT_ICONS[item.category] ? CAT_ICONS[item.category] + ' ' : ''}${escapeHtml(msg)}${shotHtml}`;
  div.appendChild(t);
  div.appendChild(m);
  return div;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function pushFeed(item) {
  const feed = $('#feed');
  feed.prepend(feedItemEl(item));
  while (feed.children.length > 150) feed.lastChild.remove();
  if (!journalCategory || item.category === journalCategory) {
    const jf = $('#journalFeed');
    jf.prepend(feedItemEl(item));
    while (jf.children.length > 300) jf.lastChild.remove();
  }
  if (item.category === 'SECURITY' && item.level === 'warn') {
    document.title = '🛡 SEM — проверка сайта';
  } else if (document.title !== 'SEM — оператор заявок') {
    document.title = 'SEM — оператор заявок';
  }
}

async function loadJournal() {
  const q = journalCategory ? `?category=${journalCategory}&limit=200` : '?limit=200';
  const items = await api('/api/events' + q);
  const jf = $('#journalFeed');
  jf.innerHTML = '';
  for (const it of items.slice().reverse()) jf.prepend(feedItemEl(it));
}

/* ---------- websocket ---------- */
function connectWs() {
  clearTimeout(wsTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'feed') pushFeed(data.item);
      if (data.type === 'status') { snap = data.snap; renderStatus(); }
      if (data.type === 'agent') renderAgent(data.st);
    } catch { /* ignore */ }
  };
  ws.onclose = () => { wsTimer = setTimeout(connectWs, 3000); };
  ws.onerror = () => ws.close();
}

/* ---------- analytics ---------- */
async function loadAnalytics() {
  const a = await api('/api/analytics');
  $('#stToday').textContent = a.today;
  $('#stWeek').textContent = a.week;
  $('#stTotal').textContent = a.total;
  $('#stAvg').textContent = a.avgDurationMs ? (a.avgDurationMs / 1000).toFixed(1) + ' с' : '—';

  const body = $('#recentBody');
  body.innerHTML = '';
  for (const r of a.recent) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDateTime(r.ts)}</td><td>#${escapeHtml(r.application_id)}</td>
      <td><span class="res-badge">принята</span></td>
      <td>${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + ' с' : '—'}</td>`;
    body.appendChild(tr);
  }

  const ctx = $('#chart24').getContext('2d');
  const labels = a.series24h.map((p) => p.hour.slice(11, 16));
  const counts = a.series24h.map((p) => p.count);
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Принято заявок',
        data: counts,
        backgroundColor: 'rgba(79,140,255,.55)',
        borderRadius: 6,
        maxBarThickness: 26,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b98a9', font: { size: 10 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: '#8b98a9', precision: 0 }, grid: { color: 'rgba(30,40,54,.6)' } },
      },
    },
  });
}

/* ---------- settings ---------- */
async function loadSettings() {
  const s = await api('/api/settings');
  const form = $('#settingsForm');
  for (const [k, v] of Object.entries(s)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
  const meta = await api('/api/meta');
  if (meta.vncUrl) {
    $('#vncWrap').innerHTML = `<iframe src="${meta.vncUrl}" allow="clipboard-read; clipboard-write"></iframe>`;
  }
}

async function saveSettings(ev) {
  ev.preventDefault();
  const form = $('#settingsForm');
  const patch = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    patch[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  await api('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  toast('✅ Настройки сохранены');
  loadStatusSoon();
}

function loadStatusSoon() {
  api('/api/status').then((d) => { snap = d.snap; renderStatus(); }).catch(() => {});
}

/* ---------- controls ---------- */
async function control(cmd) {
  try {
    const r = await api('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd }),
    });
    if (cmd === 'test-login') {
      toast(r.ok ? '🔑 Вход выполнен успешно' : '❌ Вход не удался — смотрите журнал');
    }
    if (r.snap) { snap = r.snap; renderStatus(); }
  } catch (e) {
    toast('Ошибка команды: ' + e.message);
  }
}

/* ---------- tabs & events ---------- */
function bindUI() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('active', p.dataset.tab === tab));
      if (tab === 'analytics') loadAnalytics().catch(() => {});
      if (tab === 'settings') { loadSettings().catch(() => {}); refreshAgent(); }
      if (tab === 'journal') loadJournal().catch(() => {});
    });
  });

  $('#btnStart').addEventListener('click', () => control('start'));
  $('#btnStop').addEventListener('click', () => control('stop'));
  $('#btnPause').addEventListener('click', () => control(snap && snap.paused ? 'resume' : 'pause'));
  $('#btnLogout').addEventListener('click', () => { location.href = '/logout'; });

  $('#speedRange').addEventListener('input', (e) => {
    $('#speedVal').textContent = '×' + e.target.value;
    clearTimeout(speedSaveTimer);
    speedSaveTimer = setTimeout(async () => {
      await api('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ speed: Number(e.target.value) }),
      });
    }, 400);
  });

  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#btnTestLogin').addEventListener('click', () => control('test-login'));

  /* ---------- ИИ-агент ---------- */
  const AI_ICON = { click:'🖱', type:'⌨️', key:'⌨️', scroll:'↕', goto:'🌐', back:'↩', done:'✅', fail:'⚠️' };

  function renderAgent(st) {
    const box = $('#aiLive');
    if (!box) return;
    if (!st || (!st.running && !st.lastAction)) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="ai-live-head">${st.running ? '<span class="ai-dot"></span> Агент работает' : '⏹ Агент остановлен'}
        ${st.step ? `<span class="ai-step">шаг ${st.step}</span>` : ''}</div>
      ${st.task ? `<div class="ai-task">🎯 ${escapeHtml(st.task)}</div>` : ''}
      ${st.lastAction ? `<div class="ai-act">${escapeHtml(st.lastAction)}</div>` : ''}`;
  }

  async function refreshAgent() {
    try { renderAgent(await api('/api/ai/state')); } catch { /* ignore */ }
  }

  $('#btnAiRun').addEventListener('click', async () => {
    const task = $('#aiTask').value.trim();
    if (!task) { toast('Напишите команду'); return; }
    const btn = $('#btnAiRun');
    btn.disabled = true;
    btn.textContent = '⏳ Агент работает…';
    try {
      const r = await api('/api/ai/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task }),
      });
      if (!r.ok) toast('❌ ' + (r.reason || 'Ошибка'));
      else if (r.done) toast(`✅ Готово за ${r.steps} шаг(ов)`);
      else toast('⚠️ ' + (r.reason || 'Не завершено'));
    } catch (e) { toast('Ошибка: ' + e.message); }
    btn.disabled = false;
    btn.textContent = '🚀 Выполнить команду';
    refreshAgent();
    loadJournal().catch(() => {});
  });

  $('#aiForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = $('#aiForm');
    const patch = {};
    for (const el of f.elements) { if (el.name) patch[el.name] = el.value; }
    await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    toast('✅ Настройки ИИ сохранены');
    loadSettings().catch(() => {});
  });

  $('#btnAiTest').addEventListener('click', async () => {
    const out = $('#aiTestOut');
    out.textContent = '⏳ Проверяю ключ…';
    try {
      const r = await api('/api/ai/test', { method: 'POST' });
      out.textContent = r.ok
        ? `✅ Ключ работает. Доступно моделей: ${r.models}. Модель ${r.model}: ${r.modelFound ? 'найдена' : 'не найдена — выберите другую'}`
        : '❌ ' + (r.reason || 'Ключ не подошёл');
    } catch (e) { out.textContent = 'Ошибка: ' + e.message; }
  });

  /* ---------- Помощь (?) ---------- */
  const HELP = {
    ai: ['🤖 ИИ-агент', `Агент видит экран браузера и сам нажимает нужные кнопки — как человек.<br><br>
<b>Как пользоваться:</b><br>
1. Вставьте Gemini API Key (ниже) и сохраните<br>
2. Напишите команду обычными словами, например:<br>
&nbsp;&nbsp;<i>«Открой список заявок и прими первую новую заявку»</i><br>
&nbsp;&nbsp;<i>«Войди на сайт: логин admin, пароль 12345»</i><br>
&nbsp;&nbsp;<i>«Найди заявку №184 и нажми Принять, потом подтверди в окне»</i><br>
3. Нажмите <b>🚀 Выполнить команду</b> — ниже увидите каждый шаг агента<br>
4. В любой момент откройте вкладку <b>VNC</b> и смотрите работу глазами<br><br>
<b>Круглосуточная работа:</b> заполните «Постоянную инструкцию», выберите режим <b>🤖 ИИ-агент</b> и нажмите ▶ Старт — агент будет повторять инструкцию сам.`],
    aikey: ['🔑 Где взять ключ', `1. Откройте <b>aistudio.google.com/apikey</b><br>
2. Войдите Google-аккаунтом<br>
3. Нажмите «Create API key» → скопируйте (начинается на <code>AIza…</code>)<br>
4. Вставьте здесь и нажмите <b>Сохранить</b>, затем <b>Проверить ключ</b><br><br>
Ключ хранится только на вашем сервере. Модель <b>gemini-2.0-flash</b> — оптимальна по цене и скорости.`],
    povedenie: ['⚙️ Поведение', `<b>Скорость ×</b> — множитель пауз. 0.5 = быстрее, 2 = медленнее и осторожнее.<br><br>
<b>Задержка, мс</b> — базовая пауза между действиями (800 мс = как человек).<br><br>
<b>Keep-alive, сек</b> — как часто бот «напоминает о себе» сайту, чтобы сессия не истекла. 180 сек — оптимально.`],
    schedule: ['🕒 График работы', `Бот сам ставит паузу вне рабочих часов и сам возобновляет утром.<br><br>
Пример: График = Включён, начало <b>9</b>, конец <b>21</b> → работает с 09:00 до 21:00 (по Алматы), ночью спит.<br><br>
В нерабочее время браузер закрывается — сервер отдыхает. Утром бот откроет его сам, сессия сохранена.`],
    site: ['🌐 Сайт и вход', `Адрес, логин и пароль сайта, где бот обрабатывает заявки.<br><br>
Пароль хранится только на вашем сервере.<br><br>
<b>Селекторы формы входа</b> — нужны только если сайт нестандартный. Пример (hub.alemi.kz):
<code>{"user":["#hub-identifier"],"password":["#hub-password"],"submit":[".partner-auth-submit"]}</code>`],
    mode: ['🎮 Режим работы', `<b>Демо</b> — бот тренируется на встроенном учебном сайте (безопасно, ничего реального не нажимает).<br><br>
<b>Боевой</b> — работает с вашим реальным сайтом из настроек ниже.`],
    telegram: ['📨 Telegram', `Пришлём уведомления: 🔐 нужен вход, 🛡 проверка сайта, 🟠 требуется внимание.<br><br>
1. Создайте бота у @BotFather → получите token<br>
2. Напишите своему боту любое сообщение<br>
3. Узнайте chat_id через @userinfobot<br>
4. Вставьте оба значения и сохраните.`],
  };

  function openHelp(key) {
    const h = HELP[key];
    if (!h) return;
    $('#helpTitle').textContent = h[0];
    $('#helpBody').innerHTML = h[1];
    $('#helpModal').classList.remove('hidden');
  }
  document.querySelectorAll('.qmark').forEach((q) =>
    q.addEventListener('click', () => openHelp(q.dataset.help)));
  $('#helpClose').addEventListener('click', () => $('#helpModal').classList.add('hidden'));
  $('#helpModal').addEventListener('click', (e) => {
    if (e.target === $('#helpModal')) $('#helpModal').classList.add('hidden');
  });

  $('#btnSelHealth').addEventListener('click', async () => {
    const out = $('#selHealthOut');
    out.textContent = '⏳ Проверяем сайт…';
    try {
      const r = await api('/api/selectors-health');
      if (r.needsLogin) {
        out.textContent = '⚠️ Бот ещё не вошёл на сайт. Нажмите ▶ Старт, дождитесь входа, затем ⏸ Пауза и повторите проверку.';
        return;
      }
      if (!r.ok) {
        out.textContent = '❌ ' + (r.reason || 'Не удалось проверить');
        return;
      }
      out.innerHTML =
        r.items.map((i) => (i.ok ? '✅ ' : '❌ ') + escapeHtml(i.key)).join('<br>') +
        '<br><span style="opacity:.7">' + escapeHtml(r.note || '') + '</span>';
    } catch (e) {
      out.textContent = 'Ошибка: ' + e.message;
    }
  });

  document.querySelectorAll('#journalChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#journalChips .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      journalCategory = chip.dataset.cat;
      loadJournal().catch(() => {});
    });
  });
}

/* ---------- boot ---------- */
bindUI();
connectWs();
loadStatusSoon();
loadJournal().catch(() => {});
setInterval(loadStatusSoon, 10000);
