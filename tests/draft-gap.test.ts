import { describe, expect, it } from 'vitest';
import { approvalBlock, cardText, draftGap } from '../src/agents/k2.ts';
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
});
