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
      if (tab === 'settings') loadSettings().catch(() => {});
      if (tab === 'journal') loadJournal().catch(() => {});
    });
  });

  $('#btnStart').addEventListener('click', () => control('start'));
  $('#btnStop').addEventListener('click', () => control('stop'));
  $('#btnPause').addEventListener('click', () => control(snap && snap.paused ? 'resume' : 'pause'));

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

  /* ---------- Оқыту режимі (picker) ---------- */
  const ROLE_LABELS = {
    ignore: '— ешқандай',
    listRow: '📋 Заявка жолы',
    openLink: '🔗 Ашу сілтемесі',
    statusPending: '🟡 Статус: күтуде',
    statusAccepted: '🟢 Статус: қабылданған',
    acceptButton: '✅ Принять батырмасы',
  };
  let pickPoll = null;

  function renderPicks(picks) {
    const out = $('#picksOut');
    if (!picks.length) {
      out.innerHTML = '<div class="hint">Әзірше элемент таңдалмады — VNC-де сайтты ашып, басыңыз.</div>';
      return;
    }
    out.innerHTML = '';
    [...picks].reverse().forEach((p) => {
      const row = document.createElement('div');
      row.className = 'card';
      row.style.cssText = 'padding:10px;display:flex;flex-direction:column;gap:6px';
      const candsOpts = p.cands
        .map((c, i) => `<option value="${i}" ${p.chosen === i ? 'selected' : ''}>${escapeHtml(c)}</option>`)
        .join('');
      row.innerHTML = `
        <div style="font-size:13px"><b>&lt;${escapeHtml(p.tag)}&gt;</b> ${escapeHtml(p.text || '(мәтінсіз)')}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select data-pick="${p.index}" data-field="role" style="flex:1;min-width:150px">
            ${Object.entries(ROLE_LABELS).map(([v, l]) =>
              `<option value="${v}" ${p.label === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <select data-pick="${p.index}" data-field="chosen" style="flex:2;min-width:200px;font-family:monospace;font-size:11px">
            ${candsOpts}
          </select>
        </div>`;
      out.appendChild(row);
    });
    out.querySelectorAll('select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const idx = Number(sel.dataset.pick);
        if (sel.dataset.field === 'role') {
          await api('/api/picker/label', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: idx, role: sel.value }) });
        } else {
          await api('/api/picker/label', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: idx, role: 'pending-label', chosen: Number(sel.value) }) });
          await api('/api/picker/label', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: idx, role: picks.find((x) => x.index === idx)?.label || 'ignore' }) });
        }
      });
    });
  }

  async function refreshPicks() {
    try {
      const r = await api('/api/picker/picks');
      renderPicks(r.picks || []);
    } catch { /* ignore */ }
  }

  $('#btnPickStart').addEventListener('click', async () => {
    try {
      const r = await api('/api/picker/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: $('#pickUrl').value }) });
      if (!r.ok) { toast('❌ ' + (r.reason || 'Кіре алмадым')); return; }
      toast('🎯 Оқыту режимі қосылды — VNC вкладкасына өтіңіз');
      refreshPicks();
      if (!pickPoll) pickPoll = setInterval(refreshPicks, 4000);
    } catch (e) { toast('Қате: ' + e.message); }
  });
  $('#btnPickReinject').addEventListener('click', async () => {
    await api('/api/picker/reinject', { method: 'POST' });
    toast('Скрипт қайта енгізілді');
  });
  $('#btnPickStop').addEventListener('click', async () => {
    await api('/api/picker/stop', { method: 'POST' });
    clearInterval(pickPoll); pickPoll = null;
    toast('⏹ Оқыту режимі тоқтатылды');
  });
  $('#btnPickSave').addEventListener('click', async () => {
    try {
      const r = await api('/api/picker/save', { method: 'POST' });
      if (r.ok) { toast('✅ Селекторлар сақталды'); await loadSettings(); }
    } catch (e) { toast('Қате: ' + e.message); }
  });

  $('#btnSelHealth').addEventListener('click', async () => {
    const out = $('#selHealthOut');
    out.textContent = '⏳ Сайтты тексеруде…';
    try {
      const r = await api('/api/selectors-health');
      if (r.needsLogin) {
        out.textContent = '⚠️ Бот сайтқа кірмеген. Алдымен ▶ Старт басып, логинделсін, сосын ⏸ Пауза жасап қайта тексеріңіз.';
        return;
      }
      if (!r.ok) {
        out.textContent = '❌ ' + (r.reason || 'Тексеру мүмкін болмады');
        return;
      }
      out.innerHTML =
        r.items.map((i) => (i.ok ? '✅ ' : '❌ ') + escapeHtml(i.key)).join('<br>') +
        '<br><span style="opacity:.7">' + escapeHtml(r.note || '') + '</span>';
    } catch (e) {
      out.textContent = 'Қате: ' + e.message;
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
