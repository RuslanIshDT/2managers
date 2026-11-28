import { describe, expect, it } from 'vitest';
import {
  canonicalCategory,
  confirmationPoints,
  leaderMustConfirm,
  amountBlocksRule,
  breachesFromAnswer,
  limitBreaches,
  nearestAmount,
  withinLimit,
} from '../src/agents/confirm.ts';

const profile = `# Профиль
## Никогда без подтверждения руководителя
- деньги и бюджеты (скидки, перераспределения, закупки);
- кадры (найм, офферы, отпуска, увольнения);
- обязательства клиентам (сроки, условия, гарантии);
`;

describe('правила подтверждения из профиля', () => {
  it('берёт пункты раздела и не берёт пустой раздел', () => {
    expect(confirmationPoints(profile)).toHaveLength(3);
    expect(confirmationPoints('# Профиль\nДругой раздел\n- пункт')).toEqual([]);
    expect(confirmationPoints('')).toEqual([]);
  });

  it('точное совпадение с пунктом уходит руководителю, чужая строка — нет', () => {
    const points = confirmationPoints(profile);
    expect(leaderMustConfirm(points[0] ?? '', points)).toBe(true);
    expect(canonicalCategory(points[1] ?? '', points)).toBe(points[1]);
    expect(canonicalCategory('кадры', points)).toBe('иное');
    expect(leaderMustConfirm('кадры', points)).toBe(true);
    expect(leaderMustConfirm('обязательства_клиентам', points)).toBe(true);
    expect(leaderMustConfirm('клиенты', points)).toBe(false);
    expect(leaderMustConfirm('иное', points)).toBe(false);
    expect(leaderMustConfirm('деньги', [])).toBe(false);
  });

  it('берёт число рядом с областью, а не чужое число той же единицы', () => {
    const text = 'Маржа 18%. Прошу скидку 12% и отдельно бонус 4%.';
    expect(nearestAmount(text, 'скидка', '%')).toBe(12);
    expect(nearestAmount(text, 'маржа', '%')).toBe(18);
    expect(limitBreaches(text, [{ area: 'скидка', limit: '5', unit: '%' }])).toEqual([
      { area: 'скидка', asked: 12, limit: 5, unit: '%' },
    ]);
    expect(limitBreaches('Скидка 4%', [{ area: 'скидка', limit: '5', unit: '%' }])).toEqual([]);
    expect(limitBreaches('Прошу компенсацию клиенту 8 000 ₽', [{ area: 'компенсация клиенту', limit: '5000', unit: '₽' }])[0]?.asked).toBe(8000);
    expect(limitBreaches('Бюджет кампании 250 000 руб.', [{ area: 'бюджет кампании', limit: '200000', unit: '₽' }])[0]?.asked).toBe(250000);
    expect(limitBreaches('Отпуск с 20 декабря', [{ area: 'отпуск', limit: '5', unit: '%' }])).toEqual([]);
    const power = [{ area: 'компенсация клиенту', limit: '5000', unit: '₽' }];
    expect(breachesFromAnswer({ area: 'компенсация клиенту', value: 8000, unit: '₽' }, power)[0]?.asked).toBe(8000);
    expect(breachesFromAnswer({ area: 'компенсация клиенту', value: 4000, unit: '₽' }, power)).toEqual([]);
    expect(breachesFromAnswer({ area: 'нет', value: 8000, unit: '₽' }, power)).toEqual([]);
    expect(amountBlocksRule('компенсация 8000 руб. и ещё 1000 руб.', power)).toBe(true);
    expect(withinLimit('компенсация 4000 руб.', 'компенсация клиенту', 5000, '₽')).toBe(true);
    expect(withinLimit('компенсация 4000 руб. и 1000 руб.', 'компенсация клиенту', 5000, '₽')).toBe(false);
  });
});
