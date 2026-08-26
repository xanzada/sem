import type { Page } from 'playwright';
import { getPage } from './browser.js';
import { getAllSettings, setSettingsPatch, getSetting } from './settings.js';
import { log } from './logger.js';
import type { Step } from './types.js';

let active = false;

export interface PickItem {
  index: number;
  tag: string;
  text: string;
  cands: string[];
  human?: string;
  label?: string;
  chosen?: number;
  ts: string;
}

let picks: PickItem[] = [];

const INJECT = `
(() => {
  if (window.__semPickerOn) return 'already';
  window.__semPickerOn = true;
  window.__semMode = 'on';
  window.__semRealOnce = false;
  window.__semBypass = false;

  const tb = document.createElement('div');
  tb.id = 'sem-tb';
  tb.innerHTML =
    '<button id="sem-mode">🖱 Указание: ВКЛ</button>' +
    '<button id="sem-enter">⤵ Войти внутрь</button>' +
    '<button id="sem-back">↩ Назад</button>' +
    '<button id="sem-fwd">⤴ Вперёд</button>' +
    '<button id="sem-off">✕ Выключить обучение</button>' +
    '<span id="sem-hint">Режим: клик = запомнить элемент. «Войти внутрь» → следующий клик откроет страницу.</span>';
  const st = document.createElement('style');
  st.textContent =
    '#sem-tb{position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0e141d;'+
    'border-bottom:2px solid #4f8cff;display:flex;gap:8px;padding:8px 10px;align-items:center;'+
    'flex-wrap:wrap;font-family:system-ui,sans-serif;font-size:13px;color:#e7edf5}'+
    '#sem-tb button{padding:10px 14px;border-radius:10px;border:1px solid #2a3a58;'+
    'background:#182131;color:#fff;font-size:13px;font-weight:700;cursor:pointer}'+
    '#sem-tb button.on{background:#3568e0;border-color:#4f8cff}'+
    '#sem-tb #sem-off{background:#3a1518;border-color:#6b2b2b;color:#ff9a9a}'+
    '#sem-tb #sem-hint{flex-basis:100%;font-size:11px;color:#8b98a9}'+
    'body{padding-top:56px!important}'+
    '*{cursor:crosshair!important}.sempick-hl{outline:2px solid #ff5252!important;outline-offset:1px!important}';
  document.head.appendChild(st);
  document.body.appendChild(tb);

  const hint = (t) => { document.getElementById('sem-hint').textContent = t; };
  const setMode = (m) => {
    window.__semMode = m;
    const b = document.getElementById('sem-mode');
    b.textContent = m === 'on' ? '🖱 Указание: ВКЛ' : '🖱 Указание: ВЫКЛ (клики работают)';
    b.classList.toggle('on', m === 'on');
    hint(m === 'on'
      ? 'Режим: клик = запомнить элемент. «Войти внутрь» → следующий клик откроет страницу.'
      : 'Клики работают как обычно. Включите «Указание», чтобы запомнить элемент.');
  };
  document.getElementById('sem-mode').addEventListener('click', () => {
    setMode(window.__semMode === 'on' ? 'off' : 'on');
  });
  document.getElementById('sem-enter').addEventListener('click', () => {
    window.__semRealOnce = true;
    hint('Теперь кликните по кнопке сайта — произойдёт НАСТОЯЩИЙ переход, и шаг сохранится.');
  });
  document.getElementById('sem-back').addEventListener('click', () => history.back());
  document.getElementById('sem-fwd').addEventListener('click', () => history.forward());
  document.getElementById('sem-off').addEventListener('click', () => {
    if (window.__semStop) window.__semStop();
  });

  let last = null;
  const hl = (el) => {
    if (last) last.classList.remove('sempick-hl');
    last = el; el.classList.add('sempick-hl');
  };
  const describe = (el0) => {
    const el = (el0.closest && el0.closest('button,a,[role=button],input,select,textarea,tr,li,[onclick]')) || el0;
    const cands = [];
    try { if (el.id) cands.push('#' + CSS.escape(el.id)); } catch {}
    for (const a of ['data-testid','data-test','data-action','data-id','name']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) cands.push(el.tagName.toLowerCase() + '[' + a + '="' + v + '"]');
    }
    const txt = (el.innerText || el.value || '').trim().replace(/\\s+/g,' ').slice(0,40);
    if (txt && ['BUTTON','A','INPUT'].includes(el.tagName)) {
      cands.push(el.tagName.toLowerCase() + ':has-text("' + txt.replace(/"/g,'') + '")');
    }
    if (el.classList.length) {
      cands.push(el.tagName.toLowerCase() + '.' + [...el.classList].slice(0,2).join('.'));
    }
    let cur = el, path = [];
    while (cur && cur.tagName !== 'BODY') {
      let s = cur.tagName.toLowerCase();
      if (cur.classList.length) s += '.' + [...cur.classList].slice(0,3).join('.');
      const p = cur.parentElement;
      if (p) {
        const same = [...p.children].filter(c => c.tagName === cur.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      path.unshift(s); cur = p ? p.parentElement : null;
    }
    if (path.length) cands.push(path.join(' > '));
    const names = {BUTTON:'Кнопка',A:'Ссылка',INPUT:'Поле',SELECT:'Список',TR:'Строка',DIV:'Блок',SPAN:'Элемент',LI:'Пункт',TD:'Ячейка',H1:'Заголовок'};
    const ru = names[el.tagName] || el.tagName;
    const human = ru + (txt ? ' «' + txt.slice(0,30) + '»' : '');
    return { tag: el.tagName.toLowerCase(), text: txt, cands: [...new Set(cands)].slice(0,6), human: human };
  };
  document.addEventListener('mouseover', (e) => hl(e.target), true);
  document.addEventListener('mouseout', () => { if (last){last.classList.remove('sempick-hl');} }, true);
  document.addEventListener('click', (e) => {
    if (window.__semBypass) return;
    if (e.target.closest && e.target.closest('#sem-tb')) return;
    if (window.__semMode === 'off') return;
    e.preventDefault(); e.stopPropagation();
    const el0 = e.target;
    if (window.__semRealOnce) {
      window.__semRealOnce = false;
      const d = describe(el0);
      if (window.__semCapture) window.__semCapture(d);
      hint('Переход выполняется… шаг сохранён.');
      window.__semBypass = true;
      setTimeout(() => {
        window.__semBypass = false;
        if (el0.click) el0.click();
      }, 250);
      return;
    }
    const d = describe(el0);
    if (window.__semCapture) window.__semCapture(d);
    return false;
  }, true);
  return 'ok';
})()
`;

