'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const COLORS = {
  RUNNING: '#22c55e', STARTING: '#38bdf8', WAITING: '#eab308',
  AUTH_REQUIRED: '#f59e0b', SECURITY_VERIFICATION_WAIT: '#38bdf8',
  MANUAL_REVIEW: '#f97316', ERROR: '#ef4444', STOPPED: '#6b7280',
};
const CAT = { SYSTEM: '⚙️', CONTROL: '🎛', WORKFLOW: '📋', AUTH: '🔐', SECURITY: '🛡' };

let snap = null;
let chart = null;
let ws = null, wsTimer = null;
let journalCat = '';
/* Агенттің нақты күйі: сервер оны /api/ai/state және ws «agent» арқылы береді.
 * СТАРТ/СТОП батырмалары engine.running-ке емес, осыған қарайды. */
let agentBusy = false;

/* ---------------- utils ---------------- */
function toast(t, ms = 2600) {
  const el = $('#toast');
  el.textContent = t;
  el.classList.add('show');
  clearTimeout(el._h);
  el._h = setTimeout(() => el.classList.remove('show'), ms);
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const hhmmss = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dmhm = (iso) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function dur(sec) {
  if (sec < 60) return sec + ' с';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + ' мин';
  return Math.floor(m / 60) + ' ч ' + (m % 60) + ' м';
}

/* ---------------- status ---------------- */
function setText(sel, val) {
  const el = $(sel);
  if (el && el.textContent !== String(val)) el.textContent = val;
}

function renderStatus() {
  if (!snap) return;
  const color = COLORS[snap.state] || '#6b7280';
  const live = snap.state === 'RUNNING' || snap.state === 'STARTING';

  setText('#stateRu', snap.emoji + ' ' + snap.stateRu);
  setText('#stateSub', snap.paused && snap.running
    ? 'На паузе' : (live ? 'В работе · ' + dur(snap.uptimeSec) : 'Ожидание команды'));

  $('#bigOrb').classList.toggle('live', live);
  $('#brandOrb').classList.toggle('live', live);
  $$('.orb span, .orb i, .brand-orb i').forEach((el) => {
    el.style.background = color;
    el.style.borderColor = color;
  });

  setText('#modeBadge', snap.mode === 'ai' ? 'ИИ-АГЕНТ' : snap.mode === 'simulation' ? 'ДЕМО' : 'БОЕВОЙ');
  setText('#kToday', snap.processedToday);
  setText('#kUp', live ? dur(snap.uptimeSec) : '—');

  syncRunButtons();

  const alert = ['AUTH_REQUIRED', 'MANUAL_REVIEW', 'ERROR'].includes(snap.state);
  $$('.tab[data-tab="vnc"]').forEach((b) => b.classList.toggle('alert', alert));
}

/* СТАРТ пен СТОП екеуі де әрқашан басылады: СТОП — агентті де, циклді де
 * тоқтатады, сондықтан «Агент работает» деген күйде қатып қалу мүмкін емес. */
function syncRunButtons() {
  const run = $('#btnAiRun');
  const stop = $('#btnAiStop');
  if (!run || !stop) return;
  const busy = agentBusy || Boolean(snap && snap.running);
  run.disabled = busy;
  run.classList.toggle('active-glow', !busy);
  run.textContent = busy ? '⏳ Работает…' : '▶ СТАРТ';
  stop.disabled = false;
  stop.classList.toggle('active-glow', busy);
}

/* ---------------- feed ---------------- */
function feedRow(it) {
  const d = document.createElement('div');
  d.className = 'feed-item ' + it.level;
  let shot = '';
  try {
    const m = it.meta ? JSON.parse(it.meta) : null;
    if (m && m.screenshot) shot = `<img class="shot-thumb" loading="lazy" src="/shots/${m.screenshot}">`;
  } catch { /* plain */ }
  d.innerHTML = `<span class="fi-time">${hhmmss(it.ts)}</span>
    <span class="fi-msg">${CAT[it.category] ? CAT[it.category] + ' ' : ''}${esc(it.message)}${shot}</span>`;
  return d;
}
function pushFeed(it) {
  if (journalCat && it.category !== journalCat) return;
  const j = $('#journalFeed');
  if (!j) return;
  j.prepend(feedRow(it));
  while (j.children.length > 250) j.lastChild.remove();
}
async function loadJournal() {
  const q = journalCat ? `?category=${journalCat}&limit=200` : '?limit=200';
  const items = await api('/api/events' + q);
  const j = $('#journalFeed');
  j.innerHTML = '';
  items.forEach((it) => j.appendChild(feedRow(it)));
}

/* ---------------- analytics ---------------- */
/* Chart.js әдейі кейін жүктеледі: бастапқы бет жеңіл болады. */
let chartLibPromise = null;
function loadChartLib() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (chartLibPromise) return chartLibPromise;
  chartLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
    s.async = true;
    s.onload = () => resolve(window.Chart);
    s.onerror = () => { chartLibPromise = null; reject(new Error('chart.js')); };
    document.head.appendChild(s);
  });
  return chartLibPromise;
}

