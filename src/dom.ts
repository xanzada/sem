import type { Page } from 'playwright';

/**
 * Беттегі интерактив элементтердің нөмірленген тізімі.
 *
 * Модель тек скриншот бойынша координат берген кезде екі мәселе шығады:
 * 1) координат viewport-тан шығып кетеді (мыс. y=805, ал биіктік 760) — клик
 *    ешқайда түспейді, бет өзгермейді, модель дәл сол әрекетті қайталайды;
 * 2) checkbox/radio көрнекі карточканың астында жасырын жатады — «карточканы»
 *    басу нақты input-ты өзгертпейді.
 * Сондықтан модельге әр қадамда DOM-нан алынған нақты элементтер тізімін
 * `ref` нөмірімен береміз, ал клик соңында Playwright locator арқылы жасалады.
 */
export interface DomElement {
  ref: number;
  tag: string;
  type: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  disabled: boolean;
  checked: boolean | null;
  value: string;
  options: string[];
  /** Элемент көрінетін аймақта ма. false болса ref арқылы басу керек (өзі скроллдайды). */
  inView: boolean;
}

const REF_ATTR = 'data-sem-ref';

const COLLECT = `(() => {
  const ATTR = 'data-sem-ref';
  document.querySelectorAll('[' + ATTR + ']').forEach((el) => el.removeAttribute(ATTR));

  const SEL = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=tab]', '[role=checkbox]',
    '[role=radio]', '[role=option]', '[role=menuitem]', '[role=switch]',
    '[onclick]', '[contenteditable=true]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const viewArea = vw * vh;
  const out = [];
  const seen = new Set();

  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();

  const label = (el) => {
    const own = clean(el.getAttribute('aria-label') || el.getAttribute('title'));
    if (own) return own.slice(0, 110);
    let t = clean(el.innerText || el.textContent);
    if (!t && el.id) {
      const lb = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lb) t = clean(lb.innerText);
    }
    if (!t) {
      const wrap = el.closest('label');
      if (wrap) t = clean(wrap.innerText);
    }
    if (!t) t = clean(el.placeholder || el.value || el.name);
    /* Стильденген checkbox-тың өз мәтіні жоқ — көрнекі карточкадан аламыз. */
    if (!t) {
      let p = el.parentElement;
      for (let i = 0; i < 3 && p && !t; i++) { t = clean(p.innerText); p = p.parentElement; }
    }
    /* Онclick-тегі JS коды мәтін ретінде пайдасыз. */
    if (/[{};]|function|document\\./.test(t) && t.length > 60) t = '';
    return t.slice(0, 110);
  };

  /** display:none/0x0 элемент үшін өлшемі бар, тым үлкен емес ата-элемент. */
  const sizedHost = (el) => {
    let p = el.closest('label') || el.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      const r = p.getBoundingClientRect();
      if (r.width >= 6 && r.height >= 6 && r.width * r.height < viewArea * 0.5) return r;
      p = p.parentElement;
    }
    return null;
  };

  const push = (el, r, proxied, forcedType) => {
    const cs = getComputedStyle(el);
    const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    const text = label(el);
    const type = forcedType || clean(el.getAttribute('type') || el.getAttribute('role')).toLowerCase();
    /* Мәтіні де, түрі де жоқ элемент модельге пайдасыз. */
    if (!text && !type) return;
    /* Дубль: бір орында бір мәтінмен бірнеше элемент (dropdown көшірмелері). */
    const dupKey = text + '|' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width);
    if (seen.has(dupKey)) return;
    seen.add(dupKey);

    const opts = el.tagName === 'SELECT'
      ? [...el.options].map((o) => clean(o.textContent).slice(0, 40)).slice(0, 25)
      : [];
    out.push({
      el,
      ref: 0,
      tag: el.tagName.toLowerCase() + (proxied ? '*' : ''),
      type,
      text,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true' || cs.pointerEvents === 'none',
      checked: typeof el.checked === 'boolean' ? el.checked : null,
      value: clean(el.value).slice(0, 60),
      options: opts,
      inView,
    });
  };

  const candidates = new Set(document.querySelectorAll(SEL));

  /* Стильденген карточка/тумблер: түпнұсқа input display:none болғанда сайт
   * көрнекі \`div\`-ті басады. Ондай элементтерді cursor:pointer арқылы табамыз. */
  for (const el of document.querySelectorAll('div,span,li,td,label,section')) {
    if (candidates.has(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.cursor !== 'pointer' || cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (r.width * r.height > viewArea * 0.4) continue;
    /* Ішінде тағы басылатын элемент болса — ата-элементті алмаймыз. */
    if (el.querySelector('a,button,input,select,textarea,[role=button]')) continue;
    candidates.add(el);
  }

  for (const el of candidates) {
    if (out.length >= 160) break;
    const cs = getComputedStyle(el);
    const t = clean(el.getAttribute('type')).toLowerCase();
    const isToggle = t === 'checkbox' || t === 'radio';
    const hidden = cs.display === 'none' || cs.visibility === 'hidden';

    /* Стильденген checkbox/radio әдейі жасырылады, бірақ жұмыс істейді:
     * оны тастауға болмайды — тек көрнекі «денесін» табамыз. */
    if (hidden && !isToggle) continue;

    let r = el.getBoundingClientRect();
    let proxied = false;
    if (hidden || r.width < 2 || r.height < 2) {
      const host = sizedHost(el);
      if (!host) continue;
      r = host;
      proxied = true;
    }
    if (r.width * r.height > viewArea * 0.5) continue;
    push(el, r, proxied, isToggle ? t : '');
  }

  /* Жоғарыдан төменге қарай нөмірлеу — модельге оқу ыңғайлы, әрі ref
   * атрибуты нақты осы тәртіппен қойылады. */
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out.map((e, i) => {
    const ref = i + 1;
    e.el.setAttribute(ATTR, String(ref));
    return {
      ref, tag: e.tag, type: e.type, text: e.text,
      x: e.x, y: e.y, w: e.w, h: e.h,
      disabled: e.disabled, checked: e.checked,
      value: e.value, options: e.options, inView: e.inView,
    };
  });
})()`;

export async function collectDom(page: Page): Promise<DomElement[]> {
  try {
    return (await page.evaluate(COLLECT)) as DomElement[];
  } catch {
    return [];
  }
}

/** Модельге берілетін ықшам мәтіндік тізім. */
export function renderDom(els: DomElement[]): string {
  if (els.length === 0) return '(интерактивных элементов не найдено)';
  return els
    .map((e) => {
      const flags = [
        e.disabled ? 'НЕАКТИВЕН' : '',
        e.inView ? '' : 'ВНЕ ЭКРАНА (жми по ref — прокрутка сама)',
        e.checked === true ? 'ВЫБРАН' : e.checked === false ? 'не выбран' : '',
        e.value ? `значение="${e.value}"` : '',
        e.options.length ? `варианты: ${e.options.join(' / ')}` : '',
      ].filter(Boolean);
      const kind = e.type ? `${e.tag}:${e.type}` : e.tag;
      return `[${e.ref}] ${kind} (${e.x},${e.y}) "${e.text}"${flags.length ? ' — ' + flags.join(', ') : ''}`;
    })
    .join('\n');
}

export function refSelector(ref: number): string {
  return `[${REF_ATTR}="${ref}"]`;
}
