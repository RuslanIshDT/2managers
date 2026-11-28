import { describe, expect, it } from 'vitest';
import { applyCheckResult, approvalBlock, cardText, draftGap, holdsDraft, keepForLeader } from '../src/agents/k2.ts';
import { buildDesk, type DeskInput } from '../src/agents/desk.ts';

const card = {
  who: 'Отправитель: тема',
  вывод: 'Нужен ответ',
  рекомендация: 'Дописать',
  основание: 'Фактов нет',
  риски: '',
  если_не_решить: '',
  контекст: '',
};

describe('пропуск в черновике', () => {
  it('утверждение с пропуском не готово, после правки готово, карточка показывает пропуск', () => {
    const open = 'Договор на подписи у юристов. [допишите: итоги встречи]';
    expect(draftGap(open)).toBe('[допишите: итоги встречи]');
    expect(approvalBlock(open)).toContain('Допишите');
    expect(approvalBlock('Договор на подписи у юристов, ждём до 12 декабря.')).toBe('');
    expect(cardText({ ...card, draft: open })).toContain('В черновике пропуск');
    expect(cardText({ ...card, draft: 'Готовый текст.' })).not.toContain('В черновике пропуск');
  });

  it('карточка решения показывает, что в черновике пропуск', () => {
    const input = {
      accepted: true,
      decisions: [
        {
          id: 'd1',
          status: 'ждёт',
          summary: 'Нужен ответ',
          replyName: 'Анна Босс',
          createdAt: '2026-12-11T10:00:00.000Z',
          category: 'иное',
          draft: 'Ответ. [допишите: чего не хватает]',
        },
      ],
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
      returnedLetters: 0,
      returnedMeetings: 0,
    } as DeskInput;
    const desk = buildDesk(input);
    expect(desk.work.find((item) => item.id === 'd1')?.lines[0]?.title).toContain('пропуск');
  });

  it('любые скобки — пропуск, несверенный и неподтверждённый черновик не уходит', () => {
    const named = '[Ответственный], подтвердите получение.';
    expect(draftGap(named)).toBe('[Ответственный]');
    expect(approvalBlock(named)).toContain('Допишите');
    const leftover = applyCheckResult('Срок перенесён на май.', { claims: ['Срок перенесён на май'], draft: 'Срок перенесён на май.' });
    expect(leftover.note).toContain('Не подтверждено данными');
    expect(approvalBlock(leftover.draft, leftover.note)).toContain('Допишите');
    const failed = applyCheckResult('Короткий ответ.', null);
    expect(failed.note).toBe('Черновик не сверен');
    expect(approvalBlock(failed.draft, failed.note)).toContain('Допишите');
    const replaced = applyCheckResult('Факт, которого не было.', { claims: ['Факт, которого не было'], draft: 'Ответ. [допишите: недостающий факт]' });
    expect(replaced.unconfirmed).toEqual([]);
    expect(holdsDraft(replaced)).toBe(true);
    const clean = applyCheckResult('Ответ по письму.', { claims: [], draft: 'Ответ по письму.' });
    expect(holdsDraft(clean)).toBe(false);
    const sent = keepForLeader({ ask: false, send: true, kind: 'вернуть' }, failed);
    expect(sent).toEqual({ ask: true, send: false, kind: 'нужен_руководитель' });
  });

  it('карточка показывает пометку сверки', () => {
    const input = {
      accepted: true,
      decisions: [
        {
          id: 'd2',
          status: 'ждёт',
          summary: 'Нужен ответ',
          replyName: 'Анна Босс',
          createdAt: '2026-12-11T10:00:00.000Z',
          category: 'иное',
          draft: 'Готовый текст.',
          draftNote: 'Черновик не сверен',
        },
      ],
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
      returnedLetters: 0,
      returnedMeetings: 0,
    } as DeskInput;
    const desk = buildDesk(input);
    expect(desk.work.find((item) => item.id === 'd2')?.lines.map((line) => line.title).join(' ')).toContain('не сверен');
  });
});
