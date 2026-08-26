import type { Page } from 'playwright';
import { getPage } from './browser.js';
import { getAllSettings, setSettingsPatch, getSetting } from './settings.js';
import { log } from './logger.js';
import type { Step } from './types.js';

let active = false;

/* ------------------------------------------------------------------ *
 * Скрипт, который живёт на странице сайта внутри VNC.
 * Показывает панель управления сверху и панель подтверждения после клика.
 * ------------------------------------------------------------------ */
const INJECT = String.raw`
(() => {
  if (window.__semPickerOn) return 'already';
  window.__semPickerOn = true;
  window.__semMode = 'on';
  window.__semBypass = false;
  window.__semSel = null;

  const style = document.createElement('style');
  style.textContent = [
    '#sem-bar{position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0e141d;',
    'border-bottom:2px solid #4f8cff;padding:8px 10px;display:flex;gap:8px;flex-wrap:wrap;',
    'align-items:center;font-family:system-ui,sans-serif;color:#e7edf5;font-size:13px}',
    '#sem-bar button{padding:9px 13px;border-radius:10px;border:1px solid #2a3a58;background:#182131;',
    'color:#fff;font-size:13px;font-weight:700;cursor:pointer}',
    '#sem-bar button.on{background:#3568e0;border-color:#4f8cff}',
    '#sem-bar #sem-off{background:#3a1518;border-color:#6b2b2b;color:#ff9a9a}',
    '#sem-bar .sem-note{flex-basis:100%;font-size:11.5px;color:#8b98a9}',
    '#sem-ask{position:fixed;top:56px;left:0;right:0;z-index:2147483647;background:#12233b;',
    'border-bottom:2px solid #22c55e;padding:10px;display:none;gap:8px;flex-wrap:wrap;',
    'align-items:center;font-family:system-ui,sans-serif;color:#e7edf5;font-size:13px}',
    '#sem-ask.show{display:flex}',
    '#sem-ask b{color:#9dff c0}',
    '#sem-ask button{padding:10px 14px;border-radius:10px;border:none;color:#fff;font-weight:800;',
    'font-size:13px;cursor:pointer}',
    '#sem-ask .ok{background:#22a55a}#sem-ask .go{background:#3568e0}',
    '#sem-ask .acc{background:#0f9b6c}#sem-ask .chk{background:#8a6d1f}',
    '#sem-ask .no{background:#3a1518;color:#ff9a9a}',
    '#sem-ask .sem-what{flex-basis:100%;font-size:14px}',
    '#sem-toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;',
    'background:#16324a;color:#dff3ff;padding:10px 16px;border-radius:12px;font-family:system-ui;',
    'font-size:13px;display:none;border:1px solid #2f6d99}',
    'body{padding-top:56px !important}',
    '.sem-hl{outline:3px solid #ff5252 !important;outline-offset:1px !important}'
  ].join('');
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'sem-bar';
  bar.innerHTML = [
    '<button id="sem-mode" class="on">🖱 Обучение: ВКЛ</button>',
    '<button id="sem-back">↩ Назад</button>',
    '<button id="sem-fwd">⤴ Вперёд</button>',
    '<button id="sem-off">✕ Закончить</button>',
    '<span class="sem-note" id="sem-note">Нажмите на элемент сайта → появится вопрос, что с ним делать.</span>'
  ].join('');
  document.body.appendChild(bar);

  const ask = document.createElement('div');
  ask.id = 'sem-ask';
  ask.innerHTML = [
    '<div class="sem-what">Выбрано: <b id="sem-what">—</b></div>',
    '<button class="ok" id="sem-save">✓ Просто нажать</button>',
    '<button class="go" id="sem-open">→ Нажать и открыть страницу</button>',
    '<button class="acc" id="sem-acc">✅ Это «Принять заявку»</button>',
    '<button class="chk" id="sem-chk">👁 Проверить, что появилось</button>',
    '<button class="no" id="sem-cancel">✕ Отмена</button>'
  ].join('');
  document.body.appendChild(ask);

  const toastEl = document.createElement('div');
  toastEl.id = 'sem-toast';
  document.body.appendChild(toastEl);

  const note = (t) => { document.getElementById('sem-note').textContent = t; };
  const toast = (t) => {
    toastEl.textContent = t;
    toastEl.style.display = 'block';
    clearTimeout(window.__semT);
    window.__semT = setTimeout(() => { toastEl.style.display = 'none'; }, 2600);
  };

  const NAMES = {BUTTON:'Кнопка',A:'Ссылка',INPUT:'Поле',SELECT:'Список',TEXTAREA:'Поле',
    TR:'Строка',LI:'Пункт',TD:'Ячейка',DIV:'Блок',SPAN:'Элемент',H1:'Заголовок',H2:'Заголовок',IMG:'Картинка'};

  const describe = (raw) => {
    const el = (raw.closest && raw.closest('button,a,[role="button"],input,select,textarea,tr,li,[onclick]')) || raw;
    const cands = [];
    const tag = el.tagName.toLowerCase();
    try { if (el.id) cands.push('#' + CSS.escape(el.id)); } catch (e) {}
    ['data-testid','data-test','data-action','data-id','name','aria-label'].forEach((a) => {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) cands.push(tag + '[' + a + '="' + String(v).replace(/"/g,'') + '"]');
    });
    const txt = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (txt && (tag === 'button' || tag === 'a' || tag === 'input')) {
      cands.push(tag + ':has-text("' + txt.replace(/"/g, '') + '")');
    }
    const clsList = Array.prototype.slice.call(el.classList).filter((c) => c !== 'sem-hl' && c !== 'sempick-hl');
    if (clsList.length) cands.push(tag + '.' + clsList.slice(0, 2).join('.'));
    let cur = el, path = [];
    while (cur && cur.tagName !== 'BODY') {
      let s = cur.tagName.toLowerCase();
      const pc = Array.prototype.slice.call(cur.classList).filter((c) => c !== 'sem-hl' && c !== 'sempick-hl');
      if (pc.length) s += '.' + pc.slice(0, 3).join('.');
      const par = cur.parentElement;
      if (par) {
        const same = Array.prototype.filter.call(par.children, (c) => c.tagName === cur.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      path.unshift(s);
      cur = par;
    }
    if (path.length) cands.push(path.join(' > '));
    const human = (NAMES[el.tagName] || el.tagName) + (txt ? ' «' + txt.slice(0, 30) + '»' : '');
    return { el: el, sel: cands.filter(Boolean).slice(0, 6), human: human };
  };

  const showAsk = (d) => {
    window.__semSel = d;
    document.getElementById('sem-what').textContent = d.human;
    ask.classList.add('show');
  };
  const hideAsk = () => { ask.classList.remove('show'); window.__semSel = null; };

  const send = (act) => {
    const d = window.__semSel;
    if (!d) return;
    if (window.__semAddStep) window.__semAddStep({ act: act, sel: d.sel, note: d.human });
    const label = {click:'Нажать', accept:'Принять заявку', check:'Проверить'}[act] || act;
    toast('💾 Шаг сохранён: ' + label + ' — ' + d.human);
    hideAsk();
  };

  document.getElementById('sem-save').addEventListener('click', () => send('click'));
  document.getElementById('sem-acc').addEventListener('click', () => send('accept'));
  document.getElementById('sem-chk').addEventListener('click', () => send('check'));
  document.getElementById('sem-cancel').addEventListener('click', hideAsk);
  document.getElementById('sem-open').addEventListener('click', () => {
    const d = window.__semSel;
    if (!d) return;
    if (window.__semAddStep) window.__semAddStep({ act: 'click', sel: d.sel, note: d.human });
    toast('💾 Шаг сохранён и открываю страницу…');
    hideAsk();
    window.__semBypass = true;
    const target = d.el;
    setTimeout(() => {
      window.__semBypass = false;
      try { target.click(); } catch (e) {}
    }, 200);
  });

  const setMode = (m) => {
    window.__semMode = m;
    const b = document.getElementById('sem-mode');
    b.textContent = m === 'on' ? '🖱 Обучение: ВКЛ' : '🖱 Обучение: ВЫКЛ (сайт работает обычно)';
    b.className = m === 'on' ? 'on' : '';
    note(m === 'on'
      ? 'Нажмите на элемент сайта → появится вопрос, что с ним делать.'
      : 'Клики идут на сайт как обычно. Включите обучение, чтобы записывать шаги.');
    hideAsk();
  };
  document.getElementById('sem-mode').addEventListener('click', () => setMode(window.__semMode === 'on' ? 'off' : 'on'));
  document.getElementById('sem-back').addEventListener('click', () => history.back());
  document.getElementById('sem-fwd').addEventListener('click', () => history.forward());
  document.getElementById('sem-off').addEventListener('click', () => {
    if (window.__semStop) window.__semStop();
    setTimeout(() => location.reload(), 300);
  });

  let last = null;
  document.addEventListener('mouseover', (e) => {
    if (e.target.closest && e.target.closest('#sem-bar,#sem-ask')) return;
    if (last) last.classList.remove('sem-hl');
    last = e.target;
    last.classList.add('sem-hl');
  }, true);

  document.addEventListener('click', (e) => {
    if (window.__semBypass) return;
    if (e.target.closest && e.target.closest('#sem-bar,#sem-ask')) return;
    if (window.__semMode === 'off') return;
    e.preventDefault();
    e.stopPropagation();
    showAsk(describe(e.target));
  }, true);

  return 'ok';
})()
`;

