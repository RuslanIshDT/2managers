import { describe, expect, it } from 'vitest';
import { hashPassword, hashToken, verifyPassword } from '../src/auth.ts';
import { checkDepartment, readDepartment } from '../src/agents/k1.ts';
import { chainKey, discountLimit, enforce, textSignals, type ModelVerdict } from '../src/agents/k2.ts';
import { lettersForMailbox } from '../src/agents/intake.ts';
import { loadSynthetic } from '../src/data/synthetic.ts';
import { parseMailboxSource, syntheticSource } from '../src/mail.ts';
import { applyOrigin, formOrigin, requestOrigin } from '../src/http/origin.ts';
import { mailConfig } from '../src/mail.ts';
import { authorityBlocks, dependenceIndex, dependenceOf, staffCard, trustOffer, type AuditTotals } from '../src/agents/dependence.ts';
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

const AUDIT: AuditTotals = {
  flowHours: 22.58,
  freedHours: 13.91,
  letters: 80,
  meetings: 50,
  stoppedLetters: 40,
  stoppedMeetings: 4,
  digestLetters: 40,
  digestMeetings: 35,
};

describe('индекс и правила недели', () => {
  it('до правил индекс 100, после — доля оставшихся часов', () => {
    expect(dependenceIndex(22.58, 22.58)).toBe(100);
    expect(dependenceIndex(22.58, 22.58 - 13.91)).toBe(38);
    const before = dependenceOf(AUDIT, false);
    const after = dependenceOf(AUDIT, true);
    expect(before.before).toBe(100);
    expect(after.after).toBe(38);
    expect(before.stoppedLetters).toBe(0);
    expect(after.stoppedLetters).toBe(40);
    expect(after.digestMeetings).toBe(35);
  });

  it('пять утверждений подряд дают Ольге скидку до 10%, 8% закрывает правило, 12% нет', () => {
    const rows = [
      { personId: 'p02', area: 'скидка', subject: 'старая', outcome: 'с_правкой', at: '2026-10-20' },
      { personId: 'p02', area: 'скидка', subject: '1', outcome: 'утверждено', at: '2026-11-03' },
      { personId: 'p02', area: 'скидка', subject: '2', outcome: 'утверждено', at: '2026-11-10' },
      { personId: 'p02', area: 'скидка', subject: '3', outcome: 'утверждено', at: '2026-11-17' },
      { personId: 'p02', area: 'скидка', subject: '4', outcome: 'утверждено', at: '2026-11-24' },
      { personId: 'p02', area: 'скидка', subject: '5', outcome: 'утверждено', at: '2026-12-01' },
    ];
    const offer = trustOffer(rows, 'p02', 'скидка');
    expect(offer.ready).toBe(true);
    expect(offer.streak).toBe(5);
    expect(offer.limit).toBe(10);
    const rules = [{ personId: 'p02', email: 'p02@company.example', area: 'скидка', limit: 10 }];
    expect(authorityBlocks({ fromEmail: 'p02@company.example', subject: 'Скидка', body: 'Скидка 8% для «Поле»' }, rules)?.limit).toBe(10);
    expect(authorityBlocks({ fromEmail: 'p02@company.example', subject: 'Скидка', body: 'Скидка 12% для «Ромашка»' }, rules)).toBeNull();
    expect(staffCard({ вывод: '', рекомендация: 'да', основание: '', риски: '', если_не_решить: '', контекст: '' })).toBeNull();
    expect(staffCard({ вывод: 'Скидка', рекомендация: 'Утвердить', основание: 'лимит', риски: 'маржа', если_не_решить: 'клиент ждёт', контекст: 'письмо' })?.вывод).toBe('Скидка');
  });
});