async function loadStats() {
  const a = await api('/api/analytics');
  $('#stToday').textContent = a.today;
  $('#stWeek').textContent = a.week;
  $('#stTotal').textContent = a.total;
  $('#stAvg').textContent = a.avgDurationMs ? (a.avgDurationMs / 1000).toFixed(1) + ' с' : '—';
  setText('#kWeek', a.week);
  setText('#kAi', a.aiToday ?? 0);

  const tb = $('#recentBody');
  tb.innerHTML = '';
  a.recent.forEach((r) => {
    const tr = document.createElement('tr');
    const what = r.action === 'ai-task' ? '🤖 Задача ИИ' : '#' + esc(r.application_id);
    tr.innerHTML = `<td>${dmhm(r.ts)}</td><td>${what}</td>
      <td><span class="tag">${r.result === 'done' ? 'выполнено' : 'принята'}</span></td>
      <td>${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + ' с' : '—'}</td>`;
    tb.appendChild(tr);
  });

  const labels = a.series24h.map((p) => p.hour.slice(11, 16));
  const data = a.series24h.map((p) => p.count);
  const sig = labels.join(',') + '|' + data.join(',');
  if (chart && chart.__sig === sig) return;

  /* Диаграмма — тек «Статистика» көрініп тұрғанда салынады. */
  const box = $('#chart24');
  if (!box || !box.offsetParent) return;

  let Lib;
  try { Lib = await loadChartLib(); } catch { return; }
  if (chart) chart.destroy();
  chart = new Lib(box.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: 'rgba(79,140,255,.55)', borderRadius: 6, maxBarThickness: 22 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8794a5', font: { size: 9 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: '#8794a5', precision: 0 }, grid: { color: 'rgba(29,38,52,.6)' } },
      },
    },
  });
  chart.__sig = sig;
}

