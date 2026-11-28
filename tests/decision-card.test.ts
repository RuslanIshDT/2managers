import { describe, expect, it } from 'vitest';
import { buildDesk, type DeskInput } from '../src/agents/desk.ts';
import { letterExcerpt, parseDeferDate, performRefusal, reviveDeferred, sendLabel } from '../src/agents/decision.ts';
import { rememberChoiceVisible } from '../web/src/decision-ui.ts';

function desk(over: Partial<DeskInput> = {}) {
  const input: DeskInput = {
    accepted: true,
    decisions: [],
    verdicts: [],
    letters: [],
    meetings: [],
    rules: [],
    people: [],
    authorities: [],
    history: [],
    series: [],
    relief: null,
    tasks: [],
    calls: [],
    ...over,
  };
  return buildDesk(input);
}

describe('карточка решения', () => {
  it('показывает письмо и черновик: кому уйдёт ответ, видно до отправки', () => {
    const card = desk({
      decisions: [
        {
          id: 'd1',
          status: 'ждёт',
          summary: 'Скидка клиенту',
          replyName: 'Анна Волкова',
          replyTo: 'anna@example.com',
          subject: 'Скидка 12%',
          createdAt: '2026-12-01T10:00:00.000Z',
          category: 'деньги',
          draft: 'Екатерина, эту скидку подтвердить не могу.',
        },
      ],
      letters: [
        {
          id: 'd1',
          fromName: 'Анна Волкова',
          fromEmail: 'anna@example.com',
          subject: 'Скидка 12%',
          body: 'Прошу согласовать скидку 12% постоянному клиенту.',
          received: '2026-12-01T09:00:00.000Z',
        },
      ],
    }).work.find((item) => item.kind === 'decision');

    expect(card?.mail?.fromName).toBe('Анна Волкова');
    expect(card?.mail?.subject).toBe('Скидка 12%');
    expect(card?.mail?.excerpt).toContain('скидку 12%');
    expect(card?.mail?.replyName).toBe('Анна Волкова');
    expect(card?.mail?.draft).toContain('Екатерина');
    expect(sendLabel(card?.mail?.replyName ?? '')).toBe('Отправить ответ Анна Волкова');
  });

  it('длинное письмо на карточке сворачивается, короткий текст виден целиком', () => {
    expect(letterExcerpt('Одна строка').collapsed).toBe(false);
    const long = ['первая', 'вторая', 'третья', 'четвёртая'].join('\n');
    const cut = letterExcerpt(long);
    expect(cut.collapsed).toBe(true);
    expect(cut.excerpt).not.toContain('четвёртая');
  });

  it('отказ уходит письмом с причиной и не уходит без адреса', async () => {
    const sent: { name: string; email: string; subject: string; body: string }[] = [];
    const saved: string[] = [];
    const notice = await performRefusal({ replyName: 'Кира', replyTo: 'kira@example.com', subject: 'Отпуск' }, 'сейчас нельзя', {
      send: async (name, email, subject, body) => {
        sent.push({ name, email, subject, body });
      },
      save: async (status) => {
        saved.push(status);
      },
      journal: async () => {},
    });
    expect(notice).toBe('Отправителю отправлен отказ');
    expect(saved).toEqual(['отклонено']);
    expect(sent[0]?.name).toBe('Кира');
    expect(sent[0]?.body).toContain('согласовать не могу');
    expect(sent[0]?.body).toContain('Причина: сейчас нельзя');

    const skipped = await performRefusal({ replyName: 'Кира', replyTo: '  ', subject: 'Отпуск' }, 'нет', {
      send: async () => {
        throw new Error('нельзя отправлять');
      },
      save: async () => {
        throw new Error('нельзя сохранять');
      },
      journal: async () => {
        throw new Error('нельзя писать');
      },
    });
    expect(skipped).toBe('Нет адреса отправителя, письмо не отправлено');
  });

  it('отложенное скрыто до своего дня и в этот день снова ждёт', () => {
    const hidden = desk({
      decisions: [
        {
          id: 'later',
          status: 'отложено',
          summary: 'Бюджет',
          replyName: 'Кира',
          createdAt: '2026-12-01T10:00:00.000Z',
          category: '',
        },
      ],
    });
    expect(hidden.work.some((item) => item.kind === 'decision')).toBe(false);

    const rows = [
      { id: 'soon', status: 'отложено', deferUntil: '2026-12-20' },
      { id: 'due', status: 'отложено', deferUntil: '2026-12-11' },
    ];
    expect(reviveDeferred(rows, '2026-12-11').map((row) => row.status)).toEqual(['отложено', 'ждёт']);
    expect(parseDeferDate('20.12.2026', '2026-12-11')).toBe('2026-12-20');
    expect(parseDeferDate('2026-12-20', '2026-12-11')).toBe('2026-12-20');
    expect(parseDeferDate('не дата', '2026-12-11')).toBeNull();

    const back = reviveDeferred([{ id: 'due', status: 'отложено', deferUntil: '2026-12-11', summary: 'Бюджет' }], '2026-12-11')[0];
    const shown = desk({
      decisions: [
        {
          id: 'due',
          status: back?.status ?? '',
          summary: 'Бюджет',
          replyName: 'Кира',
          subject: 'Бюджет',
          createdAt: '2026-12-01T10:00:00.000Z',
          category: '',
          draft: 'Кира, бюджет оставляем прежним.',
        },
      ],
      letters: [{ id: 'due', fromName: 'Кира', fromEmail: 'kira@example.com', subject: 'Бюджет', body: 'Нужен бюджет.', received: '2026-12-01' }],
    });
    expect(shown.work.find((item) => item.id === 'due')?.mail?.draft).toContain('бюджет оставляем');
  });

  it('«Только сейчас» и «Запомнить» видны только после правки', () => {
    expect(rememberChoiceVisible(false)).toBe(false);
    expect(rememberChoiceVisible(true)).toBe(true);
  });
});
