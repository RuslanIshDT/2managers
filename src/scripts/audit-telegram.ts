// Итог аудита потока — сообщением руководителю в Telegram.
//   npm run audit:telegram        — отправить
//   npm run audit:telegram:dry    — показать текст, не отправляя
//   npm run tg:chats              — какие чаты писали боту (узнать TELEGRAM_CHAT_ID)
import { readFile } from 'node:fs/promises';
import { toTelegram } from '../agents/flow-audit-report.ts';
import { recentChats, sendMessage } from '../telegram.ts';

const args = process.argv.slice(2);

if (args.includes('--chats')) {
  const { bot, chats } = await recentChats();
  console.log(`Бот @${bot}. Чаты, которые писали боту:`);
  for (const [id, who] of chats) console.log(`  ${id}  ${who}`);
  if (!chats.length) console.log('  пока никого: напишите боту /start и повторите');
  process.exit(0);
}

const report = JSON.parse(await readFile('reports/flow-audit.json', 'utf8'));
const origin = process.env.STAND_ORIGIN;
if (!origin) throw new Error('STAND_ORIGIN не задан (.env): адрес стенда, на котором открывается /audit/');
const text = toTelegram(report.summary, report.view, `${origin.replace(/\/+$/, '')}/audit/`);

if (args.includes('--dry-run')) {
  console.log(text);
  process.exit(0);
}
const sent = await sendMessage(text);
console.log(`Отправлено, message_id ${sent.message_id}`);
