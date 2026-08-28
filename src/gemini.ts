import type { Page } from 'playwright';
import { collectDom, renderDom, refSelector, type DomElement } from './dom.js';

export interface AiAction {
  act:
    | 'click'
    | 'fill'
    | 'select'
    | 'check'
    | 'type'
    | 'key'
    | 'scroll'
    | 'goto'
    | 'back'
    | 'wait'
    | 'done'
    | 'fail';
  ref?: number;
  x?: number;
  y?: number;
  dy?: number;
  text?: string;
  key?: string;
  url?: string;
  sec?: number;
  why?: string;
}

const GEMINI_DEFAULT = 'https://generativelanguage.googleapis.com/v1beta';

function prompt(
  task: string,
  w: number,
  h: number,
  url: string,
  history: string[],
  domText: string
): string {
  return [
    `Ты управляешь браузером. Видимая область: ${w}x${h} пикселей (координата y больше ${h} НЕ существует).`,
    `Текущий адрес: ${url}`,
    `ЗАДАЧА: ${task}`,
    '',
    'ЭЛЕМЕНТЫ СТРАНИЦЫ (нумерованный список, бери ref отсюда):',
    domText,
    '',
    history.length ? `История: ${history.slice(-10).join(' | ')}` : 'Действий ещё не было.',
    '',
    'Ответь ОДНИМ JSON-объектом — следующее действие:',
    '{"act":"click","ref":12,"why":"кратко"}      — нажать элемент по номеру (предпочтительно)',
    '{"act":"click","x":100,"y":200,"why":"..."}   — только если нужного элемента нет в списке',
    '{"act":"fill","ref":5,"text":"...","why":"..."}   — очистить поле и вписать текст',
    '{"act":"select","ref":7,"text":"Вариант","why":"..."} — выбрать пункт в select',
    '{"act":"check","ref":9,"why":"..."}          — включить checkbox/radio (для скрытых input надёжнее click)',
    '{"act":"type","text":"...","why":"..."}      — печатать в уже активное поле',
    '{"act":"key","key":"Enter","why":"..."}',
    '{"act":"scroll","dy":400,"why":"..."}        — + вниз, − вверх',
    '{"act":"wait","sec":3,"why":"..."}           — подождать загрузку',
    '{"act":"goto","url":"https://...","why":"..."}',
    '{"act":"back","why":"..."}',
    '{"act":"done","why":"..."}                   — задача выполнена',
    '{"act":"fail","why":"..."}                   — выполнить невозможно',
    '',
    'ПРАВИЛА:',
    '- Элемент с пометкой НЕАКТИВЕН нажимать бесполезно: сначала выполни условие (выбери опцию, заполни поле).',
    '- Если элемент уже ВЫБРАН, второй раз его не трогай.',
    '- Если история говорит, что действие не сработало, НЕ повторяй его — попробуй другой ref, прокрутку или fail.',
    '- Только JSON, без пояснений вокруг.',
  ].join('\n');
}

const ACTS = new Set([
  'click', 'fill', 'select', 'check', 'type', 'key',
  'scroll', 'goto', 'back', 'wait', 'done', 'fail',
]);

function parseAction(raw: string): AiAction {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const jsonStart = cleaned.indexOf('{');
  const body = jsonStart >= 0 ? cleaned.slice(jsonStart, cleaned.lastIndexOf('}') + 1) : cleaned;
  let p: Partial<AiAction>;
  try {
    p = JSON.parse(body) as Partial<AiAction>;
  } catch {
    throw new Error(`Модель вернула не JSON: ${cleaned.slice(0, 120)}`);
  }
  const act = String(p.act ?? 'fail');
  const ref = Number(p.ref);
  return {
    act: (ACTS.has(act) ? act : 'fail') as AiAction['act'],
    ref: Number.isFinite(ref) && ref > 0 ? ref : undefined,
    x: Number.isFinite(Number(p.x)) ? Number(p.x) : undefined,
    y: Number.isFinite(Number(p.y)) ? Number(p.y) : undefined,
    dy: Number.isFinite(Number(p.dy)) ? Number(p.dy) : 350,
    sec: Number.isFinite(Number(p.sec)) ? Math.min(30, Math.max(1, Number(p.sec))) : undefined,
    text: p.text != null ? String(p.text).slice(0, 300) : undefined,
    key: p.key ? String(p.key).slice(0, 20) : undefined,
    url: p.url ? String(p.url).slice(0, 300) : undefined,
    why: p.why ? String(p.why).slice(0, 160) : undefined,
  };
}

