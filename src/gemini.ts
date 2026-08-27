import type { Page } from 'playwright';

export interface AiAction {
  act: 'click' | 'type' | 'key' | 'scroll' | 'goto' | 'back' | 'done' | 'fail';
  x?: number;
  y?: number;
  dy?: number;
  text?: string;
  key?: string;
  url?: string;
  why?: string;
}

const GEMINI_DEFAULT = 'https://generativelanguage.googleapis.com/v1beta';

function prompt(task: string, w: number, h: number, url: string, history: string[]): string {
  return [
    `Ты управляешь браузером по скриншоту. Размер экрана: ${w}x${h} пикселей.`,
    `Текущий адрес: ${url}`,
    `ЗАДАЧА: ${task}`,
    history.length ? `Уже сделано: ${history.slice(-8).join(' | ')}` : 'Действий ещё не было.',
    '',
    'Ответь ОДНИМ JSON-объектом — следующее действие:',
    '{"act":"click","x":число,"y":число,"why":"кратко"}',
    '{"act":"type","text":"...","why":"..."}  — сначала кликни по полю',
    '{"act":"key","key":"Enter","why":"..."}',
    '{"act":"scroll","dy":число,"why":"..."}',
    '{"act":"goto","url":"https://...","why":"..."}',
    '{"act":"back","why":"..."}',
    '{"act":"done","why":"..."}  — задача выполнена',
    '{"act":"fail","why":"..."} — выполнить невозможно',
    '',
    'Координаты бери точно по скриншоту. Только JSON, без пояснений вокруг.',
  ].join('\n');
}

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
  return {
    act: (p.act ?? 'fail') as AiAction['act'],
    x: Number(p.x ?? 0),
    y: Number(p.y ?? 0),
    dy: Number(p.dy ?? 350),
    text: p.text ? String(p.text).slice(0, 300) : undefined,
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

/** Один вызов модели: скриншот + задача → следующее действие. */
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
}): Promise<AiAction> {
  const base = normalizeBase(opts.baseUrl);
  const text = prompt(opts.task, opts.width, opts.height, opts.url, opts.history);
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

const RETRY_DELAYS_MS = [4000, 12000, 30000];

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
}): Promise<AiAction> {
  let last: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await decideOnce(opts);
    } catch (e) {
      last = e;
      if (!isTransient(e) || attempt === RETRY_DELAYS_MS.length) break;
      await new Promise((res) => setTimeout(res, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Проверка ключа и доступности модели. */
export async function testKey(opts: {
  key: string;
  model: string;
  baseUrl?: string;
}): Promise<{ ok: boolean; reason?: string; models?: number; modelFound?: boolean; model: string; base: string }> {
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
    return {
      ok: true,
      models: names.length,
      modelFound: names.some((n) => n.includes(opts.model)),
      model: opts.model,
      base,
    };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 140), model: opts.model, base };
  }
}

export interface AgentSessionResult {
  steps: number;
  done: boolean;
  lastWhy: string;
}

export async function runAgentSession(opts: {
  page: Page;
  key: string;
  model: string;
  baseUrl?: string;
  task: string;
  maxSteps?: number;
  onAction?: (a: AiAction, step: number) => Promise<void> | void;
}): Promise<AgentSessionResult> {
  const page = opts.page;
  const maxSteps = opts.maxSteps ?? 25;
  const history: string[] = [];
  let lastWhy = '';

  for (let step = 1; step <= maxSteps; step++) {
    const shot = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 20000 });
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    const a = await decide({
      key: opts.key,
      model: opts.model,
      baseUrl: opts.baseUrl,
      task: opts.task,
      history,
      shotJpeg: shot,
      width: vp.width,
      height: vp.height,
      url: page.url(),
    });
    lastWhy = a.why ?? a.act;
    history.push(`${a.act}(${lastWhy.slice(0, 60)})`);
    await (opts.onAction?.(a, step) ?? Promise.resolve());

    switch (a.act) {
      case 'click':
        if (!a.x || !a.y) throw new Error('Модель не дала координаты клика');
        await page.mouse.click(a.x, a.y);
        await page.waitForTimeout(950);
        break;
      case 'type':
        await page.keyboard.type(a.text ?? '', { delay: 35 });
        await page.waitForTimeout(300);
        break;
      case 'key':
        await page.keyboard.press((a.key ?? 'Enter').replace(/^Key/i, ''));
        await page.waitForTimeout(500);
        break;
      case 'scroll':
        await page.mouse.wheel(0, a.dy ?? 400);
        await page.waitForTimeout(400);
        break;
      case 'goto':
        if (a.url) await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(800);
        break;
      case 'back':
        await page.goBack().catch(() => {});
        await page.waitForTimeout(700);
        break;
      case 'done':
        return { steps: step, done: true, lastWhy };
      case 'fail':
        return { steps: step, done: false, lastWhy };
    }
  }
  return { steps: maxSteps, done: false, lastWhy: 'Достигнут лимит шагов' };
}
