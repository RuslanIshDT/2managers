import { describe, expect, it } from 'vitest';
import { hashPassword, hashToken, verifyPassword } from '../src/auth.ts';
import { checkDepartment, readDepartment } from '../src/agents/k1.ts';
import { chainKey, discountLimit, enforce, textSignals, type ModelVerdict } from '../src/agents/k2.ts';
import { lettersForMailbox } from '../src/agents/intake.ts';
import { loadSynthetic } from '../src/data/synthetic.ts';
import { parseMailboxSource, syntheticSource } from '../src/mail.ts';
import { applyOrigin, formOrigin, requestOrigin } from '../src/http/origin.ts';
import { mailConfig } from '../src/mail.ts';
import { staffCard } from '../src/agents/dependence.ts';
import { departmentMatrix, goalMinutes, morningLines } from '../src/agents/focus.ts';
import { burningSeries, noteToSend, weeklyNotes } from '../src/agents/mirror.ts';
import { letterHits, replayWeek, rulesFromAudit, trustOffers, waitingHours } from '../src/agents/replay.ts';
import { finishTemplate, hasProposal } from '../src/agents/k2.ts';
import { decisionCallback, parseCallback, parseRuleCallback, parseStart } from '../src/telegram.ts';

describe('синтетика D2', () => {
  it('загружает профиль, людей, письма, встречи и задачи', async () => {
    const data = await loadSynthetic('data/synthetic');
    expect(data.profile).toContain('Иван Петров');
    expect(data.people).toHaveLength(12);
    expect(data.emails).toHaveLength(80);
    expect(data.emailEtalon.size).toBe(80);
    expect(data.meetings).toHaveLength(50);
    expect(data.tasks).toHaveLength(12);
    expect(data.emails[0]).not.toHaveProperty('category');
  });
});

describe('отдел D4', () => {
  it('раскладывает цели и оставляет проверки K2 и K3 видимыми', async () => {
    const data = await loadSynthetic('data/synthetic');
    const files = await readDepartment('data/synthetic');
    const checked = checkDepartment(data.people, files);
    expect(checked.errors).toEqual([]);
    expect(checked.cards).toHaveLength(7);

    const olga = checked.cards.find((card) => card.name === 'Ольга Смирнова');
    const maria = checked.cards.find((card) => card.name === 'Мария Лебедева');
    const sergey = checked.cards.find((card) => card.name === 'Сергей Морозов');
    const dmitry = checked.cards.find((card) => card.name === 'Дмитрий Козлов');
    expect(olga?.leaderGoal).toBe('1');
    expect(sergey?.leaderGoal).toBe('2');
    expect(maria?.leaderGoal).toBe('3');
    expect(Number(olga?.authorities.find((item) => item.area === 'скидка')?.limit)).toBeLessThan(12);
    expect(maria?.kpis.some((kpi) => kpi.name.toLowerCase().includes('время ответа'))).toBe(true);
    const lagging = dmitry?.kpis[0]?.weeks.filter((week) => week.status === 'отстаёт') ?? [];
    expect(lagging.length).toBeGreaterThanOrEqual(3);
    const dmitryPerson = data.people.find((person) => person.name === 'Дмитрий Козлов');
    expect(data.emails.filter((email) => email.fromEmail === dmitryPerson?.email)).toHaveLength(0);
  });

  it('показывает ошибку, если у подчинённого нет полномочий', () => {
    const people = [{ id: 'p02', name: 'Ольга Смирнова', role: 'подчинённый' }];
    const files = {
      department: [{ personId: 'p02', zone: 'Продажи', goal: 'План', leaderGoal: '1' }],
      kpis: [
        { personId: 'p02', kpiId: 'k', name: 'План', unit: '%', better: 'больше', week: '2026-11-09', plan: '100', fact: '100' },
        { personId: 'p02', kpiId: 'k', name: 'План', unit: '%', better: 'больше', week: '2026-11-16', plan: '100', fact: '100' },
        { personId: 'p02', kpiId: 'k', name: 'План', unit: '%', better: 'больше', week: '2026-11-23', plan: '100', fact: '100' },
        { personId: 'p02', kpiId: 'k', name: 'План', unit: '%', better: 'больше', week: '2026-11-30', plan: '100', fact: '100' },
        { personId: 'p02', kpiId: 'k', name: 'План', unit: '%', better: 'больше', week: 'квартал', plan: '100', fact: '100' },
      ],
      authorities: [],
    };
    const checked = checkDepartment(people, files);
    expect(checked.errors.join(' ')).toContain('нет полномочий');
    expect(checked.cards).toHaveLength(0);
  });
});

