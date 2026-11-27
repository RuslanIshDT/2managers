import { describe, expect, it } from 'vitest';
import { costView, moscowStart, type OperationRow } from '../src/agents/cost.ts';
import { modelsWithSchema, priceWords } from '../src/agents/models.ts';
import { sendTrace } from '../src/langfuse.ts';
import { eventFile, issueDraft, meetingStart, readEvents, relatedSubjects, standEvent, taskUnique } from '../src/agents/materials.ts';
import { followUpStart, parseProtocolCallback, preparationMinutes, preparationWords, protocolRelease, renderProtocol } from '../src/agents/protocol.ts';
import { providerHeaders } from '../src/llm.ts';
import { hashPassword, hashToken, verifyPassword } from '../src/auth.ts';
import { checkDepartment, readDepartment } from '../src/agents/k1.ts';
import { controlOf, kpiOutlook, reviewTasks, withLeader, type PersonGoal } from '../src/agents/control.ts';
import { readFile } from 'node:fs/promises';
import { chainKey, discountLimit, enforce, textSignals, type ModelVerdict } from '../src/agents/k2.ts';
import { hideMailbox, isOwnAddress, lettersForMailbox } from '../src/agents/intake.ts';
import { pickDiscountAboveLimit } from '../src/agents/reset-stand.ts';
import { buildDesk, type DeskInput } from '../src/agents/desk.ts';
import { subjectKey, type FlowRule } from '../src/agents/replay.ts';
import { freshVerdictKind } from '../src/agents/week.ts';
import { applyRevision, revisionPrompt } from '../src/agents/revisions.ts';
import { loadSynthetic } from '../src/data/synthetic.ts';
import { parseMailboxSource, syntheticSource } from '../src/mail.ts';
import { applyOrigin, formOrigin, requestOrigin } from '../src/http/origin.ts';
import { mailConfig } from '../src/mail.ts';
import { staffCard } from '../src/agents/dependence.ts';
import { adviceTitle, departmentMatrix, goalMinutes, overdueLines, overdueTasks, ownWeekTasks, renderMorning } from '../src/agents/focus.ts';
import { applyChoice, GOAL_KINDS } from '../src/agents/conductor.ts';
import { burningSeries, noteToSend, pendingNotes, weeklyNotes } from '../src/agents/mirror.ts';
import { letterHits, replayWeek, ruleEffect, rulesFromAudit, trustOffers, waitingHours } from '../src/agents/replay.ts';
import { copyRuling } from '../src/agents/intake.ts';
import { findPerson } from '../src/agents/k2.ts';
import { forceMailAction, mailScore } from '../src/agents/accuracy.ts';
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
  действие: 'ответить',
  кому_передать: '',
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
  it('категорию «руководство» ставит только код по оргструктуре', () => {
    const text = 'Подтвердите участие в планёрке в пятницу.';
    const fromTeam = enforce({ ...modelReturn, действие: 'руководителю', суть: 'Планёрка' }, text, null, null, false);
    const forecast = enforce({ ...modelReturn, суть: 'Прогноз 94%' }, 'Прогноз выполнения плана: 94%.', null, null, false);
    const fromBoss = enforce({ ...modelReturn, действие: 'ответить', суть: 'Вопрос сверху' }, text, null, null, true);
    expect(fromTeam.category).toBe('иное');
    // Модель сказала «руководителю» — код не спорит.
    expect(fromTeam.kind).toBe('нужен_руководитель');
    expect(forecast.category).toBe('иное');
    expect(fromBoss.category).toBe('руководство');
    expect(fromBoss.ask).toBe(true);
  });

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
    const repeat = letters.find((letter) => letter.repeat);
    expect(chainKey(first?.fromEmail ?? '', first?.subject ?? '')).toBe(chainKey(repeat?.fromEmail ?? '', repeat?.subject ?? ''));
    const intake = await readFile('src/agents/intake.ts', 'utf8');
    const dependence = await readFile('src/agents/dependence.ts', 'utf8');
    expect(intake).not.toMatch(/m079/);
    expect(dependence).not.toMatch(/OLGA_DISCOUNT_LIMIT|trustOffer/);
    const kept = lettersForMailbox(
      [
        { id: 'a', fromName: 'А', fromEmail: 'a@example.com', subject: 'Одна тема', body: '', received: '2026-12-01 10:00', repeat: false },
        { id: 'b', fromName: 'А', fromEmail: 'a@example.com', subject: 'Одна тема', body: '', received: '2026-12-02 10:00', repeat: true },
        { id: 'c', fromName: 'А', fromEmail: 'a@example.com', subject: 'Одна тема', body: '', received: '2026-12-03 10:00' },
      ],
      new Set(['a@example.com']),
    );
    expect(kept.map((letter) => letter.id)).toEqual(['a', 'b']);
    expect(isOwnAddress('Box@Example.com', 'box@example.com')).toBe(true);
    expect(isOwnAddress('other@example.com', 'box@example.com')).toBe(false);
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
    expect(parsed?.marked).toBe(true);
    const human = parseMailboxSource(
      [
        'From: =?UTF-8?B?0JjQstCw0L0=?= <person@example.com>',
        'To: <leader@example.com>',
        'Subject: =?UTF-8?B?0JLQvtC/0YDQvtGB?=',
        'Date: Thu, 26 Nov 2026 12:00:00 +0300',
        'Message-ID: <hand.1@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Нужно решение по сроку.',
      ].join('\n'),
    );
    expect(human?.marked).toBe(false);
    expect(human?.fromEmail).toBe('person@example.com');
    expect(human?.subject).toBe('Вопрос');
    const split = Buffer.from('Облако Плюс', 'utf8');
    const cut = split.indexOf(Buffer.from('ю', 'utf8')) + 1;
    const splitSubject = `=?UTF-8?B?${split.subarray(0, cut).toString('base64')}?= =?UTF-8?B?${split.subarray(cut).toString('base64')}?=`;
    const splitLetter = parseMailboxSource(
      ['From: А <a@example.com>', `Subject: ${splitSubject}`, 'Message-ID: <split@example.com>', 'Content-Type: text/plain; charset=utf-8', '', 'Текст.'].join('\n'),
    );
    expect(splitLetter?.subject).toBe('Облако Плюс');
    expect(human?.body).toContain('решение');
    const plain = 'Нужно решение по сроку, без разметки.';
    const qp = [...Buffer.from(plain, 'utf8')].map((byte) => `=${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
    const html = Buffer.from(`<html><body><p>${plain}</p><p>лишний html</p></body></html>`, 'utf8').toString('base64');
    const multipart = [
      'From: =?UTF-8?Q?=D0=98=D0=B2=D0=B0=D0=BD?= <person@example.com>',
      'To: <leader@example.com>',
      'Subject: =?UTF-8?Q?=D0=92=D0=BE=D0=BF=D1=80=D0=BE=D1=81?=',
      'Date: Thu, 26 Nov 2026 12:00:00 +0300',
      'Message-ID: <hand.multipart@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="----client"',
      '',
      '------client',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      qp,
      '------client',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      html,
      '------client--',
      '',
    ].join('\r\n');
    const fromClient = parseMailboxSource(multipart);
    expect(fromClient?.marked).toBe(false);
    expect(fromClient?.fromName).toBe('Иван');
    expect(fromClient?.subject).toBe('Вопрос');
    expect(fromClient?.body).toBe(plain);
    expect(fromClient?.body).not.toContain('<p>');
    expect(fromClient?.body).not.toContain('boundary');
    const htmlOnly = [
      'From: <person@example.com>',
      'Subject: html',
      'Message-ID: <hand.html@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p>=D0=9D=D1=83=D0=B6=D0=BD=D0=BE =D1=80=D0=B5=D1=88=D0=B5=D0=BD=D0=B8=D0=B5</p>',
    ].join('\n');
    expect(parseMailboxSource(htmlOnly)?.body).toBe('Нужно решение');
    const nested = [
      'From: <person@example.com>',
      'Subject: nested',
      'Message-ID: <hand.nested@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="mix"',
      '',
      '--mix',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      qp,
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      '',
      `<p>${plain}</p>`,
      '--alt--',
      '--mix',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="a.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('not-the-letter').toString('base64'),
      '--mix--',
      '',
    ].join('\n');
    const nestedParsed = parseMailboxSource(nested);
    expect(nestedParsed?.body).toBe(plain);
    expect(nestedParsed?.body).not.toContain('not-the-letter');
  });

  it('шаблона нет: статус уходит в сводку без ответа, ответ — текст модели по письму', () => {
    // Письма придуманы для теста, в синтетике их нет.
    const status = enforce({ ...modelReturn, действие: 'в_сводку', черновик_ответа: 'лишний текст', суть: 'Статус по отгрузкам' }, 'Отгрузки идут по графику, отклонений нет.', null, null, false);
    expect(status.kind).toBe('в_сводку');
    expect(status.send).toBe(false);
    expect(status.ask).toBe(false);
    expect(status.draft).toBe('');
    const answer = enforce(modelReturn, 'Клиент недоволен временем ответа, разберитесь.', null, null, false);
    expect(answer.kind).toBe('вернуть');
    expect(answer.draft).toBe(modelReturn.черновик_ответа);
    expect(answer.draft).not.toMatch(/Доделайте просьбу/);
    // Ответить без текста нельзя — решает руководитель.
    const empty = enforce({ ...modelReturn, черновик_ответа: ' ' }, 'Вопрос по графику смен', null, null, false);
    expect(empty.ask).toBe(true);
  });

  it('передать — только человеку из списка, иначе руководителю; копия — для сведения', () => {
    const staff = [
      { name: 'Пётр Сидоров', email: 'p@x.example' },
      { name: 'Вера Петрова', email: 'v@x.example' },
    ];
    const forward = enforce({ ...modelReturn, действие: 'передать', кому_передать: 'Сидоров', черновик_ответа: 'Пётр, подготовь КП до пятницы.' }, 'Просим КП на 20 лицензий', null, null, false, [], staff);
    expect(forward.kind).toBe('делегировать');
    expect(forward.forwardTo).toEqual(staff[0]);
    expect(forward.send).toBe(true);
    const nobody = enforce({ ...modelReturn, действие: 'передать', кому_передать: 'Николай Иванов', черновик_ответа: 'Сделай' }, 'Просим КП', null, null, false, [], staff);
    expect(nobody.ask).toBe(true);
    // Передать самому отправителю — это ответ ему.
    const back = enforce({ ...modelReturn, действие: 'передать', кому_передать: 'Вера Петрова', черновик_ответа: 'Вера, разберите сами.' }, 'Жалоба клиента', null, null, false, [], staff, 'v@x.example');
    expect(back.kind).toBe('вернуть');
    expect(back.forwardTo).toBeUndefined();
    expect(findPerson('Пет', staff)).toBeNull();
    expect(findPerson('вера петрова', staff)).toEqual(staff[1]);
    const copy = copyRuling(true);
    expect(copy.kind).toBe('в_сводку');
    expect(copy.send || copy.ask).toBe(false);
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
    expect(pendingNotes(notes, ['d@example']).map((note) => note.name)).toEqual(['Мария']);
    const series = burningSeries([
      { kind: 'встречи', title: 'Статус', verdict: 'не_должно', change: 'убрать', freedHours: 1.5 },
      { kind: 'встречи', title: 'Совет', verdict: 'должно', change: '', hours: 2 },
      { kind: 'письма', title: 'Письмо', verdict: 'не_должно', change: '', hours: 1 },
    ]);
    expect(series.map((item) => item.title)).toEqual(['Статус']);
    expect(series[0]?.hours).toBe(1.5);
  });
});
describe('дирижёр', () => {
  it('оставляет не больше трёх дел, остальные в сообщение не идут', () => {
    const candidates = [
      { id: 'a', kind: 'задача', title: 'Бюджет', detail: 'срок', goal: '' },
      { id: 'b', kind: 'решение', title: 'Ждёт ответ', detail: '2 дн.', goal: '' },
      { id: 'c', kind: 'kpi', title: 'Отстаёт план', detail: '', goal: 'План' },
      { id: 'd', kind: 'матрица', title: 'Тихий', detail: '', goal: '' },
      { id: 'e', kind: 'задача', title: 'Лишнее', detail: '', goal: '' },
    ];
    const plan = applyChoice(candidates, [
      { id: 'нет', goal: 'чужое', minutes: 10, why: 'мимо' },
      { id: 'c', goal: 'План', minutes: 30, why: 'час руководителя двигает отставание' },
      { id: 'a', goal: 'План', minutes: 20, why: 'срок ближе' },
      { id: 'b', goal: '', minutes: 15, why: 'пустое отбрасывается' },
      { id: 'd', goal: 'План', minutes: 10, why: 'третье входит' },
      { id: 'e', goal: 'План', minutes: 10, why: 'четвёртое не входит' },
    ]);
    expect(plan.today.map((item) => item.title)).toEqual(['Отстаёт план', 'Бюджет', 'Тихий']);
    expect(plan.later).toEqual(['Ждёт ответ', 'Лишнее']);
    const text = renderMorning({
      today: '2026-12-11',
      waiting: [],
      ownWeek: [],
      plan: plan.today,
      returned: [],
      overdue: [],
      todayMeetings: [],
      openItems: [],
      share: { onGoal: 0, total: 0, percent: 0 },
    });
    expect(text).toContain('1. Отстаёт план. 30 мин, цель «План»');
    expect(text).not.toContain('Не сегодня');
    expect(text).not.toContain('Лишнее');
  });
});

const emptyMorning = {
  today: '2026-12-11',
  waiting: [],
  ownWeek: [],
  plan: null,
  returned: [],
  overdue: [],
  todayMeetings: [],
  openItems: [],
  share: { onGoal: 0, total: 0, percent: 0 },
};

describe('утро и матрица', () => {
  it('тихая проблема — тот, кто отстаёт и не пишет; у другого отдела её нет', async () => {
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
    expect(adviceTitle(first[0]!)).toBe('А — поговорить один на один');
    expect(adviceTitle(second[0]!)).toBe('Г — помочь по существу');
    expect(adviceTitle(second[1]!)).toBeNull();
    const late = overdueTasks(
      [
        { title: 'Сдать линию', owner: 'Пётр', dueOn: '2026-11-20', status: 'в работе' },
        { title: 'Позже', owner: 'Пётр', dueOn: '2026-12-01', status: 'просрочена' },
        { title: 'Готово', owner: 'Пётр', dueOn: '2026-11-01', status: 'сделана' },
      ],
      '2026-11-27',
    );
    expect(late).toEqual([{ title: 'Сдать линию', owner: 'Пётр', dueOn: '2026-11-20', days: 7 }]);
    expect(overdueLines(late).join('\n')).toContain('Пётр: Сдать линию, просрочено на 7 дней');
    const file = await readFile('data/synthetic/tasks.csv', 'utf8');
    const fromFile = file
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => {
        const [title, owner, dueOn, status] = line.split(',').slice(1);
        return { title: title ?? '', owner: owner ?? '', dueOn: dueOn ?? '', status: status ?? '' };
      });
    expect(overdueTasks(fromFile, '2026-11-27')).toEqual([]);
    const morning = renderMorning({
      today: '2026-11-27',
      waiting: [
        { who: 'Ольга', what: 'Скидка 12%', days: 1 },
        { who: 'Мария', what: 'Отпуск', days: 0 },
      ],
      ownWeek: [
        { title: 'Отчёт совету', dueOn: '2026-11-25' },
        { title: 'Согласовать бюджет', dueOn: '2026-11-29' },
      ],
      plan: null,
      returned: [{ who: 'Анна', what: 'Перенос встречи' }],
      overdue: late,
      todayMeetings: ['Планёрка'],
      openItems: ['Кто ведёт понедельник'],
      share: { onGoal: 360, total: 2070, percent: 17 },
    });
    // Решения, которые ждут руководителя, — первым блоком после заголовка.
    expect(morning.split('\n\n')[1]).toBe('Ждут вашего решения:\n— Ольга: Скидка 12% (ждёт 1 день)\n— Мария: Отпуск (ждёт меньше дня)');
    // Свои задачи на неделе — сразу после решений, всегда, с понятным сроком.
    expect(morning.split('\n\n')[2]).toBe(
      'Ваши задачи со сроком в ближайшую неделю:\n— Отчёт совету, срок был 25 ноября, просрочено на 2 дня\n— Согласовать бюджет, срок 29 ноября, через 2 дня',
    );
    const own = [
      { title: 'Бюджет', dueOn: '2026-12-13', status: 'в работе' },
      { title: 'Тезисы', dueOn: '2026-12-26', status: 'в работе' },
      { title: 'Старое', dueOn: '2026-12-01', status: 'сделана' },
      { title: 'Сегодня', dueOn: '2026-12-11', status: 'новая' },
    ];
    expect(ownWeekTasks(own, '2026-12-11').map((task) => task.title)).toEqual(['Сегодня', 'Бюджет']);
    expect(renderMorning({ ...emptyMorning, ownWeek: [] })).toContain('Ваших задач со сроком в ближайшую неделю нет.');
    // Порядок: из систем (решения, ваши задачи, встречи), затем собранное агентами.
    const heads = morning.split('\n\n').map((block) => block.split('\n')[0]);
    expect(heads.slice(1)).toEqual([
      'Ждут вашего решения:',
      'Ваши задачи со сроком в ближайшую неделю:',
      'Встречи сегодня: Планёрка.',
      'Три дела на сегодня модель выберет при отправке.',
      'Просрочено у сотрудников:',
      'Открытые вопросы прошлой встречи:',
      'Время встреч на ваши цели: 17% (6 из 34,5 ч по календарю).',
      'Помощник ответил сам на этой неделе:',
    ]);
    expect(morning).toContain('План на 27 ноября');
    expect(morning).toContain('— Анна: Перенос встречи');
    expect(morning).toContain('Сдать линию');
    expect(morning).toContain('Встречи сегодня: Планёрка.');
    expect(morning).toContain('Открытые вопросы прошлой встречи:\n— Кто ведёт понедельник');
    expect(morning).toContain('17% (6 из 34,5 ч');
    expect(morning).not.toContain('Матрица');
    expect(preparationMinutes(new Date('2026-11-27T08:00:00Z'), new Date('2026-11-27T08:00:20Z'))).toBe(0);
    expect(preparationWords(0)).toBe('Подготовка: меньше минуты');
    expect(preparationWords(null)).toBe('Время подготовки не записано');
    // Время на цели — по виду встречи, а не по словам в названии; блок под приоритет тоже на цели; без вида — не на цели.
    expect(
      goalMinutes(
        [
          { minutes: 30, kind: 'стратегия' },
          { minutes: 60, kind: 'статус' },
          { minutes: 30, kind: 'один_на_один' },
          { minutes: 60, kind: 'внешняя' },
          { minutes: 30, goal: true },
          { minutes: 90 },
        ],
        GOAL_KINDS,
      ),
    ).toEqual({ onGoal: 150, total: 300, percent: 50 });
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
    expect(second).toHaveLength(0);
    expect(trustOffers(firstHistory, [{ personId: 'a', area: 'скидка', limit: '8' }])).toHaveLength(0);
    expect(trustOffers(firstHistory, [{ personId: 'a', area: 'скидка', limit: '5' }])[0]?.limit).toBe(8);
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
    expect(closed.stillMeetings).toBe(2);
    expect(ruleEffect('не_должно', 'кадры')).toBe('карточка');
    expect(ruleEffect('в_другом_виде', 'иное')).toBe('карточка');
    expect(ruleEffect('не_должно', 'иное')).toBe('стоп');
    expect(ruleEffect('должно', 'деньги')).toBeNull();
    const guarded = rulesFromAudit(
      [{ kind: 'письма', key: 'a@example|отпуск', title: 'Отпуск', verdict: 'не_должно', change: '', cause: 'кадры' }],
      [],
      new Map(),
      new Map([['a@example|отпуск', 'кадры']]),
    );
    expect(guarded[0]?.effect).toBe('карточка');
    const twice = replayWeek(
      [
        { fromEmail: 'a@example', subject: 'Отпуск', body: 'даты' },
        { fromEmail: 'a@example', subject: 'Повтор: Отпуск', body: 'даты' },
      ],
      [],
      guarded,
      true,
    );
    expect(twice.stillLetters).toBe(1);
    expect(twice.gluedLetters).toBe(1);
    expect(twice.digestLetters).toBe(0);
    expect(letterHits(letters[0], rules)?.effect).toBe('стоп');
    expect(letterHits({ fromEmail: 'a@example', subject: 'Скидка новая', body: 'Скидка 8%' }, rules)?.effect).toBe('сам');
    expect(letterHits({ fromEmail: 'a@example', subject: 'Скидка новая', body: 'Скидка 12%' }, rules)).toBeNull();
    const other = rulesFromAudit(pieces, second, new Map([['b', 'b@example']]));
    expect(other.some((rule) => rule.personId === 'b' && rule.limitValue === '')).toBe(false);
    expect(other.some((rule) => rule.personId === 'a')).toBe(false);
    expect(staffCard({ вывод: '', рекомендация: 'да', основание: '', риски: '', если_не_решить: '', контекст: '' })).toBeNull();
    expect(waitingHours([{ status: 'ждёт', createdAt: new Date('2026-11-26T08:00:00Z') }], new Date('2026-11-26T10:30:00Z'))).toBe(2.5);
  });
});

describe('правка и второй каталог', () => {
  it('правка меняет только черновик своей категории', () => {
    const edits = [{ category: 'кадры', instead: 'Нужна замена на даты отпуска' }];
    const same = applyRevision('Черновик ответа.', 'кадры', edits);
    const other = applyRevision('Черновик ответа.', 'деньги', edits);
    expect(same).toContain('Нужна замена на даты отпуска');
    expect(other).toBe('Черновик ответа.');
    expect(revisionPrompt(edits)).toContain('кадры');
  });

  it('второй каталог — другие люди', async () => {
    const first = await loadSynthetic('data/synthetic');
    const second = await loadSynthetic('data/leader2');
    const firstNames = new Set(first.people.map((person) => person.name));
    expect(second.people.every((person) => !firstNames.has(person.name))).toBe(true);
    expect(second.people.some((person) => person.role === 'подчинённый')).toBe(true);
    expect(second.emails.length).toBeGreaterThan(0);
  });
});

describe('точность почты', () => {
  it('код переводит деньги и кадры в вопрос руководителю и сам ничего не шлёт', () => {
    expect(forceMailAction('Прошу скидку 12%', false, 'делегировать')).toEqual({
      action: 'спросить_руководителя',
      forced: true,
    });
    expect(forceMailAction('Отпуск с 20 декабря', false, 'в_сводку')).toEqual({
      action: 'спросить_руководителя',
      forced: true,
    });
    expect(forceMailAction('Прогноз плана 94%', true, 'в_сводку')).toEqual({
      action: 'спросить_руководителя',
      forced: true,
    });
    expect(forceMailAction('Дашборд обновлён', false, 'в_сводку')).toEqual({ action: 'в_сводку', forced: false });
    expect(forceMailAction('Есть обязательство клиенту по сроку', false, 'делегировать')).toEqual({
      action: 'спросить_руководителя',
      forced: true,
    });
  });

  it('считает совпадения и группирует расхождения', () => {
    const score = mailScore([
      { expected: 'в_сводку', action: 'в_сводку' },
      { expected: 'в_сводку', action: 'в_сводку' },
      { expected: 'делегировать', action: 'в_сводку' },
    ]);
    expect(score).toEqual({ total: 3, hit: 2, misses: [{ pair: 'делегировать → в_сводку', count: 1 }] });
  });
});

describe('протокол', () => {
  it('собирает текст и узнаёт кнопку утверждения', () => {
    const text = renderProtocol({
      theme: 'План <недели>',
      participants: ['Анна'],
      notes: ['Срок сдвинули'],
      decisions: ['Оставить две планёрки'],
      next: ['Анна пишет список'],
      proposals: ['Сводку вместо статуса'],
      open: ['Кто ведёт понедельник'],
    });
    expect(text).toContain('План &lt;недели&gt;');
    expect(text).not.toContain('заглушка');
    expect(parseProtocolCallback('p:approve:ab12cd34')).toBe('ab12cd34');
    expect(parseProtocolCallback('d:approve:ab12cd34')).toBeNull();
    const now = new Date('2026-11-26T12:00:00Z');
    const earlier = new Date('2026-11-26T09:00:00Z');
    expect(freshVerdictKind('d1', [
      { id: 'v-d1', messageId: 'd1', kind: 'нужен_руководитель', createdAt: earlier },
      { id: 'v-d1-2', messageId: 'd1', kind: 'вернуть', createdAt: now },
    ])).toBe('вернуть');
    expect(freshVerdictKind('d2', [{ id: 'v-d2', messageId: 'd2', kind: 'нужен_руководитель', createdAt: now }])).toBe('нужен_руководитель');
  });
});

describe('цели, задачи и KPI', () => {
  it('продлевает тренд и считает недели отставания', () => {
    const outlook = kpiOutlook([
      { fact: '100', status: 'норма' },
      { fact: '90', status: 'отстаёт' },
      { fact: '80', status: 'отстаёт' },
    ]);
    expect(outlook).toEqual({ behind: 2, trend: 'падает', forecast: '70' });
  });

  it('задача относится к цели исполнителя, без цели — только если цели нет или модель так сказала', () => {
    const people: PersonGoal[] = [
      { name: 'Пётр', goal: 'Сдать линию', leaderGoal: '1', emails: 1, kpis: [] },
      { name: 'Кира', goal: '', leaderGoal: '', emails: 0, kpis: [] },
    ];
    const goals = [{ n: '1', text: 'Сдать линию' }];
    const reviews = reviewTasks({
      goals,
      people,
      offGoal: ['Купить кружки'],
      tasks: [
        { title: 'Сдать линию к среде', owner: 'Пётр', due: '2026-12-01', status: 'просрочена' },
        { title: 'Купить кружки', owner: 'Пётр', due: '2026-12-20', status: 'новая' },
        { title: 'Принять оснастку', owner: 'Пётр', due: '2026-12-20', status: 'новая' },
        { title: 'Закрыть смену', owner: 'Кира', due: '2026-12-20', status: 'новая' },
      ],
    });
    expect(reviews[0]?.recommendation).toBe('перенести');
    expect(reviews[0]?.goal).toBe('Сдать линию');
    expect(reviews[1]?.recommendation).toBe('снять');
    expect(reviews[2]?.goal).toBe('Сдать линию');
    expect(reviews[2]?.recommendation).toBe('оставить');
    expect(reviews[3]?.recommendation).toBe('снять');
  });

  it('собирает каскад, разбор задач и ранний сигнал из файлов, без имён в коде', async () => {
    const source = await readFile('src/agents/control.ts', 'utf8');
    expect(source).not.toMatch(/Ольга|Иван|Марина|p02|m062|10%/);

    const synthetic = await scene('data/synthetic');
    expect(synthetic.goals.length).toBeGreaterThan(0);
    expect(synthetic.goals.every((goal) => goal.owners.length > 0)).toBe(true);
    expect(synthetic.tasks).toHaveLength(12);
    expect(synthetic.tasks.every((task) => task.goal.length > 0)).toBe(true);
    expect(synthetic.holes.some((hole) => hole.kind === 'задача без цели')).toBe(false);
    expect(synthetic.tasks.some((task) => task.recommendation === 'перенести')).toBe(true);
    expect(synthetic.tasks.some((task) => task.deadline === 'нет')).toBe(true);
    const quiet = synthetic.signals.filter((item) => item.early);
    expect(quiet.length).toBeGreaterThan(0);
    expect(quiet.every((item) => item.text.includes('писем нет'))).toBe(true);

    const second = await scene('data/leader2');
    expect(second.goals.length).toBe(3);
    expect(second.signals.length).toBeGreaterThan(0);
    const firstNames = new Set(synthetic.goals.flatMap((goal) => goal.owners));
    expect(second.goals.some((goal) => goal.owners.some((name) => firstNames.has(name)))).toBe(false);
  });
});

describe('лента и сброс стенда', () => {
  it('прячет адрес ящика и выбирает скидку выше полномочия без зашитого id', async () => {
    expect(hideMailbox('Письмо на box@example.com и BOX@example.com', 'box@example.com')).toBe('Письмо на и');
    expect(hideMailbox('аккаунт standbox', 'standbox@example.com')).toBe('аккаунт');
    const within = {
      id: 'low',
      fromEmail: 'a@example.com',
      fromName: 'Аня',
      subject: 'Скидка 8% клиенту',
      body: '',
      received: '2026-11-01T10:00:00',
    };
    const above = {
      id: 'high',
      fromEmail: 'old@example.com',
      fromName: 'Боря',
      subject: 'Скидка 12% клиенту',
      body: '',
      received: '2026-11-02T10:00:00',
    };
    const limits = [
      { email: 'a@example.com', name: 'Аня', limit: 10 },
      { email: 'new@example.com', name: 'Боря', limit: 10 },
    ];
    expect(pickDiscountAboveLimit([within, above], limits)?.id).toBe('high');
    const source = await readFile('src/scripts/reset-stand.ts', 'utf8');
    const picker = await readFile('src/agents/reset-stand.ts', 'utf8');
    expect(source + picker).not.toMatch(/m062|Ольга|10%/);
  });
});

describe('главная T34', () => {
  it('собирает работу и цифры из переданных данных и не знает людей синтетики', async () => {
    const rule: FlowRule = {
      kind: 'письмо',
      title: 'Статус закрыт',
      personId: 'a',
      area: '',
      limitValue: '',
      fromEmail: 'kira@example.com',
      subjectKey: subjectKey('Статус сделки'),
      seriesKey: '',
      effect: 'стоп',
      cause: '',
    };
    const meetingRule: FlowRule = {
      kind: 'встреча',
      title: 'Планёрка',
      personId: '',
      area: '',
      limitValue: '',
      fromEmail: '',
      subjectKey: '',
      seriesKey: 'Планёрка направления',
      effect: 'стоп',
      cause: '',
    };
    const input: DeskInput = {
      accepted: true,
      decisions: [{ id: 'd1', status: 'ждёт', summary: 'Скидка 15% клиенту, ответ до пятницы', replyName: 'Кира', createdAt: '2026-11-26T10:00:00.000Z', category: 'деньги' }],
      verdicts: [{ id: 'v1', kind: 'вернуть', category: 'кадры', summary: 'Кира просит согласовать отпуск', basis: 'Это кадры', createdAt: '2026-11-20T10:00:00.000Z' }],
      letters: [{ fromName: 'Кира', fromEmail: 'kira@example.com', subject: 'Статус сделки', body: '', received: '2026-11-25T10:00:00' }],
      meetings: [{ summary: 'Планёрка направления', minutes: 40 }],
      rules: [rule, meetingRule],
      people: [
        { id: 'a', name: 'Кира', emails: 0, laggingWeeks: [{ name: 'План', week: '2026-11-23' }] },
        { id: 'b', name: 'Инга', emails: 7, laggingWeeks: [] },
      ],
      authorities: [{ personId: 'a', area: 'скидка', limit: '9', unit: '%' }],
      history: [],
      series: [{ title: 'Планёрка направления', open: true }, { title: 'Статус направления', open: true }],
      relief: null,
      tasks: [
        { title: 'Разобрать бюджет', minutes: 25, goal: 'План квартала' },
        { title: 'Скидка 15% клиенту, ответ до пятницы', minutes: 10, goal: 'Продажи' },
        { title: 'Инга: KPI отстаёт, писем 0, тихая проблема', minutes: 20, goal: '' },
        { title: 'Кира: писем 0, тихая проблема', minutes: 15, goal: '' },
      ],
      calls: [],
    };
    const desk = buildDesk(input);
    expect(desk.work.filter((item) => item.kind === 'series')).toHaveLength(1);
    expect(desk.work.find((item) => item.kind === 'series')?.title).toContain('2 серии');
    expect(desk.work.find((item) => item.kind === 'series')?.lines).toHaveLength(2);
    expect(desk.work.some((item) => item.title.includes('Скидка 15%'))).toBe(true);
    expect(desk.work.filter((item) => item.title.includes('Скидка 15%'))).toHaveLength(1);
    expect(desk.work.some((item) => item.title.includes('Инга'))).toBe(false);
    // Тихая проблема — одна карточка «Поговорите», дело из плана о том же человеке второй раз не показывается.
    expect(desk.work.filter((item) => item.title.includes('Кира')).map((item) => item.kind)).toEqual(['talk']);
    expect(desk.done.some((line) => line.text.startsWith('Было 100% → стало'))).toBe(true);
    const pending = buildDesk({ ...input, accepted: false, rules: [], relief: { letters: 12, meetings: 4 } });
    expect(pending.work[0]?.kind).toBe('rules');
    expect(pending.work[0]?.title).toContain('12 писем');
    expect(pending.work[0]?.title).toContain('4 встречи');
    expect(desk.work[0]?.kind).toBe('decision');
    expect(desk.work[0]?.title.startsWith('Решите:')).toBe(true);
    expect(desk.work[0]?.origin.data).toContain('Кира');
    expect(desk.work.some((item) => item.title === 'Поговорите: Кира')).toBe(true);
    const letterLine = desk.done.find((line) => line.text.includes('письмо'));
    const meetingLine = desk.done.find((line) => line.text.includes('встреч'));
    expect(letterLine?.text).toContain('оценка');
    expect(meetingLine?.text).toContain('40 минут');
    expect(meetingLine?.text).not.toContain('оценка');
    expect(desk.work[0]?.minutes).toBe('');
    expect(desk.helpers.filter((card) => /^k\d+$/.test(card.id))).toHaveLength(15);
    expect(desk.helpers.filter((card) => card.mode === 'заглушка').map((card) => card.id)).toEqual(['stub-tasks', 'stub-calendar']);
    expect(desk.helpers.find((card) => card.id === 'r5')?.mode).toBe('код');
    for (const item of [...desk.work, ...desk.done]) {
      expect(item.origin.who).not.toBe('');
      expect(item.origin.data).not.toBe('');
      expect(item.origin.how).not.toBe('');
      expect(item.origin.safety).toContain('кнопки');
    }
    const dump = JSON.stringify(desk);
    expect(dump).toContain('Кира');
    expect(dump).not.toMatch(/Ольга|Дмитрий|m062|Ромашка|вердикт|дайджест|склеен/);
    const source = await readFile('src/agents/desk.ts', 'utf8');
    expect(source).not.toMatch(/Ольга|Дмитрий|m062|Ромашка/);
  });
});

describe('модели и стоимость T35', () => {
  it('в каталоге остаются только модели со схемой', () => {
    const models = modelsWithSchema([
      { id: 'a/one', name: 'Одна', supported_parameters: ['structured_outputs'], pricing: { prompt: '0.000003', completion: '0.000015' } },
      { id: 'b/two', name: 'Две', supported_parameters: ['structured_outputs'], input_price_per_1m: 2, output_price_per_1m: 10 },
      { id: 'a/two', name: 'Две', supported_parameters: ['response_format'], pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: '', name: 'Пустая', supported_parameters: ['structured_outputs'] },
      null,
    ]);
    expect(models.map((model) => model.id).sort()).toEqual(['a/one', 'b/two']);
    const openrouter = models.find((model) => model.id === 'a/one');
    const listed = models.find((model) => model.id === 'b/two');
    expect(openrouter?.promptPerMillion).toBe(3);
    expect(openrouter?.completionPerMillion).toBe(15);
    expect(listed?.promptPerMillion).toBe(2);
    expect(listed?.completionPerMillion).toBe(10);
    expect(priceWords(0)).toBe('$0');
    expect(priceWords(null)).toBe('нет цены');
  });

  it('итог по Москве не смешивает руководителей и ноль с пустой ценой', () => {
    const now = new Date('2026-11-26T15:00:00Z');
    expect(moscowStart(now, 'day').toISOString()).toBe('2026-11-25T21:00:00.000Z');
    expect(moscowStart(now, 'week').toISOString()).toBe('2026-11-22T21:00:00.000Z');
    const ivan = costView(
      [
        op('ivan', 'k2', 0.02, true, '2026-11-26T10:00:00Z'),
        op('ivan', 'k2', null, false, '2026-11-26T11:00:00Z', 'Другой разбор'),
        op('ivan', 'k5', 0, true, '2026-11-24T10:00:00Z'),
        op('ivan', 'k4', 1, true, '2026-10-31T20:00:00Z'),
      ],
      now,
      'http://127.0.0.1:3001/project/ecompras',
    );
    const marina = costView([op('marina', 'k2', 0, true, '2026-11-26T10:00:00Z')], now, '');
    expect(ivan.today).toBe('нет цены');
    expect(ivan.week).toBe('нет цены');
    expect(ivan.month).toBe('нет цены');
    expect(ivan.byAgent.find((row) => row.agent === 'k5')?.total).toBe('$0');
    expect(ivan.byAgent.find((row) => row.agent === 'k5')?.average).toContain('$0');
    expect(ivan.recent.find((row) => row.price === '$0.02')?.trace).toContain('/traces/');
    expect(marina.today).toBe('$0');
    expect(marina.recent[0]?.trace).toBe('');
    expect(JSON.stringify(ivan)).not.toContain('marina');
    const folded = costView(
      [op('ivan', 'accuracy', 0.02, true, '2026-11-26T12:00:00Z', 'Разбор'), op('ivan', 'accuracy', 0.03, true, '2026-11-26T12:01:00Z', 'Разбор'), op('ivan', 'accuracy', 0.03, true, '2026-11-26T12:02:00Z', 'Разбор')],
      now,
      '',
    );
    expect(folded.recent).toHaveLength(1);
    expect(folded.recent[0]?.groupWords).toBe('3 разбора');
    expect(folded.recent[0]?.price).toBe('$0.08');
  });

  it('запрос подписан ecompras, след несёт окружение, метку и цену', async () => {
    expect(providerHeaders('secret')['HTTP-Referer']).toBe('ecompras');
    expect(providerHeaders('secret')['X-Title']).toBe('ecompras');
    expect(providerHeaders('secret').authorization).toBe('Bearer secret');
    process.env.LANGFUSE_HOST = 'http://langfuse.invalid';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk';
    process.env.LANGFUSE_SECRET_KEY = 'sk';
    let payload: { batch: { type: string; body: Record<string, unknown> }[] } | undefined;
    const id = await sendTrace({ ...trace(), costUsd: 0.0052 }, async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response('{}', { status: 200 });
    });
    expect(id).not.toBe('');
    const traceEvent = payload?.batch.find((event) => event.type === 'trace-create');
    const generation = payload?.batch.find((event) => event.type === 'generation-create');
    expect(traceEvent?.body.environment).toBe('ecompras');
    expect(traceEvent?.body.tags).toEqual(['ecompras']);
    expect(generation?.body.environment).toBe('ecompras');
    expect(generation?.body.costDetails).toEqual({ total: 0.0052 });
    expect((generation?.body.usage as { totalCost?: number } | undefined)?.totalCost).toBe(0.0052);
    delete process.env.LANGFUSE_HOST;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
  });

  it('выключенный Langfuse не роняет вызов', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    expect(await sendTrace(trace(), async () => { throw new Error('нет сети'); })).toBe('');
    process.env.LANGFUSE_HOST = 'http://langfuse.invalid';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk';
    process.env.LANGFUSE_SECRET_KEY = 'sk';
    expect(await sendTrace(trace(), async () => { throw new Error('нет сети'); })).toBe('');
    delete process.env.LANGFUSE_HOST;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
  });
});

describe('материалы в трекере и календаре', () => {
  it('связывает задачу с письмом и собирает событие', () => {
    expect(taskUnique('leader', 'task-1')).toBe('ecompras-leader-task-1');
    expect(relatedSubjects('Собрать отчёт по бюджету', ['Бюджет декабря', 'Другое письмо'])).toEqual(['Бюджет декабря']);
    const draft = issueDraft(
      { title: 'Собрать отчёт по бюджету', ownerName: 'Анна', dueOn: '2026-12-01', status: 'в работе', source: 'файл' },
      ['Бюджет декабря'],
    );
    expect(draft.summary).toContain('бюджету');
    expect(draft.description).toContain('Анна');
    expect(draft.description).toContain('Бюджет декабря');
    expect(draft.deadline).toBe('2026-12-01');
    const start = meetingStart('2026-12-07T10:00');
    expect(start.toISOString()).toBe('2026-12-07T07:00:00.000Z');
    const ics = standEvent({ uid: 'meet-1', start, minutes: 30, summary: 'План', description: 'Рядом в почте: Бюджет декабря.' });
    expect(ics).toContain('DTSTART;TZID=Europe/Moscow:20261207T100000');
    expect(ics).toContain('SUMMARY:План');
    expect(readEvents(ics)).toEqual([{ uid: 'meet-1', summary: 'План', start: '20261207T100000' }]);
    expect(eventFile('meet-1')).toMatch(/\.ics$/);
  });
});

describe('протокол после утверждения', () => {
  it('собирает письмо, задачи и приглашение из текста протокола', () => {
    const body = ['Сверка плана', '', 'Участники: Анна, Борис.', '', 'Дальше:', '— Анна пришлёт план.', '— Сверить цифры.', ''].join('\n');
    const at = new Date('2026-11-27T08:00:00Z');
    const release = protocolRelease(body, [{ name: 'Анна', email: 'anna@example.com' }], at, 'abc');
    expect(followUpStart(at).toISOString()).toBe('2026-11-30T07:00:00.000Z');
    expect(release.tasks.map((task) => task.owner)).toEqual(['Анна', 'не назван']);
    expect(release.tasks[0]?.dueOn).toBe('2026-11-30');
    expect(release.text).toContain('Анна <anna@example.com>');
    expect(release.text).toContain('Борис');
    expect(release.text).toContain('тестовый ящик');
    expect(release.text).not.toContain('заглушка');
    expect(release.ics).toContain('METHOD:REQUEST');
    expect(release.ics).toContain('DTSTART:20261130T070000Z');
    expect(release.ics).toContain('SUMMARY:Сверка плана');
  });
});

function op(leaderId: string, agent: string, cost: number | null, priced: boolean, createdAt: string, title = 'Разбор'): OperationRow {
  return {
    id: `${leaderId}-${agent}-${createdAt}`,
    leaderId,
    agent,
    title,
    model: 'model/test',
    calls: 1,
    tokensIn: 10,
    tokensOut: 5,
    ms: 100,
    costUsd: cost,
    priced,
    traceId: priced ? 'trace-1' : '',
    createdAt,
  };
}

function trace() {
  return {
    agent: 'k2',
    leaderId: 'leader',
    operationId: 'op',
    title: 'Разбор',
    model: 'model/test',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: null,
    ms: 10,
    input: 'in',
    output: 'out',
  };
}

async function scene(dir: string) {
  const data = await loadSynthetic(dir);
  const files = await readDepartment(dir);
  const checked = checkDepartment(data.people, files);
  const mail = new Map<string, number>();
  for (const letter of data.emails) {
    const person = data.people.find((row) => row.email.toLowerCase() === letter.fromEmail.toLowerCase());
    if (person) mail.set(person.id, (mail.get(person.id) ?? 0) + 1);
  }
  const people: PersonGoal[] = checked.cards.map((card) => ({
    name: card.name,
    goal: card.goal,
    leaderGoal: card.leaderGoal,
    emails: mail.get(card.personId) ?? 0,
    kpis: card.kpis.map((kpi) => ({
      name: kpi.name,
      unit: kpi.unit,
      better: kpi.better,
      weeks: kpi.weeks.map((week) => ({ fact: week.fact, status: week.status })),
    })),
  }));
  const tasks = data.tasks.map((task) => ({ title: task.task, owner: task.owner, due: task.due, status: task.status }));
  const leader = data.people.find((person) => person.role === 'руководитель');
  return controlOf(data.profile, withLeader(data.profile, leader?.name ?? '', people), tasks);
}

