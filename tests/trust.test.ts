import { describe, expect, it } from 'vitest';
import { trustOffers } from '../src/agents/replay.ts';
import { decisionOutcome, standTrustRows, trustSubject } from '../src/agents/trust.ts';

const person = { id: 'a', name: 'Аня Петрова', email: 'anya@example.test' };
const power = { personId: 'a', area: 'скидка', unit: '%' };

function approval(at: string, draft = 'Согласовано', original = 'Согласовано') {
  return {
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
    const rows = ['2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06'].map((day) => approval(`${day}T10:00:00Z`));
    const history = standTrustRows({ decisions: rows, letters, people: [person], authorities: [power] });
    expect(history).toHaveLength(5);
    expect(history.every((row) => row.outcome === 'утверждено' && row.area === 'скидка')).toBe(true);
    expect(history[0]?.subject).toContain('8%');
    expect(trustOffers(history, [{ personId: 'a', area: 'скидка', limit: '5' }])).toHaveLength(1);
    const edited = standTrustRows({
      decisions: [...rows.slice(0, 4), approval('2026-12-06T10:00:00Z', 'Другой текст', 'Согласовано')],
      letters,
      people: [person],
      authorities: [power],
    });
    expect(trustOffers(edited)).toHaveLength(0);
  });

  it('решение без человека или без названной области в журнал не входит', () => {
    const letter = { fromEmail: 'anya@example.test', subject: 'Скидка клиенту', body: 'Прошу скидку 8%' };
    const known = standTrustRows({
      decisions: [approval('2026-12-02T10:00:00Z')],
      letters: [letter],
      people: [person],
      authorities: [power],
    });
    expect(known).toHaveLength(1);
    const stranger = standTrustRows({
      decisions: [{ ...approval('2026-12-02T10:00:00Z'), replyTo: 'other@example.test', replyName: 'Чужой' }],
      letters: [letter],
      people: [person],
      authorities: [power],
    });
    expect(stranger).toEqual([]);
    const otherArea = standTrustRows({
      decisions: [{ ...approval('2026-12-02T10:00:00Z'), subject: 'График смен', summary: 'планёрка' }],
      letters: [{ ...letter, subject: 'График смен', body: 'Сдвинем планёрку' }],
      people: [person],
      authorities: [power],
    });
    expect(otherArea).toEqual([]);
    expect(trustSubject('Скидка клиенту', 'скидка 9%', 'скидка', '%')).toContain('9%');
  });
});
