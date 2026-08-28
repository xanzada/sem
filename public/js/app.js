'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const COLORS = {
  RUNNING: '#22c55e', STARTING: '#38bdf8', WAITING: '#eab308',
  AUTH_REQUIRED: '#f59e0b', SECURITY_VERIFICATION_WAIT: '#38bdf8',
  MANUAL_REVIEW: '#f97316', ERROR: '#ef4444', STOPPED: '#6b7280',
};
const CAT = { SYSTEM: 'вљ™пёЏ', CONTROL: 'рџЋ›', WORKFLOW: 'рџ“‹', AUTH: 'рџ”ђ', SECURITY: 'рџ›Ў' };

let snap = null;
let chart = null;
let ws = null, wsTimer = null;
let journalCat = '';

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
  if (sec < 60) return sec + ' СЃ';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + ' РјРёРЅ';
  return Math.floor(m / 60) + ' С‡ ' + (m % 60) + ' Рј';
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
    ? 'РќР° РїР°СѓР·Рµ' : (live ? 'Р’ СЂР°Р±РѕС‚Рµ В· ' + dur(snap.uptimeSec) : 'РћР¶РёРґР°РЅРёРµ РєРѕРјР°РЅРґС‹'));

  $('#bigOrb').classList.toggle('live', live);
  $('#brandOrb').classList.toggle('live', live);
  $$('.orb span, .orb i, .brand-orb i').forEach((el) => {
    el.style.background = color;
    el.style.borderColor = color;
  });

  setText('#modeBadge', snap.mode === 'ai' ? 'РР-РђР“Р•РќРў' : snap.mode === 'simulation' ? 'Р”Р•РњРћ' : 'Р‘РћР•Р’РћР™');
  setText('#kToday', snap.processedToday);
  setText('#kUp', live ? dur(snap.uptimeSec) : 'вЂ”');

  $('#btnStart').disabled = snap.running && !snap.paused;

  const alert = ['AUTH_REQUIRED', 'MANUAL_REVIEW', 'ERROR'].includes(snap.state);
  $$('.tab[data-tab="vnc"]').forEach((b) => b.classList.toggle('alert', alert));
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
async function loadStats() {
  const a = await api('/api/analytics');
  $('#stToday').textContent = a.today;
  $('#stWeek').textContent = a.week;
  $('#stTotal').textContent = a.total;
  $('#stAvg').textContent = a.avgDurationMs ? (a.avgDurationMs / 1000).toFixed(1) + ' СЃ' : 'вЂ”';
  setText('#kWeek', a.week);
  setText('#kAi', a.aiToday ?? 0);

  const tb = $('#recentBody');
  tb.innerHTML = '';
  a.recent.forEach((r) => {
    const tr = document.createElement('tr');
    const what = r.action === 'ai-task' ? 'рџ¤– Р—Р°РґР°С‡Р° РР' : '#' + esc(r.application_id);
    tr.innerHTML = `<td>${dmhm(r.ts)}</td><td>${what}</td>
      <td><span class="tag">${r.result === 'done' ? 'РІС‹РїРѕР»РЅРµРЅРѕ' : 'РїСЂРёРЅСЏС‚Р°'}</span></td>
      <td>${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + ' СЃ' : 'вЂ”'}</td>`;
    tb.appendChild(tr);
  });

  const labels = a.series24h.map((p) => p.hour.slice(11, 16));
  const data = a.series24h.map((p) => p.count);
  const sig = labels.join(',') + '|' + data.join(',');
  if (chart && chart.__sig === sig) return;
  if (chart) chart.destroy();
  chart = new Chart($('#chart24').getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: 'rgba(79,140,255,.55)', borderRadius: 6, maxBarThickness: 22 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
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
  if (sp) { sp.value = s.speed; $('#speedVal').textContent = 'Г—' + Number(s.speed); }

  /* РЎРµРєСЂРµС‚С‹ СЃРµСЂРІРµСЂ РЅР°СЂСѓР¶Сѓ РЅРµ РѕС‚РґР°С‘С‚, РїРѕСЌС‚РѕРјСѓ РїРѕР»Рµ РѕСЃС‚Р°С‘С‚СЃСЏ РїСѓСЃС‚С‹Рј вЂ”
   * Р±РµР· СЌС‚РѕР№ РїРѕРґРїРёСЃРё РєР°Р¶РµС‚СЃСЏ, С‡С‚Рѕ РїР°СЂРѕР»СЊ РЅРµ СЃРѕС…СЂР°РЅРёР»СЃСЏ. */
  $$('[data-state-for]').forEach((tag) => {
    const saved = s[tag.dataset.stateFor + 'Set'] === true;
    tag.textContent = saved ? 'В· СЃРѕС…СЂР°РЅС‘РЅ' : 'В· РЅРµ Р·Р°РґР°РЅ';
    tag.className = 'key-state ' + (saved ? 'ok' : 'no');
    const input = document.querySelector(`[name=${tag.dataset.stateFor}]`);
    if (input && saved && !input.value) input.placeholder = 'РЎРѕС…СЂР°РЅС‘РЅ вЂ” РѕСЃС‚Р°РІСЊС‚Рµ РїСѓСЃС‚С‹Рј РёР»Рё РІРІРµРґРёС‚Рµ РЅРѕРІС‹Р№';
  });

  const ks = $('#keyState');
  if (ks) {
    ks.textContent = s.aiApiKeySet ? 'В· СЃРѕС…СЂР°РЅС‘РЅ' : 'В· РЅРµ Р·Р°РґР°РЅ';
    ks.className = 'key-state ' + (s.aiApiKeySet ? 'ok' : 'no');
  }
  const keyInput = document.querySelector('input[name=aiApiKey]');
  if (keyInput && s.aiApiKeySet && !keyInput.value) {
    keyInput.placeholder = 'РљР»СЋС‡ СЃРѕС…СЂР°РЅС‘РЅ вЂ” РѕСЃС‚Р°РІСЊС‚Рµ РїСѓСЃС‚С‹Рј РёР»Рё РІРІРµРґРёС‚Рµ РЅРѕРІС‹Р№';
  }
  markProvider(s.aiBaseUrl || '');

  const loop = $('#loopOn');
  if (loop) {
    const on = Number(s.aiIntervalMin) > 0;
    if (loop !== document.activeElement) loop.checked = on;
    const lf = $('#loopFields');
    if (lf) lf.style.display = on ? '' : 'none';
  }

}

let vncLoaded = false;
async function loadVnc() {
  const el = $('#vncWrap');
  if (!el) return;
  if (vncLoaded && el.querySelector('iframe')) return;
  el.innerHTML = '<div class="hint" style="padding:16px">вЏі РџРѕРґРєР»СЋС‡Р°СЋСЃСЊ Рє СЌРєСЂР°РЅСѓвЂ¦</div>';
  const meta = await api('/api/meta').catch(() => ({}));
  if (meta.vncUrl) {
    el.innerHTML = `<iframe src="${meta.vncUrl}" allow="clipboard-read; clipboard-write"></iframe>`;
    vncLoaded = true;
  } else {
    el.innerHTML =
      '<div class="hint" style="padding:16px">Р­РєСЂР°РЅ РїРѕРєР° РЅРµРґРѕСЃС‚СѓРїРµРЅ: noVNC РЅРµ Р·Р°РїСѓС‰РµРЅ.<br><br>' +
      '<button class="btn ghost block" id="btnVncRetry">РџРѕРІС‚РѕСЂРёС‚СЊ</button></div>';
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
      btn.disabled = true; btn.textContent = 'РЎРѕС…СЂР°РЅСЏСЋвЂ¦';
      try {
        await api('/api/settings', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        toast('вњ… РЎРѕС…СЂР°РЅРµРЅРѕ');
        Array.from(form.elements).forEach((el) => { el.dataset.dirty = ''; });
        await loadSettings(true);
        pullStatus();
      } catch (e) { toast('РћС€РёР±РєР°: ' + e.message); }
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
  } catch (e) { toast('РћС€РёР±РєР°: ' + e.message); }
}
function pullStatus() {
  api('/api/status').then((d) => { snap = d.snap; renderStatus(); }).catch(() => {});
}

/* ---------------- AI agent ---------------- */
function renderAgent(st) {
  const html = (!st || (!st.running && !st.lastAction)) ? '' : `
    <div class="ai-live-head">${st.running ? '<span class="ai-dot"></span> РђРіРµРЅС‚ СЂР°Р±РѕС‚Р°РµС‚' : 'вЏ№ РћСЃС‚Р°РЅРѕРІР»РµРЅ'}
      ${st.step ? `<span class="ai-step">С€Р°Рі ${st.step}</span>` : ''}</div>
    ${st.task ? `<div class="ai-task">рџЋЇ ${esc(st.task)}</div>` : ''}
    ${st.lastAction ? `<div class="ai-act">${esc(st.lastAction)}</div>` : ''}`;
  const el = $('#aiLive'); if (el) el.innerHTML = html;
}
async function refreshAgent() {
  try { renderAgent(await api('/api/ai/state')); } catch { /* ignore */ }
}
async function runTask(inputSel, btnSel) {
  const field = document.querySelector(inputSel);
  const task = (field?.value || '').trim();
  if (!task) { toast('РќР°РїРёС€РёС‚Рµ Р·Р°РґР°С‡Сѓ'); return; }
  try {
    await api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aiInstruction: task }),
    });
  } catch { /* СЃРѕС…СЂР°РЅРёРј РїСЂРё СЃР»РµРґСѓСЋС‰РµРј Save */ }
  const btn = $(btnSel);
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'вЏі РђРіРµРЅС‚ СЂР°Р±РѕС‚Р°РµС‚вЂ¦';
  try {
    const r = await api('/api/ai/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    if (!r.ok) toast('вќЊ ' + (r.reason || 'РћС€РёР±РєР°'));
    else if (r.done) toast(`вњ… Р“РѕС‚РѕРІРѕ Р·Р° ${r.steps} С€Р°Рі(РѕРІ)`);
    else toast('вљ пёЏ ' + (r.reason || 'РќРµ Р·Р°РІРµСЂС€РµРЅРѕ'));
  } catch (e) { toast('РћС€РёР±РєР°: ' + e.message); }
  btn.disabled = false; btn.textContent = old;
  refreshAgent(); loadStats().catch(() => {}); }

