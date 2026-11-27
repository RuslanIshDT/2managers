import { describe, expect, it } from 'vitest';
import { failedRuling } from '../src/agents/k2.ts';
import { liveLetterId, parseMailboxSource } from '../src/mail.ts';
import { decisionCallback, parseCallback } from '../src/telegram.ts';

describe('T52: сбой разбора одного письма', () => {
  it('живое письмо с длинным Message-ID получает номер, который принимает кнопка Telegram', () => {
    const messageId = `<CAF${'x'.repeat(90)}.Long.ID+tag@mail.gmail.com>`;
    const source = [
      'From: Someone <someone@example.org>',
      'Subject: Hello',
      `Message-ID: ${messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Текст письма',
    ].join('\r\n');
    const letter = parseMailboxSource(source);
    expect(letter?.marked).toBe(false);
    expect(letter?.messageId).toBe(messageId);
    const id = letter?.id ?? '';
    expect(id).toBe(liveLetterId(messageId));
    for (const action of ['approve', 'reject', 'defer', 'edit'] as const) {
      const data = decisionCallback(action, id);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallback(data)).toEqual({ action, decisionId: id });
    }
    expect(liveLetterId(messageId)).not.toBe(liveLetterId(`${messageId}2`));
  });

  it('нет ответа модели — письмо уходит руководителю, ничего не отправляется', () => {
    const plain = failedRuling('Перенос созвона\nМожно в четверг?', 'основание: too_small');
    expect(plain.kind).toBe('нужен_руководитель');
    expect(plain.ask).toBe(true);
    expect(plain.send).toBe(false);
    expect(plain.draft).toBe('');
    expect(plain.basis).toContain('too_small');
    expect(plain.category).toBe('иное');
    expect(failedRuling('Скидка 7% клиенту', 'x').category).toBe('иное');
  });
});