export function normalizeBase(base?: string): string {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return GEMINI_DEFAULT;
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  /* Пользователь мог вставить полный путь — приводим к базовому. */
  b = b.replace(/\/(chat\/completions|models(\/.*)?)$/i, '');
  if (/generativelanguage\.googleapis\.com$/i.test(b)) b += '/v1beta';
  if (/^https:\/\/api\.openai\.com$/i.test(b)) b += '/v1';
  if (/^https:\/\/openrouter\.ai$/i.test(b)) b += '/api/v1';
  return b.replace(/\/+$/, '');
}

export function isGeminiApi(base?: string): boolean {
  return normalizeBase(base).includes('generativelanguage');
}

/** Один вызов модели: скриншот + список элементов + задача → следующее действие. */
async function decideOnce(opts: {
  key: string;
  model: string;
  baseUrl?: string;
  task: string;
  history: string[];
  shotJpeg: Buffer;
  width: number;
  height: number;
  url: string;
  domText: string;
}): Promise<AiAction> {
  const base = normalizeBase(opts.baseUrl);
  const text = prompt(opts.task, opts.width, opts.height, opts.url, opts.history, opts.domText);
  const b64 = opts.shotJpeg.toString('base64');

  if (isGeminiApi(base)) {
    const r = await fetch(
      `${base}/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] },
          ],
          /* Лимит большой, а «размышления» отключены: у 2.5+/3.x модели
           * thinking-токены съедали весь бюджет и ответ обрывался на середине
           * JSON (finishReason=MAX_TOKENS, пустой content). */
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.timeout(70000),
      }
    );
    if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
    const j = (await r.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const cand = j.candidates?.[0];
    const raw = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!raw.trim()) {
      throw new Error(`Модель не вернула текст (finishReason=${cand?.finishReason ?? 'нет'})`);
    }
    return parseAction(raw);
  }

  /* OpenAI-совместимый эндпоинт (OpenRouter, vLLM, LM Studio, прокси и т.д.) */
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key}` },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.2,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(70000),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return parseAction(j.choices?.[0]?.message?.content ?? '');
}

/** Перегрузка модели и обрыв связи — не ошибка задачи, а повод подождать. */
function isTransient(e: unknown): boolean {
  const s = String(e);
  return (
    /API (429|500|502|503|504)/.test(s) ||
    /aborted due to timeout/i.test(s) ||
    /fetch failed|ECONNRESET|ETIMEDOUT/i.test(s) ||
    /не вернула текст|вернула не JSON/i.test(s)
  );
}

/** Дневная квота модели исчерпана — ждать бессмысленно, нужна другая модель. */
function isQuotaExhausted(e: unknown): boolean {
  const s = String(e);
  return /API 429/.test(s) && /exceeded your current quota|RESOURCE_EXHAUSTED|PerDay/i.test(s);
}

/** Модель отсутствует или закрыта для новых проектов. */
function isModelUnavailable(e: unknown): boolean {
  const s = String(e);
  return /API 404/.test(s) || /no longer available|is not found/i.test(s);
}

const RETRY_DELAYS_MS = [4000, 12000, 30000];

/** Резервные модели на случай исчерпанной квоты — из env или разумный список. */
const FALLBACK_MODELS = (
  process.env.AI_FALLBACK_MODELS ??
  'gemini-2.5-flash,gemini-2.0-flash,gemini-2.5-flash-lite,gemini-flash-latest'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Модель → до какого времени её не трогаем (исчерпана квота / нет доступа). */
const modelCooldown = new Map<string, number>();
const COOLDOWN_MS = 30 * 60 * 1000;

function usableModels(primary: string): string[] {
  const now = Date.now();
  const all = [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];
  const free = all.filter((m) => (modelCooldown.get(m) ?? 0) <= now);
  return free.length ? free : all;
}

export async function decide(opts: {
  key: string;
  model: string;
  baseUrl?: string;
  task: string;
  history: string[];
  shotJpeg: Buffer;
  width: number;
  height: number;
  url: string;
  domText: string;
}): Promise<AiAction> {
  const models = isGeminiApi(opts.baseUrl) ? usableModels(opts.model) : [opts.model];
  let last: unknown;

  for (const model of models) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await decideOnce({ ...opts, model });
      } catch (e) {
        last = e;
        if (isQuotaExhausted(e) || isModelUnavailable(e)) {
          modelCooldown.set(model, Date.now() + COOLDOWN_MS);
          break; /* следующая модель */
        }
        if (!isTransient(e) || attempt === RETRY_DELAYS_MS.length) return Promise.reject(e);
        await new Promise((res) => setTimeout(res, RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Проверка ключа и доступности модели. */
export async function testKey(opts: {
  key: string;
  model: string;
  baseUrl?: string;
}): Promise<{
  ok: boolean;
  reason?: string;
  models?: number;
  modelFound?: boolean;
  model: string;
  base: string;
  quotaOk?: boolean;
  quotaNote?: string;
}> {
  const base = normalizeBase(opts.baseUrl);
  try {
    const url = isGeminiApi(base)
      ? `${base}/models?key=${encodeURIComponent(opts.key)}`
      : `${base}/models`;
    const r = await fetch(url, {
      headers: isGeminiApi(base) ? {} : { authorization: `Bearer ${opts.key}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const hint =
        r.status === 404
          ? 'проверьте Base URL (для Gemini оставьте пустым)'
          : r.status === 401 || r.status === 403
            ? 'ключ отклонён'
            : '';
      return {
        ok: false,
        reason: `Сервер ответил ${r.status}${hint ? ' — ' + hint : ''} · ${base}`,
        model: opts.model,
        base,
      };
    }
    const j = (await r.json()) as { models?: { name?: string }[]; data?: { id?: string }[] };
    const names = (j.models ?? [])
      .map((m) => String(m.name))
      .concat((j.data ?? []).map((m) => String(m.id)));

    /* Список моделей отдаётся даже при исчерпанной квоте, поэтому отдельно
     * делаем один минимальный запрос генерации: именно он показывает, сможет
     * ли агент работать прямо сейчас. */
    const q = await probeQuota(base, opts.key, opts.model);

    return {
      ok: true,
      models: names.length,
      modelFound: names.some((n) => n.includes(opts.model)),
      model: opts.model,
      base,
      quotaOk: q.ok,
      quotaNote: q.note,
    };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 140), model: opts.model, base };
  }
}

/** Один дешёвый запрос генерации: проверяем не ключ, а остаток квоты. */
async function probeQuota(
  base: string,
  key: string,
  model: string
): Promise<{ ok: boolean; note: string }> {
  try {
    const body = isGeminiApi(base)
      ? JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 8, thinkingConfig: { thinkingBudget: 0 } },
        })
      : JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] });
    const url = isGeminiApi(base)
      ? `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`
      : `${base}/chat/completions`;
    const r = await fetch(url, {
      method: 'POST',
      headers: isGeminiApi(base)
        ? { 'content-type': 'application/json' }
        : { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(25000),
    });
    if (r.ok) return { ok: true, note: 'модель отвечает, квота есть' };
    const text = (await r.text().catch(() => '')).slice(0, 200);
    if (r.status === 429) {
      return {
        ok: false,
        note: 'дневная квота исчерпана — подключите биллинг в Google AI Studio, смените модель или укажите другого провайдера',
      };
    }
    if (r.status === 404) {
      return { ok: false, note: `модель «${model}» недоступна для этого ключа — выберите другую` };
    }
    return { ok: false, note: `модель ответила ${r.status}: ${text}` };
  } catch (e) {
    return { ok: false, note: `не удалось проверить: ${String(e).slice(0, 90)}` };
  }
}

/** Список доступных моделей для ключа. */
export async function listModels(opts: {
  key: string;
  baseUrl?: string;
}): Promise<{ ok: boolean; models?: string[]; reason?: string; base: string }> {
  const base = normalizeBase(opts.baseUrl);
  try {
    const url = isGeminiApi(base)
      ? `${base}/models?key=${encodeURIComponent(opts.key)}`
      : `${base}/models`;
    const r = await fetch(url, {
      headers: isGeminiApi(base) ? {} : { authorization: `Bearer ${opts.key}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      return {
        ok: false,
        reason: `Сервер ответил ${r.status}`,
        base,
      };
    }
    const j = (await r.json()) as { models?: { name?: string }[]; data?: { id?: string }[] };
    const names = (j.models ?? [])
      .map((m) => String(m.name).replace(/^models\//, ''))
      .concat((j.data ?? []).map((m) => String(m.id)));
    return {
      ok: true,
      models: names,
      base,
    };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 140), base };
  }
}

export interface AgentSessionResult {
  steps: number;
  done: boolean;
  lastWhy: string;
}

/** Оператор «СТОП» басқанда цикл келесі қадамға өтпей тоқтайды. */
export class AgentAborted extends Error {
  constructor() {
    super('Остановлено оператором');
  }
}

interface ActOutcome {
  note: string;
  ok: boolean;
}

/** Беттің «қолтаңбасы»: әрекет нәтиже бердi ме, соны осымен тексереміз. */
async function pageSignature(page: Page): Promise<string> {
  try {
    return (await page.evaluate(
      `(() => {
        const b = document.body;
        return [
          location.href,
          document.title,
          b ? b.innerText.length : 0,
          document.querySelectorAll('*').length,
          Math.round(window.scrollY),
          [...document.querySelectorAll('input:checked')].map((i) => i.id || i.name).join(','),
          (document.querySelector('.modal.show, [role=dialog]:not([aria-hidden=true])') ? 'modal' : ''),
        ].join('|');
      })()`
    )) as string;
  } catch {
    return String(Date.now());
  }
}

export async function runAgentSession(opts: {
  page: Page;
  key: string;
  model: string;
  baseUrl?: string;
  task: string;
  maxSteps?: number;
  /** Әрекеттер арасындағы негізгі пауза (ms). Панельдегі «Пауза между действиями». */
  actionDelayMs?: number;
  /** Жылдамдық көбейткіші: 0.25 — жылдам, 3 — баяу. */
  speed?: number;
  /** false қайтарса — цикл дереу тоқтайды. */
  shouldContinue?: () => boolean;
  onAction?: (a: AiAction, step: number) => Promise<void> | void;
}): Promise<AgentSessionResult> {
  const page = opts.page;
  const maxSteps = opts.maxSteps ?? 25;
  const speed = Math.min(3, Math.max(0.1, Number(opts.speed) || 1));
  const baseDelay = Math.min(10000, Math.max(50, Number(opts.actionDelayMs) || 800));
  /* Барлық күту осы көбейткішке бағынады, сондықтан «Скорость» шынымен әсер етеді. */
  const pace = (ms: number): number => Math.round(ms * speed);

  const history: string[] = [];
  let lastWhy = '';
  let noProgress = 0;
  const tried = new Set<string>();

  const alive = (): void => {
    if (opts.shouldContinue && !opts.shouldContinue()) throw new AgentAborted();
  };
  /** Тоқтату сигналын елемей ұзақ ұйықтамау үшін ұсақ бөліктермен күтеміз. */
  const nap = async (ms: number): Promise<void> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      alive();
      await page.waitForTimeout(Math.min(250, until - Date.now()));
    }
  };

  for (let step = 1; step <= maxSteps; step++) {
    alive();

    const dom = await collectDom(page);
    const shot = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 20000 });
    const vp = page.viewportSize() ?? { width: 1280, height: 760 };
    const urlBefore = page.url();
    const sigBefore = await pageSignature(page);

    alive();
    const a = await decide({
      key: opts.key,
      model: opts.model,
      baseUrl: opts.baseUrl,
      task: opts.task,
      history,
      shotJpeg: shot,
      width: vp.width,
      height: vp.height,
      url: urlBefore,
      domText: renderDom(dom),
    });
    alive();

    lastWhy = a.why ?? a.act;
    await (opts.onAction?.(a, step) ?? Promise.resolve());

    if (a.act === 'done') return { steps: step, done: true, lastWhy };
    if (a.act === 'fail') return { steps: step, done: false, lastWhy };

    const out = await perform(page, a, dom, vp, nap, pace(baseDelay));
    history.push(`${step}. ${a.act}${a.ref ? `[${a.ref}]` : ''}: ${out.note}`);

    /* Бір әрекетті қайталап басу — прогресс емес. Дәл сол әрекет екінші рет
     * келсе, модельге бұл жұмыс істемегенін ашық айтамыз. */
    const key = `${a.act}:${a.ref ?? ''}:${a.x ?? ''},${a.y ?? ''}:${a.text ?? ''}`;
    const sigAfter = await pageSignature(page);
    const changed = sigAfter !== sigBefore;

    if (!changed) {
      noProgress += 1;
      const repeated = tried.has(key);
      history.push(
        repeated
          ? `⛔ Действие ${key} УЖЕ выполнялось и страница снова не изменилась. Оно не работает — выбери другой элемент, прокрути страницу или верни fail.`
          : '⚠️ Страница не изменилась после этого действия.'
      );
      if (noProgress >= 5) {
        return {
          steps: step,
          done: false,
          lastWhy: `Страница не меняется ${noProgress} шагов подряд — задача остановлена, чтобы не тратить запросы`,
        };
      }
    } else {
      noProgress = 0;
    }
    tried.add(key);
  }
  return { steps: maxSteps, done: false, lastWhy: 'Достигнут лимит шагов' };
}

/** Бір әрекетті орындау. Нәтижесі модельге келесі қадамда мәтін болып барады. */
export async function perform(
  page: Page,
  a: AiAction,
  dom: DomElement[],
  vp: { width: number; height: number },
  nap: (ms: number) => Promise<void>,
  delayMs: number
): Promise<ActOutcome> {
  const byRef = (ref?: number): DomElement | undefined =>
    ref == null ? undefined : dom.find((d) => d.ref === ref);

  const settle = async (): Promise<void> => {
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await nap(delayMs);
  };

  switch (a.act) {
    case 'click': {
      const el = byRef(a.ref);
      if (el) {
        if (el.disabled) {
          return { ok: false, note: `элемент [${a.ref}] "${el.text}" НЕАКТИВЕН, клик пропущен` };
        }
        const loc = page.locator(refSelector(el.ref)).first();
        try {
          /* force: көрнекі карточка астында жатқан нақты input үшін керек. */
          await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await loc.click({ timeout: 6000 });
        } catch {
          try {
            await loc.dispatchEvent('click', { timeout: 4000 });
          } catch {
            return { ok: false, note: `не удалось нажать [${a.ref}] "${el.text}"` };
          }
        }
        await settle();
        return { ok: true, note: `нажал [${a.ref}] "${el.text}"` };
      }
      /* ref жоқ — координат бойынша, бірақ viewport ішінде ғана. */
      const x = Number(a.x);
      const y = Number(a.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, note: 'ни ref, ни координаты не заданы — клик пропущен' };
      }
      if (x < 0 || y < 0 || x > vp.width || y > vp.height) {
        return {
          ok: false,
          note: `координаты (${x},${y}) вне экрана ${vp.width}x${vp.height} — клик невозможен, прокрути страницу или используй ref`,
        };
      }
      await page.mouse.click(x, y);
      await settle();
      return { ok: true, note: `клик по координатам (${x},${y})` };
    }

    case 'fill': {
      const el = byRef(a.ref);
      if (!el) return { ok: false, note: 'для fill нужен ref из списка элементов' };
      try {
        await page.locator(refSelector(el.ref)).first().fill(a.text ?? '', { timeout: 6000 });
      } catch {
        return { ok: false, note: `не удалось заполнить [${a.ref}] "${el.text}"` };
      }
      await nap(delayMs);
      return { ok: true, note: `заполнил [${a.ref}] "${el.text}" = "${(a.text ?? '').slice(0, 40)}"` };
    }

    case 'select': {
      const el = byRef(a.ref);
      if (!el) return { ok: false, note: 'для select нужен ref' };
      const loc = page.locator(refSelector(el.ref)).first();
      try {
        await loc.selectOption({ label: a.text ?? '' }, { timeout: 5000 });
      } catch {
        try {
          await loc.selectOption(a.text ?? '', { timeout: 5000 });
        } catch {
          return { ok: false, note: `вариант "${a.text}" не найден в [${a.ref}]` };
        }
      }
      await settle();
      return { ok: true, note: `выбрал "${a.text}" в [${a.ref}]` };
    }

    case 'check': {
      const el = byRef(a.ref);
      if (!el) return { ok: false, note: 'для check нужен ref' };
      const loc = page.locator(refSelector(el.ref)).first();
      try {
        await loc.check({ timeout: 5000, force: true });
      } catch {
        try {
          await loc.dispatchEvent('click', { timeout: 4000 });
        } catch {
          return { ok: false, note: `не удалось включить [${a.ref}] "${el.text}"` };
        }
      }
      await settle();
      return { ok: true, note: `включил [${a.ref}] "${el.text}"` };
    }

    case 'type':
      await page.keyboard.type(a.text ?? '', { delay: 30 });
      await nap(Math.min(delayMs, 600));
      return { ok: true, note: `напечатал "${(a.text ?? '').slice(0, 40)}"` };

    case 'key':
      await page.keyboard.press((a.key ?? 'Enter').replace(/^Key/i, ''));
      await settle();
      return { ok: true, note: `нажал клавишу ${a.key ?? 'Enter'}` };

    case 'scroll': {
      const dy = Number(a.dy) || 400;
      await page.mouse.wheel(0, dy);
      await nap(Math.min(delayMs, 600));
      return { ok: true, note: `прокрутил на ${dy}` };
    }

    case 'wait':
      await nap((a.sec ?? 3) * 1000);
      return { ok: true, note: `подождал ${a.sec ?? 3} с` };

    case 'goto': {
      if (!a.url) return { ok: false, note: 'goto без url' };
      try {
        await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {
        return { ok: false, note: `не удалось открыть ${a.url}` };
      }
      await nap(delayMs);
      return { ok: true, note: `перешёл на ${a.url}` };
    }

    case 'back':
      await page.goBack().catch(() => {});
      await settle();
      return { ok: true, note: 'вернулся назад' };

    default:
      return { ok: false, note: `действие ${a.act} не поддержано` };
  }
}
