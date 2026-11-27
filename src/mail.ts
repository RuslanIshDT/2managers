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
  client.on('error', (err: unknown) => console.error('IMAP', err instanceof Error ? err.message : err));
  await client.connect();
  try {
    const status = await client.status('INBOX', { messages: true });
    return { configured: true, ok: true, detail: `Входящие: ${status.messages ?? 0}` };
  } finally {
    await client.logout();
  }
}

export async function sendMail(
  to: string,
  subject: string,
  text: string,
  attachments: { filename: string; content: string; contentType: string }[] = [],
) {
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
    attachments,
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
  const headers = text.slice(0, splitAt);
  const body = readableText(text);
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
  client.on('error', (err: unknown) => console.error('IMAP', err instanceof Error ? err.message : err));
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
  client.on('error', (err: unknown) => console.error('IMAP', err instanceof Error ? err.message : err));
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

function readableText(source: string): string {
  const found = collectText(source);
  const plain = found.find((part) => part.kind === 'plain');
  const html = found.find((part) => part.kind === 'html');
  return (plain ?? html)?.text.trim() ?? '';
}

function collectText(chunk: string): { kind: 'plain' | 'html'; text: string }[] {
  const splitAt = chunk.indexOf('\n\n');
  if (splitAt < 0) return [];
  const headers = chunk.slice(0, splitAt);
  const raw = chunk.slice(splitAt + 2).replace(/\n$/, '');
  const typeHeader = headerValue(headers, 'content-type') || 'text/plain; charset=utf-8';
  const mime = typeHeader.split(';')[0]?.trim().toLowerCase() ?? 'text/plain';
  if (mime.startsWith('multipart/')) {
    const boundary = /boundary="?([^";]+)"?/i.exec(typeHeader)?.[1];
    if (!boundary) return [];
    return splitByBoundary(raw, boundary).flatMap((part) => collectText(part));
  }
  if (headerValue(headers, 'content-disposition').toLowerCase().startsWith('attachment')) return [];
  const charset = /charset="?([^";]+)"?/i.exec(typeHeader)?.[1] ?? 'utf-8';
  const text = decodeTransfer(raw, headerValue(headers, 'content-transfer-encoding'), charset);
  if (mime === 'text/plain') return [{ kind: 'plain', text }];
  if (mime === 'text/html') return [{ kind: 'html', text: stripHtml(text) }];
  return [];
}

function splitByBoundary(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === marker || trimmed === `${marker}--`) {
      if (current) parts.push(current.join('\n'));
      current = trimmed.endsWith('--') && trimmed !== marker ? null : [];
      if (trimmed === `${marker}--`) break;
      continue;
    }
    if (current) current.push(line);
  }
  return parts.filter((part) => part.trim().length > 0);
}

function decodeTransfer(raw: string, encoding: string, charset: string): string {
  const enc = encoding.toLowerCase();
  if (enc.includes('base64')) return decodeBytes(Buffer.from(raw.replace(/\s/g, ''), 'base64'), charset);
  if (enc.includes('quoted-printable')) return decodeBytes(decodeQuotedPrintable(raw), charset);
  return raw.trim();
}

function decodeQuotedPrintable(raw: string): Buffer {
  const unfolded = raw.replace(/=\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i += 1) {
    if (unfolded[i] === '=' && /[0-9A-Fa-f]{2}/.test(unfolded.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(unfolded.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeBytes(bytes: Buffer, charset: string): string {
  const name = charset.toLowerCase().replaceAll('_', '-');
  try {
    return new TextDecoder(name === 'utf8' ? 'utf-8' : name).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function encodedWordBytes(encoding: string, data: string): Buffer {
  if (encoding.toUpperCase() === 'B') return Buffer.from(data, 'base64');
  return decodeQuotedPrintable(data.replaceAll('_', ' '));
}

function decodeHeader(value: string): string {
  const words = [...value.matchAll(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g)].map((match) => ({
    charset: match[1] ?? '',
    encoding: match[2] ?? 'B',
    data: match[3] ?? '',
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  if (!words.length) return value.replace(/[ \t]{2,}/g, ' ').trim();
  let out = '';
  let cursor = 0;
  let previousWord = false;
  for (let i = 0; i < words.length; ) {
    const gap = value.slice(cursor, words[i]?.start ?? cursor);
    out += previousWord && /^[ \t]*$/.test(gap) ? '' : gap;
    let j = i + 1;
    while (
      j < words.length &&
      words[j]?.charset.toLowerCase() === words[i]?.charset.toLowerCase() &&
      /^[ \t]*$/.test(value.slice(words[j - 1]?.end ?? 0, words[j]?.start ?? 0))
    ) {
      j += 1;
    }
    const group = words.slice(i, j);
    const head = group[0];
    if (head) out += decodeBytes(Buffer.concat(group.map((word) => encodedWordBytes(word.encoding, word.data))), head.charset);
    cursor = group.at(-1)?.end ?? cursor;
    previousWord = true;
    i = j;
  }
  out += value.slice(cursor);
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

function encoded(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}