/* ------------------------------------------------------------------ */

function readSteps(): Step[] {
  const raw = String(getSetting('stepsJson') || '').trim();
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as Step[]) : [];
  } catch {
    return [];
  }
}

function writeSteps(steps: Step[]): void {
  setSettingsPatch({ stepsJson: JSON.stringify(steps) });
}

export function addStep(d: { act?: string; sel?: string[]; note?: string }): number {
  const steps = readSteps();
  const act = (['click', 'accept', 'check', 'open', 'back', 'wait'] as const).includes(
    (d.act ?? 'click') as never
  )
    ? (d.act as Step['act'])
    : 'click';
  steps.push({
    act,
    sel: Array.isArray(d.sel) ? d.sel.filter(Boolean).slice(0, 6) : [],
    note: String(d.note ?? '').slice(0, 60),
  });
  writeSteps(steps);
  log('info', 'CONTROL', `Обучение: шаг ${steps.length} — ${act} · ${d.note ?? ''}`);
  return steps.length;
}

async function ensureBinding(page: Page): Promise<void> {
  /* Всегда пытаемся зарегистрировать: после пересоздания браузера
     (график работы, перезапуск) контекст новый — привязки теряются. */
  try {
    await page.exposeBinding('__semAddStep', (_src, d) => {
      addStep(d as { act?: string; sel?: string[]; note?: string });
    });
  } catch {
    /* уже зарегистрирован на этом контексте */
  }
  try {
    await page.exposeBinding('__semStop', async () => {
      active = false;
      log('info', 'CONTROL', 'Обучение завершено кнопкой в VNC');
    });
  } catch {
    /* уже зарегистрирован */
  }
}

