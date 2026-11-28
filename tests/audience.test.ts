import { describe, expect, it } from 'vitest';
import { forceMailAction } from '../src/agents/accuracy.ts';
import { addresseeHold, audiencesFromAnswer, orgStamp, type OrgMember } from '../src/agents/audience.ts';
import { enforce, type ModelVerdict } from '../src/agents/k2.ts';
import { ruleEffect, rulesFromAudit } from '../src/agents/replay.ts';

const boss: OrgMember = {
  id: 'a',
  name: 'Анна Босс',
  email: 'anna@example',
  position: 'Директор направления',
  role: 'выше',
  reportsTo: '—',
};
const peer: OrgMember = {
  id: 'b',
  name: 'Пётр Сотрудник',
  email: 'petr@example',
  position: 'Специалист',
  role: 'рядом',
  reportsTo: 'a',
};
const topic = 'закупки';
const addressed = 'письма тем, кто выше по должности';
const other = 'письма специалисту рядом';

const reply: ModelVerdict = {
  действие: 'ответить',
  кому_передать: '',
  в_полномочиях: 'да',
  есть_предложение: 'нет',
  только_руководитель: 'нет',
  категория: 'иное',
  суть: 'Короткий вопрос',
  контекст: '',
  рекомендация: '',
  черновик_ответа: 'Отвечаю по существу.',
  предложение_полномочия: '',
  основание: 'Вопрос по факту',
  риски: '',
  если_не_решить: '',
  уверенность: 0.5,
};

describe('адресаты пункта профиля', () => {
  it('пустой список — пункт про тему, ответ начальнику не задерживается', () => {
    const audiences = audiencesFromAnswer(
      { пункты: [{ пункт: topic, люди: [] }, { пункт: addressed, люди: [] }] },
      [topic, addressed],
      [boss, peer],
    );
    expect(audiences.find((row) => row.point === addressed)?.people).toEqual([]);
    const ruled = enforce(reply, 'Как прошла встреча?', [topic, addressed], [], null, [], [], boss.email, audiences, boss.name);
    expect(ruled.kind).toBe('вернуть');
    expect(ruled.ask).toBe(false);
  });

  it('другая должность в пункте даёт другой список, ответ только этому человеку ждёт утверждения', () => {
    const toBoss = audiencesFromAnswer({ пункты: [{ пункт: addressed, люди: [boss.name] }] }, [addressed], [boss, peer]);
    const toPeer = audiencesFromAnswer({ пункты: [{ пункт: other, люди: [peer.name] }] }, [other], [boss, peer]);
    expect(toBoss[0]?.people.map((person) => person.email)).toEqual([boss.email]);
    expect(toPeer[0]?.people.map((person) => person.email)).toEqual([peer.email]);
    const held = enforce(reply, 'Как прошла встреча?', [addressed], [], null, [], [], boss.email, toBoss, boss.name);
    expect(held.ask).toBe(true);
    expect(held.send).toBe(false);
    expect(held.category).toBe(addressed);
    expect(held.basis).toContain(addressed);
    expect(held.basis).toContain(boss.name);
    const asked = enforce({ ...reply, действие: 'руководителю' }, 'Как прошла встреча?', [addressed], [], null, [], [], boss.email, toBoss, boss.name);
    expect(asked.ask).toBe(true);
    expect(asked.basis.startsWith('Код:')).toBe(true);
    expect(asked.basis).toContain(boss.name);
    const notHeld = enforce(reply, 'Как прошла встреча?', [other], [], null, [], [], boss.email, toPeer, boss.name);
    expect(notHeld.kind).toBe('вернуть');
    const forwarded = enforce(
      { ...reply, действие: 'передать', кому_передать: peer.name, черновик_ответа: 'Посмотрите.' },
      'Просьба',
      [other],
      [],
      null,
      [],
      [{ name: peer.name, email: peer.email }],
      'other@example',
      toPeer,
      'Кто-то',
    );
    expect(forwarded.ask).toBe(true);
    expect(forwarded.basis).toContain(peer.name);
  });

  it('неизвестное имя отбрасывается, смена должности меняет отпечаток оргструктуры', () => {
    const audiences = audiencesFromAnswer({ пункты: [{ пункт: addressed, люди: ['Никого Нет', boss.name] }] }, [addressed], [boss]);
    expect(audiences[0]?.people).toEqual([{ name: boss.name, email: boss.email }]);
    expect(orgStamp([boss])).not.toBe(orgStamp([{ ...boss, position: 'Другая должность' }]));
    expect(addresseeHold(audiences, 'в_сводку', { name: boss.name, email: boss.email }, null)).toBeNull();
  });

  it('письмо такого человека правило без руководителя не уводит', () => {
    expect(ruleEffect('не_должно', 'иное', [], true)).toBe('карточка');
    expect(ruleEffect('не_должно', 'иное', [], false)).toBe('стоп');
    const piece = { kind: 'письма' as const, key: `${boss.email}|вопрос`, title: 'Вопрос', verdict: 'не_должно', change: 'убрать', cause: '' };
    const guarded = rulesFromAudit([piece], [], new Map(), new Map(), [], new Set([boss.email]));
    expect(guarded[0]?.effect).toBe('карточка');
    const open = rulesFromAudit([piece], [], new Map(), new Map(), [], new Set());
    expect(open[0]?.effect).toBe('стоп');
    expect(forceMailAction('иное', [], 'авто', true)).toEqual({ action: 'спросить_руководителя', forced: true });
    expect(forceMailAction('иное', [], 'в_сводку', true)).toEqual({ action: 'в_сводку', forced: false });
  });
});
