'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const COLORS = {
  RUNNING: '#22c55e',
  WAITING: '#eab308',
  AUTH_REQUIRED: '#f59e0b',
  ERROR: '#ef4444',
  STOPPED: '#6b7280',
};
const CAT = { SYSTEM: '⚙️', CONTROL: '🎛', WORKFLOW: '🎯', AUTH: '🔐' };

let snap = null;
let rule = null;
let chart = null;
let ws = null, wsTimer = null;
let journalCat = '';

/* ---------------- utils ---------------- */
function toast(t, ms = 2800) {
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
/* Реакция — главный показатель качества, поэтому показываем её честно. */
function ms(v) {
  if (v == null || v === 0) return '—';
  return v < 1000 ? v + ' мс' : (v / 1000).toFixed(2) + ' с';
}
function setText(sel, val) {
  const el = $(sel);
  if (el && el.textContent !== String(val)) el.textContent = val;
}

/* ---------------- status ---------------- */
function renderStatus() {
  if (!snap) return;
  const color = COLORS[snap.state] || '#6b7280';
  const live = snap.state === 'RUNNING';

  setText('#stateRu', snap.emoji + ' ' + snap.stateRu);
  setText('#stateSub', snap.step || (live ? 'Наблюдаю' : 'Ожидание команды'));
  setText('#stateBadge', live ? 'СЛЕДИТ' : snap.stateRu.toUpperCase());

  $('#bigOrb').classList.toggle('live', live);
  $('#brandOrb').classList.toggle('live', live);
  $$('.orb span, .orb i, .brand-orb i').forEach((el) => {
    el.style.background = color;
    el.style.borderColor = color;
  });

  setText('#kToday', snap.caughtToday);
  setText('#kScans', snap.scans > 999 ? Math.round(snap.scans / 1000) + 'k' : snap.scans);
  setText('#kUp', live ? dur(snap.uptimeSec) : '—');

  const start = $('#btnStart');
  const stop = $('#btnStop');
  if (start && stop) {
    start.disabled = live;
    start.classList.toggle('active-glow', !live);
    start.textContent = live ? '👁 Следит…' : '▶ СЛЕДИТЬ';
    /* СТОП всегда доступен: залипшее состояние должно сбрасываться одним нажатием. */
    stop.disabled = false;
    stop.classList.toggle('active-glow', live);
  }

  const alert = ['AUTH_REQUIRED', 'ERROR'].includes(snap.state);
  $$('.tab[data-tab="vnc"]').forEach((b) => b.classList.toggle('alert', alert));
}

/* ---------------- rule ---------------- */
function renderRule() {
  const box = $('#ruleBox');
  const actions = $('#ruleActions');
  if (!box) return;
  if (!rule) {
    box.innerHTML = 'Правило пока не выучено. Откройте нужную страницу во вкладке <b>Экран</b>, опишите задачу выше и нажмите «Обучить».';
    if (actions) actions.style.display = 'none';
    return;
  }
  const conf = rule.confirm && rule.confirm.length
    ? rule.confirm.map((s) => esc(s.text || s.selector || '?')).join(' → ')
    : 'не требуется';
  const scopeRu = { row: 'в той же строке', self: 'сам найденный элемент', document: 'в любом месте страницы' };
  box.innerHTML = `
    <div class="ai-task">👁 Ждёт текст: <b>${esc(rule.watchText)}</b>${rule.watchScope ? ` <span style="opacity:.6">в ${esc(rule.watchScope)}</span>` : ''}</div>
    <div class="ai-act">🖱 Нажимает: <b>${esc(rule.clickText || rule.clickSelector || 'первую кнопку')}</b> — ${scopeRu[rule.clickScope] || rule.clickScope}</div>
    <div class="ai-act">✅ Подтверждение: ${conf}</div>
    <div class="hint" style="margin-top:8px">Сработало успешно: <b>${rule.successCount}</b> · не подтвердилось: ${rule.failCount}</div>`;
  if (actions) actions.style.display = '';
}

/* ---------------- feed ---------------- */
function feedRow(it) {
  const d = document.createElement('div');
  d.className = 'feed-item ' + it.level;
  d.innerHTML = `<span class="fi-time">${hhmmss(it.ts)}</span>
    <span class="fi-msg">${CAT[it.category] ? CAT[it.category] + ' ' : ''}${esc(it.message)}</span>`;
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
/* Chart.js подгружается только при открытии «Статистики»: первый экран должен
 * быть максимально быстрым. */
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
  setText('#stToday', a.today);
  setText('#stFailed', a.failedToday);
  setText('#stWeek', a.week);
  $('#stAvg').textContent = ms(a.avgReactionMs);
  setText('#kBest', ms(a.bestReactionMs));

  const tb = $('#recentBody');
  if (tb) {
    tb.innerHTML = '';
    a.recent.forEach((r) => {
      const tr = document.createElement('tr');
      const okTag = r.result === 'done'
        ? '<span class="tag">выполнено</span>'
        : '<span class="tag" style="background:rgba(239,68,68,.12);color:#ffa3a3">не подтвердилось</span>';
      tr.innerHTML = `<td>${dmhm(r.ts)}</td><td>${esc(r.label)}</td><td>${okTag}</td><td>${ms(r.reactionMs)}</td>`;
      tb.appendChild(tr);
    });
  }

  const labels = a.series24h.map((p) => p.hour.slice(11, 16));
  const data = a.series24h.map((p) => p.count);
  const sig = labels.join(',') + '|' + data.join(',');
  if (chart && chart.__sig === sig) return;

  const box = $('#chart24');
  if (!box || !box.offsetParent) return;
  let Lib;
  try { Lib = await loadChartLib(); } catch { return; }
  if (chart) chart.destroy();
  chart = new Lib(box.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: 'rgba(34,197,94,.55)', borderRadius: 6, maxBarThickness: 22 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
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

  /* Задача живёт вне формы (обучение — не сохранение настроек). */
  const task = document.querySelector('textarea[name=taskText]');
  if (task && task !== document.activeElement && !task.value) task.value = s.taskText ?? '';

  const scan = $('#scanRange');
  if (scan) { scan.value = s.scanIntervalMs; setText('#scanVal', s.scanIntervalMs); }
  const conf = $('#confRange');
  if (conf) { conf.value = s.confirmDelayMs; setText('#confVal', s.confirmDelayMs); }

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
  markProvider(s.aiBaseUrl || '');

  if (s.aiApiKeySet) {
    try {
      const r = await api('/api/models');
      const dl = document.getElementById('modelList');
      if (r.ok && r.models && dl) {
        dl.innerHTML = '';
        r.models.forEach((m) => {
          const o = document.createElement('option');
          o.value = m;
          dl.appendChild(o);
        });
      }
    } catch { /* список не обязателен */ }
  }
}

function markProvider(base) {
  const b = String(base || '').trim();
  const known = ['', 'https://api.openai.com/v1', 'https://openrouter.ai/api/v1'];
  $$('#provSeg .seg-btn').forEach((btn) => {
    const bb = btn.dataset.base;
    btn.classList.toggle('on', bb === 'custom' ? !known.includes(b) : bb === b);
  });
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

/* ---------------- vnc ---------------- */
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

/* ---------------- control ---------------- */
/* Адрес открытой страницы виден сразу: без него непонятно, за чем робот следит. */
function renderPage() {
  const box = $('#pageBox');
  if (!box || !snap) return;
  const u = snap.watchUrl;
  box.innerHTML = u && u !== 'about:blank'
    ? `Открыто: <b style="word-break:break-all">${esc(u)}</b>`
    : '⚠️ Страница не открыта. Укажите адрес ниже или откройте её вручную во вкладке <b>Экран</b>.';
}

function pullStatus() {
  api('/api/status')
    .then((d) => { snap = d.snap; rule = d.rule; renderStatus(); renderRule(); renderPage(); })
    .catch(() => {});
}

async function openPage() {
  const url = ($('#openUrl')?.value || '').trim();
  if (!url) { toast('Укажите адрес'); return; }
  const btn = $('#btnOpen');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Открываю…';
  try {
    const r = await api('/api/tools/open', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    toast(r.ok ? '🌐 Открыто — доведите шаги во вкладке «Экран»' : '❌ ' + (r.reason || 'Ошибка'));
  } catch (e) { toast('Ошибка: ' + e.message); }
  btn.disabled = false; btn.textContent = old;
  pullStatus();
}

async function learn() {
  const field = document.querySelector('textarea[name=taskText]');
  const task = (field?.value || '').trim();
  if (!task) { toast('Опишите задачу словами'); return; }
  const btn = $('#btnLearn');
  const out = $('#learnOut');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '🎓 Смотрю на страницу…';
  out.textContent = 'Один запрос к модели. Дальше робот работает без неё.';
  try {
    const r = await api('/api/learn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    if (!r.ok) {
      out.innerHTML = '❌ ' + esc(r.reason || 'Не удалось выучить');
      toast('❌ ' + (r.reason || 'Ошибка'));
    } else {
      out.innerHTML = '✅ Правило выучено' + (r.note ? '<br>' + esc(r.note) : '');
      toast('✅ Правило выучено');
      rule = r.rule;
      renderRule();
    }
  } catch (e) {
    out.textContent = 'Ошибка: ' + e.message;
  }
  btn.disabled = false; btn.textContent = old;
  pullStatus();
}

/* Проверка «видно ли условие сейчас» — без модели и без клика. */
async function probe() {
  if (!rule) return;
  const out = $('#probeOut');
  out.textContent = '⏳ Смотрю страницу…';
  try {
    const r = await api('/api/tools/probe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: rule.watchText, scope: rule.watchScope }),
    });
    if (!r.ok) { out.textContent = '❌ ' + (r.reason || 'ошибка'); return; }
    if (r.count === 0) {
      out.innerHTML = `⏳ Текст «${esc(rule.watchText)}» на странице сейчас <b>не найден</b> — робот будет ждать его появления. Это нормально.`;
    } else {
      out.innerHTML = `⚠️ Текст найден <b>${r.count}</b> раз(а) уже сейчас:<br>`
        + r.matches.map((m) => '• ' + esc(m.text)).join('<br>')
        + '<br><br>Если это постоянный текст страницы, робот сработает сразу и зря — уточните задачу и обучите заново.';
    }
  } catch (e) { out.textContent = 'Ошибка: ' + e.message; }
}

/* Тест вживую: подсовываем роботу условие и смотрим, поймает ли он его.
 * Настоящий сайт при этом не трогается — блок только в браузере робота. */
async function simulate() {
  const out = $('#probeOut');
  out.textContent = '⏳ Подставляю условие…';
  try {
    const r = await api('/api/tools/simulate', { method: 'POST' });
    if (!r.ok) { out.innerHTML = '❌ ' + esc(r.reason || 'ошибка'); return; }
    out.innerHTML = `🧪 На страницу добавлен блок «${esc(r.watchText)}» с кнопкой «${esc(r.clickText)}».<br>`
      + 'Смотрите <b>Журнал</b>: должна появиться запись «Поймано за N мс». Блок исчезнет сам через 20 секунд.';
    setTimeout(() => { loadStats().catch(() => {}); pullStatus(); }, 2500);
  } catch (e) { out.textContent = 'Ошибка: ' + e.message; }
}

async function startWatch() {
  try {
    const r = await api('/api/watch/start', { method: 'POST' });
    snap = r.snap; renderStatus();
    toast(r.ok ? '👁 Наблюдение началось' : '❌ Не удалось запустить — смотрите журнал');
  } catch (e) { toast('Ошибка: ' + e.message); }
}

async function stopWatch() {
  try {
    const r = await api('/api/watch/stop', { method: 'POST' });
    snap = r.snap; renderStatus();
    toast('⏹ Остановлено');
  } catch (e) { toast('Ошибка: ' + e.message); }
}

/* ---------------- help ---------------- */
const HELP = {
  page: ['🌐 Страница', `Робот работает с <b>одной уже открытой страницей</b> и никогда её не перезагружает.<br><br>
Порядок: откройте адрес здесь или во вкладке <b>Экран</b>, затем <b>сами</b> пройдите все шаги (пункт, дата, транспорт) до момента, где нужно ждать свободное место.<br><br>
Кнопка «Открыть» заблокирована во время наблюдения: переход сбросил бы заполненные шаги.`],
  learn: ['🎓 Обучение', `Робот учится <b>один раз</b>, потом работает сам.<br><br>
<b>Порядок:</b><br>
1. Вкладка <b>Экран</b> — сами доведите страницу до состояния ожидания (выберите пункт, дату, всё что нужно).<br>
2. Здесь опишите словами, чего ждать и что нажать.<br>
3. «Обучить» — модель посмотрит на страницу и составит правило.<br><br>
<b>Пример задачи:</b><br>
<i>«Когда появится Свободно — нажми в этой строке Записаться, потом подтверди в окне»</i><br><br>
Модель вызывается только в этот момент. В работе робот к интернету за ИИ не обращается — поэтому реакция миллисекунды, а не секунды.`],
  rule: ['👁 Правило', `Что именно будет делать робот:<br><br>
<b>Ждёт текст</b> — появление этой надписи означает «пора».<br>
<b>Нажимает</b> — кнопка в той же строке, где найден текст.<br>
<b>Подтверждение</b> — шаги после первого клика.<br><br>
Кнопка <b>Проверить</b> смотрит страницу прямо сейчас и без клика. Если условие уже видно на пустой странице — правило неточное, робот сработает зря. Тогда уточните задачу и обучите заново.`],
  watch: ['👁 Наблюдение', `Робот следит за <b>уже открытой</b> страницей.<br><br>
<b>Страница не перезагружается никогда</b> — иначе заполненные шаги пришлось бы вводить заново.<br><br>
Наблюдение работает внутри страницы: как только нужный элемент появляется, клик происходит в тот же момент. Плюс резервная проверка по таймеру.<br><br>
<b>СТОП</b> доступен всегда и останавливает всё сразу.`],
  speed: ['⚡ Скорость', `<b>Проверка страницы</b> — резервный таймер. Основная реакция мгновенная: робот слушает изменения страницы напрямую. Меньшее значение даёт запас, но чуть сильнее нагружает браузер. 150 мс — хороший баланс.<br><br>
<b>Пауза перед подтверждением</b> — 0 значит «жать сразу». Увеличьте, только если сайт не успевает открыть окно подтверждения.<br><br>
Реальную скорость видно в <b>Статистике</b>: «Лучшая реакция» и «Ср. реакция» в миллисекундах.`],
  mouse: ['🖱 Живая сессия', `Сайты выкидывают неактивных пользователей. Робот периодически двигает мышью и чуть прокручивает страницу туда-обратно.<br><br>
Перезагрузки страницы <b>нет</b> — заполненные шаги остаются.<br><br>
45 секунд подходит почти всем. Если сайт разлогинивает — уменьшите.`],
  schedule: ['🕒 График работы', `<b>Круглосуточно</b> — робот следит всегда.<br><br>
<b>По часам</b> — например с 9 до 21 (по Алматы). Вне графика наблюдение приостанавливается, но <b>страница остаётся открытой</b>, и утром работа продолжается с того же места.`],
  aikey: ['🔑 Доступ к модели', `Ключ нужен <b>только для обучения</b> — один запрос на правило.<br><br>
<b>Google Gemini:</b><br>
1. aistudio.google.com/apikey<br>
2. Create API key → скопируйте (<code>AIza…</code>)<br>
3. Base URL оставьте пустым<br><br>
<b>Другой провайдер:</b> укажите Base URL и модель с поддержкой картинок (vision).<br><br>
<b>Проверить ключ</b> делает один реальный запрос: так видно не только «ключ верный», но и хватает ли квоты или депозита именно на эту модель.`],
  site: ['🌐 Сайт и вход', `Эти данные нужны для уведомлений и подсказок. Робот работает с той страницей, которую вы открыли сами во вкладке «Экран» — он её не переоткрывает.<br><br>
Пароль хранится только на вашем сервере.`],
  telegram: ['📨 Уведомления', `Придёт сообщение при успешном захвате и когда подтверждение не прошло.<br><br>
1. @BotFather → создайте бота → token<br>
2. Напишите своему боту любое сообщение<br>
3. @userinfobot → ваш chat_id`],
  reset: ['🧹 Обнулить статистику', `Удалит историю захватов и счётчики правил.<br><br>
Само правило и настройки останутся.`],
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
    if (t === 'settings') loadSettings().catch(() => {});
    if (t === 'vnc') loadVnc().catch(() => {});
    if (t === 'journal') loadJournal().catch(() => {});
  });
});