async function inject(page: Page): Promise<void> {
  try {
    await page.evaluate(INJECT);
  } catch (e) {
    log('warn', 'SYSTEM', `Скрипт обучения не внедрился: ${String(e).slice(0, 90)}`);
  }
}

export async function startPicker(url?: string): Promise<{ ok: boolean; url: string }> {
  const s = getAllSettings();
  const page = await getPage();
  await ensureBinding(page);
  const target = url || s.listUrl || s.siteUrl || 'about:blank';
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await inject(page);
  active = true;
  log('info', 'CONTROL', 'Режим обучения включён — панель управления теперь в VNC');
  return { ok: true, url: page.url() };
}

export async function reinject(): Promise<{ ok: boolean }> {
  const page = await getPage();
  await ensureBinding(page);
  await inject(page);
  active = true;
  return { ok: true };
}

/** Держит панель живой: после перехода на новую страницу скрипт внедряется снова. */
export async function heartbeat(): Promise<void> {
  if (!active) return;
  try {
    const page = await getPage();
    const on = await page.evaluate('window.__semPickerOn===true').catch(() => false);
    if (!on) {
      await ensureBinding(page);
      await inject(page);
    }
  } catch {
    /* браузер занят */
  }
}

export async function demoClicks(
  url: string | undefined,
  selectors: string[]
): Promise<{ ok: boolean; count: number }> {
  const s = getAllSettings();
  const page = await getPage();
  await ensureBinding(page);
  await page.goto(url || s.listUrl || s.siteUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(2000);
  await inject(page);
  let count = 0;
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      const box = await el.boundingBox({ timeout: 5000 });
      if (!box) continue;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      count += 1;
      await page.waitForTimeout(600);
    } catch {
      /* пропускаем */
    }
  }
  active = true;
  return { ok: true, count };
}

export function stop(): { ok: boolean } {
  active = false;
  void getPage()
    .then((p) => p.evaluate('window.__semPickerOn=false; location.reload();'))
    .catch(() => {});
  log('info', 'CONTROL', 'Режим обучения остановлен');
  return { ok: true };
}

export function isActive(): boolean {
  return active;
}

export function list(): [] {
  return [];
}
