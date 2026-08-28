/**
 * Доступ к модели. Используется РОВНО в двух местах:
 *   1) src/learn.ts — один запрос, чтобы выучить правило;
 *   2) панель «Проверить ключ» — диагностика ключа и остатка квоты.
 *
 * В горячем пути (поимка слота) модель не участвует: один запрос занимает
 * 3–8 секунд, а свободное место исчезает за доли секунды. Работу выполняет
 * наблюдатель внутри страницы (src/watcher.ts).
 */

const GEMINI_DEFAULT = 'https://generativelanguage.googleapis.com/v1beta';

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

/** Один запрос: текст (+ необязательный скриншот) → сырой ответ модели. */
export async function askVision(opts: {
  key: string;
  model: string;
  baseUrl?: string;
  prompt: string;
  shotJpeg?: Buffer;
  maxTokens?: number;
}): Promise<string> {
  const base = normalizeBase(opts.baseUrl);
  const b64 = opts.shotJpeg?.toString('base64');
  const maxTokens = opts.maxTokens ?? 2048;

  if (isGeminiApi(base)) {
    const parts: Record<string, unknown>[] = [{ text: opts.prompt }];
    if (b64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
    const r = await fetch(
      `${base}/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          /* thinkingBudget:0 — иначе у 2.5+/3.x «размышления» съедают весь
           * бюджет и ответ обрывается на середине JSON. */
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.timeout(90000),
      }
    );
    if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const j = (await r.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const cand = j.candidates?.[0];
    const raw = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!raw.trim()) {
      throw new Error(`Модель не вернула текст (finishReason=${cand?.finishReason ?? 'нет'})`);
    }
    return raw;
  }

  const content: Record<string, unknown>[] = [{ type: 'text', text: opts.prompt }];
  if (b64) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key}` },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.1,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = j.choices?.[0]?.message?.content ?? '';
  if (!raw.trim()) throw new Error('Модель вернула пустой ответ');
  return raw;
}

/** Проверка ключа, доступности модели и остатка квоты. */
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

    /* Список моделей отдаётся даже при исчерпанной квоте и при отсутствии
     * депозита, поэтому отдельно делаем один минимальный запрос генерации. */
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
    if (r.ok) return { ok: true, note: 'модель отвечает, обучение возможно' };
    const text = (await r.text().catch(() => '')).slice(0, 200);
    if (r.status === 429) {
      return { ok: false, note: 'квота исчерпана — смените модель или подключите оплату' };
    }
    if (r.status === 403) {
      return { ok: false, note: `модель платная для этого ключа: ${text}` };
    }
    if (r.status === 404) {
      return { ok: false, note: `модель «${model}» недоступна для этого ключа` };
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
    if (!r.ok) return { ok: false, reason: `Сервер ответил ${r.status}`, base };
    const j = (await r.json()) as { models?: { name?: string }[]; data?: { id?: string }[] };
    const names = (j.models ?? [])
      .map((m) => String(m.name).replace(/^models\//, ''))
      .concat((j.data ?? []).map((m) => String(m.id)));
    return { ok: true, models: names, base };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 140), base };
  }
}