/* ---------------- help ---------------- */
const HELP = {
  ai: ['рџ¤– РљРѕРјР°РЅРґР° Р°РіРµРЅС‚Сѓ', `РћРґРЅР° Р·Р°РґР°С‡Р° вЂ” Р°РіРµРЅС‚ РґРµР»Р°РµС‚ РµС‘ Рё РїРѕРІС‚РѕСЂСЏРµС‚ РїРѕ СЂР°СЃРїРёСЃР°РЅРёСЋ.<br><br>
<b>в–¶ Р’С‹РїРѕР»РЅРёС‚СЊ СЃРµР№С‡Р°СЃ</b> вЂ” СЃРґРµР»Р°С‚СЊ РѕРґРёРЅ СЂР°Р· РїСЂСЏРјРѕ СЃРµР№С‡Р°СЃ.<br>
<b>РџРѕРІС‚РѕСЂСЏС‚СЊ РїРѕ СЂР°СЃРїРёСЃР°РЅРёСЋ</b> вЂ” РІРєР»СЋС‡РёС‚Рµ Рё СѓРєР°Р¶РёС‚Рµ РёРЅС‚РµСЂРІР°Р» (РЅР°РїСЂРёРјРµСЂ 5 РјРёРЅСѓС‚). Р—Р°С‚РµРј в–¶ РЎС‚Р°СЂС‚ СЃРІРµСЂС…Сѓ вЂ” Р°РіРµРЅС‚ Р±СѓРґРµС‚ СЂР°Р±РѕС‚Р°С‚СЊ СЃР°Рј РєСЂСѓРіР»РѕСЃСѓС‚РѕС‡РЅРѕ.<br>
<b>Р›РёРјРёС‚ С€Р°РіРѕРІ</b> вЂ” СЃРєРѕР»СЊРєРѕ РґРµР№СЃС‚РІРёР№ РјР°РєСЃРёРјСѓРј Р·Р° РѕРґРёРЅ РїСЂРѕС…РѕРґ (Р·Р°С‰РёС‚Р° РѕС‚ Р»РёС€РЅРёС… СЂР°СЃС…РѕРґРѕРІ).<br><br>
РџРёС€РёС‚Рµ РѕР±С‹С‡РЅС‹РјРё СЃР»РѕРІР°РјРё:<br>
вЂў <i>В«Р’РѕР№РґРё РЅР° СЃР°Р№С‚: Р»РѕРіРёРЅ admin, РїР°СЂРѕР»СЊ 12345В»</i><br>
вЂў <i>В«РћС‚РєСЂРѕР№ СЃРїРёСЃРѕРє Р·Р°СЏРІРѕРє Рё РїСЂРёРјРё РїРµСЂРІСѓСЋ РЅРѕРІСѓСЋВ»</i><br>
вЂў <i>В«РќР°Р№РґРё Р·Р°СЏРІРєСѓ в„–184, РЅР°Р¶РјРё РџСЂРёРЅСЏС‚СЊ Рё РїРѕРґС‚РІРµСЂРґРё РІ РѕРєРЅРµВ»</i><br><br>
РќРёР¶Рµ РєРЅРѕРїРєРё РІРёРґРЅРѕ РєР°Р¶РґС‹Р№ С€Р°Рі Р°РіРµРЅС‚Р°, Р° РІРѕ РІРєР»Р°РґРєРµ <b>Р­РєСЂР°РЅ</b> вЂ” РєР°СЂС‚РёРЅРєСѓ Р±СЂР°СѓР·РµСЂР°.<br><br>
РќСѓР¶РµРЅ РєР»СЋС‡ Gemini вЂ” СЃРј. РєР°СЂС‚РѕС‡РєСѓ В«Р”РѕСЃС‚СѓРї Рє GeminiВ».`],
  aikey: ['рџ”‘ Р”РѕСЃС‚СѓРї Рє РјРѕРґРµР»Рё', `<b>Google Gemini (РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ):</b><br>
1. РћС‚РєСЂРѕР№С‚Рµ <b>aistudio.google.com/apikey</b><br>
2. Р’РѕР№РґРёС‚Рµ Google-Р°РєРєР°СѓРЅС‚РѕРј<br>
3. В«Create API keyВ» в†’ СЃРєРѕРїРёСЂСѓР№С‚Рµ (РЅР°С‡РёРЅР°РµС‚СЃСЏ РЅР° <code>AIzaвЂ¦</code>)<br>
4. Р’СЃС‚Р°РІСЊС‚Рµ Р·РґРµСЃСЊ в†’ <b>РЎРѕС…СЂР°РЅРёС‚СЊ</b> в†’ <b>РџСЂРѕРІРµСЂРёС‚СЊ РєР»СЋС‡</b><br><br>
5. Base URL РѕСЃС‚Р°РІСЊС‚Рµ РїСѓСЃС‚С‹Рј<br><br>
<b>Р”СЂСѓРіРѕР№ РїСЂРѕРІР°Р№РґРµСЂ</b> (OpenRouter, СЃРІРѕР№ РїСЂРѕРєСЃРё, Р»РѕРєР°Р»СЊРЅР°СЏ РјРѕРґРµР»СЊ):<br>
вЂў Base URL: <code>https://openrouter.ai/api/v1</code><br>
вЂў РњРѕРґРµР»СЊ: <code>google/gemini-2.5-flash</code> РёР»Рё <code>anthropic/claude-sonnet-4.5</code><br>
вЂў РљР»СЋС‡: РІР°С€ <code>sk-вЂ¦</code><br><br>
РњРѕРґРµР»СЊ РЅСѓР¶РЅРѕ РІС‹Р±РёСЂР°С‚СЊ <b>СЃ РїРѕРґРґРµСЂР¶РєРѕР№ РєР°СЂС‚РёРЅРѕРє</b> (vision) вЂ” Р°РіРµРЅС‚ СЂР°Р±РѕС‚Р°РµС‚ РїРѕ СЃРєСЂРёРЅС€РѕС‚Сѓ.
РќР°Р·РІР°РЅРёРµ РїРёС€РёС‚Рµ С‚РѕС‡РЅРѕ РєР°Рє Сѓ РїСЂРѕРІР°Р№РґРµСЂР°. РљР»СЋС‡ С…СЂР°РЅРёС‚СЃСЏ С‚РѕР»СЊРєРѕ РЅР° РІР°С€РµРј СЃРµСЂРІРµСЂРµ.`],
  loop: ['в™»пёЏ РђРІС‚РѕР·Р°РїСѓСЃРє', `Р•СЃР»Рё РІРєР»СЋС‡РµРЅРѕ вЂ” РїРѕСЃР»Рµ РїРµСЂРµР·Р°РїСѓСЃРєР° СЃРµСЂРІРµСЂР° Р°РіРµРЅС‚ РїРѕРґРЅРёРјРµС‚СЃСЏ СЃР°Рј Рё РїСЂРѕРґРѕР»Р¶РёС‚ СЂР°Р±РѕС‚Р°С‚СЊ РїРѕ РІР°С€РµР№ Р·Р°РґР°С‡Рµ.<br><br>
В«Р”СЂСѓРіРёРµ СЂРµР¶РёРјС‹В» РЅСѓР¶РЅС‹ СЂРµРґРєРѕ: РѕР±С‹С‡РЅС‹Р№ СЂРµР¶РёРј вЂ” <b>рџ¤– РР-Р°РіРµРЅС‚</b>.`],
  site: ['рџЊђ РЎР°Р№С‚ Рё РІС…РѕРґ', `РђРґСЂРµСЃ СЃР°Р№С‚Р°, РіРґРµ СЂР°Р±РѕС‚Р°РµС‚ Р°РіРµРЅС‚, Рё РґР°РЅРЅС‹Рµ РґР»СЏ РІС…РѕРґР°.<br><br>
Р•СЃР»Рё СЃРµСЃСЃРёСЏ РёСЃС‚РµС‡С‘С‚ вЂ” Р±РѕС‚ РІРѕР№РґС‘С‚ СЃР°Рј РїРѕ СЌС‚РёРј РґР°РЅРЅС‹Рј. Р•СЃР»Рё РїРѕРЅР°РґРѕР±РёС‚СЃСЏ РєРѕРґ РёР· SMS, РІС‹ РїРѕР»СѓС‡РёС‚Рµ СѓРІРµРґРѕРјР»РµРЅРёРµ, РІРІРµРґС‘С‚Рµ РєРѕРґ РІРѕ РІРєР»Р°РґРєРµ <b>Р­РєСЂР°РЅ</b>, Рё Р°РіРµРЅС‚ РїСЂРѕРґРѕР»Р¶РёС‚.<br><br>
РџР°СЂРѕР»СЊ С…СЂР°РЅРёС‚СЃСЏ С‚РѕР»СЊРєРѕ РЅР° РІР°С€РµРј СЃРµСЂРІРµСЂРµ.`],
  schedule: ['рџ•’ Р“СЂР°С„РёРє СЂР°Р±РѕС‚С‹', `<b>РљСЂСѓРіР»РѕСЃСѓС‚РѕС‡РЅРѕ</b> вЂ” Р°РіРµРЅС‚ СЂР°Р±РѕС‚Р°РµС‚ РІСЃРµРіРґР°.<br><br>
<b>РџРѕ С‡Р°СЃР°Рј</b> вЂ” РЅР°РїСЂРёРјРµСЂ СЃ 9 РґРѕ 21 (РїРѕ РђР»РјР°С‚С‹). Р’РЅРµ РіСЂР°С„РёРєР° Р°РіРµРЅС‚ СЃС‚Р°РІРёС‚ РїР°СѓР·Сѓ Рё Р·Р°РєСЂС‹РІР°РµС‚ Р±СЂР°СѓР·РµСЂ, С‡С‚РѕР±С‹ СЃРµСЂРІРµСЂ РѕС‚РґС‹С…Р°Р», Р° СѓС‚СЂРѕРј РїРѕРґРЅРёРјР°РµС‚СЃСЏ СЃР°Рј.`],
  behavior: ['вљ™пёЏ РџРѕРІРµРґРµРЅРёРµ', `<b>РЎРєРѕСЂРѕСЃС‚СЊ</b> вЂ” РјРЅРѕР¶РёС‚РµР»СЊ РїР°СѓР·: 0.5 Р±С‹СЃС‚СЂРµРµ, 2 РјРµРґР»РµРЅРЅРµРµ Рё РѕСЃС‚РѕСЂРѕР¶РЅРµРµ.<br><br>
<b>РџР°СѓР·Р° РјРµР¶РґСѓ РґРµР№СЃС‚РІРёСЏРјРё</b> вЂ” 800 РјСЃ РїРѕС…РѕР¶Рµ РЅР° С‡РµР»РѕРІРµРєР°.<br><br>
<b>Keep-alive</b> вЂ” РєР°Рє С‡Р°СЃС‚Рѕ РЅР°РїРѕРјРёРЅР°С‚СЊ СЃР°Р№С‚Сѓ Рѕ СЃРµР±Рµ, С‡С‚РѕР±С‹ РЅРµ СЂР°Р·Р»РѕРіРёРЅРёР»Рѕ (180 СЃРµРє).<br><br>
<b>РЎРєСЂРёРЅС€РѕС‚-РґРѕРєР°Р·Р°С‚РµР»СЊСЃС‚РІРѕ</b> вЂ” СЃРЅРёРјРѕРє РїРѕСЃР»Рµ РєР°Р¶РґРѕР№ РїСЂРёРЅСЏС‚РѕР№ Р·Р°СЏРІРєРё, РІРёРґРµРЅ РІ Р–СѓСЂРЅР°Р»Рµ.`],
  telegram: ['рџ“Ё РЈРІРµРґРѕРјР»РµРЅРёСЏ', `РЎРѕРѕР±С‰РёРј, РµСЃР»Рё РЅСѓР¶РµРЅ РІС…РѕРґ, РїРѕСЏРІРёР»Р°СЃСЊ РїСЂРѕРІРµСЂРєР° Р±РµР·РѕРїР°СЃРЅРѕСЃС‚Рё РёР»Рё С‚СЂРµР±СѓРµС‚СЃСЏ РІР°С€Рµ РІРЅРёРјР°РЅРёРµ.<br><br>
1. @BotFather в†’ СЃРѕР·РґР°Р№С‚Рµ Р±РѕС‚Р° в†’ РїРѕР»СѓС‡РёС‚Рµ token<br>
2. РќР°РїРёС€РёС‚Рµ СЃРІРѕРµРјСѓ Р±РѕС‚Сѓ Р»СЋР±РѕРµ СЃРѕРѕР±С‰РµРЅРёРµ<br>
3. @userinfobot в†’ СѓР·РЅР°Р№С‚Рµ СЃРІРѕР№ chat_id<br>
4. Р’СЃС‚Р°РІСЊС‚Рµ РѕР±Р° Р·РЅР°С‡РµРЅРёСЏ Рё СЃРѕС…СЂР°РЅРёС‚Рµ.`],
  reset: ['рџ§№ РћР±РЅСѓР»РёС‚СЊ СЃС‚Р°С‚РёСЃС‚РёРєСѓ', `РЈРґР°Р»РёС‚ РёСЃС‚РѕСЂРёСЋ Р·Р°СЏРІРѕРє Рё СЃС‡С‘С‚С‡РёРєРё (СЃРµРіРѕРґРЅСЏ / 7 РґРЅРµР№ / РІСЃРµРіРѕ).<br><br>
Р–СѓСЂРЅР°Р» СЃРѕР±С‹С‚РёР№ Рё РЅР°СЃС‚СЂРѕР№РєРё РѕСЃС‚Р°РЅСѓС‚СЃСЏ. РџРѕР»РµР·РЅРѕ, РµСЃР»Рё РІ СЃС‚Р°С‚РёСЃС‚РёРєРµ РЅР°РєРѕРїРёР»РёСЃСЊ С‚РµСЃС‚РѕРІС‹Рµ Р·Р°РїСѓСЃРєРё.`],
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

$('#btnStart').addEventListener('click', () => control('start'));
$('#btnStop').addEventListener('click', () => control('stop'));
$('#btnLogout').addEventListener('click', () => { location.href = '/logout'; });

$('#btnAiRun').addEventListener('click', () => runTask('textarea[name=aiInstruction]', '#btnAiRun'));

$('#btnAiTest').addEventListener('click', async () => {
  const out = $('#aiTestOut');
  out.textContent = 'вЏі РџСЂРѕРІРµСЂСЏСЋ РєР»СЋС‡вЂ¦';
  try {
    const r = await api('/api/ai/test', { method: 'POST' });
    out.innerHTML = r.ok
      ? `вњ… РљР»СЋС‡ СЂР°Р±РѕС‚Р°РµС‚ В· РјРѕРґРµР»РµР№: ${r.models}<br>РњРѕРґРµР»СЊ <b>${esc(r.model)}</b>: ${r.modelFound ? 'РґРѕСЃС‚СѓРїРЅР°' : 'РЅРµ РЅР°Р№РґРµРЅР° РІ СЃРїРёСЃРєРµ'}<br><span style="opacity:.65">${esc(r.base || '')}</span>`
      : 'вќЊ ' + esc(r.reason || 'РљР»СЋС‡ РЅРµ РїРѕРґРѕС€С‘Р»');
  } catch (e) { out.textContent = 'РћС€РёР±РєР°: ' + e.message; }
});

$('#btnStatsReset').addEventListener('click', async () => {
  if (!confirm('РћР±РЅСѓР»РёС‚СЊ СЃС‚Р°С‚РёСЃС‚РёРєСѓ Р·Р°СЏРІРѕРє?')) return;
  try {
    await api('/api/stats/reset', { method: 'POST' });
    toast('рџ§№ РЎС‚Р°С‚РёСЃС‚РёРєР° РѕР±РЅСѓР»РµРЅР°');
    loadStats().catch(() => {});
    pullStatus();
  } catch (e) { toast('РћС€РёР±РєР°: ' + e.message); }
});

const sp = $('#speedRange');
if (sp) sp.addEventListener('input', (e) => { $('#speedVal').textContent = 'Г—' + e.target.value; });

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
setInterval(() => { if (!document.hidden) loadStats().catch(() => {}); }, 60000);


