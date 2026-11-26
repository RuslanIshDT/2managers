// Telegram Bot API: отправка сообщений руководителю. Токен и чат — в .env, не в репозитории.
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

export async function sendMessage(text: string, chatId = telegramConfig().chatId) {
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID не задан (.env): напишите боту /start и запустите npm run tg:chats');
  return api<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
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
