import { describe, expect, it } from 'vitest';
import { applyMorning, combineMorning, MORNING_UNUSABLE, morningLimit, parseMorningStored, shapeFromAnswer, shapeWords, storeMorning, type MorningShape } from '../src/agents/morning.ts';

describe('правило утра', () => {
  it('собирает порядок, скрытый блок и предел строк и словами говорит, как понято', () => {
    const result = shapeFromAnswer({
      порядок: ['просрочено', 'ждут решения'],
      скрыть: ['время на цели'],
      не_больше: [{ блок: 'три дела', строк: 3 }],
      указание: 'сначала то, что горит',
      не_применить: '',
    });
    expect(result.shape?.order).toEqual(['overdue', 'waiting']);
    expect(result.shape?.hide).toEqual(['share']);
    expect(result.shape?.focus).toContain('горит');
    expect(morningLimit(result.shape, 'plan')).toBe(3);
    expect(applyMorning(result.shape)[0]).toBe('overdue');
    expect(applyMorning(result.shape)).not.toContain('share');
    expect(result.note).toContain('просрочено');
    expect(result.note).toContain('время на цели');
    const stored = storeMorning(result);
    expect(parseMorningStored(stored)?.hide).toEqual(['share']);
    expect(shapeWords(result.shape!)).toContain('три дела');
  });

  it('правило не про утро не становится действующим', () => {
    const verse = shapeFromAnswer({ порядок: [], скрыть: [], не_больше: [], указание: '', не_применить: 'это не про блоки утра' });
    expect(verse.shape).toBeNull();
    expect(verse.note).toBe(MORNING_UNUSABLE);
    expect(parseMorningStored(storeMorning(verse))).toBeNull();
    expect(shapeFromAnswer({ порядок: [], скрыть: [], не_больше: [], указание: '', не_применить: '' }).shape).toBeNull();
    expect(applyMorning(null)).toContain('waiting');
  });

  it('все правила действуют вместе, позднее перекрывает раннее, порядок строк не важен', () => {
    const order: MorningShape = { order: ['overdue', 'waiting'], hide: [], limit: [], focus: '' };
    const hide: MorningShape = { order: [], hide: ['share'], limit: [], focus: '' };
    const later: MorningShape = { order: ['meetings', 'own'], hide: [], limit: [], focus: '' };
    const both = combineMorning([
      { id: 'b', at: '2026-12-02T10:00:00.000Z', text: 'не показывай долю', shape: hide },
      { id: 'a', at: '2026-12-01T10:00:00.000Z', text: 'сначала просроченные', shape: order },
    ]);
    expect(both.shape?.order).toEqual(['overdue', 'waiting']);
    expect(both.shape?.hide).toEqual(['share']);
    expect(both.notes).toEqual({});
    expect(applyMorning(both.shape)[0]).toBe('overdue');
    expect(applyMorning(both.shape)).not.toContain('share');
    const edited = combineMorning([
      { id: 'a', at: '2026-12-01T10:00:00.000Z', text: 'сначала встречи', shape: later },
      { id: 'b', at: '2026-12-02T10:00:00.000Z', text: 'сначала просроченные', shape: order },
    ]);
    expect(edited.shape?.order).toEqual(['overdue', 'waiting']);
    expect(edited.notes.a).toContain('сначала просроченные');
    expect(edited.notes.b).toBeUndefined();
  });
});
