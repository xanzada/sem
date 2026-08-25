import { getSetting } from './settings.js';
import { log } from './logger.js';

export async function tgNotify(html: string): Promise<void> {
  const token = String(getSetting('telegramToken') || '');
  const chatId = String(getSetting('telegramChatId') || '');
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    log('warn', 'SYSTEM', `Telegram уведомление не отправлено: ${String(e)}`);
  }
}
