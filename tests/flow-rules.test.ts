import { describe, expect, it } from 'vitest';
import { buildDesk, type DeskInput } from '../src/agents/desk.ts';
import { acceptedLine, awaySummary, flowRuleList, type FlowLetter, type FlowMeeting, type FlowPerson } from '../src/agents/flow-list.ts';
import { rulesFromAudit, type TrustOffer } from '../src/agents/replay.ts';

function offer(personId: string, area: string, limit: number, streak: number, unit: '%' | 'ч'): TrustOffer {
  const limitText = unit === '%' ? `до ${limit}%` : `до ${limit} ${unit}`;
  return {
    personId,
    area,
    limit,
    streak,
    ready: true,
    title: `Дать право решать самостоятельно «${area}» ${limitText}: ${streak} утверждений подряд без правок`,
  };
}

function deskTitle(letters: number, meetings: number, proposal: ReturnType<typeof rulesFromAudit>): string | undefined {
  const input: DeskInput = {
    accepted: false,
    decisions: [],
    verdicts: [],
    letters: [],
    meetings: [],
    rules: [],
    people: [],
    authorities: [],
    history: [],
    series: [],
    relief: { letters, meetings },
    proposal,
    tasks: [],
    calls: [],
  };
  return buildDesk(input).work.find((item) => item.id === 'rules:week')?.title;
}

