import { describe, expect, it } from 'vitest';
import { protocolRelease, renderProtocol } from '../src/agents/protocol.ts';
import {
  cleanMeetings,
  cleanPrior,
  cleanSteps,
  openWithMeetings,
  priorEffects,
  lettersToSend,
  mailResultLine,
  protocolLetters,
  reminderItems,
  storedMailed,
  reminderLetters,
  replaceSection,
  scheduledMeetings,
  stepLine,
} from '../src/agents/protocol-steps.ts';
import { isLeaderTask } from '../src/agents/focus.ts';
import { assigneeLogin } from '../src/yandex/tracker.ts';

// Люди и поручения выдуманы: этого протокола нет в синтетике.
const known = [
  { name: 'Инга Волкова', email: 'inga@example.test' },
  { name: 'Борис Ким', email: 'boris@example.test' },
  { name: 'Руководитель Тест', email: 'lead@example.test' },
];

describe('одно поручение — одна задача', () => {
  it('у одного человека три поручения с разными сроками, чужой исполнитель — «не назван»', () => {
    const steps = cleanSteps(
      [
        { owner: 'Инга Волкова', task: 'Письмо клиенту сегодня', due: '2026-12-10' },
        { owner: 'Инга', task: 'Коммерческое предложение', due: '2026-12-14' },
        { owner: 'Инга Волкова', task: 'Инга Волкова: абзац к совету', due: '2026-12-18' },
        { owner: 'Незнакомец', task: 'Сверить архив', due: '' },
        { owner: 'Инга Волкова', task: 'Лишнее', due: '14 декабря' },
      ],
      known,
    );
    expect(steps.map((step) => step.owner)).toEqual(['Инга Волкова', 'Инга Волкова', 'Инга Волкова', 'не назван', 'Инга Волкова']);
    expect(steps.map((step) => step.due)).toEqual(['2026-12-10', '2026-12-14', '2026-12-18', '', '']);
    expect(steps[2]?.task).toBe('абзац к совету');
    expect(stepLine(steps[1]!)).toBe('Инга Волкова: Коммерческое предложение, до 14 декабря');
    const body = renderProtocol({
      theme: 'Смена цеха',
      participants: ['Инга Волкова'],
      previous: [],
      notes: ['Коротко'],
      decisions: ['Оставить'],
      next: [],
      steps,
      proposals: [],
      open: [],
    });
    expect(body).toContain('— Инга Волкова: Коммерческое предложение, до 14 декабря');
    const release = protocolRelease(body, known, new Date('2026-12-10T07:00:00Z'), 'new1', null, '2026-12-10', 'leader', steps);
    expect(release.tasks.map((task) => [task.owner, task.title, task.dueOn])).toEqual(steps.map((step) => [step.owner, step.task, step.due]));
    expect(isLeaderTask('не назван', 'Руководитель Тест')).toBe(true);
    expect(isLeaderTask('Инга Волкова', 'Руководитель Тест')).toBe(false);
  });

  it('старый протокол строками по-прежнему читается', () => {
    const body = ['Сверка', '', 'Участники: Инга Волкова.', '', 'Дальше:', '— Инга Волкова пришлёт план до 14 декабря.', ''].join('\n');
    const release = protocolRelease(body, known, new Date('2026-12-10T07:00:00Z'), 'old', null, '2026-12-10', 'leader');
    expect(release.tasks).toEqual([{ title: 'Инга Волкова пришлёт план до 14 декабря.', owner: 'Инга Волкова', dueOn: '2026-12-14' }]);
  });
});

describe('новый протокол закрывает задачи старого', () => {
  it('«сделано» закрывает, «просрочено» комментирует, остальное не трогает', () => {
    const tasks = [{ externalId: 'protocol-old-p1' }, { externalId: 'protocol-old-p2' }, { externalId: 'protocol-old-p3' }];
    const prior = cleanPrior(
      [
        { n: 1, status: 'сделано', note: 'Ответ ушёл' },
        { n: 2, status: 'просрочено', note: 'Срок прошёл' },
        { n: 3, status: 'не обсуждали', note: '' },
        { n: 9, status: 'сделано', note: 'нет такой' },
      ],
      tasks.length,
    );
    expect(priorEffects(tasks, prior, '2026-12-11')).toEqual({
      closeIds: ['protocol-old-p1'],
      comments: [{ externalId: 'protocol-old-p2', text: 'Просрочено по протоколу 11 декабря' }],
    });
  });
});

