// Яндекс Почта: IMAP для чтения, SMTP для отправки.
// Без YANDEX_MAIL_USER и YANDEX_MAIL_PASSWORD модуль сообщает «не настроено» и ничего не шлёт.
import { Buffer } from 'node:buffer';
import nodemailer from 'nodemailer';

export interface MailConfig {
  user: string;
  password: string;
}

export function mailConfig(): MailConfig | null {
  const user = process.env.YANDEX_MAIL_USER?.trim();
  const password = process.env.YANDEX_MAIL_PASSWORD;
  if (!user || !password) return null;
  return { user, password };
}

export interface MailStatus {
  configured: boolean;
  ok: boolean;
  detail: string;
}

export async function checkMail(): Promise<MailStatus> {
  const cfg = mailConfig();
  if (!cfg) {
    return { configured: false, ok: false, detail: 'Яндекс Почта не настроена: нет учётных данных' };
  }
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: 'imap.yandex.com',
    port: 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
  });
  await client.connect();
  try {
    const status = await client.status('INBOX', { messages: true });
    return { configured: true, ok: true, detail: `Входящие: ${status.messages ?? 0}` };
  } finally {
    await client.logout();
  }
}

export async function sendMail(to: string, subject: string, text: string) {
  const cfg = mailConfig();
  if (!cfg) throw new Error('Яндекс Почта не настроена');
  const transport = nodemailer.createTransport({
    host: 'smtp.yandex.com',
    port: 465,
    secure: true,
    auth: { user: cfg.user, pass: cfg.password },
  });
  const info = await transport.sendMail({
    from: `"ИИ-помощник" <${cfg.user}>`,
    to,
    subject,
    text: `${text}\n\n— ИИ-помощник руководителя`,
  });
  return { messageId: info.messageId };
}

export interface SyntheticLetter {
  id: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  received: string;
}

export interface MailboxLetter extends SyntheticLetter {
  messageId: string;
  marked?: boolean;
}

export function syntheticSource(letter: SyntheticLetter, to: string): string {
  const body = `синтетика ${letter.id}\nОт: ${letter.fromName} <${letter.fromEmail}>\n\n${letter.body.trim()}\n`;
  const date = new Date(letter.received.replace(' ', 'T') + '+03:00');
  const stamp = Number.isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString();
  return [
    `From: ${encoded(letter.fromName)} <${letter.fromEmail}>`,
    `To: <${to}>`,
    `Subject: ${encoded(letter.subject)}`,
    `Date: ${stamp}`,
    `Message-ID: <${letter.id}.synthetic@ecompras.local>`,
    `X-Ecompras-Synthetic: ${letter.id}`,
    `X-Ecompras-Received: ${letter.received}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\n'),
  ].join('\r\n');
}

export function parseMailboxSource(source: string): MailboxLetter | null {
  const text = source.replace(/\r\n/g, '\n');
  const splitAt = text.indexOf('\n\n');
  if (splitAt < 0) return null;
  const rawBody = text.slice(splitAt + 2);
  const encoding = headerValue(text.slice(0, splitAt), 'content-transfer-encoding');
  const body = encoding.toLowerCase().includes('base64')
    ? Buffer.from(rawBody.replace(/\s/g, ''), 'base64').toString('utf8')
    : rawBody;
  const headers = text.slice(0, splitAt);
  const lines = body.split('\n');
  const marker = /^синтетика\s+([A-Za-z0-9_-]+)\s*$/.exec(lines[0] ?? '');
  const fromLine = /^От:\s*(.+?)\s*<([^>]+)>\s*$/.exec(lines[1] ?? '');
  const subject = decodeHeader(headerValue(headers, 'subject'));
  const received = headerValue(headers, 'x-ecompras-received') || headerValue(headers, 'date');
  if (marker && fromLine) {
    const messageId = headerValue(headers, 'message-id') || `<${marker[1]}.synthetic@ecompras.local>`;
    return {
      id: marker[1],
      messageId,
      fromName: fromLine[1],
      fromEmail: fromLine[2],
      subject,
      body: lines.slice(3).join('\n').trim(),
      received,
      marked: true,
    };
  }
  const fromHeader = decodeHeader(headerValue(headers, 'from'));
  const from = /^(.*?)\s*<([^>]+)>\s*$/.exec(fromHeader);
  const email = (from?.[2] ?? fromHeader).trim().toLowerCase();
  if (!email.includes('@')) return null;
  const messageId = headerValue(headers, 'message-id') || `local-${email}-${subject}`;
  return {
    id: messageId.replace(/[<>]/g, '').slice(0, 80),
    messageId,
    fromName: (from?.[1] ?? '').replace(/^"|"$/g, '').trim() || email,
    fromEmail: email,
    subject: subject || '(без темы)',
    body: body.trim(),
    received,
    marked: false,
  };
}

export async function appendSynthetic(letters: SyntheticLetter[]): Promise<number> {
  const cfg = mailConfig();
  if (!cfg) throw new Error('Яндекс Почта не настроена');
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: 'imap.yandex.com',
    port: 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
  });
  await client.connect();
  try {
    const existing = new Set((await readSynthetic(client)).map((letter) => letter.id));
    let added = 0;
    const lock = await client.getMailboxLock('INBOX');
    try {
      for (const letter of letters) {
        if (existing.has(letter.id)) continue;
        await client.append('INBOX', syntheticSource(letter, cfg.user), ['\\Seen']);
        added += 1;
      }
    } finally {
      lock.release();
    }
    return added;
  } finally {
    await client.logout();
  }
}

export async function readSyntheticInbox(): Promise<MailboxLetter[]> {
  const cfg = mailConfig();
  if (!cfg) throw new Error('Яндекс Почта не настроена');
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: 'imap.yandex.com',
    port: 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
  });
  await client.connect();
  try {
    return await readSynthetic(client);
  } finally {
    await client.logout();
  }
}

async function readSynthetic(client: {
  getMailboxLock: (path: string) => Promise<{ release: () => void }>;
  status: (path: string, query: { messages: true }) => Promise<{ messages?: number }>;
  fetch: (range: string, query: { source: true }) => AsyncIterable<{ source?: Buffer }>;
}): Promise<MailboxLetter[]> {
  const status = await client.status('INBOX', { messages: true });
  const total = status.messages ?? 0;
  if (total === 0) return [];
  const from = Math.max(1, total - 80);
  const lock = await client.getMailboxLock('INBOX');
  const found: MailboxLetter[] = [];
  try {
    for await (const message of client.fetch(`${from}:*`, { source: true })) {
      if (!message.source) continue;
      const parsed = parseMailboxSource(message.source.toString('utf8'));
      if (parsed) found.push(parsed);
    }
  } finally {
    lock.release();
  }
  return found;
}

function headerValue(headers: string, name: string): string {
  const unfolded = headers.replace(/\n[ \t]+/g, ' ');
  const match = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded);
  return match?.[1]?.trim() ?? '';
}

function decodeHeader(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

function encoded(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}
