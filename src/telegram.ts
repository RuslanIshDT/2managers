// Telegram Bot API: отправка сообщений руководителю. Токен и чат — в .env, не в репозитории.
import { sendLabel } from './agents/decision.ts';
export function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан (.env)');
  return { token, chatId: process.env.TELEGRAM_CHAT_ID ?? '' };
}

async function api<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const { token } = telegramConfig();
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  return data.result as T;
}

export async function sendMessage(
  text: string,
  chatId = telegramConfig().chatId,
  extra?: Record<string, unknown>,
) {
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID не задан (.env): напишите боту /start и запустите npm run tg:chats');
  return api<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

export function decisionKeyboard(decisionId: string, replyName: string) {
  return {
    inline_keyboard: [
      [{ text: sendLabel(replyName), callback_data: decisionCallback('approve', decisionId) }],
      [
        { text: 'Отказать', callback_data: decisionCallback('reject', decisionId) },
        { text: 'Отложить', callback_data: decisionCallback('defer', decisionId) },
      ],
      [{ text: 'Поправить', callback_data: decisionCallback('edit', decisionId) }],
    ],
  };
}

export async function sendDecisionCard(text: string, decisionId: string, chatId: string, replyName = '') {
  return sendMessage(text, chatId, { reply_markup: decisionKeyboard(decisionId, replyName) });
}

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

const ACTIONS = ['approve', 'edit', 'reject', 'defer', 'once', 'keep'] as const;
export type ButtonAction = (typeof ACTIONS)[number];

export function decisionCallback(action: ButtonAction, decisionId: string): string {
  return `d:${action}:${decisionId}`;
}

export function parseCallback(data: string): { action: ButtonAction; decisionId: string } | null {
  const match = /^d:(approve|edit|reject|defer|once|keep):([A-Za-z0-9_-]{1,64})$/.exec(data);
  if (!match) return null;
  return { action: match[1] as ButtonAction, decisionId: match[2] };
}

export function editChoiceKeyboard(decisionId: string, replyName = '') {
  return {
    inline_keyboard: [
      [
        { text: 'Только сейчас', callback_data: decisionCallback('once', decisionId) },
        { text: 'Запомнить', callback_data: decisionCallback('keep', decisionId) },
      ],
      [
        { text: sendLabel(replyName), callback_data: decisionCallback('approve', decisionId) },
        { text: 'Отказать', callback_data: decisionCallback('reject', decisionId) },
      ],
    ],
  };
}

export function parseRuleCallback(data: string): 'week' | null {
  return data === 'r:accept:week' ? 'week' : null;
}

export async function sendRulesCard(text: string, chatId: string) {
  return sendMessage(text, chatId, {
    reply_markup: { inline_keyboard: [[{ text: 'Принять правила недели', callback_data: 'r:accept:week' }]] },
  });
}

export function parseStart(text: string): string | null {
  const match = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!match) return null;
  return match[1] ?? '';
}

export async function answerCallback(callbackId: string, text: string) {
  return api<boolean>('answerCallbackQuery', { callback_query_id: callbackId, text });
}

// Чаты, которые писали боту: чтобы узнать TELEGRAM_CHAT_ID руководителя.
export async function recentChats() {
  const me = await api<{ username: string }>('getMe');
  const updates = await api<{ message?: { chat: { id: number; type: string; first_name?: string; username?: string; title?: string } } }[]>('getUpdates');
  const chats = new Map<number, string>();
  for (const u of updates) {
    const c = u.message?.chat;
    if (c) chats.set(c.id, `${c.type}: ${c.title ?? c.first_name ?? ''}${c.username ? ' @' + c.username : ''}`);
  }
  return { bot: me.username, chats: [...chats.entries()] };
}
