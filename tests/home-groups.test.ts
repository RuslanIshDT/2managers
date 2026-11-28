import { describe, expect, it } from 'vitest';
import { buildDesk, type DeskInput } from '../src/agents/desk.ts';
import { DECISION_PREVIEW, splitPreview, workGroups } from '../src/agents/home-groups.ts';
import { renderMorning, type MorningInput } from '../src/agents/focus.ts';

function desk(over: Partial<DeskInput>) {
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

function weeks(facts: string[], plan: string, lagging: boolean) {
  return facts.map((fact, index) => ({ week: `2026-11-${String(index + 1).padStart(2, '0')}`, plan, fact, lagging }));
}

describe('группы главной', () => {
  it('три группы, пустая не выводится, дольше ждёт — выше', () => {
    const built = desk({
      accepted: false,
      relief: { letters: 2, meetings: 1 },
      proposal: [],
      decisions: [
        { id: 'new', status: 'ждёт', summary: 'Новое', replyName: 'Глеб', createdAt: '2026-12-10T10:00:00.000Z', category: '' },
        { id: 'old', status: 'ждёт', summary: 'Старое', replyName: 'Глеб', createdAt: '2026-12-01T10:00:00.000Z', category: '' },
      ],
      people: [{ id: 'g', name: 'Глеб', emails: 0, laggingWeeks: [{ name: 'План', week: '2026-11-23' }] }],
      tasks: [{ title: 'Разобрать бюджет', minutes: 20, goal: 'Квартал', why: 'срок близко' }],
      series: [{ title: 'Планёрка', open: true }],
    });
    const groups = workGroups(built.work);
    expect(groups.map((group) => group.title)).toEqual(['Сегодня', 'Ждёт вашего решения', 'Предложения помощника']);
    expect(groups.find((group) => group.id === 'waiting')?.items.map((item) => item.id)).toEqual(['old', 'new']);
    expect(groups.find((group) => group.id === 'today')?.items.map((item) => item.kind)).toEqual(['task', 'talk']);
    const onlyWaiting = workGroups(desk({ decisions: [{ id: 'a', status: 'ждёт', summary: 'Одно', replyName: 'Глеб', createdAt: '2026-12-01', category: '' }] }).work);
    expect(onlyWaiting.map((group) => group.id)).toEqual(['waiting']);
  });

  it('после пяти решений остальные прячутся за «ещё»', () => {
    expect(DECISION_PREVIEW).toBe(5);
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(splitPreview(items)).toEqual({ head: ['a', 'b', 'c', 'd', 'e'], more: 2 });
    expect(splitPreview(items.slice(0, 5)).more).toBe(0);
  });

  it('дело дня, совпавшее с решением, остаётся одной карточкой в «Сегодня»', () => {
    const built = desk({
      decisions: [{ id: 'd', status: 'ждёт', summary: 'Бюджет кампании', replyName: 'Вера', subject: 'Бюджет кампании', createdAt: '2026-12-02', category: '', draft: 'Оставляем бюджет.' }],
      tasks: [{ title: 'Бюджет кампании', minutes: 15, goal: 'План', why: 'без этого план не сойдётся' }],
    });
    expect(built.work.filter((item) => item.title.includes('Бюджет кампании'))).toHaveLength(1);
    const groups = workGroups(built.work);
    expect(groups.find((group) => group.id === 'today')?.items.map((item) => item.id)).toEqual(['d']);
    expect(groups.find((group) => group.id === 'waiting')).toBeUndefined();
    const card = built.work[0];
    expect(card?.minutes).toContain('15 минут');
    expect(card?.minutes).toContain('модель');
    expect(card?.lines.map((line) => line.title).join(' ')).toContain('без этого план не сойдётся');
  });
});

describe('карточка дела о человеке', () => {
  const vera = {
    id: 'v',
    name: 'Вера',
    emails: 8,
    laggingWeeks: [{ name: 'План продаж', week: '2026-11-24' }],
    kpis: [{ name: 'План продаж', unit: '%', weeks: weeks(['97', '96', '95', '94'], '100', true) }],
  };
  const gleb = { id: 'g', name: 'Глеб', emails: 1, laggingWeeks: [], kpis: [] };
  const nina = { id: 'n', name: 'Нина', emails: 3, laggingWeeks: [], kpis: [] };

  it('показывает недели, письма против середины, смысл совета, ждущее письмо и почему', () => {
    const built = desk({
      people: [vera, gleb, nina],
      decisions: [
        { id: 'sale', status: 'ждёт', summary: 'Скидка на партию', replyName: 'Вера', subject: 'Скидка на партию', createdAt: '2026-12-01', category: '' },
      ],
      tasks: [{ title: 'Вера — помочь по существу', minutes: 45, goal: 'План продаж', why: 'четыре недели подряд ниже плана' }],
    });
    const text = built.work.find((item) => item.kind === 'task')?.lines.map((line) => line.title).join('\n') ?? '';
    expect(text).toContain('План продаж: 97% → 96% → 95% → 94% при плане 100%');
    expect(text).toContain('Писем за неделю: 8, это выше середины отдела (3).');
    expect(text).toContain('человек пишет и просит, но показатель падает, разберите с ним дела, на которых он застрял');
    expect(text).toContain('Скидка на партию');
    expect(text).toContain('четыре недели подряд ниже плана');
    expect(built.work.find((item) => item.kind === 'task')?.minutes).toContain('модель');
  });

  it('молчащий человек и человек в норме получают свои тексты, другой отдел — другие числа', () => {
    const quiet = desk({
      people: [
        { id: 'b', name: 'Борис', emails: 0, laggingWeeks: [{ name: 'Выпуск', week: '2026-11-24' }], kpis: [{ name: 'Выпуск', unit: 'шт', weeks: weeks(['10', '9', '8'], '20', true) }] },
        { id: 'z', name: 'Зоя', emails: 2, laggingWeeks: [], kpis: [] },
        { id: 'k', name: 'Клим', emails: 4, laggingWeeks: [], kpis: [] },
      ],
    });
    const quietText = quiet.work.find((item) => item.kind === 'talk')?.lines.map((line) => line.title).join('\n') ?? '';
    expect(quietText).toContain('Выпуск: 10 шт → 9 шт → 8 шт при плане 20 шт');
    expect(quietText).toContain('Писем за неделю: 0, это ниже середины отдела (2).');
    expect(quietText).toContain('отстаёт и молчит');
    expect(quietText).not.toContain('Вера');
    expect(quietText).not.toContain('97%');

    const grow = desk({
      people: [
        {
          id: 'p',
          name: 'Полина',
          emails: 6,
          laggingWeeks: [],
          kpis: [{ name: 'Ответ сервиса', unit: 'ч', weeks: weeks(['4', '4'], '4', false) }],
        },
        { id: 'z', name: 'Зоя', emails: 1, laggingWeeks: [], kpis: [] },
      ],
      tasks: [{ title: 'Полина — расширить полномочия', minutes: 20, goal: 'Сервис', why: 'справляется сама' }],
    });
    const growText = grow.work.find((item) => item.kind === 'task')?.lines.map((line) => line.title).join('\n') ?? '';
    expect(growText).toContain('В плане. Ответ сервиса: 4 ч → 4 ч при плане 4 ч');
    expect(growText).toContain('в норме и много спрашивает');
    expect(growText).not.toContain('Выпуск');
  });
});

describe('утро', () => {
  it('к делу о человеке добавляется одна строка, что отстаёт', () => {
    const morning: MorningInput = {
      today: '2026-12-11',
      waiting: [],
      ownWeek: [],
      plan: [
        {
          title: 'Вера — помочь по существу',
          goal: 'План',
          minutes: 45,
          why: 'эффект больше.',
          lag: 'Отстаёт: План продаж: 97% → 94% при плане 100%',
        },
      ],
      returned: [],
      overdue: [],
      todayMeetings: [],
      questions: [],
      share: { onGoal: 0, total: 0, percent: 0 },
    };
    const text = renderMorning(morning);
    expect(text).toContain('Отстаёт: План продаж: 97% → 94% при плане 100%');
    const plain = renderMorning({ ...morning, plan: [{ title: 'Вера — помочь по существу', goal: 'План', minutes: 45, why: 'эффект больше.' }] });
    expect(plain).not.toContain('Отстаёт:');
  });
});
