// Яндекс Почта: IMAP для чтения, SMTP для отправки.
// Без YANDEX_MAIL_USER и YANDEX_MAIL_PASSWORD модуль сообщает «не настроено» и ничего не шлёт.
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
