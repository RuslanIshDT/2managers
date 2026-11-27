import { describe, expect, it } from 'vitest';
import { evalReport, evalScore, type EvalRow } from '../src/agents/eval.ts';

const row = (over: Partial<EvalRow>): EvalRow => ({
  id: 'x',
  subject: 'Тема',
  senderRole: 'подчинённый',
  category: 'отчёт',
  expected: 'в_сводку',
  route: 'k2',
  action: 'вернуть',
  toLeader: false,
  tools: [],
  error: '',
  ...over,
});

describe('T54: счёт замера', () => {
  it('считает доход до руководителя, N1, лишние и точное действие у писем не из отдела', () => {
    const points = ['деньги и бюджеты (скидки)', 'кадры (найм, отпуска)'];
    const score = evalScore([
      row({ id: 'a', category: 'деньги', expected: 'спросить_руководителя', toLeader: true, action: 'спросить_руководителя', tools: ['authorities', 'kpi'] }),
      row({ id: 'b', category: 'кадры', expected: 'спросить_руководителя', toLeader: false }),
      row({ id: 'c', category: 'приглашение', expected: 'спросить_руководителя', toLeader: true, route: 'mail', action: 'спросить_руководителя', senderRole: 'приглашение' }),
      row({ id: 'd', toLeader: true, action: 'спросить_руководителя', tools: ['authorities'] }),
      row({ id: 'e', route: 'mail', senderRole: 'рассылка', category: 'рассылка', expected: 'игнорировать', action: 'игнорировать' }),
      row({ id: 'f', route: 'mail', senderRole: 'клиент', category: 'продажи', expected: 'делегировать', action: 'в_сводку' }),
    ], points);
    expect(score.total).toBe(6);
    expect(score.correct).toBe(4);
    expect(score.needLeader).toBe(3);
    expect(score.caught).toBe(2);
    expect(score.n1).toBe(2);
    expect(score.n1Caught).toBe(1);
    expect(score.falseAlarms).toBe(1);
    expect(score.missed.map((r) => r.id)).toEqual(['b']);
    expect(score.alarms.map((r) => r.id)).toEqual(['d']);
    // Точное действие считается по всем письмам: и внутренним, и внешним (T67).
    expect(score.mailExact).toEqual({ total: 6, correct: 3 });
    expect(score.toolCalls).toEqual({ authorities: 2, kpi: 1 });
    const text = evalReport(score, { model: 'm', at: 'сейчас', costUsd: 0.5, calls: 10, minutes: 2 });
    expect(text).toContain('| Письма пунктов подтверждения из профиля: дошли | 1 из 2 |');
    expect(text).toContain('- b «Тема»');
  });
});
