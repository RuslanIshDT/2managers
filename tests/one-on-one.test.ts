import { describe, expect, it } from 'vitest';
import { renderMorning, morningHtml } from '../src/agents/focus.ts';
import { letterById, liveLetterId, parseMailboxSource } from '../src/mail.ts';
import { blocksFromVerdicts, briefPackets, oneOnOneBrief, type BriefInput, type BriefLetter, type MeetingPacket, type TurnVerdict } from '../src/agents/one-on-one.ts';

const people = [
  { name: 'Наталья Фомина', email: 'natalia@example.test' },
  { name: 'Кирилл Белов', email: 'kirill@example.test' },
  { name: 'Вера Носова', email: 'vera@example.test' },
];

const promise = {
  id: 'proto-1',
  at: '2026-12-07T09:00',
  title: '1:1 с Кириллом Беловым',
  steps: [{ owner: 'Наталья Фомина', task: 'Выбрать вариант запуска, когда Кирилл пришлёт оба варианта' }],
};

const options: BriefLetter = {
  id: 'letter-options',
  at: '2026-12-09T11:00',
  fromName: 'Кирилл Белов',
  fromEmail: 'kirill@example.test',
  toEmail: 'natalia@example.test',
  subject: 'Варианты запуска',
  body: 'Оба варианта запуска: первый и второй.',
};

function input(day: string, letters: BriefLetter[], tasks: BriefInput['tasks'] = [], protocols = [promise]): BriefInput {
  return {
    leaderName: 'Наталья Фомина',
    leaderEmail: 'natalia@example.test',
    leaderMailbox: 'boss@example.test',
    origin: 'https://stand.example',
    until: `${day}T08:30`,
    people,
    meetings: [{ summary: '1:1 с Кириллом Беловым', startsAt: `${day}T09:00` }],
    letters,
    protocols,
    tasks,
  };
}

function waiting(packet: MeetingPacket, action: string, ids: string[]): TurnVerdict {
  return { waiting: true, action, reason: '', sourceIds: ids.length ? ids : packet.sources.map((source) => source.id) };
}

