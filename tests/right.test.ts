import { describe, expect, it } from 'vitest';
import { enforce, rightRuling, type ModelVerdict } from '../src/agents/k2.ts';
import { letterHits, replayWeek, type FlowRule, type RightReading } from '../src/agents/replay.ts';

const discount: FlowRule = {
  kind: 'полномочие',
  title: 'Дать право решать самостоятельно «скидка» до 9%',
  personId: 'p',
  area: 'скидка',
  limitValue: '9',
  fromEmail: 'olga@example',
  subjectKey: '',
  seriesKey: '',
  effect: 'сам',
  cause: '',
};

const compensation: FlowRule = {
  ...discount,
  title: 'Дать право решать самостоятельно «компенсация клиенту» до 5000 ₽',
  area: 'компенсация клиенту',
  limitValue: '5000',
  fromEmail: 'maria@example',
};

function hit(fromEmail: string, subject: string, reading: RightReading | null, rules: FlowRule[]) {
  return letterHits({ fromEmail, subject, body: subject }, rules, reading);
}

const answer = (over: Partial<ModelVerdict>): ModelVerdict => ({
  действие: 'ответить',
  кому_передать: '',
  в_полномочиях: 'да',
  есть_предложение: 'нет',
  только_руководитель: 'нет',
  категория: 'деньги и бюджеты',
  суть: 'Просьба',
  контекст: '',
  рекомендация: '',
  черновик_ответа: 'Ответ',
  предложение_полномочия: '',
  основание: 'Пункт профиля',
  риски: '',
  если_не_решить: '',
  уверенность: 0.8,
  ...over,
});

describe('принятое право только по своему предмету', () => {
  it('без разбора и по чужой области право письмо не забирает', () => {
    expect(hit('olga@example', 'Можно увеличить бюджет на 4%?', null, [discount])).toBeNull();
    expect(hit('olga@example', 'Можно увеличить бюджет на 4%?', { area: 'бюджет', value: 4, unit: '%', others: false }, [discount])).toBeNull();
    expect(hit('olga@example', 'Конверсия выросла на 3%, нужен ваш выбор по бюджету', { area: 'бюджет', value: 3, unit: '%', others: true }, [discount])).toBeNull();
    expect(hit('maria@example', 'Закупка ноутбука 4000 руб.', { area: 'закупка', value: 4000, unit: '₽', others: false }, [compensation])).toBeNull();
  });

  it('своя область в пределе и без другой просьбы — это право, пункт профиля не удерживает', () => {
    const granted = hit('olga@example', 'Клиент просит скидку 7%', { area: 'скидка', value: 7, unit: '%', others: false }, [discount]);
    expect(granted?.effect).toBe('сам');
    const reply = rightRuling(granted ?? discount);
    expect(reply.ask).toBe(false);
    expect(reply.send).toBe(true);
    expect(reply.draft).toContain('Это ваше право');
    expect(reply.draft).toContain('скидка');
    const asked = enforce(answer({ категория: 'деньги и бюджеты' }), 'Клиент просит скидку 7%', ['деньги и бюджеты'], [], null);
    expect(asked.ask).toBe(true);
    expect(reply.kind).toBe('вернуть');
  });

  it('та же область, но есть другая просьба — обычный разбор, к руководителю', () => {
    expect(hit('olga@example', 'Скидка 7% и отсрочка оплаты 60 дней', { area: 'скидка', value: 7, unit: '%', others: true }, [discount])).toBeNull();
    const asked = enforce(answer({ другие_просьбы: 'да' }), 'Скидка 7% и отсрочка оплаты 60 дней', ['деньги и бюджеты'], [], null);
    expect(asked.ask).toBe(true);
  });

  it('индекс покрывает право только по разбору', () => {
    const letters = [
      { fromEmail: 'olga@example', subject: 'Клиент просит скидку 7%', body: '', reading: { area: 'скидка', value: 7, unit: '%', others: false } },
      { fromEmail: 'olga@example', subject: 'Можно увеличить бюджет на 4%?', body: '', reading: { area: 'бюджет', value: 4, unit: '%', others: false } },
      { fromEmail: 'olga@example', subject: 'Старое письмо', body: '' },
    ];
    const picture = replayWeek(letters, [], [discount], true);
    expect(picture.stoppedLetters).toBe(1);
    expect(picture.stillLetters).toBe(2);
  });
});
