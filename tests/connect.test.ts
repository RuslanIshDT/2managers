import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  acceptLogin,
  acceptPassword,
  acceptSource,
  buildProfile,
  previewConnect,
  storedLinks,
  templateLists,
  type ConnectRequest,
} from '../src/agents/connect.ts';
import { confirmationPoints } from '../src/agents/confirm.ts';
import { profileItems } from '../src/agents/free-time.ts';
import { profileToStore } from '../src/agents/profile-file.ts';

const root = await mkdtemp(join(tmpdir(), 'leader-'));

function request(patch: Partial<ConnectRequest> = {}): ConnectRequest {
  return {
    source: 'shift',
    personId: 's1',
    login: 'boris',
    password: 'long-pass',
    confirm: ['своё правило'],
    confirmOwn: 'допуск к станку',
    time: [],
    timeOwn: 'разбор смены',
    hours: '4',
    mailAddress: 'box@example.com',
    mailPassword: 'mail-secret',
    calendarPassword: 'cal-secret',
    trackerOrg: 'org',
    trackerQueue: 'queue',
    trackerToken: 'token-secret',
    ...patch,
  };
}

async function writeCatalog(dir: string, kpiTail: string) {
  await writeFile(
    join(dir, 'org_structure.csv'),
    'id,name,position,role_for_leader,reports_to\ns1,Борис Седов,Начальник участка,руководитель,—\ns2,Алла Ким,Мастер,подчинённый,s1\n',
  );
  await writeFile(
    join(dir, 'inbox.csv'),
    'id,received,from_name,from_email,sender_role,to,subject,body,repeat,category,expected_action,reason\na1,2026-12-07T09:00,Алла Ким,alla@example.com,подчинённый,boss@example.com,Смена,Текст,нет,иное,в_сводку,тест\n',
  );
  await writeFile(
    join(dir, 'calendar.ics'),
    'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:meet-1\nDTSTART:20261207T100000\nDTEND:20261207T110000\nSUMMARY:План смены\nORGANIZER:mailto:boss@example.com\nEND:VEVENT\nEND:VCALENDAR\n',
  );
  await writeFile(join(dir, 'tasks.csv'), 'id,task,owner,due,status,source\nt1,Принять оснастку,Борис Седов,2026-12-15,в работе,план\n');
  await writeFile(join(dir, 'department.csv'), 'person_id,zone,goal,leader_goal\ns2,Смена,Сдать смену,1\n');
  await writeFile(
    join(dir, 'kpi.csv'),
    `person_id,kpi_id,name,unit,better,week,plan,fact\ns2,k,Выпуск,шт,больше,2026-11-09,10,9\ns2,k,Выпуск,шт,больше,2026-11-16,10,9\ns2,k,Выпуск,шт,больше,2026-11-23,10,9\ns2,k,Выпуск,шт,больше,2026-11-30,10,9\n${kpiTail}`,
  );
  await writeFile(join(dir, 'authority.csv'), 'person_id,area,limit,unit,note\ns2,простой,1,ч,\n');
  await writeFile(join(dir, 'goals.csv'), 'n,goal\n1,Сдать смену.\n');
  await writeFile(join(dir, 'scene.csv'), 'today\n2026-12-07\n');
  await writeFile(join(dir, 'decisions_history.csv'), 'person_id,area,subject,outcome,at\n');
  await writeFile(join(dir, 'source.txt'), 'Участок\n');
}

describe('подключение руководителя', () => {
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('не хранит пароль и токен и не перезаписывает профиль формы', () => {
    const saved = storedLinks(request());
    expect(saved).toEqual({ mailAddress: 'box@example.com', trackerOrg: 'org', trackerQueue: 'queue' });
    expect(JSON.stringify(saved)).not.toMatch(/secret/);
    expect(acceptPassword('short')).toBeTruthy();
    expect(acceptPassword('long-pass')).toBeNull();
    expect(acceptLogin('boris', ['Boris'])).toBe('Такой логин уже есть');
    expect(acceptSource('shift', ['shift'])).toBe('Этот источник уже подключён');
    expect(profileToStore('собран формой', 'текст файла', true)).toBeNull();
    expect(profileToStore('старый', 'новый', false)).toBe('новый');
  });

  it('собирает профиль из галочек, своего текста и целей источника', async () => {
    const template = await readFile('data/profile-template.md', 'utf8');
    const lists = templateLists(template);
    expect(lists.confirm.length).toBeGreaterThan(0);
    expect(lists.time.length).toBeGreaterThan(0);
    const profile = buildProfile({
      name: 'Борис Седов',
      position: 'Начальник участка',
      goals: [{ n: '1', goal: 'Сдать смену.' }],
      confirm: ['допуск к станку'],
      time: ['разбор смены'],
      hours: '4',
      rest: lists.rest,
    });
    expect(profile.startsWith('Борис Седов — Начальник участка')).toBe(true);
    expect(profile).toContain('1. Сдать смену.');
    expect(confirmationPoints(profile)).toEqual(['допуск к станку']);
    expect(profileItems(profile, /освобожд/i)).toEqual(['разбор смены']);
    expect(profile).toContain('Часов в неделю: 4.');
    expect(profile).toContain('## Можно без подтверждения');
    expect(profile).toContain('## Каналы');
    expect(profile).toContain('## Стиль общения');
    const code = await readFile('src/agents/connect.ts', 'utf8');
    const web = await readFile('web/src/leaders.tsx', 'utf8');
    for (const item of [...lists.confirm, ...lists.time]) {
      expect(code).not.toContain(item);
      expect(web).not.toContain(item);
    }
    expect(`${code}\n${web}`).not.toMatch(/marina|leader2|q01/i);
  });

  it('ошибка в KPI ничего не готовит к записи, чужие люди не попадают в кабинет', async () => {
    const good = join(root, 'good');
    const bad = join(root, 'bad');
    await mkdir(good);
    await mkdir(bad);
    await writeCatalog(good, 's2,k,Выпуск,шт,больше,квартал,40,36\n');
    await writeCatalog(bad, '');
    const template = '# Профиль\n\n## Можно без подтверждения\n- внутренние переносы\n';
    const broken = await previewConnect(bad, request(), { ids: [], logins: [] }, template);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.errors.some((item) => item.toLowerCase().includes('kpi'))).toBe(true);
    const ready = await previewConnect(good, request({ login: 'taken' }), { ids: [], logins: ['taken'] }, template);
    expect(ready.ok).toBe(false);
    const again = await previewConnect(good, request(), { ids: ['shift'], logins: [] }, template);
    expect(again.ok).toBe(false);
    const created = await previewConnect(good, request(), { ids: [], logins: [] }, template);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.summary).toMatchObject({ login: 'boris', people: 2, emails: 1, meetings: 1, tasks: 1, goals: 1 });
    expect(created.data.people.map((person) => person.name)).toEqual(['Борис Седов', 'Алла Ким']);
    expect(created.profile).toContain('допуск к станку');
    expect(created.profile).toContain('Сдать смену.');
    expect(JSON.stringify(created.stored)).not.toMatch(/secret/);
    expect(created.profile).not.toContain('mail-secret');
  });
});
