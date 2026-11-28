import { useEffect, useState, type FormEvent } from 'react';
import { Button } from './components/ui/button.tsx';
import { Card } from './components/ui/card.tsx';
import { Input } from './components/ui/input.tsx';

interface LeaderRow {
  name: string;
  login: string;
  people: number;
}

interface SourceRow {
  id: string;
  title: string;
}

interface PersonChoice {
  id: string;
  name: string;
  position: string;
  email: string;
}

interface Summary {
  login: string;
  people: number;
  emails: number;
  meetings: number;
  tasks: number;
  goals: number;
  holes: { kind: string; text: string }[];
}

async function load<T>(path: string, init?: RequestInit): Promise<T & { error?: string; errors?: string[] }> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  });
  const data = (await res.json()) as T & { error?: string; errors?: string[] };
  if (!res.ok) {
    const error = new Error(data.error || `Ошибка ${res.status}`) as Error & { errors?: string[] };
    error.errors = data.errors;
    throw error;
  }
  return data;
}

export function LeadersPanel() {
  const [rows, setRows] = useState<LeaderRow[]>([]);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [sourceNote, setSourceNote] = useState('');
  const [source, setSource] = useState('');
  const [people, setPeople] = useState<PersonChoice[]>([]);
  const [personId, setPersonId] = useState('');
  const [confirm, setConfirm] = useState<string[]>([]);
  const [time, setTime] = useState<string[]>([]);
  const [confirmOn, setConfirmOn] = useState<string[]>([]);
  const [timeOn, setTimeOn] = useState<string[]>([]);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [confirmOwn, setConfirmOwn] = useState('');
  const [timeOwn, setTimeOwn] = useState('');
  const [hours, setHours] = useState('');
  const [mailAddress, setMailAddress] = useState('');
  const [mailPassword, setMailPassword] = useState('');
  const [calendarPassword, setCalendarPassword] = useState('');
  const [trackerOrg, setTrackerOrg] = useState('');
  const [trackerQueue, setTrackerQueue] = useState('');
  const [trackerToken, setTrackerToken] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = () => {
    load<{ note: string; leaders: LeaderRow[] }>('/api/leaders')
      .then((data) => {
        setRows(data.leaders);
        setNote(data.note);
      })
      .catch(() => setRows([]));
  };

  useEffect(refresh, []);

  const chosen = people.find((person) => person.id === personId);

  const start = () => {
    setOpen(true);
    setSummary(null);
    setErrors([]);
    load<{ note: string; sources: SourceRow[] }>('/api/leaders/sources')
      .then((data) => {
        setSources(data.sources);
        setSourceNote(data.note);
        setSource(data.sources[0]?.id ?? '');
      })
      .catch(() => setSources([]));
    load<{ confirm: string[]; time: string[] }>('/api/leaders/template')
      .then((data) => {
        setConfirm(data.confirm);
        setTime(data.time);
        setConfirmOn(data.confirm);
        setTimeOn(data.time);
      })
      .catch(() => {
        setConfirm([]);
        setTime([]);
      });
  };

  useEffect(() => {
    if (!source) {
      setPeople([]);
      setPersonId('');
      return;
    }
    load<{ leaders: PersonChoice[] }>(`/api/leaders/sources/${encodeURIComponent(source)}`)
      .then((data) => {
        setPeople(data.leaders);
        setPersonId(data.leaders[0]?.id ?? '');
      })
      .catch(() => {
        setPeople([]);
        setPersonId('');
      });
  }, [source]);

  const toggle = (list: string[], setList: (next: string[]) => void, item: string) => {
    setList(list.includes(item) ? list.filter((row) => row !== item) : [...list, item]);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setErrors([]);
    setSummary(null);
    load<Summary>('/api/leaders', {
      method: 'POST',
      body: JSON.stringify({
        source,
        personId,
        login,
        password,
        confirm: confirmOn,
        confirmOwn,
        time: timeOn,
        timeOwn,
        hours,
        mailAddress,
        mailPassword,
        calendarPassword,
        trackerOrg,
        trackerQueue,
        trackerToken,
      }),
    })
      .then((data) => {
        setSummary(data);
        setPassword('');
        setMailPassword('');
        setCalendarPassword('');
        setTrackerToken('');
        refresh();
      })
      .catch((err: Error & { errors?: string[] }) => setErrors(err.errors?.length ? err.errors : [err.message]))
      .finally(() => setPending(false));
  };

  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">Руководители</h2>
      <p className="mb-3 text-sm text-[#5d6878]">{note}</p>
      <ul className="mb-3 grid gap-1 text-sm">
        {rows.map((row) => (
          <li key={row.login}>
            {row.name}, логин {row.login}, людей {row.people}
          </li>
        ))}
      </ul>
      {open ? null : (
        <Button type="button" onClick={start}>
          Подключить руководителя
        </Button>
      )}
      {open ? (
        <form className="grid gap-3" onSubmit={submit}>
          <label className="grid gap-1 text-sm">
            Источник данных
            <select className="h-10 rounded-md border border-[#dde1e7] bg-white px-3" value={source} onChange={(event) => setSource(event.target.value)}>
              {sources.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.title}
                </option>
              ))}
            </select>
            <span className="text-[#5d6878]">{sourceNote}</span>
          </label>
          <label className="grid gap-1 text-sm">
            Руководитель
            <select className="h-10 rounded-md border border-[#dde1e7] bg-white px-3" value={personId} onChange={(event) => setPersonId(event.target.value)}>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            {chosen ? (
              <span>
                {chosen.name} — {chosen.position}. Почта {chosen.email}
              </span>
            ) : null}
          </label>
          <label className="grid gap-1 text-sm">
            Логин
            <Input value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="off" />
          </label>
          <label className="grid gap-1 text-sm">
            Пароль
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
          </label>
          <fieldset className="grid gap-2 text-sm">
            <legend className="font-semibold">Подключения — заглушка</legend>
            <p className="text-[#5d6878]">Пароль и токен не сохраняются и никуда не отправляются. Подключение не выполняется.</p>
            <label className="grid gap-1">
              Адрес ящика
              <Input value={mailAddress} onChange={(event) => setMailAddress(event.target.value)} autoComplete="off" />
            </label>
            <label className="grid gap-1">
              Пароль приложения почты
              <Input type="password" value={mailPassword} onChange={(event) => setMailPassword(event.target.value)} autoComplete="new-password" />
            </label>
            <label className="grid gap-1">
              Пароль приложения «Календарь»
              <Input type="password" value={calendarPassword} onChange={(event) => setCalendarPassword(event.target.value)} autoComplete="new-password" />
            </label>
            <label className="grid gap-1">
              Организация Трекера
              <Input value={trackerOrg} onChange={(event) => setTrackerOrg(event.target.value)} autoComplete="off" />
            </label>
            <label className="grid gap-1">
              Очередь Трекера
              <Input value={trackerQueue} onChange={(event) => setTrackerQueue(event.target.value)} autoComplete="off" />
            </label>
            <label className="grid gap-1">
              Токен Трекера
              <Input type="password" value={trackerToken} onChange={(event) => setTrackerToken(event.target.value)} autoComplete="new-password" />
            </label>
          </fieldset>
          <fieldset className="grid gap-1 text-sm">
            <legend className="font-semibold">Что только с подтверждением</legend>
            {confirm.map((item) => (
              <label key={item} className="flex gap-2">
                <input type="checkbox" checked={confirmOn.includes(item)} onChange={() => toggle(confirmOn, setConfirmOn, item)} />
                {item}
              </label>
            ))}
            <label className="grid gap-1">
              Своё, пункт на строку
              <textarea className="min-h-20 rounded-md border border-[#dde1e7] p-2" value={confirmOwn} onChange={(event) => setConfirmOwn(event.target.value)} />
            </label>
          </fieldset>
          <fieldset className="grid gap-1 text-sm">
            <legend className="font-semibold">Куда отдать освобождённое время</legend>
            {time.map((item) => (
              <label key={item} className="flex gap-2">
                <input type="checkbox" checked={timeOn.includes(item)} onChange={() => toggle(timeOn, setTimeOn, item)} />
                {item}
              </label>
            ))}
            <label className="grid gap-1">
              Своё, пункт на строку
              <textarea className="min-h-16 rounded-md border border-[#dde1e7] p-2" value={timeOwn} onChange={(event) => setTimeOwn(event.target.value)} />
            </label>
            <label className="grid gap-1">
              Часов в неделю
              <Input value={hours} onChange={(event) => setHours(event.target.value)} inputMode="decimal" />
            </label>
          </fieldset>
          {errors.length ? (
            <ul className="grid gap-1 text-sm text-[#a3302a]">
              {errors.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          {summary ? (
            <p className="text-sm text-[#1b7a45]">
              Подключён логин {summary.login}. Людей {summary.people}, писем {summary.emails}, встреч {summary.meetings}, задач {summary.tasks}, целей {summary.goals}.
              {summary.holes.length ? ` Дыры: ${summary.holes.map((hole) => `${hole.kind} — ${hole.text}`).join('; ')}.` : ' Дыр каскада нет.'}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? 'Подключение…' : 'Подключить'}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

export function ConnectionFields({
  mailAddress,
  trackerOrg,
  trackerQueue,
  onSaved,
}: {
  mailAddress: string;
  trackerOrg: string;
  trackerQueue: string;
  onSaved: () => Promise<void>;
}) {
  const [mail, setMail] = useState(mailAddress);
  const [org, setOrg] = useState(trackerOrg);
  const [queue, setQueue] = useState(trackerQueue);
  const [mailPassword, setMailPassword] = useState('');
  const [calendarPassword, setCalendarPassword] = useState('');
  const [token, setToken] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);

  const save = (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setNote('');
    load<{ mailAddress: string }>('/api/connections', {
      method: 'POST',
      body: JSON.stringify({
        mailAddress: mail,
        mailPassword,
        calendarPassword,
        trackerOrg: org,
        trackerQueue: queue,
        trackerToken: token,
      }),
    })
      .then(async () => {
        setMailPassword('');
        setCalendarPassword('');
        setToken('');
        setNote('Сохранены адрес, организация и очередь. Пароль и токен не записаны.');
        await onSaved();
      })
      .catch((err: Error) => setNote(err.message))
      .finally(() => setPending(false));
  };

  return (
    <form className="mt-4 grid gap-2 text-sm" onSubmit={save}>
      <p className="font-semibold">Заглушка: пароль и токен не сохраняются</p>
      <label className="grid gap-1">
        Адрес ящика
        <Input value={mail} onChange={(event) => setMail(event.target.value)} autoComplete="off" />
      </label>
      <label className="grid gap-1">
        Пароль приложения почты
        <Input type="password" value={mailPassword} onChange={(event) => setMailPassword(event.target.value)} autoComplete="new-password" />
      </label>
      <label className="grid gap-1">
        Пароль приложения «Календарь»
        <Input type="password" value={calendarPassword} onChange={(event) => setCalendarPassword(event.target.value)} autoComplete="new-password" />
      </label>
      <label className="grid gap-1">
        Организация Трекера
        <Input value={org} onChange={(event) => setOrg(event.target.value)} autoComplete="off" />
      </label>
      <label className="grid gap-1">
        Очередь Трекера
        <Input value={queue} onChange={(event) => setQueue(event.target.value)} autoComplete="off" />
      </label>
      <label className="grid gap-1">
        Токен Трекера
        <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" />
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? 'Запись…' : 'Сохранить поля'}
      </Button>
      {note ? <p>{note}</p> : null}
    </form>
  );
}