describe('контекст встречи один на один', () => {
  it('собирает протокол и письма сотрудника и не берёт чужое письмо', () => {
    const empty = briefPackets(input('2026-12-08', []));
    expect(empty).toHaveLength(1);
    expect(empty[0]?.sources.map((source) => source.id)).toEqual(['p:proto-1']);
    const packet = briefPackets(input('2026-12-15', [options]))[0];
    expect(packet?.sources.map((source) => source.id)).toEqual(['p:proto-1', 'm:letter-options']);
    const other: BriefLetter = { ...options, id: 'other', subject: 'Отчёт по складу', body: 'Отчёт по складу готов.', fromName: 'Вера Носова', fromEmail: 'vera@example.test' };
    expect(briefPackets(input('2026-12-15', [other]))[0]?.sources.some((source) => source.id === 'm:other')).toBe(false);
  });

  it('строка есть только если модель ждёт действия и назвала существующий источник', () => {
    const [packet] = briefPackets(input('2026-12-15', [options]));
    expect(packet).toBeTruthy();
    const shown = blocksFromVerdicts([packet!], [waiting(packet!, 'Выбрать вариант запуска.', ['p:proto-1', 'm:letter-options'])]);
    expect(shown[0]?.name).toBe('Кирилл Белов');
    expect(shown[0]?.lines[0]?.text).toContain('вариант запуска');
    expect(shown[0]?.lines[0]?.sources.some((source) => source.href.includes('#protocol-'))).toBe(true);
    expect(shown[0]?.lines[0]?.sources.some((source) => source.href.includes('#letter-'))).toBe(true);
    const earlyDecision = blocksFromVerdicts([packet!], [{ waiting: false, action: 'нет', reason: 'руководитель решил', sourceIds: ['p:proto-1'] }]);
    expect(earlyDecision[0]?.lines).toHaveLength(1);
    expect(blocksFromVerdicts([packet!], [{ waiting: false, action: 'Выбрать вариант', reason: 'руководитель решил', sourceIds: ['m:letter-options'] }])[0]?.lines).toHaveLength(1);
    expect(blocksFromVerdicts([packet!], [{ waiting: true, action: 'Выбрать', reason: '', sourceIds: ['letter-options'] }])[0]?.lines).toHaveLength(1);
    const missing = blocksFromVerdicts([packet!], [{ waiting: true, action: 'Выбрать', reason: '', sourceIds: ['нет-такого'] }]);
    expect(missing[0]?.lines[0]?.text).toContain('Выбрать');
    expect(missing[0]?.lines[0]?.sources.some((source) => source.href.includes('letter-options'))).toBe(true);
    expect(blocksFromVerdicts([packet!], [{ waiting: true, action: '  ', reason: '', sourceIds: ['p:proto-1'] }])[0]?.lines[0]?.text).toContain('не смог проверить');
  });

  it('закрытая задача входит, если она не раньше писем и протокола', () => {
    const open = briefPackets(input('2026-12-15', [options], [{ key: 't-1', title: 'Запустить кампанию января', owner: 'Кирилл Белов', status: 'в работе' }]));
    expect(open[0]?.sources.some((source) => source.id === 't:t-1' && source.role === 'задача')).toBe(true);
    const early = briefPackets(input('2026-12-15', [options], [{ key: 'QUEUE-1', title: 'Выбрать вариант запуска', owner: 'Кирилл Белов', status: 'закрыта', closedAt: '2026-12-01' }]));
    expect(early[0]?.sources.some((source) => source.id === 't:QUEUE-1')).toBe(false);
    const later = briefPackets(input('2026-12-15', [options], [{ key: 'QUEUE-7', title: 'Выбрать вариант запуска', owner: 'Кирилл Белов', status: 'закрыта', closedAt: '2026-12-10' }]));
    const task = later[0]?.sources.find((source) => source.id === 't:QUEUE-7');
    expect(task?.role).toBe('задача_закрыта');
    expect(task?.text).toContain('Статус: закрыта');
    expect(blocksFromVerdicts(later, [{ waiting: false, action: 'Выбрать', reason: 'задача закрыта', sourceIds: ['t:QUEUE-7'] }])).toEqual([]);
    const beforeLetter = blocksFromVerdicts(later, [{ waiting: false, action: 'Выбрать', reason: 'задача закрыта', sourceIds: ['t:QUEUE-1'] }]);
    expect(beforeLetter[0]?.lines).toHaveLength(1);
    const decision = {
      id: 'letter-decision',
      at: '2026-12-16T11:00',
      fromName: 'Наталья Фомина',
      fromEmail: 'natalia@example.test',
      toEmail: 'kirill@example.test',
      subject: 'Re: Варианты запуска',
      body: 'Делаем по второму.',
    };
    const after = briefPackets(input('2026-12-22', [options, decision]))[0];
    expect(blocksFromVerdicts([after!], [{ waiting: false, action: 'нет', reason: 'руководитель решил', sourceIds: ['m:letter-decision'] }])).toEqual([]);
    const newer = blocksFromVerdicts([after!], [{ waiting: false, action: 'Посмотреть новый вариант', reason: 'руководитель решил', sourceIds: ['m:letter-decision', 'нет-письма'] }]);
    expect(newer).toEqual([]);
    const stale = blocksFromVerdicts([after!], [{ waiting: false, action: 'Посмотреть', reason: 'руководитель решил', sourceIds: ['m:missing'] }]);
    expect(stale[0]?.lines[0]?.sources.some((source) => source.href.includes('letter-options') || source.href.includes('letter-decision'))).toBe(true);
  });

  it('пустой ответ, ответ не по схеме и сбой оставляют строку с пометкой', async () => {
    const [packet] = briefPackets(input('2026-12-15', [options]));
    const empty = blocksFromVerdicts([packet!], [{ waiting: false, action: '', reason: '', sourceIds: [] }]);
    expect(empty[0]?.lines[0]?.text).toContain('не смог проверить');
    expect(empty[0]?.lines[0]?.text).toContain('Варианты запуска');
    const broken = await oneOnOneBrief(input('2026-12-15', [options]), async () => {
      throw new Error('сбой');
    });
    expect(broken[0]?.lines[0]?.text).toContain('не смог проверить');
    expect(blocksFromVerdicts([{ ...packet!, sources: [] }], [{ waiting: true, action: 'Выбрать', reason: '', sourceIds: [] }])).toEqual([]);
  });

  it('письмо из отправленных находится по тому же номеру, что в ссылке', () => {
    const messageId = '<sent-choice@example.test>';
    const parsed = parseMailboxSource(
      [
        'From: Наталья Фомина <natalia@example.test>',
        'To: <kirill@example.test>',
        'Subject: Vybor',
        'Date: Tue, 16 Dec 2026 11:00:00 +0300',
        `Message-ID: ${messageId}`,
        '',
        'Делаем по второму.',
      ].join('\n'),
    );
    expect(parsed?.id).toBe(liveLetterId(messageId));
    expect(letterById(parsed ? [parsed] : [], parsed?.id ?? '')?.body).toContain('Делаем по второму');
    expect(letterById([], messageId)).toBeNull();
  });

  it('блок стоит рядом со встречей и пропадает, когда пунктов нет', () => {
    const [packet] = briefPackets(input('2026-12-15', [options]));
    const oneOnOne = blocksFromVerdicts([packet!], [waiting(packet!, 'Выбрать вариант запуска.', [])]);
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
      oneOnOne,
    };
    const text = renderMorning(morning);
    expect(text).toMatch(/Встречи сегодня:.*\n\nЧто Кирилл Белов ждёт от вас:/s);
    expect(morningHtml(text)).toContain('<a href="https://stand.example/#protocol-proto-1">');
    expect(morningHtml(text)).toContain('<a href="https://stand.example/#letter-letter-options">');
    expect(renderMorning({ ...morning, oneOnOne: [] })).not.toContain('ждёт от вас');
  });
});

