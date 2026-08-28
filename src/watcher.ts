import type { Page } from 'playwright';
import type { Rule } from './rules.js';

/**
 * Күзетші (watcher) — беттің ӨЗ ІШІНДЕ жұмыс істейтін скрипт.
 *
 * Неге Node жағында емес: Node-тан клик жасау = CDP айналымы, 150–400 мс,
 * ал скриншот + модель = 3–8 секунд. Бос орын секундтың бөлігінде жоғалады,
 * сондықтан шешім де, клик те бет ішінде, бір JS тактында жасалуы керек.
 * Node тек нәтижені жинайды және журналға жазады.
 *
 * Бет ЖАҢАРТЫЛМАЙДЫ: сайт wizard-пен жүреді, reload барлық қадамды нөлге
 * қайтарады. Күзетші MutationObserver + rAF арқылы бар бетті бақылайды.
 */

export interface WatchHit {
  ts: number;
  /** Шарт табылған мәтін. */
  found: string;
  /** Басылған элементтің мәтіні. */
  clicked: string;
  /** Шарт табылғаннан кликке дейінгі уақыт, мс. */
  reactionMs: number;
  /** Растау қадамдарының қорытындысы. */
  confirmed: boolean;
  confirmNotes: string[];
  /** Толық аяқталуға кеткен уақыт. */
  totalMs: number;
}

export interface WatchState {
  armed: boolean;
  scans: number;
  lastScanAt: number;
  hits: WatchHit[];
  /** Күзетші тірі ме (бет жаңартылса қайта енеді). */
  alive: boolean;
}

const FLAG = '__semWatch';
/* Клик беттің навигациясын тудыруы мүмкін: сол кезде барлық JS-күй жоғалады.
 * Нәтижелерді sessionStorage-қа жазамыз — ол навигациядан кейін де тірі қалады,
 * сондықтан «ұстады, бірақ есеп жоқ» деген жағдай болмайды. */
const HITS_KEY = '__semWatchHits';