/* ---------------- settings ---------------- */
async function loadSettings(force) {
  const s = await api('/api/settings');
  $$('form[data-save]').forEach((form) => {
    Array.from(form.elements).forEach((el) => {
      if (!el.name || !(el.name in s)) return;
      if (!force && (el === document.activeElement || el.dataset.dirty === '1')) return;
      if (el.type === 'checkbox') el.checked = s[el.name] === true || s[el.name] === 'true';
      else el.value = s[el.name] ?? '';
    });
  });
  const sp = $('#speedRange');
  if (sp) { sp.value = s.speed; $('#speedVal').textContent = '×' + Number(s.speed); }

  /* Секреты сервер наружу не отдаёт, поэтому поле остаётся пустым —
   * без этой подписи кажется, что пароль не сохранился. */
  $$('[data-state-for]').forEach((tag) => {
    const saved = s[tag.dataset.stateFor + 'Set'] === true;
    tag.textContent = saved ? '· сохранён' : '· не задан';
    tag.className = 'key-state ' + (saved ? 'ok' : 'no');
    const input = document.querySelector(`[name=${tag.dataset.stateFor}]`);
    if (input && saved && !input.value) input.placeholder = 'Сохранён — оставьте пустым или введите новый';
  });

  const ks = $('#keyState');
  if (ks) {
    ks.textContent = s.aiApiKeySet ? '· сохранён' : '· не задан';
    ks.className = 'key-state ' + (s.aiApiKeySet ? 'ok' : 'no');
  }
  const keyInput = document.querySelector('input[name=aiApiKey]');
  if (keyInput && s.aiApiKeySet && !keyInput.value) {
    keyInput.placeholder = 'Ключ сохранён — оставьте пустым или введите новый';
  }
  markProvider(s.aiBaseUrl || '');

  const loop = $('#loopOn');
  if (loop) {
    const on = Number(s.aiIntervalMin) > 0;
    if (loop !== document.activeElement) loop.checked = on;
    const lf = $('#loopFields');
    if (lf) lf.style.display = on ? '' : 'none';
  }

  // Загружаем список моделей, если есть ключ
  if (s.aiApiKeySet) {
    try {
      const r = await api('/api/models');
      if (r.ok && r.models) {
        const datalist = document.getElementById('modelList');
        if (datalist) {
          // Сохраняем текущее значение
          const current = document.querySelector('input[name=aiModel]')?.value || '';
          datalist.innerHTML = '';
          // Показываем только модели с generateContent (фильтруем на сервере)
          r.models.forEach((m) => {
            const opt = document.createElement('option');
            opt.value = m;
            datalist.appendChild(opt);
          });
          // Восстанавливаем значение, если оно было
          const modelInput = document.querySelector('input[name=aiModel]');
          if (modelInput && current) modelInput.value = current;
        }
      }
    } catch (e) {
      // Тихая ошибка — список не обязателен
    }
  }
}

let vncLoaded = false;
async function loadVnc() {
  const el = $('#vncWrap');
  if (!el) return;
  if (vncLoaded && el.querySelector('iframe')) return;
  el.innerHTML = '<div class="hint" style="padding:16px">⏳ Подключаюсь к экрану…</div>';
  const meta = await api('/api/meta').catch(() => ({}));
  if (meta.vncUrl) {
    el.innerHTML = `<iframe src="${meta.vncUrl}" allow="clipboard-read; clipboard-write"></iframe>`;
    vncLoaded = true;
  } else {
    el.innerHTML =
      '<div class="hint" style="padding:16px">Экран пока недоступен: noVNC не запущен.<br><br>' +
      '<button class="btn ghost block" id="btnVncRetry">Повторить</button></div>';
    vncLoaded = false;
    const rb = $('#btnVncRetry');
    if (rb) rb.addEventListener('click', () => loadVnc().catch(() => {}));
  }
}

function bindSaveForms() {
  $$('form[data-save]').forEach((form) => {
    Array.from(form.elements).forEach((el) => {
      if (!el.name) return;
      el.addEventListener('input', () => { el.dataset.dirty = '1'; });
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const patch = {};
      Array.from(form.elements).forEach((el) => {
        if (!el.name) return;
        patch[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      });
      const btn = form.querySelector('button[type=submit]');
      const old = btn.textContent;
      btn.disabled = true; btn.textContent = 'Сохраняю…';
      try {
        await api('/api/settings', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        toast('✅ Сохранено');
        Array.from(form.elements).forEach((el) => { el.dataset.dirty = ''; });
        await loadSettings(true);
        pullStatus();
      } catch (e) { toast('Ошибка: ' + e.message); }
      btn.disabled = false; btn.textContent = old;
    });
  });
}

function markProvider(base) {
  const b = String(base || '').trim();
  const known = ['', 'https://api.openai.com/v1', 'https://openrouter.ai/api/v1'];
  $$('#provSeg .seg-btn').forEach((btn) => {
    const bb = btn.dataset.base;
    const active = bb === 'custom' ? !known.includes(b) : bb === b;
    btn.classList.toggle('on', active);
  });
}

$$('#provSeg .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const base = btn.dataset.base;
    const baseInput = document.querySelector('input[name=aiBaseUrl]');
    const modelInput = document.querySelector('input[name=aiModel]');
    if (base !== 'custom') {
      baseInput.value = base;
      baseInput.dataset.dirty = '1';
      if (btn.dataset.model) { modelInput.value = btn.dataset.model; modelInput.dataset.dirty = '1'; }
    }
    markProvider(base === 'custom' ? 'custom-x' : base);
    if (base === 'custom') baseInput.focus();
  });
});

