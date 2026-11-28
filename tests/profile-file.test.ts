import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { goalCascade } from '../src/agents/control.ts';
import { applyGoals, catalogProfile, nextProfile, parseGoals } from '../src/agents/profile-file.ts';

describe('профиль из файла', () => {
  it('обновляет текст, если файл изменился, и не трогает тот же текст', () => {
    expect(nextProfile('старый', 'новый')).toBe('новый');
    expect(nextProfile('тот же', 'тот же')).toBeNull();
  });

  it('раздел целей берётся из файла целей, остальной профиль не меняется', async () => {
    const raw = await readFile('data/synthetic/leader_profile.md', 'utf8');
    const goals = parseGoals(await readFile('data/synthetic/goals.csv', 'utf8'));
    expect(goals.map((row) => row.n)).toEqual(['1', '2', '3']);
    expect(applyGoals(raw, goals)).toBe(raw);
    expect(await catalogProfile('data/synthetic')).toBe(raw);
    const second = await readFile('data/leader2/leader_profile.md', 'utf8');
    expect(await catalogProfile('data/leader2')).toBe(second);
    const replaced = applyGoals(raw, [{ n: '1', goal: 'Другая цель.' }]);
    expect(replaced).toContain('1. Другая цель.');
    expect(replaced).not.toContain('Выполнить план продаж SMB.');
    expect(replaced).toContain('## Куда направить освобождённое время');
    expect(replaced).toContain('## Никогда без подтверждения руководителя');
  });
});

describe('KPI целей', () => {
  it('цель без KPI владельца — дыра, цель без владельца — своя дыра', () => {
    const noKpi = goalCascade({
      goals: [{ n: '1', text: 'Сдать линию' }],
      people: [{ name: 'Пётр', goal: 'Сдать линию', leaderGoal: '1', emails: 0, kpis: [] }],
      tasks: [],
    });
    expect(noKpi.holes).toContainEqual({ kind: 'KPI нет', text: 'Сдать линию' });
    const noOwner = goalCascade({
      goals: [{ n: '2', text: 'Снизить брак' }],
      people: [],
      tasks: [],
    });
    expect(noOwner.holes).toContainEqual({ kind: 'цель без владельца', text: 'Снизить брак' });
    expect(noOwner.holes.some((hole) => hole.kind === 'KPI нет')).toBe(false);
  });
});