/** Бет ішінде орындалатын күзетші. Аргумент — сериялданған ереже. */
function watcherSource(): string {
  return `(cfg) => {
  const W = window['${FLAG}'];
  /* Қайта енгізілсе — ескісін тоқтатып, есепті сақтаймыз. */
  if (W && W.stop) { W.stop(); }

  const KEY = '${HITS_KEY}';
  const readHits = () => {
    try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { return []; }
  };
  const writeHit = (h) => {
    try {
      const all = readHits();
      all.push(h);
      while (all.length > 50) all.shift();
      sessionStorage.setItem(KEY, JSON.stringify(all));
    } catch { /* приватный режим — тогда только в памяти */ }
  };

  const state = {
    armed: true,
    scans: 0,
    lastScanAt: Date.now(),
    busy: false,
    /* Бір элементті екі рет баспау үшін. */
    done: new WeakSet(),
    doneKeys: new Set(),
    /* Клик жасалғаннан кейінгі қысқа тыныс: бір блоктың сыртқы және ішкі
     * элементтері екеуі де сәйкес келіп, түйме екі рет басылып қалмауы үшін. */
    cooldownUntil: 0,
  };

  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const low = (s) => norm(s).toLowerCase();
  const needle = low(cfg.watchText);

  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };

  const scopeRoots = () => {
    if (!cfg.watchScope) return [document.body];
    try {
      /* Селектор бірнеше бөліктен тұруы мүмкін («label, div, span»).
       * Бір ғана querySelector алсақ, беттің қалған бөлігі бақылаусыз қалады. */
      const list = [...document.querySelectorAll(cfg.watchScope)];
      return list.length ? list : [document.body];
    } catch {
      return [document.body];
    }
  };

  /** Мәтіні needle-ге сәйкес, ең кіші (жапырақ) элементті табу. */
  const findMatch = () => {
    for (const root of scopeRoots()) {
      if (!root) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node) {
        if (node.childElementCount <= 2) {
          const t = low(node.textContent);
          if (t && t.indexOf(needle) >= 0 && visible(node) && !state.done.has(node)) {
            return node;
          }
        }
        node = walker.nextNode();
      }
    }
    return null;
  };

  const CLICKABLE = 'button,a[href],input[type=submit],input[type=button],[role=button],[onclick]';

  /** Ережеге сай басылатын элементті табу. */
  const findTarget = (match) => {
    const wanted = low(cfg.clickText);
    const bySelector = (root) => {
      if (!cfg.clickSelector) return null;
      try {
        const list = [...root.querySelectorAll(cfg.clickSelector)].filter(visible);
        return list[0] || null;
      } catch { return null; }
    };
    const byText = (root) => {
      if (!wanted) return null;
      const list = [...root.querySelectorAll(CLICKABLE)].filter(
        (b) => visible(b) && low(b.textContent || b.value).indexOf(wanted) >= 0
      );
      return list[0] || null;
    };

    if (cfg.clickScope === 'self') return match;

    if (cfg.clickScope === 'row') {
      /* Жол (tr/li/карточка) ішінен іздеу: бос орын дәл сол жолда. */
      let row = match;
      for (let i = 0; i < 6 && row; i++) {
        if (/^(TR|LI)$/.test(row.tagName)) break;
        const r = row.getBoundingClientRect();
        if (r.width > 120 && r.height > 20 && row.querySelector(CLICKABLE)) break;
        row = row.parentElement;
      }
      const scope = row || match;
      return bySelector(scope) || byText(scope) ||
        (visible(scope.querySelector(CLICKABLE)) ? scope.querySelector(CLICKABLE) : null);
    }

    return bySelector(document) || byText(document);
  };

  /** Растау тізбегі: модаль, «Подтвердить» және т.б. */
  const runConfirm = async (notes) => {
    for (const step of (cfg.confirm || [])) {
      /* Жалпы кешігу (панельдегі «Пауза перед подтверждением») + қадам кешігуі. */
      const pre = Math.min(15000, (cfg.confirmDelayMs || 0) + (step.waitMs || 0));
      if (pre > 0) await new Promise((r) => setTimeout(r, pre));
      const deadline = Date.now() + Math.min(30000, step.timeoutMs || 6000);
      let el = null;
      while (Date.now() < deadline && !el) {
        if (step.selector) {
          try { el = [...document.querySelectorAll(step.selector)].filter(visible)[0] || null; }
          catch { el = null; }
        }
        if (!el && step.text) {
          const w = low(step.text);
          el = [...document.querySelectorAll(CLICKABLE)].filter(
            (b) => visible(b) && low(b.textContent || b.value).indexOf(w) >= 0
          )[0] || null;
        }
        if (!el) await new Promise((r) => setTimeout(r, 40));
      }
      if (!el) {
        notes.push((step.text || step.selector || '?') + ': не найдено' + (step.optional ? ' (пропущено)' : ''));
        if (step.optional) continue;
        return false;
      }
      el.click();
      notes.push('нажато: ' + norm(el.textContent || el.value).slice(0, 40));
    }
    return true;
  };

  const fire = async (match) => {
    if (state.busy) return;
    state.busy = true;
    const t0 = Date.now();
    try {
      const key = low(match.textContent).slice(0, 80) + '|' + Math.round(match.getBoundingClientRect().top);
      if (state.doneKeys.has(key)) { state.busy = false; return; }

      const target = findTarget(match);
      if (!target) {
        /* Мәтін табылды, бірақ басатын түйме жоқ — мұны үнсіз өткізіп жіберу
         * ең жаман нәрсе: оператор роботты «ұстамады» деп ойлайды. */
        state.done.add(match);
        state.doneKeys.add(key);
        writeHit({
          ts: t0,
          found: norm(match.textContent).slice(0, 80),
          clicked: '',
          reactionMs: Date.now() - t0,
          confirmed: false,
          confirmNotes: ['кнопка для нажатия не найдена — уточните правило'],
          totalMs: Date.now() - t0,
        });
        state.busy = false;
        return;
      }

      /* Клик — сол ілезде, ешқандай await-сыз. */
      target.click();
      const clickedAt = Date.now();
      state.done.add(match);
      state.doneKeys.add(key);
      /* Басылған түймені де белгілеп қоямыз: сол блоктың басқа элементі
       * сәйкес келсе, түйме екінші рет басылмайды. */
      state.done.add(target);
      state.cooldownUntil = clickedAt + 1500;

      /* Клик пен растау арасында бет ауысып кетуі мүмкін, сондықтан кликтің
       * өзін бірден жазып қоямыз, растау нәтижесін кейін толықтырамыз. */
      const base = {
        ts: t0,
        found: norm(match.textContent).slice(0, 80),
        clicked: norm(target.textContent || target.value).slice(0, 60),
        reactionMs: clickedAt - t0,
      };

      const notes = [];
      const confirmed = await runConfirm(notes);
      writeHit({
        ...base,
        confirmed,
        confirmNotes: notes,
        totalMs: Date.now() - t0,
      });
    } catch (e) {
      writeHit({
        ts: t0, found: 'ошибка', clicked: '', reactionMs: 0,
        confirmed: false, confirmNotes: [String(e).slice(0, 120)], totalMs: Date.now() - t0,
      });
    }
    state.busy = false;
  };

  const scan = () => {
    state.scans += 1;
    state.lastScanAt = Date.now();
    if (!state.armed || state.busy) return;
    if (Date.now() < state.cooldownUntil) return;
    const m = findMatch();
    if (m) void fire(m);
  };

  /* Екі тәуелсіз триггер: DOM өзгерісі (ілезде) және таймер (резерв). */
  const obs = new MutationObserver(() => scan());
  obs.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'style', 'disabled', 'hidden'],
  });
  const timer = setInterval(scan, Math.max(50, Math.min(2000, cfg.pollMs || 150)));

  window['${FLAG}'] = {
    state,
    cfg,
    stop() { try { obs.disconnect(); } catch {} clearInterval(timer); state.armed = false; },
    disarm() { state.armed = false; },
    arm() { state.armed = true; },
    pending() { return readHits().length; },
    take() {
      const h = readHits();
      try { sessionStorage.setItem(KEY, '[]'); } catch { /* ignore */ }
      return { armed: state.armed, scans: state.scans, lastScanAt: state.lastScanAt, hits: h };
    },
  };
  scan();
  return true;
}`;
}