const loopChk = $('#loopOn');
if (loopChk) {
  loopChk.addEventListener('change', () => {
    const lf = $('#loopFields');
    if (lf) lf.style.display = loopChk.checked ? '' : 'none';
    const iv = document.querySelector('input[name=aiIntervalMin]');
    if (iv) {
      if (loopChk.checked && Number(iv.value) <= 0) iv.value = '5';
      if (!loopChk.checked) iv.value = '0';
      iv.dataset.dirty = '1';
    }
  });
}

/* ---------------- control ---------------- */
async function control(cmd) {
  try {
    const r = await api('/api/control', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd }),
    });
    if (r.snap) { snap = r.snap; renderStatus(); }
  } catch (e) { toast('Ошибка: ' + e.message); }
}
function pullStatus() {
  api('/api/status').then((d) => { snap = d.snap; renderStatus(); }).catch(() => {});
}

/* ---------------- AI agent ---------------- */
function renderAgent(st) {
  agentBusy = Boolean(st && st.running);
  syncRunButtons();
  const html = (!st || (!st.running && !st.lastAction)) ? '' : `
    <div class="ai-live-head">${st.running ? '<span class="ai-dot"></span> Агент работает' : '⏹ Остановлен'}
      ${st.step ? `<span class="ai-step">шаг ${st.step}</span>` : ''}</div>
    ${st.task ? `<div class="ai-task">🎯 ${esc(st.task)}</div>` : ''}
    ${st.lastAction ? `<div class="ai-act">${esc(st.lastAction)}</div>` : ''}`;
  const el = $('#aiLive'); if (el) el.innerHTML = html;
}
async function refreshAgent() {
  try { renderAgent(await api('/api/ai/state')); } catch { /* ignore */ }
}

/** СТОП: агентті де, тұрақты циклді де бірден тоқтатады. */
async function stopEverything() {
  agentBusy = false;
  syncRunButtons();
  try {
    await api('/api/ai/stop', { method: 'POST' });
  } catch { /* агент жүрмеген болуы мүмкін */ }
  await control('stop');
  toast('⏹ Остановлено');
  refreshAgent();
}

async function runTask(inputSel) {
  const field = document.querySelector(inputSel);
  const task = (field?.value || '').trim();
  if (!task) { toast('Напишите задачу'); return; }
  try {
    await api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aiInstruction: task }),
    });
  } catch { /* сохраним при следующем Save */ }
  agentBusy = true;
  syncRunButtons();
  try {
    const r = await api('/api/ai/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    if (!r.ok) toast('❌ ' + (r.reason || 'Ошибка'));
    else if (r.aborted) toast('⏹ Остановлено');
    else if (r.done) toast(`✅ Готово за ${r.steps} шаг(ов)`);
    else toast('⚠️ ' + (r.reason || 'Не завершено'));
  } catch (e) { toast('Ошибка: ' + e.message); }
  agentBusy = false;
  syncRunButtons();
  refreshAgent(); loadStats().catch(() => {});
}

