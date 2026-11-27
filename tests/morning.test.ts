import { describe, expect, it } from 'vitest';
import { applyMorning, MORNING_UNUSABLE, morningLimit, parseMorningStored, shapeFromAnswer, shapeWords, storeMorning } from '../src/agents/morning.ts';

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
});