$('#btnOpen').addEventListener('click', () => openPage());
$('#btnLearn').addEventListener('click', () => learn());
$('#btnProbe').addEventListener('click', () => probe());
$('#btnSim').addEventListener('click', () => simulate());
$('#btnStart').addEventListener('click', () => startWatch());
$('#btnStop').addEventListener('click', () => stopWatch());
$('#btnLogout').addEventListener('click', () => { location.href = '/logout'; });

$('#btnAiTest').addEventListener('click', async () => {
  const out = $('#aiTestOut');
  out.textContent = '⏳ Проверяю ключ и доступ к модели…';
  try {
    const r = await api('/api/ai/test', { method: 'POST' });
    if (!r.ok) { out.innerHTML = '❌ ' + esc(r.reason || 'Ключ не подошёл'); return; }
    /* Ключ может быть верным, но модель — платной или квота исчерпана.
     * Это разные вещи, и раньше панель показывала просто «работает». */
    const quota = r.quotaOk === false
      ? `<br>⛔ <b>${esc(r.quotaNote || 'модель недоступна')}</b>`
      : r.quotaOk === true ? '<br>✅ ' + esc(r.quotaNote || '') : '';
    out.innerHTML =
      `✅ Ключ работает · моделей: ${r.models}<br>Модель <b>${esc(r.model)}</b>: ${r.modelFound ? 'есть в списке' : 'не найдена в списке'}`
      + quota + `<br><span style="opacity:.65">${esc(r.base || '')}</span>`;
  } catch (e) { out.textContent = 'Ошибка: ' + e.message; }
});

$('#btnStatsReset').addEventListener('click', async () => {
  if (!confirm('Обнулить статистику захватов?')) return;
  try {
    await api('/api/stats/reset', { method: 'POST' });
    toast('🧹 Статистика обнулена');
    loadStats().catch(() => {});
    pullStatus();
  } catch (e) { toast('Ошибка: ' + e.message); }
});

const scanR = $('#scanRange');
if (scanR) scanR.addEventListener('input', (e) => setText('#scanVal', e.target.value));
const confR = $('#confRange');
if (confR) confR.addEventListener('input', (e) => setText('#confVal', e.target.value));

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
setInterval(pullStatus, 5000);
setInterval(() => { if (!document.hidden) loadStats().catch(() => {}); }, 30000);