/* ---------------- help ---------------- */
const HELP = {
  ai: ['🤖 Команда агенту', `Одна задача — агент делает её и повторяет по расписанию.<br><br>
<b>▶ Выполнить сейчас</b> — сделать один раз прямо сейчас.<br>
<b>Повторять по расписанию</b> — включите и укажите интервал (например 5 минут). Затем ▶ Старт сверху — агент будет работать сам круглосуточно.<br>
<b>Лимит шагов</b> — сколько действий максимум за один проход (защита от лишних расходов).<br><br>
Пишите обычными словами:<br>
• <i>«Войди на сайт: логин admin, пароль 12345»</i><br>
• <i>«Открой список заявок и прими первую новую»</i><br>
• <i>«Найди заявку №184, нажми Принять и подтверди в окне»</i><br><br>
Ниже кнопки видно каждый шаг агента, а во вкладке <b>Экран</b> — картинку браузера.<br><br>
Нужен ключ Gemini — см. карточку «Доступ к Gemini».`],
  aikey: ['🔑 Доступ к модели', `<b>Google Gemini (по умолчанию):</b><br>
1. Откройте <b>aistudio.google.com/apikey</b><br>
2. Войдите Google-аккаунтом<br>
3. «Create API key» → скопируйте (начинается на <code>AIza…</code>)<br>
4. Вставьте здесь → <b>Сохранить</b> → <b>Проверить ключ</b><br><br>
5. Base URL оставьте пустым<br><br>
<b>Другой провайдер</b> (OpenRouter, свой прокси, локальная модель):<br>
• Base URL: <code>https://openrouter.ai/api/v1</code><br>
• Модель: <code>google/gemini-2.5-flash</code> или <code>anthropic/claude-sonnet-4.5</code><br>
• Ключ: ваш <code>sk-…</code><br><br>
Модель нужно выбирать <b>с поддержкой картинок</b> (vision) — агент работает по скриншоту.
Название пишите точно как у провайдера. Ключ хранится только на вашем сервере.`],
  loop: ['♻️ Автозапуск', `Если включено — после перезапуска сервера агент поднимется сам и продолжит работать по вашей задаче.<br><br>
«Другие режимы» нужны редко: обычный режим — <b>🤖 ИИ-агент</b>.`],
  site: ['🌐 Сайт и вход', `Адрес сайта, где работает агент, и данные для входа.<br><br>
Если сессия истечёт — бот войдёт сам по этим данным. Если понадобится код из SMS, вы получите уведомление, введёте код во вкладке <b>Экран</b>, и агент продолжит.<br><br>
Пароль хранится только на вашем сервере.`],
  schedule: ['🕒 График работы', `<b>Круглосуточно</b> — агент работает всегда.<br><br>
<b>По часам</b> — например с 9 до 21 (по Алматы). Вне графика агент ставит паузу и закрывает браузер, чтобы сервер отдыхал, а утром поднимается сам.`],
  behavior: ['⚙️ Поведение', `<b>Скорость</b> — множитель пауз: 0.5 быстрее, 2 медленнее и осторожнее.<br><br>
<b>Пауза между действиями</b> — 800 мс похоже на человека.<br><br>
<b>Keep-alive</b> — как часто напоминать сайту о себе, чтобы не разлогинило (180 сек).<br><br>
<b>Скриншот-доказательство</b> — снимок после каждой принятой заявки, виден в Журнале.`],
  telegram: ['📨 Уведомления', `Сообщим, если нужен вход, появилась проверка безопасности или требуется ваше внимание.<br><br>
1. @BotFather → создайте бота → получите token<br>
2. Напишите своему боту любое сообщение<br>
3. @userinfobot → узнайте свой chat_id<br>
4. Вставьте оба значения и сохраните.`],
  reset: ['🧹 Обнулить статистику', `Удалит историю заявок и счётчики (сегодня / 7 дней / всего).<br><br>
Журнал событий и настройки останутся. Полезно, если в статистике накопились тестовые запуски.`],
};
function openHelp(k) {
  const h = HELP[k];
  if (!h) return;
  $('#helpTitle').textContent = h[0];
  $('#helpBody').innerHTML = h[1];
  $('#helpModal').classList.remove('hidden');
}

