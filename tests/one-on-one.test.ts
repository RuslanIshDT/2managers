import { describe, expect, it } from 'vitest';
import { renderMorning } from '../src/agents/focus.ts';
import { oneOnOneBrief, type BriefInput, type BriefLetter } from '../src/agents/one-on-one.ts';

const people = [
  { name: 'Наталья Фомина', email: 'natalia@example.test' },
  { name: 'Кирилл Белов', email: 'kirill@example.test' },
  { name: 'Вера Носова', email: 'vera@example.test' },
];

const promise = {
  at: '2026-12-07T09:00',
  title: '1:1 с Кириллом Беловым',
  steps: [{ owner: 'Наталья Фомина', task: 'Выбрать вариант запуска, когда Кирилл пришлёт оба варианта' }],
};

const options: BriefLetter = {
  at: '2026-12-09T11:00',
  fromName: 'Кирилл Белов',
  fromEmail: 'kirill@example.test',
  toEmail: 'natalia@example.test',
  subject: 'Варианты запуска',
  body: 'Оба варианта запуска: первый и второй.',
};

const reply: BriefLetter = {
  at: '2026-12-16T11:00',
  fromName: 'Наталья Фомина',
  fromEmail: 'natalia@example.test',
  toEmail: 'kirill@example.test',
  subject: 'Re: Варианты запуска',
  body: 'Берём второй.',
};

function brief(day: string, letters: BriefLetter[], tasks: BriefInput['tasks'] = []): ReturnType<typeof oneOnOneBrief> {
  return oneOnOneBrief({
    leaderName: 'Наталья Фомина',
    leaderEmail: 'natalia@example.test',
    until: `${day}T08:30`,
    people,
    meetings: [{ summary: '1:1 с Кириллом Беловым', startsAt: `${day}T09:00` }],
    letters,
    protocols: [promise],
    tasks,
  });
}

describe('контекст встречи один на один', () => {
  it('пока варианты не пришли, пункта нет', () => {
    expect(brief('2026-12-08', [])).toEqual([]);
  });

  it('после вариантов одна строка и два разных источника', () => {
    const [block] = brief('2026-12-15', [options]);
    expect(block.name).toBe('Кирилл Белов');
    expect(block.lines).toHaveLength(1);
    expect(block.lines[0].text).toContain('выбрать вариант');
    expect(block.lines[0].text).toContain('Кирилл прислал 9 декабря');
    expect(block.lines[0].sources.some((source) => source.startsWith('Протокол'))).toBe(true);
    expect(block.lines[0].sources.some((source) => source.startsWith('Письмо'))).toBe(true);
  });

  it('чужое письмо и открытая задача сотрудника строку не создают', () => {
    const other: BriefLetter = { ...options, subject: 'Отчёт по складу', body: 'Отчёт по складу готов.' };
    expect(brief('2026-12-15', [other])).toEqual([]);
    const [block] = brief('2026-12-15', [options], [{ key: 't-1', title: 'Запустить кампанию января', owner: 'Кирилл Белов', status: 'в работе' }]);
    expect(block.lines).toHaveLength(1);
    expect(block.lines[0].text).not.toContain('кампанию');
  });

  it('ответ руководителя снимает пункт к следующей встрече с тем же названием', () => {
    const shown = brief('2026-12-15', [options]);
    expect(shown).toHaveLength(1);
    expect(brief('2026-12-22', [options, reply])).toEqual([]);
  });

  it('блок стоит рядом со встречей и пропадает, когда пунктов нет', () => {
    const morning = {
      today: '2026-12-15',
      waiting: [],
      ownWeek: [],
      plan: [],
      returned: [],
      overdue: [],
      todayMeetings: ['09:00 1:1 с Кириллом Беловым'],
      questions: [],
      share: { onGoal: 0, total: 0, percent: 0 },
      oneOnOne: brief('2026-12-15', [options]),
    };
    const text = renderMorning(morning);
    expect(text).toMatch(/Встречи сегодня:.*\n\nЧто Кирилл Белов ждёт от вас:/s);
    expect(renderMorning({ ...morning, oneOnOne: [] })).not.toContain('ждёт от вас');
  });
});