describe('пароль', () => {
  it('проверяет scrypt и не принимает чужой пароль', async () => {
    const stored = await hashPassword('секрет');
    expect(await verifyPassword('секрет', stored)).toBe(true);
    expect(await verifyPassword('другой', stored)).toBe(false);
    expect(await verifyPassword('секрет', 'нет')).toBe(false);
  });

  it('хеширует токен сессии стабильно', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('адрес стенда', () => {
  it('подставляет STAND_ORIGIN в форму', () => {
    expect(formOrigin({ host: 'localhost:8090' }, 'https://stand.example:8443')).toBe('https://stand.example:8443');
    expect(applyOrigin('см. {{origin}}/audit/', 'https://stand.example:8443')).toBe('см. https://stand.example:8443/audit/');
  });

  it('без фиксированного адреса берёт заголовок прокси', () => {
    expect(requestOrigin({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'stand.example:8443' })).toBe(
      'https://stand.example:8443',
    );
  });
});

describe('почта и кнопки', () => {
  it('без учётных данных почта не настроена', () => {
    const prevUser = process.env.YANDEX_MAIL_USER;
    const prevPass = process.env.YANDEX_MAIL_PASSWORD;
    delete process.env.YANDEX_MAIL_USER;
    delete process.env.YANDEX_MAIL_PASSWORD;
    expect(mailConfig()).toBeNull();
    if (prevUser) process.env.YANDEX_MAIL_USER = prevUser;
    if (prevPass) process.env.YANDEX_MAIL_PASSWORD = prevPass;
  });

  it('разбирает кнопку решения и команду /start', () => {
    expect(parseCallback(decisionCallback('approve', 'm062'))).toEqual({ action: 'approve', decisionId: 'm062' });
    expect(parseCallback('что-то')).toBeNull();
    expect(parseStart('/start abc12')).toBe('abc12');
    expect(parseStart('/start')).toBe('');
    expect(parseStart('привет')).toBeNull();
    expect(parseRuleCallback('r:accept:week')).toBe('week');
    expect(parseRuleCallback('d:approve:m062')).toBeNull();
  });
});

describe('цена аудита', () => {
  it('берёт цену примера и не пускает прогон модели без подтверждения', async () => {
    const { assertAuditConfirm, quoteOf } = await import('../src/jobs/flow-audit-job.ts');
    expect(quoteOf({ calls: 35, costUsd: 0.697 })).toEqual({ calls: 35, costUsd: 0.697 });
    expect(() => quoteOf({ calls: 0, costUsd: 1 })).toThrow(/цены/);
    expect(() => assertAuditConfirm('model', undefined)).toThrow(/подтверждение/);
    expect(() => assertAuditConfirm('model', true)).not.toThrow();
    expect(() => assertAuditConfirm('from-json', undefined)).not.toThrow();
  });
});

const modelReturn: ModelVerdict = {
  вердикт: 'вернуть',
  в_полномочиях: 'да',
  есть_предложение: 'да',
  только_руководитель: 'нет',
  категория: 'иное',
  суть: 'Жалоба на сроки',
  контекст: '',
  рекомендация: '',
  черновик_ответа: 'Мария, это твоя зона. Какой план?',
  предложение_полномочия: 'Оставить разбор жалоб на сервис',
  основание: 'Зона сервиса',
  риски: '',
  если_не_решить: '',
  уверенность: 0.8,
};

describe('просьба подчинённого', () => {
  it('скидка выше лимита идёт к руководителю, повтор не спрашивает, N1 само не уходит', () => {
    const text = 'Скидка 12% для «Ромашка-Ритейл», маржа 18%';
    expect(textSignals(text).discountPercent).toBe(12);
    const over = enforce(modelReturn, text, 10, null, false);
    expect(over.kind).toBe('нужен_руководитель');
    expect(over.category).toBe('деньги');
    expect(over.ask).toBe(true);
    expect(over.send).toBe(false);
    const again = enforce(modelReturn, text, 10, { id: 'm062', status: 'ждёт', summary: 'скидка' }, false);
    expect(again.kind).toBe('повтор');
    expect(again.ask).toBe(false);
    expect(again.send).toBe(false);
    const vacation = enforce(modelReturn, 'Прошу согласовать отпуск Ирины', null, null, false);
    expect(vacation.kind).toBe('нужен_руководитель');
    expect(vacation.category).toBe('кадры');
    expect(vacation.send).toBe(false);
  });

  it('жалоба без признаков N1 возвращается исполнителю', () => {
    const text = 'Клиент недоволен временем ответа. Предлагаю разбор на планёрке.';
    const ruled = enforce({ ...modelReturn, суть: 'Жалоба' }, text, null, null, false);
    expect(ruled.kind).toBe('вернуть');
    expect(ruled.send).toBe(true);
    expect(ruled.ask).toBe(false);
  });

  it('в ящик попадают 8 разных просьб и повтор m079 той же цепочки', async () => {
    const data = await loadSynthetic('data/synthetic');
    const subs = new Set(data.people.filter((person) => person.role === 'подчинённый').map((person) => person.email.toLowerCase()));
    const letters = lettersForMailbox(data.emails, subs);
    expect(letters.map((letter) => letter.id).sort()).toEqual(
      ['m007', 'm008', 'm009', 'm020', 'm022', 'm044', 'm046', 'm062', 'm079'].sort(),
    );
    const first = letters.find((letter) => letter.id === 'm062');
    const repeat = letters.find((letter) => letter.id === 'm079');
    expect(chainKey(first?.fromEmail ?? '', first?.subject ?? '')).toBe(chainKey(repeat?.fromEmail ?? '', repeat?.subject ?? ''));
    expect(discountLimit([{ area: 'скидка', limit: '10' }])).toBe(10);
    const source = syntheticSource(
      { id: 'm062', fromName: 'Ольга Смирнова', fromEmail: 'p02@company.example', subject: first?.subject ?? '', body: first?.body ?? '', received: '2026-12-10 15:52' },
      'leader@example.com',
    );
    const parsed = parseMailboxSource(source);
    expect(parsed?.id).toBe('m062');
    expect(parsed?.fromEmail).toBe('p02@company.example');
    expect(parsed?.subject).toBe(first?.subject);
    expect(parsed?.body).toContain('12%');
  });

  it('просьба без предложения возвращается с шаблоном', () => {
    const text = 'Клиент недоволен временем ответа, разберитесь.';
    expect(hasProposal(text)).toBe(false);
    const ruled = enforce({ ...modelReturn, суть: 'Жалоба без предложения' }, text, null, null, false);
    expect(ruled.kind).toBe('вернуть');
    expect(ruled.send).toBe(true);
    expect(ruled.draft).toBe(finishTemplate());
  });
});

describe('записки и серии', () => {
  it('тихий отстающий получает другую записку, серия «должно» не сгорает', () => {
    const notes = weeklyNotes([
      { name: 'Мария', email: 'm@example', subjects: ['отпуск Ирины', 'жалоба клиента'], lagging: false, ownRules: [] },
      { name: 'Дмитрий', email: 'd@example', subjects: [], lagging: true, ownRules: [] },
    ]);
    expect(notes[0]?.text).toContain('отпуск Ирины');
    expect(notes[1]?.text).toContain('не писали');
    expect(noteToSend(notes)?.name).toBe('Дмитрий');
    const series = burningSeries([
      { kind: 'встречи', title: 'Статус', verdict: 'не_должно', change: 'убрать', freedHours: 1.5 },
      { kind: 'встречи', title: 'Совет', verdict: 'должно', change: '', hours: 2 },
      { kind: 'письма', title: 'Письмо', verdict: 'не_должно', change: '', hours: 1 },
    ]);
    expect(series.map((item) => item.title)).toEqual(['Статус']);
    expect(series[0]?.hours).toBe(1.5);
  });
});
describe('утро и матрица', () => {
  it('тихая проблема — тот, кто отстаёт и не пишет; у другого отдела её нет', () => {
    const first = departmentMatrix([
      { name: 'А', emails: 0, lagging: true },
      { name: 'Б', emails: 8, lagging: false },
      { name: 'В', emails: 2, lagging: false },
    ]);
    expect(first.find((row) => row.name === 'А')?.cell).toBe('один_на_один');
    expect(first.find((row) => row.name === 'А')?.quiet).toBe(true);
    expect(first.find((row) => row.name === 'Б')?.cell).toBe('расширить');
    const second = departmentMatrix([
      { name: 'Г', emails: 3, lagging: true },
      { name: 'Д', emails: 1, lagging: false },
    ]);
    expect(second.some((row) => row.quiet)).toBe(false);
    expect(second.find((row) => row.name === 'Г')?.cell).toBe('помочь');
    const text = morningLines({
      tasks: [{ title: 'Бюджет', dueOn: '2026-12-13' }],
      waiting: [],
      quiet: ['А'],
    });
    expect(text.join('\n')).toContain('Бюджет');
    expect(text.join('\n')).toContain('А');
    expect(goalMinutes([{ minutes: 30, summary: 'План продаж' }, { minutes: 60, summary: 'Статус' }], ['план продаж'])).toEqual({
      onGoal: 30,
      total: 90,
      percent: 33,
    });
  });
});
describe('пересчёт недели', () => {
  it('два руководителя получают разные числа из своих данных', () => {
    const firstHistory = [
      { personId: 'a', area: 'скидка', subject: 'старая', outcome: 'с_правкой', at: '2026-10-01' },
      { personId: 'a', area: 'скидка', subject: 'Скидка 4%', outcome: 'утверждено', at: '2026-10-08' },
      { personId: 'a', area: 'скидка', subject: 'Скидка 6%', outcome: 'утверждено', at: '2026-10-15' },
      { personId: 'a', area: 'скидка', subject: 'Скидка 5%', outcome: 'утверждено', at: '2026-10-22' },
      { personId: 'a', area: 'скидка', subject: 'Скидка 8%', outcome: 'утверждено', at: '2026-10-29' },
      { personId: 'a', area: 'скидка', subject: 'Скидка 7%', outcome: 'утверждено', at: '2026-11-05' },
    ];
    const secondHistory = [
      { personId: 'b', area: 'бюджет', subject: 'Бюджет кампании', outcome: 'утверждено', at: '2026-10-08' },
      { personId: 'b', area: 'бюджет', subject: 'Бюджет кампании', outcome: 'утверждено', at: '2026-10-15' },
      { personId: 'b', area: 'бюджет', subject: 'Бюджет кампании', outcome: 'утверждено', at: '2026-10-22' },
      { personId: 'b', area: 'бюджет', subject: 'Бюджет кампании', outcome: 'утверждено', at: '2026-10-29' },
      { personId: 'b', area: 'бюджет', subject: 'Бюджет кампании', outcome: 'утверждено', at: '2026-11-05' },
    ];
    const first = trustOffers(firstHistory);
    const second = trustOffers(secondHistory);
    expect(first).toHaveLength(1);
    expect(first[0]?.limit).toBe(8);
    expect(second[0]?.limit).toBeNull();
    expect(second[0]?.area).toBe('бюджет');
    const pieces = [
      { kind: 'письма' as const, key: 'a@example|скидка клиенту', title: 'Скидка', verdict: 'не_должно', change: 'сам', cause: 'в_полномочиях_отправителя' },
      { kind: 'встречи' as const, key: 'Планёрка', title: 'Планёрка', verdict: 'в_другом_виде', change: 'реже', cause: 'встреча_без_решения' },
      { kind: 'встречи' as const, key: 'Совет', title: 'Совет', verdict: 'должно', change: '', cause: 'нужно' },
    ];
    const rules = rulesFromAudit(pieces, first, new Map([['a', 'a@example']]));
    const letters = [
      { fromEmail: 'a@example', subject: 'Скидка клиенту', body: 'Скидка 8%' },
      { fromEmail: 'a@example', subject: 'Новая тема', body: 'Скидка 12%' },
      { fromEmail: 'c@example', subject: 'Другое', body: 'Вопрос' },
    ];
    const meetings = [{ summary: 'Планёрка' }, { summary: 'Совет' }];
    const open = replayWeek(letters, meetings, rules, false);
    const closed = replayWeek(letters, meetings, rules, true);
    expect(open.after).toBe(100);
    expect(closed.after).toBeLessThan(100);
    expect(closed.stillMeetings).toBe(1);
    expect(letterHits(letters[0], rules)?.effect).toBe('стоп');
    expect(letterHits({ fromEmail: 'a@example', subject: 'Скидка новая', body: 'Скидка 8%' }, rules)?.effect).toBe('сам');
    expect(letterHits({ fromEmail: 'a@example', subject: 'Скидка новая', body: 'Скидка 12%' }, rules)).toBeNull();
    const other = rulesFromAudit(pieces, second, new Map([['b', 'b@example']]));
    expect(other.some((rule) => rule.personId === 'b' && rule.limitValue === '')).toBe(true);
    expect(other.some((rule) => rule.personId === 'a')).toBe(false);
    expect(staffCard({ вывод: '', рекомендация: 'да', основание: '', риски: '', если_не_решить: '', контекст: '' })).toBeNull();
    expect(waitingHours([{ status: 'ждёт', createdAt: new Date('2026-11-26T08:00:00Z') }], new Date('2026-11-26T10:30:00Z'))).toBe(2.5);
  });
});