describe('список правил недели', () => {
  const northOffer = offer('p1', 'скидка', 8, 6, '%');
  const northRules = rulesFromAudit(
    [
      { kind: 'письма', key: 'a@example|скидка клиенту', title: 'Скидка клиенту', verdict: 'не_должно', change: 'маршрут сразу ответственному', cause: 'не_тот_адресат' },
      { kind: 'письма', key: 'b@example|отчёт смены', title: 'Отчёт смены', verdict: 'в_другом_виде', change: 'одна карточка', cause: 'повтор' },
      { kind: 'письма', key: 'c@example|сводка', title: 'Сводка', verdict: 'не_должно', change: 'в сводку', cause: 'статус_вместо_данных' },
      { kind: 'встречи', key: 'Планёрка', title: 'Планёрка', verdict: 'не_должно', change: 'убрать серию', cause: 'встреча_без_решения' },
      { kind: 'встречи', key: 'Совет', title: 'Совет', verdict: 'в_другом_виде', change: 'реже', cause: 'руководитель_лишний' },
      { kind: 'встречи', key: 'Нужная', title: 'Нужная', verdict: 'должно', change: '', cause: 'нужно' },
    ],
    [northOffer],
    new Map([['p1', 'a@example']]),
  );
  const northLetters: FlowLetter[] = [
    { fromName: 'Северный', fromEmail: 'a@example', subject: 'Скидка клиенту', body: 'прошу' },
    { fromName: 'Северный', fromEmail: 'a@example', subject: 'Re: Скидка клиенту', body: 'ещё раз' },
    { fromName: 'Северный', fromEmail: 'a@example', subject: 'Скидка клиенту', body: 'третье' },
    { fromName: 'Северный', fromEmail: 'a@example', subject: 'Новая тема', body: 'не это' },
    { fromName: 'Почта смены', fromEmail: 'b@example', subject: 'Отчёт смены', body: 'первый' },
    { fromName: 'Почта смены', fromEmail: 'b@example', subject: 'Отчёт смены', body: 'второй' },
    { fromName: 'Робот', fromEmail: 'c@example', subject: 'Сводка', body: 'статус' },
  ];
  const northMeetings: FlowMeeting[] = [
    { summary: 'Планёрка', minutes: 30 },
    { summary: 'Планёрка', minutes: 45 },
    { summary: 'Совет', minutes: 60 },
    { summary: 'Нужная', minutes: 15 },
  ];
  const northPeople: FlowPerson[] = [{ id: 'p1', name: 'Северный', emails: ['a@example'] }];

  const southOffer = offer('p2', 'отпуск', 3, 5, 'ч');
  const southRules = rulesFromAudit(
    [
      { kind: 'письма', key: 'y@example|график отпуска', title: 'График отпуска', verdict: 'не_должно', change: 'сам', cause: 'в_полномочиях_отправителя' },
      { kind: 'встречи', key: 'Разбор', title: 'Разбор', verdict: 'не_должно', change: 'убрать', cause: 'встреча_без_решения' },
    ],
    [southOffer],
    new Map([['p2', 'y@example']]),
  );
  const southLetters: FlowLetter[] = [
    { fromName: 'Южный', fromEmail: 'y@example', subject: 'График отпуска', body: 'даты' },
    { fromName: 'Южный', fromEmail: 'y@example', subject: 'График отпуска', body: 'ещё' },
  ];
  const southMeetings: FlowMeeting[] = [{ summary: 'Разбор', minutes: 20 }];
  const southPeople: FlowPerson[] = [{ id: 'p2', name: 'Южный', emails: ['y@example'] }];

  function north() {
    return flowRuleList({ rules: northRules, letters: northLetters, meetings: northMeetings, people: northPeople, offers: [northOffer] });
  }

  it('до принятия: цепочки, серии, права и числа по каждому правилу', () => {
    const view = north();
    expect(view.chains).toHaveLength(3);
    const discount = view.chains.find((row) => row.subject === 'Скидка клиенту');
    expect(discount).toMatchObject({
      who: 'Северный',
      amount: '3 письма за неделю',
      cause: 'Не тот адресат',
      change: 'до вас не доходит',
    });
    const report = view.chains.find((row) => row.subject === 'Отчёт смены');
    expect(report).toMatchObject({
      who: 'Почта смены',
      amount: '2 письма за неделю',
      cause: 'Повтор или напоминание',
      change: 'приходит один раз карточкой',
    });
    expect(view.chains.find((row) => row.subject === 'Сводка')).toMatchObject({
      who: 'Робот',
      amount: '1 письмо за неделю',
      cause: 'Статус вместо данных',
      change: 'до вас не доходит',
    });
    expect(view.chains.some((row) => row.subject === 'Новая тема')).toBe(false);

    expect(view.series.map((row) => row.subject).sort()).toEqual(['Планёрка', 'Совет']);
    expect(view.series.find((row) => row.subject === 'Планёрка')).toMatchObject({
      amount: '2 встречи, 75 минут',
      cause: 'Встреча без решения',
      change: 'до вас не доходит',
    });
    expect(view.series.find((row) => row.subject === 'Совет')).toMatchObject({
      amount: '1 встреча, 60 минут',
      cause: 'Руководитель лишний на встрече',
      change: 'приходит один раз карточкой',
    });

    expect(view.rights).toEqual([
      {
        who: 'Северный',
        subject: '',
        amount: '',
        cause: '',
        change: '',
        area: 'скидка',
        limit: 'до 8%',
        basis: '6 утверждений подряд',
      },
    ]);
  });

  it('итог совпадает с числами карточки на главной', () => {
    const view = north();
    expect(view.lettersAway).toBe(4);
    expect(view.meetingsAway).toBe(2);
    expect(view.summary).toBe('До вас не дойдут 4 письма и 2 встречи');
    expect(deskTitle(view.lettersAway, view.meetingsAway, northRules)).toBe(`Примите правила недели: ${awaySummary(view.lettersAway, view.meetingsAway).replace(/^До/, 'до')}`);
    expect(awaySummary(1, 0)).toBe('До вас не дойдёт 1 письмо');
    expect(deskTitle(1, 0, northRules)).toBe('Примите правила недели: до вас не дойдёт 1 письмо');
    expect(awaySummary(0, 1)).toBe('До вас не дойдёт 1 встреча');
  });

  it('после принятия тот же список и строка с датой', () => {
    const before = north();
    const stored = northRules.map((rule) => ({ ...rule }));
    const after = flowRuleList({ rules: stored, letters: northLetters, meetings: northMeetings, people: northPeople });
    expect(after.chains).toEqual(before.chains);
    expect(after.series).toEqual(before.series);
    expect(after.rights).toEqual(before.rights);
    expect(after.summary).toBe(before.summary);
    expect(acceptedLine('')).toBe('');
    expect(acceptedLine('2026-11-28T08:00:00.000Z')).toBe('приняты 28 ноября');
  });

  it('второй руководитель с другими людьми получает свой список', () => {
    const first = north();
    const second = flowRuleList({
      rules: southRules,
      letters: southLetters,
      meetings: southMeetings,
      people: southPeople,
      offers: [southOffer],
    });
    expect(second.chains).toEqual([
      expect.objectContaining({
        who: 'Южный',
        subject: 'График отпуска',
        amount: '2 письма за неделю',
        cause: 'Решение в полномочиях отправителя',
        change: 'до вас не доходит',
      }),
    ]);
    expect(second.series).toEqual([expect.objectContaining({ subject: 'Разбор', amount: '1 встреча, 20 минут', change: 'до вас не доходит' })]);
    expect(second.rights[0]).toMatchObject({ who: 'Южный', area: 'отпуск', limit: 'до 3 ч', basis: '5 утверждений подряд' });
    const firstText = JSON.stringify(first);
    const secondText = JSON.stringify(second);
    expect(secondText).not.toContain('Северный');
    expect(secondText).not.toContain('Скидка клиенту');
    expect(secondText).not.toContain('Планёрка');
    expect(firstText).not.toContain('Южный');
    expect(firstText).not.toContain('График отпуска');
    expect(firstText).not.toContain('отпуск');
  });
});
