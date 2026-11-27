import { describe, expect, it } from 'vitest';
import { enforce, type ModelVerdict } from '../src/agents/k2.ts';
import { renderMorning } from '../src/agents/focus.ts';
import { leaderEditReport } from '../src/agents/k2-tools.ts';
import { revisionPrompt } from '../src/agents/revisions.ts';
import { acceptRewrite, dueFromInstruction, exampleBlock, finishDraft, localRewrite, mailRevisions, morningBlockOrder, replaceStepLine, ruleFromChoice, stepIndex } from '../src/agents/memory.ts';

const letter = 'Нужно подготовить справку по оттоку до 16 декабря. Клиент ждёт цифры.';
const rule = [{ area: 'письма', instead: 'В письмах команде начинай с действия и срока' }];

describe('профиль и память', () => {
  it('обычная правка меняет письмо и не подставляет просьбу', () => {
    const source = 'Здравствуйте! Отчёт готов. Вышлю во вторник.';
    const greeting = acceptRewrite(source, 'Убери приветствие', localRewrite(source, 'Убери приветствие') ?? '');
    expect(greeting).toBe('Отчёт готов. Вышлю во вторник.');
    const shorter = acceptRewrite(source, 'Сделай ответ короче', localRewrite(source, 'Сделай ответ короче') ?? 'Сделай ответ короче');
    expect(shorter).toBeTruthy();
    expect(shorter).not.toContain('Сделай ответ короче');
    expect(shorter!.toLowerCase()).toContain('вторник');
    expect(shorter!.toLowerCase()).toContain('отчёт');
    expect(shorter!.length).toBeLessThan(source.length);
    expect(acceptRewrite(source, 'Сделай ответ короче', 'Сделай ответ короче')).toBeNull();
    expect(acceptRewrite(source, 'Убери приветствие', source)).toBeNull();
  });

  it('разбор письма не получает правила протоколов и утра', () => {
    const rows = [
      { area: 'протоколы', category: 'протоколы', instead: 'Сроки пиши в конце протокола' },
      { area: 'утро', category: 'утро', instead: 'сначала просроченные задачи' },
      { area: 'письма', category: 'письма', instead: 'Без приветствия' },
      { category: 'протокол', instead: 'Старая правка протокола' },
    ];
    expect(mailRevisions(rows).map((row) => row.instead)).toEqual(['Без приветствия']);
    expect(leaderEditReport(rows)).toContain('Без приветствия');
    expect(leaderEditReport(rows)).not.toContain('протокола');
    expect(leaderEditReport(rows)).not.toContain('просроченные');
    expect(leaderEditReport([{ area: 'протоколы', category: 'протоколы', instead: 'Сроки пиши в конце протокола' }])).toBe('Правок нет');
    expect(revisionPrompt(rows)).toContain('Без приветствия');
    expect(revisionPrompt(rows)).not.toContain('протокола');
  });

  it('запомнить создаёт правило, утверждение и разовая правка — нет', () => {
    expect(ruleFromChoice('В письмах команде начинай с действия и срока', 'keep')).toBe('В письмах команде начинай с действия и срока');
    expect(ruleFromChoice('В письмах команде начинай с действия и срока', 'once')).toBeNull();
    expect(ruleFromChoice('В письмах команде начинай с действия и срока', 'approve')).toBeNull();
  });

  it('ответ сотруднику начинается с действия и срока этого письма и без служебной фразы', () => {
    const draft = finishDraft('Ольга, беру в работу.', letter, rule, true);
    expect(draft.startsWith('Подготовить справку по оттоку, до 16 декабря.')).toBe(true);
    expect(draft).not.toContain('По вашей правке');
    expect(draft).not.toContain('начинай с действия');
    expect(finishDraft('Ольга, беру в работу.', letter, rule, false)).toBe('Ольга, беру в работу.');
  });

  it('правило стиля не снимает подтверждение по деньгам', () => {
    const model: ModelVerdict = {
      действие: 'ответить',
      кому_передать: '',
      в_полномочиях: 'да',
      есть_предложение: 'да',
      только_руководитель: 'нет',
      категория: 'иное',
      суть: 'Скидка',
      контекст: '',
      рекомендация: '',
      черновик_ответа: 'Согласовано',
      основание: '',
      риски: '',
      если_не_решить: '',
      предложение_полномочия: '',
      уверенность: 1,
    };
    const ruled = enforce(model, 'Прошу скидку 12% до 16 декабря', 5, null, false);
    expect(ruled.ask).toBe(true);
    expect(finishDraft(ruled.draft, 'Прошу скидку 12% до 16 декабря', rule, true)).not.toContain('По вашей правке');
  });

  it('разовая правка срока не становится порядком следующего протокола', () => {
    const steps = [
      { owner: 'Ольга Смирнова', task: 'Отправить клиенту коммерческое предложение для «ТехноСтрой» без согласования', due: '2026-12-14' },
      { owner: 'Мария Лебедева', task: 'Принести график замен', due: '2026-12-15' },
    ];
    const instruction = `Перенеси срок поручения «${steps[0]?.task}» на пятницу 18 декабря`;
    expect(dueFromInstruction(instruction, 2026)).toBe('2026-12-18');
    expect(stepIndex(steps, instruction)).toBe(0);
    const next = { ...steps[1] };
    const body = `Дальше:\n— ${steps[0]?.owner}: ${steps[0]?.task}, до 14 декабря`;
    const changed = replaceStepLine(body, steps[0]!, { ...steps[0]!, due: '2026-12-18' });
    expect(changed).toContain('до 18 декабря');
    expect(next?.due).toBe('2026-12-15');
    expect(ruleFromChoice(instruction, 'once')).toBeNull();
  });

  it('утренний порядок применяется и снимается вместе с правилом', () => {
    const phrase = 'сначала просроченные задачи, затем ожидающие решения';
    expect(morningBlockOrder([phrase]).indexOf('overdue')).toBeLessThan(morningBlockOrder([phrase]).indexOf('waiting'));
    expect(morningBlockOrder([]).indexOf('waiting')).toBeLessThan(morningBlockOrder([]).indexOf('overdue'));
    const input = {
      today: '2026-12-11',
      waiting: [{ who: 'Ольга', what: 'Скидка', days: 1 }],
      ownWeek: [],
      plan: [],
      returned: [],
      overdue: [{ title: 'Прогноз', owner: 'Алексей', days: 10 }],
      todayMeetings: [],
      questions: [],
      share: { onGoal: 0, total: 0, percent: 0 },
    };
    const changed = renderMorning({ ...input, rules: [phrase] });
    const usual = renderMorning(input);
    expect(changed.indexOf('Просрочено у сотрудников')).toBeLessThan(changed.indexOf('Ждут вашего решения'));
    expect(usual.indexOf('Ждут вашего решения')).toBeLessThan(usual.indexOf('Просрочено у сотрудников'));
  });

  it('примеры берутся из решений руководителя, не из действий помощника', () => {
    const text = exampleBlock('подготовить справку по оттоку', [
      { subject: 'Справка по оттоку', action: 'утвердил', approvedText: 'Подготовить справку, до 16 декабря.', auto: false },
      { subject: 'Справка по оттоку', action: 'ответил сам', approvedText: 'Уже ответил.', auto: true },
    ]);
    expect(text).toContain('утвердил');
    expect(text).not.toContain('ответил сам');
  });
});
