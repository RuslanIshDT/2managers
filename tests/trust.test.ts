import { describe, expect, it } from 'vitest';
import { trustOffers } from '../src/agents/replay.ts';
import { decisionOutcome, standTrustRows, trustSubject } from '../src/agents/trust.ts';

const person = { id: 'a', name: 'Аня Петрова', email: 'anya@example.test' };
const power = { personId: 'a', area: 'скидка', unit: '%' };

function approval(id: string, at: string, draft = 'Согласовано', original = 'Согласовано') {
  return {
    id,
    status: 'исполнено',
    subject: 'Скидка клиенту',
    summary: 'скидка',
    draft,
    originalDraft: original,
    replyName: 'Аня Петрова',
    replyTo: 'anya@example.test',
    createdAt: new Date(at),
  };
}

function pressed(ids: string[], action = 'утвердил') {
  return ids.map((refId) => ({ refId, auto: false, action }));
}

describe('журнал доверия', () => {
  it('утверждение без правки, с правкой и отказ различаются, отложенное не считается', () => {
    expect(decisionOutcome('исполнено', 'Текст', 'Текст')).toBe('утверждено');
    expect(decisionOutcome('исполнено', 'Текст', 'Другой текст')).toBe('с правкой');
    expect(decisionOutcome('отклонено', 'Текст', '')).toBe('отклонено');
    expect(decisionOutcome('отложено', 'Текст', 'Текст')).toBeNull();
    expect(decisionOutcome('ждёт', 'Текст', 'Текст')).toBeNull();
  });

  it('пять утверждений без истории дают предложение, одно с правкой — нет', () => {
    const letters = [{ fromEmail: 'anya@example.test', subject: 'Скидка клиенту', body: 'Прошу скидку 8%' }];
    const rows = ['2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06'].map((day, index) => approval(`d${index}`, `${day}T10:00:00Z`));
    const history = standTrustRows({ decisions: rows, acts: pressed(rows.map((row) => row.id)), letters, people: [person], authorities: [power] });
    expect(history).toHaveLength(5);
    expect(history.every((row) => row.outcome === 'утверждено' && row.area === 'скидка')).toBe(true);
    expect(history[0]?.subject).toContain('8%');
    expect(trustOffers(history, [{ personId: 'a', area: 'скидка', limit: '5' }])).toHaveLength(1);
    const editedRows = [...rows.slice(0, 4), approval('d4', '2026-12-06T10:00:00Z', 'Другой текст', 'Согласовано')];
    const edited = standTrustRows({
      decisions: editedRows,
      acts: pressed(editedRows.map((row) => row.id)),
      letters,
      people: [person],
      authorities: [power],
    });
    expect(trustOffers(edited)).toHaveLength(0);
  });

  it('решение без человека или без названной области в журнал не входит', () => {
    const letter = { fromEmail: 'anya@example.test', subject: 'Скидка клиенту', body: 'Прошу скидку 8%' };
    const known = standTrustRows({
      decisions: [approval('d1', '2026-12-02T10:00:00Z')],
      acts: pressed(['d1']),
      letters: [letter],
      people: [person],
      authorities: [power],
    });
    expect(known).toHaveLength(1);
    const stranger = standTrustRows({
      decisions: [{ ...approval('d1', '2026-12-02T10:00:00Z'), replyTo: 'other@example.test', replyName: 'Чужой' }],
      acts: pressed(['d1']),
      letters: [letter],
      people: [person],
      authorities: [power],
    });
    expect(stranger).toEqual([]);
    const otherArea = standTrustRows({
      decisions: [{ ...approval('d1', '2026-12-02T10:00:00Z'), subject: 'График смен', summary: 'планёрка' }],
      acts: pressed(['d1']),
      letters: [{ ...letter, subject: 'График смен', body: 'Сдвинем планёрку' }],
      people: [person],
      authorities: [power],
    });
    expect(otherArea).toEqual([]);
    expect(trustSubject('Скидка клиенту', 'скидка 9%', 'скидка', '%')).toContain('9%');
  });

  it('два утверждения и три ответа помощника предложения не дают, пять утверждений — дают', () => {
    const letters = [{ fromEmail: 'anya@example.test', subject: 'Скидка клиенту', body: 'Прошу скидку 8%' }];
    const leader = [approval('a1', '2026-12-02T10:00:00Z'), approval('a2', '2026-12-03T10:00:00Z')];
    const assistant = ['b1', 'b2', 'b3'].map((id, index) => approval(id, `2026-12-0${index + 4}T10:00:00Z`));
    const mixed = standTrustRows({
      decisions: [...leader, ...assistant],
      acts: [...pressed(leader.map((row) => row.id)), ...assistant.map((row) => ({ refId: row.id, auto: true, action: 'ответил сам' }))],
      letters,
      people: [person],
      authorities: [power],
    });
    expect(mixed).toHaveLength(2);
    expect(trustOffers(mixed, [{ personId: 'a', area: 'скидка', limit: '5' }])).toEqual([]);
    const five = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id, index) => approval(id, `2026-12-0${index + 2}T10:00:00Z`));
    const history = standTrustRows({
      decisions: five,
      acts: pressed(five.map((row) => row.id)),
      letters,
      people: [person],
      authorities: [power],
    });
    expect(trustOffers(history, [{ personId: 'a', area: 'скидка', limit: '5' }])).toHaveLength(1);
  });
});
