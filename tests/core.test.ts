import { describe, expect, it } from 'vitest';
import { hashPassword, hashToken, verifyPassword } from '../src/auth.ts';
import { checkDepartment, readDepartment } from '../src/agents/k1.ts';
import { loadSynthetic } from '../src/data/synthetic.ts';
import { applyOrigin, formOrigin, requestOrigin } from '../src/http/origin.ts';
import { mailConfig } from '../src/mail.ts';
import { decisionCallback, parseCallback, parseStart } from '../src/telegram.ts';

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
  });
});