/* ---------------- websocket ---------------- */
function connectWs() {
  clearTimeout(wsTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (d.type === 'feed') pushFeed(d.item);
      if (d.type === 'status') { snap = d.snap; renderStatus(); }
      if (d.type === 'agent') renderAgent(d.st);
    } catch { /* ignore */ }
  };
  ws.onclose = () => { wsTimer = setTimeout(connectWs, 3000); };
  ws.onerror = () => ws.close();
}

/* ---------------- boot ---------------- */
$$('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const t = b.dataset.tab;
    $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.tab === t));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (t === 'analytics') loadStats().catch(() => {});
    if (t === 'settings') { loadSettings().catch(() => {}); refreshAgent(); }
    if (t === 'vnc') loadVnc().catch(() => {});
    if (t === 'journal') loadJournal().catch(() => {});
  });
});

$('#btnAiStop').addEventListener('click', () => { stopEverything().catch(() => {}); });
$('#btnLogout').addEventListener('click', () => { location.href = '/logout'; });

$('#btnAiRun').addEventListener('click', () => runTask('textarea[name=aiInstruction]'));

$('#btnAiTest').addEventListener('click', async () => {
  const out = $('#aiTestOut');
  out.textContent = '⏳ Проверяю ключ и квоту…';
  try {
    const r = await api('/api/ai/test', { method: 'POST' });
    if (!r.ok) { out.innerHTML = '❌ ' + esc(r.reason || 'Ключ не подошёл'); return; }
    /* Ключ может быть верным, но дневная квота — исчерпана. Это разные вещи,
     * и раньше панель показывала «работает», а агент падал с 429. */
    const quota = r.quotaOk === false
      ? `<br>⛔ <b>${esc(r.quotaNote || 'квота исчерпана')}</b>`
      : r.quotaOk === true ? '<br>✅ ' + esc(r.quotaNote || '') : '';
    out.innerHTML =
      `✅ Ключ работает · моделей: ${r.models}<br>Модель <b>${esc(r.model)}</b>: ${r.modelFound ? 'доступна' : 'не найдена в списке'}`
      + quota
      + `<br><span style="opacity:.65">${esc(r.base || '')}</span>`;
  } catch (e) { out.textContent = 'Ошибка: ' + e.message; }
});

$('#btnStatsReset').addEventListener('click', async () => {
  if (!confirm('Обнулить статистику заявок?')) return;
  try {
    await api('/api/stats/reset', { method: 'POST' });
    toast('🧹 Статистика обнулена');
    loadStats().catch(() => {});
    pullStatus();
  } catch (e) { toast('Ошибка: ' + e.message); }
});

const sp = $('#speedRange');
if (sp) sp.addEventListener('input', (e) => { $('#speedVal').textContent = '×' + e.target.value; });

$$('#journalChips .chip').forEach((c) => {
  c.addEventListener('click', () => {
    $$('#journalChips .chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    journalCat = c.dataset.cat;
    loadJournal().catch(() => {});
  });
});

$$('.qmark').forEach((q) => q.addEventListener('click', () => openHelp(q.dataset.help)));
$('#helpClose').addEventListener('click', () => $('#helpModal').classList.add('hidden'));
$('#helpModal').addEventListener('click', (e) => {
  if (e.target === $('#helpModal')) $('#helpModal').classList.add('hidden');
});

bindSaveForms();
connectWs();
pullStatus();
loadStats().catch(() => {});
loadSettings(true).catch(() => {});
refreshAgent();
setInterval(pullStatus, 12000);
/* Агент күйін жиі сұраймыз: батырмалар нақты күйден кейін қалып қалмауы керек. */
setInterval(() => { if (!document.hidden) refreshAgent(); }, 4000);
setInterval(() => { if (!document.hidden) loadStats().catch(() => {}); }, 60000);