let bindingReady = false;

async function ensureBinding(page: Page): Promise<void> {
  if (bindingReady) return;
  try {
    await page.exposeBinding('__semCapture', (_source, d) => {
      capture(d as { tag: string; text: string; cands: string[]; human?: string });
    });
    await page.exposeBinding('__semStop', async () => {
      active = false;
      log('info', 'CONTROL', 'Режим обучения остановлен со страницы (VNC)');
    });
  } catch {
    /* already registered on this context */
  }
  bindingReady = true;
}

export async function heartbeat(): Promise<void> {
  if (!active) return;
  try {
    const p = await getPage();
    const on = await p.evaluate('window.__semPickerOn===true').catch(() => false);
    if (!on) {
      await ensureBinding(p);
      await p.evaluate(INJECT).catch(() => {});
    }
  } catch {
    /* browser busy */
  }
}

export async function startPicker(url?: string): Promise<{ ok: boolean; url: string }> {
  const s = getAllSettings();
  const page = await getPage();
  await ensureBinding(page);
  await page.goto(url || s.listUrl || s.siteUrl || 'about:blank', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await inject(page);
  active = true;
  log('info', 'CONTROL', 'Режим обучения включён — нажимайте на элементы сайта в VNC');
  return { ok: true, url: page.url() };
}

async function inject(page: Page): Promise<void> {
  try {
    await page.evaluate(INJECT);
  } catch (e) {
    log('warn', 'SYSTEM', `Скрипт обучения не внедрился: ${String(e).slice(0, 80)}`);
  }
}

export async function reinject(): Promise<void> {
  const page = await getPage();
  await ensureBinding(page);
  await page.evaluate(INJECT).catch(() => {});
  active = true;
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
  await page.waitForTimeout(2500);
  await page.evaluate(INJECT).catch(() => {});
  let count = 0;
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      const box = await el.boundingBox({ timeout: 5000 });
      if (!box) continue;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y, { steps: 10 });
      await page.mouse.click(x, y);
      count += 1;
      await page.waitForTimeout(700);
    } catch {
      /* skip */
    }
  }
  active = true;
  log('info', 'CONTROL', `Демо-нажатия в режиме обучения: ${count} элемент(ов)`);
  return { ok: true, count };
}

