import { describe, expect, it } from 'vitest';
import { overdueTasks } from '../src/agents/focus.ts';
import { dateWords, letterMoment, parseSceneFile, previousWorkday, sceneClock, sceneDay, waitedDays } from '../src/agents/scene.ts';
import { loadSynthetic } from '../src/data/synthetic.ts';

describe('дата сцены T44', () => {
  it('читает дату из файла руководителя, без файла — реальная дата', () => {
    expect(parseSceneFile('# пометка\ntoday\n2026-12-11\n')).toBe('2026-12-11');
    expect(parseSceneFile('today\nзавтра\n')).toBeNull();
    expect(sceneDay('нет-такого-каталога')).toBeNull();
    const real = new Date('2026-11-27T10:00:00Z');
    expect(sceneClock(null, real).now.getTime()).toBe(real.getTime());
  });

  it('сегодня — день сцены, время суток настоящее', () => {
    const clock = sceneClock('2026-12-11', new Date('2026-11-27T10:15:00Z'));
    expect(clock.today).toBe('2026-12-11');
    expect(clock.now.toISOString()).toBe('2026-12-11T10:15:00.000Z');
  });

  it('письмо из данных несёт своё время, живое сдвигается на сцену', () => {
    const clock = sceneClock('2026-12-11', new Date('2026-11-27T10:15:00Z'));
    expect(letterMoment('2026-12-10 12:52', true, clock).toISOString()).toBe('2026-12-10T09:52:00.000Z');
    expect(letterMoment('Fri, 27 Nov 2026 08:45:12 GMT', false, clock).toISOString()).toBe('2026-12-11T08:45:12.000Z');
    expect(waitedDays(letterMoment('2026-12-10 12:52', true, clock), clock.now)).toBe(1);
  });

  it('вчера для понедельника — пятница, даты словами', () => {
    expect(previousWorkday('2026-12-14')).toBe('2026-12-11');
    expect(previousWorkday('2026-12-11')).toBe('2026-12-10');
    expect(dateWords('2026-12-13')).toBe('13 декабря');
  });

  it('на сцене Ивана есть встречи сегодня и вчера и настоящие просрочки', async () => {
    const day = sceneDay('synthetic');
    expect(day).not.toBeNull();
    const data = await loadSynthetic('data/synthetic');
    const today = day ?? '';
    expect(data.meetings.some((meeting) => meeting.start.replace(/\D/g, '').startsWith(today.replace(/-/g, '')))).toBe(true);
    const yesterday = previousWorkday(today).replace(/-/g, '');
    expect(data.meetings.some((meeting) => meeting.start.replace(/\D/g, '').startsWith(yesterday))).toBe(true);
    const late = overdueTasks(
      data.tasks.map((task) => ({ title: task.task, owner: task.owner, dueOn: task.due, status: task.status })),
      today,
    );
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((task) => task.dueOn < today)).toBe(true);
    const lastLetter = [...data.emails].map((email) => email.received).sort().at(-1) ?? '';
    expect(lastLetter.slice(0, 10) <= today).toBe(true);
  });
});

describe('полномочия и доверие на данных T46', () => {
  it('история Ольги выше её права, предложение — выше права; у второго руководителя право с пределом', async () => {
    const { readHistory } = await import('../src/agents/dependence.ts');
    const { readDepartment } = await import('../src/agents/k1.ts');
    const { trustOffers } = await import('../src/agents/replay.ts');
    for (const dir of ['data/synthetic', 'data/leader2']) {
      const history = await readHistory(dir);
      const files = await readDepartment(dir);
      const rights = files.authorities.map((row) => ({ personId: row.personId, area: row.area, limit: row.limit }));
      const offers = trustOffers(history, rights);
      expect(offers.length).toBeGreaterThan(0);
      for (const offer of offers) {
        const have = rights.find((row) => row.personId === offer.personId && row.area === offer.area);
        expect(offer.limit).not.toBeNull();
        if (have) expect(offer.limit ?? 0).toBeGreaterThan(Number(have.limit));
        expect(offer.title).not.toContain('без числового предела');
      }
      for (const row of history.filter((item) => item.outcome === 'утверждено')) {
        const have = rights.find((right) => right.personId === row.personId && right.area === row.area);
        const value = Number(/(\d+)/.exec(row.subject)?.[1] ?? 'NaN');
        if (have && Number.isFinite(value)) expect(value).toBeGreaterThan(Number(have.limit));
      }
    }
  });
});

describe('утро проверяет объяснение модели T47', () => {
  it('убирает идентификаторы и чужие имена, оставляет основание из данных', async () => {
    const { checkedWhy } = await import('../src/agents/conductor.ts');
    const source = { id: 'matrix:Дмитрий Козлов', kind: 'матрица', title: 'Дмитрий Козлов: Встреча один на один', detail: 'KPI отстаёт, писем 0', goal: '', person: 'Дмитрий Козлов' };
    const names = ['Ольга Смирнова', 'Дмитрий Козлов'];
    expect(checkedWhy('Тихая проблема: KPI Ольги отстаёт', source, names)).toBe('KPI отстаёт, писем 0');
    expect(checkedWhy('Дмитрий не пишет, KPI Козлова отстаёт', source, names)).toBe('Дмитрий не пишет, KPI Козлова отстаёт');
    expect(checkedWhy('Ольга Смирнова отстаёт, писем 0', source, names)).toBe('KPI отстаёт, писем 0');
    expect(checkedWhy('Карточка kpi:p02 закрывается', source, names)).toBe('KPI отстаёт, писем 0');
    expect(checkedWhy('Раннее вмешательство дешевле срыва плана', source, names)).toBe('Раннее вмешательство дешевле срыва плана');
  });
});

describe('N1 в предложениях T48', () => {
  it('серия с деньгами, кадрами или обещанием клиенту правилом не убирается', async () => {
    const { rulesFromAudit } = await import('../src/agents/replay.ts');
    const { seriesCategory } = await import('../src/agents/focus-run.ts');
    expect(seriesCategory('Бюджет и прогноз', 'иное')).toBe('деньги');
    expect(seriesCategory('Интервью кандидата', 'кадры')).toBe('кадры');
    expect(seriesCategory('Синк с ИТ', 'иное')).toBe('иное');
    const pieces = [
      { kind: 'встречи' as const, key: 'Интервью кандидата', title: 'Интервью кандидата', verdict: 'не_должно', change: '', cause: 'руководитель_лишний' },
      { kind: 'встречи' as const, key: 'Синк с ИТ', title: 'Синк с ИТ', verdict: 'не_должно', change: '', cause: 'руководитель_лишний' },
    ];
    const rules = rulesFromAudit(pieces, [], new Map(), new Map([['встреча|интервью кандидата', 'кадры']]));
    expect(rules.find((rule) => rule.seriesKey === 'Интервью кандидата')?.effect ?? 'карточка').toBe('карточка');
    expect(rules.find((rule) => rule.seriesKey === 'Синк с ИТ')?.effect).toBe('стоп');
  });
});
