import { describe, expect, it } from 'vitest';
import { checkDepartment, planPeopleSync, type DepartmentFiles } from '../src/agents/k1.ts';
import { applyGoals } from '../src/agents/profile-file.ts';

const current = [
  { externalId: 'a', position: 'Мастер', role: 'подчинённый', reportsTo: 'b' },
  { externalId: 'b', position: 'Начальник', role: 'руководитель', reportsTo: '' },
];

describe('люди из источника', () => {
  it('добавляет нового и обновляет должность, роль и подчинение, отсутствующего не удаляет', () => {
    const plan = planPeopleSync(current, [
      { id: 'a', name: 'Алла', position: 'Старший мастер', role: 'подчинённый', reportsTo: 'b', email: 'a@example.com' },
      { id: 'b', name: 'Борис', position: 'Начальник', role: 'руководитель', reportsTo: '', email: 'b@example.com' },
      { id: 'c', name: 'Глеб', position: 'Мастер', role: 'подчинённый', reportsTo: 'b', email: 'c@example.com' },
    ]);
    expect(plan.insert.map((person) => person.id)).toEqual(['c']);
    expect(plan.update).toEqual([{ id: 'a', position: 'Старший мастер', role: 'подчинённый', reportsTo: 'b' }]);
  });

  it('без изменений файла некого добавлять и некого менять', () => {
    const plan = planPeopleSync(current, [
      { id: 'a', name: 'Алла', position: 'Мастер', role: 'подчинённый', reportsTo: 'b', email: 'a@example.com' },
      { id: 'b', name: 'Борис', position: 'Начальник', role: 'руководитель', reportsTo: '', email: 'b@example.com' },
    ]);
    expect(plan.insert).toEqual([]);
    expect(plan.update).toEqual([]);
  });

  it('новый человек источника проходит в карточку с KPI и полномочием', () => {
    const weeks = ['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'];
    const point = (personId: string, week: string, fact: string) => ({
      personId,
      kpiId: 'k',
      name: 'Выпуск',
      unit: 'шт',
      better: 'больше',
      week,
      plan: '10',
      fact,
    });
    const files: DepartmentFiles = {
      department: [
        { personId: 's2', zone: 'Смена', goal: 'Сдать смену', leaderGoal: '1' },
        { personId: 's3', zone: 'Ночь', goal: 'Закрыть ночь', leaderGoal: '1' },
      ],
      kpis: [...weeks.flatMap((week) => [point('s2', week, '9'), point('s3', week, '8')]), point('s2', 'квартал', '36'), point('s3', 'квартал', '32')],
      authorities: [
        { personId: 's2', area: 'простой', limit: '1', unit: 'ч', note: '' },
        { personId: 's3', area: 'допуск', limit: '1', unit: 'чел', note: '' },
      ],
    };
    const checked = checkDepartment(
      [
        { id: 's1', name: 'Борис', role: 'руководитель' },
        { id: 's2', name: 'Алла', role: 'подчинённый' },
        { id: 's3', name: 'Глеб', role: 'подчинённый' },
      ],
      files,
      '2026-12-07',
    );
    expect(checked.errors).toEqual([]);
    const added = checked.cards.find((card) => card.personId === 's3');
    expect(added?.kpis[0]?.quarter?.fact).toBe('32');
    expect(added?.authorities[0]?.area).toBe('допуск');
  });

  it('цель в профиле формы меняется из файла целей, остальные разделы остаются', () => {
    const stored = 'Борис — Начальник\n\n## Цели на квартал\n1. Старая.\n\n## Никогда без подтверждения руководителя\n- допуск к станку\n';
    const next = applyGoals(stored, [{ n: '1', goal: 'Новая цель.' }]);
    expect(next).toContain('1. Новая цель.');
    expect(next).not.toContain('Старая');
    expect(next).toContain('допуск к станку');
  });
});