export function capture(d: {
  tag: string;
  text: string;
  cands: string[];
  human?: string;
}): void {
  picks.push({
    index: picks.length,
    tag: d.tag,
    text: d.text,
    cands: d.cands,
    human: d.human,
    ts: new Date().toISOString(),
  });
  if (picks.length > 60) picks.shift();
}

export function list(): PickItem[] {
  return picks;
}

export function label(
  index: number,
  patch: { role?: string; chosen?: number }
): void {
  const p = picks[index];
  if (!p) return;
  if (patch.role !== undefined) p.label = patch.role;
  if (patch.chosen !== undefined) p.chosen = patch.chosen;
}

const ROLES = ['listRow', 'openLink', 'statusPending', 'statusAccepted', 'acceptButton'] as const;

const ACTS = ['click', 'check', 'accept', 'back', 'open', 'wait'] as const;

export function saveAsSteps(): { ok: boolean; count: number; steps: Step[] } {
  const labeled = picks.filter((p) => p.label && p.label !== 'ignore');
  const steps: Step[] = [];
  if (labeled.some((p) => (ACTS as readonly string[]).includes(p.label!))) {
    for (const p of labeled) {
      const act = (ACTS as readonly string[]).includes(p.label!)
        ? (p.label as Step['act'])
        : 'click';
      const chosen = p.cands[p.chosen ?? 0];
      const rest = p.cands.filter((c) => c !== chosen);
      steps.push({
        act,
        sel: [chosen, ...rest].filter(Boolean),
        note: (p.text || p.tag).slice(0, 40),
      });
    }
  }
  setSettingsPatch({ stepsJson: JSON.stringify(steps) });
  log('info', 'CONTROL', `Порядок действий сохранён из обучения: ${steps.length} шаг(ов)`);
  return { ok: true, count: steps.length, steps };
}

export function saveToSelectors(): { ok: boolean; json: string } {
  const currentRaw = String(getSetting('selectorsJson') || '').trim();
  let current: Record<string, string | string[]> = {};
  try {
    if (currentRaw) current = JSON.parse(currentRaw);
  } catch {
    /* fresh */
  }
  for (const role of ROLES) {
    const items = picks.filter((p) => p.label === role && p.cands.length > 0);
    if (items.length === 0) continue;
    const chosenList = items.map((p) => p.cands[p.chosen ?? 0]).filter(Boolean);
    const extra = items.flatMap((p) => p.cands.filter((c) => !chosenList.includes(c)));
    current[role] = [...new Set([...chosenList, ...extra])];
  }
  const json = JSON.stringify(current, null, 2);
  setSettingsPatch({ selectorsJson: json });
  log('info', 'CONTROL', `Результат обучения сохранён в селекторы (${Object.keys(current).length} эл.)`);
  return { ok: true, json };
}

export function stop(): { ok: boolean } {
  active = false;
  void getPage()
    .then((p) => p.evaluate('window.__semPickerOn = false; location.reload();'))
    .catch(() => {});
  log('info', 'CONTROL', 'Режим обучения остановлен');
  return { ok: true };
}

export function isActive(): boolean {
  return active;
}