describe('письмо каждому участнику', () => {
  it('восемь участников и руководитель, в письме человека только его поручения', () => {
    const people = Array.from({ length: 8 }, (_, index) => ({ name: `Человек ${index + 1}`, email: `p${index}@example.test` }));
    const leader = { name: 'Руководитель Тест', email: 'lead@example.test' };
    const letters = protocolLetters({
      theme: 'Смена цеха',
      body: 'Смена цеха\n\nДальше:\n— Человек 1: отчёт',
      tasks: [{ title: 'отчёт', owner: 'Человек 1', dueOn: '2026-12-14' }],
      participants: people.map((person) => person.name),
      known: [...people, leader],
      leaderName: leader.name,
      place: 'Протокол лежит в описании встречи в календаре: Смена цеха, 10 декабря, 10:00.',
    });
    expect(letters).toHaveLength(9);
    expect(letters.filter((letter) => letter.toName !== leader.name)).toHaveLength(8);
    const own = letters.find((letter) => letter.toName === 'Человек 1');
    const other = letters.find((letter) => letter.toName === 'Человек 2');
    expect(own?.text.split('\n\n')[0]).toBe('Кому: Человек 1 <p0@example.test>\nСтенд отправляет письма помощника в тестовый ящик, получатель назван выше.');
    expect(own?.text.split('\n\n')[1]).toBe('Ваши поручения:\n— отчёт, до 14 декабря');
    expect(own?.text.split('\n\n')[1]).not.toContain('Человек 2');
    expect(other?.text.split('\n\n')[1]).toBe('Ваши поручения: поручений нет.');
    const toLeader = letters.find((letter) => letter.toName === leader.name);
    expect(toLeader?.text).toContain('— Человек 1: отчёт, до 14 декабря');
    expect(toLeader?.text).toContain('— Человек 2: поручений нет');
    expect(toLeader?.subject).toBe('Протокол: Смена цеха');
  });

  it('повтор досылает только тех, кому письмо не ушло; старый протокол без списка не трогает', () => {
    const letters = [
      { toName: 'Инга Волкова' },
      { toName: 'Борис Ким' },
      { toName: 'Алёна Север' },
    ];
    expect(storedMailed(null)).toBeNull();
    expect(storedMailed(['инга волкова', 'Алена Север'])).toEqual(['инга волкова', 'алена север']);
    expect(lettersToSend(letters, ['инга волкова', 'алена север']).map((letter) => letter.toName)).toEqual(['Борис Ким']);
    expect(mailResultLine({ sent: 2, total: 3, failed: ['Борис Ким'], again: false })).toBe(
      'Писем в тестовый ящик: 2 из 3. Не ушли: Борис Ким. Повторное «Утвердить» дошлёт только их.',
    );
    expect(mailResultLine({ sent: 1, total: 3, failed: [], again: true })).toBe('Дослано писем: 1. Всего ушло: 3 из 3.');
  });
});

describe('исполнитель в Трекере', () => {
  const users = [
    { login: 'inga', display: 'Инга Волкова', email: 'inga@example.test' },
    { login: 'boris', display: 'Другое имя', email: 'boris@example.test' },
  ];

  it('назначает по имени или адресу, чужого и «не назван» не назначает', () => {
    expect(assigneeLogin('Инга Волкова', users)).toBe('inga');
    expect(assigneeLogin('инга волкова', users)).toBe('inga');
    expect(assigneeLogin('Борис Ким', users, 'boris@example.test')).toBe('boris');
    expect(assigneeLogin('Борис Ким', users)).toBe('');
    expect(assigneeLogin('не назван', users, 'inga@example.test')).toBe('');
  });
});

describe('напоминания о сроке', () => {
  it('сегодня и просрочка, повтор в тот же день пустой, задачи руководителя нет', () => {
    const tasks = [
      { key: 'a', title: 'Инга Волкова: отчёт', owner: 'Инга Волкова', dueOn: '2026-12-11', status: 'в работе' },
      { key: 'b', title: 'договор', owner: 'Борис Ким', dueOn: '2026-12-01', status: 'в работе' },
      { key: 'c', title: 'бюджет', owner: 'Руководитель Тест', dueOn: '2026-12-01', status: 'в работе' },
      { key: 'd', title: 'позже', owner: 'Инга Волкова', dueOn: '2026-12-18', status: 'в работе' },
      { key: 'e', title: 'закрыто', owner: 'Инга Волкова', dueOn: '2026-12-01', status: 'закрыта' },
    ];
    const first = reminderItems(tasks, '2026-12-11', 'Руководитель Тест', new Set());
    expect(first.map((item) => item.key).sort()).toEqual(['a', 'b']);
    expect(first.find((item) => item.key === 'a')?.title).toBe('отчёт');
    const letters = reminderLetters(first, known);
    expect(letters.map((letter) => letter.toName).sort()).toEqual(['Борис Ким', 'Инга Волкова']);
    expect(letters.find((letter) => letter.toName === 'Инга Волкова')?.text).toContain('Срок сегодня:\n— отчёт');
    expect(letters.find((letter) => letter.toName === 'Борис Ким')?.text).toContain('Просрочено:\n— договор — просрочено на 10 дней');
    const again = reminderItems(tasks, '2026-12-11', 'Руководитель Тест', new Set(first.map((item) => item.key)));
    expect(again).toEqual([]);
  });
});

describe('новые встречи из протокола', () => {
  it('со датой и временем ставится в календарь, без времени — в открытые вопросы', () => {
    const meetings = cleanMeetings([
      { title: 'Один на один', date: '2026-12-11', time: '16:00', participants: ['Инга Волкова'] },
      { title: 'Разбор кампании', date: '2026-12-12', time: '', participants: ['Борис Ким'] },
    ]);
    expect(scheduledMeetings('leader', 'new1', meetings)).toEqual([
      { uid: 'leader:protocol-new1-m1', date: '2026-12-11', time: '16:00', title: 'Один на один', participants: ['Инга Волкова'] },
    ]);
    expect(openWithMeetings(['Кто ведёт'], meetings)).toEqual(['Кто ведёт', 'Встреча «Разбор кампании» с Борис Ким — нет даты или времени']);
    const body = 'Смена\n\nДальше:\n— старое\n\nОткрытые вопросы:\n— вопрос';
    expect(replaceSection(body, 'Дальше:', ['Инга Волкова: отчёт, до 14 декабря'])).toBe(
      'Смена\n\nДальше:\n— Инга Волкова: отчёт, до 14 декабря\n\nОткрытые вопросы:\n— вопрос',
    );
  });
});
