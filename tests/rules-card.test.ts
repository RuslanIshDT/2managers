import { describe, expect, it } from 'vitest';
import { buildDesk, type DeskInput } from '../src/agents/desk.ts';
import type { FlowRule } from '../src/agents/replay.ts';

function rule(kind: FlowRule['kind'], effect: FlowRule['effect']): FlowRule {
  return {
    kind,
    title: '',
    personId: '',
    area: '',
    limitValue: '',
    fromEmail: '',
    subjectKey: '',
    seriesKey: '',
    effect,
    cause: '',
  };
}

function desk(relief: { letters: number; meetings: number } | null, proposal: FlowRule[]) {
  const input: DeskInput = {
    accepted: false,
    decisions: [],
    verdicts: [],
    letters: [],
    meetings: [],
    rules: [],
    people: [],
    authorities: [],
    history: [],
    series: [],
    relief,
    proposal,
    tasks: [],
    calls: [],
  };
  return buildDesk(input).work.find((item) => item.id === 'rules:week');
}

function text(card: { title: string; lines: { title: string }[] } | undefined): string {
  return [card?.title ?? '', ...((card?.lines ?? []).map((line) => line.title))].join('\n');
}

describe('карточка правил недели', () => {
  const proposal = [
    rule('письмо', 'стоп'),
    rule('письмо', 'стоп'),
    rule('письмо', 'дайджест'),
    rule('письмо', 'карточка'),
    rule('встреча', 'стоп'),
    rule('встреча', 'стоп'),
    rule('полномочие', 'сам'),
  ];

  it('письма и встречи: до вас не дойдут, и пояснение из предложенных правил', () => {
    const card = desk({ letters: 12, meetings: 4 }, proposal);
    expect(card?.kind).toBe('rules');
    expect(card?.title).toBe('Примите правила недели: до вас не дойдут 12 писем и 4 встречи');
    expect(card?.title).not.toContain('уйдёт');
    const lines = text(card);
    expect(lines).toContain('Аудит потока признал лишними 3 цепочки и 2 серии: их письма и встречи до вас не доходят');
    expect(lines).toContain('Подчинённым предлагается 1 право решать самому до предела');
    expect(lines).toContain('раздел «Поток» и «Полный аудит потока»');
    expect(lines).toContain('«это в вашем праве»');
    expect(lines).toContain('письма никому не уходят');
    expect(lines).toContain('важные адресаты правилами не отсекаются');
  });

  it('только письма: встречи в заголовке нет', () => {
    const card = desk({ letters: 5, meetings: 0 }, [rule('письмо', 'стоп'), rule('письмо', 'стоп')]);
    expect(card?.title).toBe('Примите правила недели: до вас не дойдут 5 писем');
    expect(card?.title).not.toMatch(/встреч/);
    expect(card?.title).not.toContain('0');
    expect(text(card)).toContain('Аудит потока признал лишними 2 цепочки: их письма до вас не доходят');
    expect(text(card)).not.toMatch(/сери/);
  });

  it('нулевые встречи не показываются', () => {
    const card = desk({ letters: 8, meetings: 0 }, [rule('письмо', 'стоп')]);
    expect(card?.title).toBe('Примите правила недели: до вас не дойдут 8 писем');
    expect(card?.title).not.toContain('0');
    expect(card?.title).not.toMatch(/встреч/);
    const onlyMeetings = desk({ letters: 0, meetings: 1 }, [rule('встреча', 'стоп')]);
    expect(onlyMeetings?.title).toBe('Примите правила недели: до вас не дойдёт 1 встреча');
    expect(onlyMeetings?.title).not.toMatch(/письм/);
    expect(text(onlyMeetings)).toContain('Аудит потока признал лишними 1 серию: их встречи до вас не доходят');
  });

  it('нет предложенных прав — про права в пояснении не написано', () => {
    const card = desk({ letters: 3, meetings: 2 }, [rule('письмо', 'стоп'), rule('встреча', 'дайджест')]);
    const lines = text(card);
    expect(card?.title).toBe('Примите правила недели: до вас не дойдут 3 письма и 2 встречи');
    expect(lines).toContain('1 цепочку и 1 серию');
    expect(lines).not.toContain('решать самому');
    expect(lines).not.toContain('предлагается');
    expect(lines).toContain('«это в вашем праве»');
    expect(lines).toContain('Полный аудит потока');
  });
});