const live = process.env.ONE_ON_ONE_LIVE ? it : it.skip;

live('модель отличает переданный ход, обещание прислать позже и закрытый вопрос', async () => {
  const cases: { body: string; waiting: boolean; letters?: BriefLetter[] }[] = [
    { body: 'Оба варианта запуска: первый и второй.', waiting: true },
    { body: 'Ещё готовлю, пришлю завтра.', waiting: false },
    { body: 'Оба варианта приложены.', waiting: true },
    { body: 'Варианты по ссылке https://files.example/launch', waiting: true },
    { body: 'Вот два макета, созвонимся завтра.', waiting: true },
    { body: 'Скину варианты к вечеру.', waiting: false },
  ];
  for (const item of cases) {
    const letter = { ...options, body: item.body };
    const blocks = await oneOnOneBrief(input('2026-12-15', item.letters ?? [letter]));
    expect(blocks.length > 0, item.body).toBe(item.waiting);
  }
  const later: BriefLetter = {
    id: 'letter-reply',
    at: '2026-12-16T11:00',
    fromName: 'Наталья Фомина',
    fromEmail: 'natalia@example.test',
    toEmail: 'kirill@example.test',
    subject: 'Re: Варианты запуска',
    body: 'Делаем по второму.',
  };
  const closed = await oneOnOneBrief(input('2026-12-22', [options, later]));
  expect(closed).toEqual([]);
  const thanks: BriefLetter = { ...later, id: 'thanks', body: 'Спасибо, посмотрю завтра.' };
  const open = await oneOnOneBrief(input('2026-12-22', [options, thanks]));
  expect(open.length).toBeGreaterThan(0);
  const closedTask = await oneOnOneBrief(input('2026-12-15', [], [{ key: 'QUEUE-9', title: 'Выбрать вариант запуска', owner: 'Кирилл Белов', status: 'закрыта', closedAt: '2026-12-10' }], []));
  expect(closedTask).toEqual([]);
  const again: BriefLetter = { ...options, id: 'letter-new', at: '2026-12-12T11:00', body: 'Появился третий вариант, посмотрите его.' };
  const reopened = await oneOnOneBrief(
    input('2026-12-15', [again], [{ key: 'QUEUE-9', title: 'Выбрать вариант запуска', owner: 'Кирилл Белов', status: 'закрыта', closedAt: '2026-12-10' }]),
  );
  expect(reopened.length).toBeGreaterThan(0);
}, 180_000);