interface WatcherCfg {
  watchText: string;
  watchScope: string;
  clickText: string;
  clickSelector: string;
  clickScope: string;
  confirm: unknown[];
  pollMs: number;
  confirmDelayMs: number;
}

function cfgOf(rule: Rule, pollMs: number, confirmDelayMs: number): WatcherCfg {
  return {
    watchText: rule.watchText,
    watchScope: rule.watchScope,
    clickText: rule.clickText,
    clickSelector: rule.clickSelector,
    clickScope: rule.clickScope,
    confirm: rule.confirm,
    pollMs,
    confirmDelayMs,
  };
}

/**
 * Күзетшіні енгізу. `addInitScript` арқасында бет өзі жаңарса да (сайт кейде
 * ajax-навигация жасайды) күзетші қайта тіріледі — бірақ біз reload жасамаймыз.
 */
export async function installWatcher(
  page: Page,
  rule: Rule,
  pollMs: number,
  confirmDelayMs = 0
): Promise<{ ok: boolean; error?: string }> {
  const cfg = cfgOf(rule, pollMs, confirmDelayMs);
  const src = watcherSource();
  /* Навигациядан кейін автоматты қайта енуі үшін. */
  await page.addInitScript({ content: `(${src})(${JSON.stringify(cfg)});` }).catch(() => {});
  try {
    /* Аргументті қоса беру: Playwright жол-өрнекті функция деп танып шақырады.
     * Қате болса — үнсіз жоғалтпаймыз, әйтпесе күзетші жоқ екені білінбейді. */
    await page.evaluate(`(${src})(${JSON.stringify(cfg)})`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Күзетші тірі ме, әрі жоқ болса қайта енгізу. */
export async function ensureWatcher(
  page: Page,
  rule: Rule,
  pollMs: number,
  confirmDelayMs = 0
): Promise<{ alive: boolean; installed: boolean; error?: string }> {
  const alive = await page
    .evaluate(`Boolean(window['${FLAG}'] && window['${FLAG}'].state.armed)`)
    .catch(() => false);
  if (alive === true) return { alive: true, installed: false };
  const r = await installWatcher(page, rule, pollMs, confirmDelayMs);
  return { alive: r.ok, installed: true, error: r.error };
}

/** Жинақталған нәтижелерді алу (буферді тазалайды). */
export async function takeHits(page: Page): Promise<{
  armed: boolean;
  scans: number;
  lastScanAt: number;
  hits: WatchHit[];
} | null> {
  try {
    /* Күзетші өлген болса да (навигация) есеп sessionStorage-та қалады —
     * сондықтан оны тікелей оқып, содан кейін тазалаймыз. */
    return (await page.evaluate(
      `(() => {
        const W = window['${FLAG}'];
        if (W) return W.take();
        let hits = [];
        try { hits = JSON.parse(sessionStorage.getItem('${HITS_KEY}') || '[]'); } catch {}
        try { sessionStorage.setItem('${HITS_KEY}', '[]'); } catch {}
        return { armed: false, scans: 0, lastScanAt: 0, hits };
      })()`
    )) as { armed: boolean; scans: number; lastScanAt: number; hits: WatchHit[] };
  } catch {
    return null;
  }
}

export async function stopWatcher(page: Page): Promise<void> {
  await page
    .evaluate(`if (window['${FLAG}']) window['${FLAG}'].stop();`)
    .catch(() => {});
}
