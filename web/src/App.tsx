import { useEffect, useState, type FormEvent } from 'react';
import { Button } from './components/ui/button.tsx';
import { Card } from './components/ui/card.tsx';
import { Input } from './components/ui/input.tsx';

interface User {
  name: string;
  login: string;
}

interface KpiWeek {
  week: string;
  plan: string;
  fact: string;
  status: string;
}

interface DepartmentPerson {
  id: string;
  name: string;
  position: string;
  zone: string;
  goal: string;
  leaderGoal: string;
  emails: number;
  kpis: {
    name: string;
    unit: string;
    better: string;
    weeks: KpiWeek[];
    quarter: { plan: string; fact: string; status: string } | null;
  }[];
  authorities: { area: string; limit: string; unit: string; note: string }[];
}

interface FeedItem {
  id: string;
  kind: string;
  category: string;
  summary: string;
  basis: string;
}

interface StaffCard {
  вывод: string;
  рекомендация: string;
  основание: string;
  риски: string;
  если_не_решить: string;
  контекст: string;
}

interface WeekScene {
  accepted: boolean;
  before: number;
  after: number;
  current: number;
  letters: number;
  meetings: number;
  stillLetters: number;
  stillMeetings: number;
  stoppedLetters: number;
  stoppedMeetings: number;
  digestLetters: number;
  digestMeetings: number;
  gluedLetters: number;
  gluedMeetings: number;
  remaining: string[];
  offers: string[];
  rules: number;
  askPercent: number;
  waitingHours: number;
  staff: StaffCard | null;
  waiting: WaitingDecision[];
}

interface WaitingDecision {
  id: string;
  summary: string;
  recommendation: string;
  basis: string;
  risks: string;
  ifNot: string;
  context: string;
}

interface FocusScene {
  text: string;
  matrix: { name: string; basis: string; quiet: boolean; cell?: string }[];
  share: { percent: number; onGoal: number; total: number };
  overdue?: string[];
}

interface MirrorScene {
  notes: { name: string; email: string; text: string; quiet: boolean }[];
  series: { title: string; verdict: string; change: string; hours: number; action: string; reason: string; kind: string }[];
}

interface Cabinet {
  name: string;
  scene?: string;
  profile: string;
  linkCode: string;
  counts: { people: number; emails: number; meetings: number; tasks: number };
  mail: 'configured' | 'missing';
  telegram: 'configured' | 'missing';
  department: { errors: string[]; people: DepartmentPerson[] };
  feed: { items: FeedItem[]; outside: number };
  week: WeekScene;
  focus: FocusScene;
  mirror: MirrorScene;
  revisions: { id: string; category: string; instead: string }[];
  accuracy: { total: number; hit: number; calls: number; forced: number; misses: { pair: string; count: number }[] } | null;
  protocol: { status: string; open: number; preparation: string } | null;
  stubs: {
    tasks: { title: string; owner: string; due: string; status: string }[];
    meetings: { summary: string; starts: string }[];
  };
  desk: Desk;
  control: {
    goals: { n: string; text: string; owners: string[]; kpis: string[]; tasks: string[] }[];
    holes: { kind: string; text: string }[];
    tasks: { title: string; owner: string; goal: string; effect: string; deadline: string; recommendation: string; basis: string }[];
    signals: { name: string; kpi: string; early: boolean; text: string }[];
  };
  lastAudit: { status: string; mode: string; at: string } | null;
  stand?: {
    tracker: { ok: boolean; detail: string; issues: { key: string; summary: string; deadline: string }[] };
    calendar: { ok: boolean; detail: string; events: { summary: string; start: string }[] };
  };
}

type Section = 'home' | 'department' | 'flow' | 'feed' | 'helper' | 'settings' | 'tasks' | 'calendar' | 'mailing';

interface Origin {
  helper: string;
  who: string;
  data: string;
  how: string;
  safety: string;
  rows: string[];
}

interface WorkItem {
  id: string;
  title: string;
  wait: string;
  minutes: string;
  kind: 'decision' | 'talk' | 'right' | 'series' | 'task' | 'rules';
  lines: { id: string; title: string }[];
  origin: Origin;
}

interface Desk {
  work: WorkItem[];
  done: DoneLine[];
  helpers: { id: string; name: string; mode: string; does: string; did: string; result: string; value: string }[];
  people: { id: string; origin: Origin }[];
  feed: { id: string; origin: Origin }[];
}

interface DoneLine {
  text: string;
  origin: Origin;
}

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'home', label: 'Главная' },
  { id: 'department', label: 'Отдел' },
  { id: 'flow', label: 'Поток' },
  { id: 'feed', label: 'Лента' },
  { id: 'helper', label: 'Помощник' },
  { id: 'settings', label: 'Настройки' },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [cabinet, setCabinet] = useState<Cabinet | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [job, setJob] = useState('');
  const [mailNote, setMailNote] = useState('');
  const [section, setSection] = useState<Section>('home');
  const [models, setModels] = useState<ModelSettings | null>(null);
  const [cost, setCost] = useState<CostView | null>(null);

  useEffect(() => {
    api<{ user: User | null }>('/api/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    api<Cabinet>('/api/cabinet')
      .then(setCabinet)
      .catch((err: Error) => setError(err.message));
  }, [user]);

  useEffect(() => {
    if (section !== 'settings' || !user) return;
    api<ModelSettings>('/api/models').then(setModels).catch(() => setModels(null));
    api<CostView>('/api/cost').then(setCost).catch(() => setCost(null));
  }, [section, user]);

  async function onLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const next = await api<User>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ login: form.get('login'), password: form.get('password') }),
      });
      setUser(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти');
    } finally {
      setPending(false);
    }
  }

  async function logout() {
    await api('/api/logout', { method: 'POST' });
    setUser(null);
    setCabinet(null);
  }

  async function sendNote() {
    setError('');
    setPending(true);
    try {
      const result = await api<{ sent: string[] }>('/api/mirror/send', { method: 'POST', body: '{}' });
      setJob(result.sent.length ? `Записки ушли в тестовый ящик: ${result.sent.join(', ')}` : 'Новых записок нет: всем уже отправляли');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить записку');
    } finally {
      setPending(false);
    }
  }

  async function seriesAction(key: string, action: 'продлить' | 'отпустить') {
    const reason = action === 'продлить' ? window.prompt('Какое решение принимается на этой серии?') ?? '' : '';
    if (action === 'продлить' && reason.trim().length < 3) return;
    setError('');
    setPending(true);
    try {
      await api('/api/series', { method: 'POST', body: JSON.stringify({ key, action, reason }) });
      const fresh = await api<Cabinet>('/api/cabinet');
      setCabinet(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось записать серию');
    } finally {
      setPending(false);
    }
  }

  function openHelper(helper: string) {
    setSection('helper');
    window.setTimeout(() => document.getElementById(`helper-${helper}`)?.scrollIntoView({ block: 'start' }), 0);
  }

  async function sendFocusNow() {
    setError('');
    setPending(true);
    try {
      const result = await api<{ text: string }>('/api/focus/send', { method: 'POST', body: '{}' });
      setJob('Утро и матрица отправлены в Telegram');
      setCabinet((prev) => (prev ? { ...prev, focus: { ...prev.focus, text: result.text } } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить');
    } finally {
      setPending(false);
    }
  }

  async function decide(id: string, action: 'approve' | 'reject' | 'defer') {
    setError('');
    setPending(true);
    try {
      const result = await api<{ notice: string }>('/api/decisions', {
        method: 'POST',
        body: JSON.stringify({ id, action }),
      });
      setJob(result.notice);
      setCabinet(await api<Cabinet>('/api/cabinet'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось записать решение');
    } finally {
      setPending(false);
    }
  }

  async function acceptRules() {
    setError('');
    setPending(true);
    try {
      await api<WeekScene>('/api/rules/accept', { method: 'POST', body: '{}' });
      setCabinet(await api<Cabinet>('/api/cabinet'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось принять правила');
    } finally {
      setPending(false);
    }
  }

  async function pullMail() {
    setMailNote('');
    setError('');
    setPending(true);
    try {
      const result = await api<{ lines: string[]; calls: number; deferred: number }>('/api/mail/pull', {
        method: 'POST',
        body: '{}',
      });
      const fresh = await api<Cabinet>('/api/cabinet');
      setCabinet(fresh);
      const head = result.lines.length ? result.lines.join('; ') : 'Новых писем подчинённых нет';
      setMailNote(result.deferred ? `${head}. Осталось ещё ${result.deferred}` : head);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось разобрать почту');
    } finally {
      setPending(false);
    }
  }

  async function sendProtocol() {
    setJob('');
    setError('');
    const agreed = window.confirm('Один вызов модели по расшифровке и сообщение в Telegram. Рассылка писем не будет. Запустить?');
    if (!agreed) return;
    setPending(true);
    try {
      const created = await api<{ id: string }>('/api/jobs/protocol', {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      });
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const state = await api<{ status: string; detail: string | null }>(`/api/jobs/${created.id}`);
        if (state.status === 'done') {
          setJob(state.detail || 'Протокол отправлен');
          setCabinet(await api<Cabinet>('/api/cabinet'));
          return;
        }
        if (state.status === 'failed') throw new Error(state.detail || 'Протокол не собрался');
      }
      setJob('Протокол ещё готовится.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить протокол');
    } finally {
      setPending(false);
    }
  }

  async function measureAccuracy() {
    setJob('');
    setError('');
    const agreed = window.confirm('Замер вызовет модель по одному разу на цепочку писем. Письма сами не отправляются. Запустить?');
    if (!agreed) return;
    setPending(true);
    try {
      const created = await api<{ id: string }>('/api/jobs/accuracy', {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      });
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const state = await api<{ status: string; detail: string | null }>(`/api/jobs/${created.id}`);
        if (state.status === 'done') {
          setJob(state.detail || 'Точность записана');
          setCabinet(await api<Cabinet>('/api/cabinet'));
          return;
        }
        if (state.status === 'failed') throw new Error(state.detail || 'Замер не выполнился');
      }
      setJob('Замер ещё идёт. Обновите страницу через минуту.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось замерить точность');
    } finally {
      setPending(false);
    }
  }

  async function runModelAudit() {
    setJob('');
    setError('');
    setPending(true);
    try {
      const quote = await api<{ calls: number; costUsd: number; note: string }>('/api/jobs/flow-audit/quote');
      const agreed = window.confirm(
        `Прогон вызовет модель около ${quote.calls} раз. Прошлая цена примера ${quote.costUsd} USD. ${quote.note} Запустить?`,
      );
      if (!agreed) return;
      const created = await api<{ id: string }>('/api/jobs/flow-audit', {
        method: 'POST',
        body: JSON.stringify({ mode: 'model', confirm: true }),
      });
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const state = await api<{ status: string; detail: string | null }>(`/api/jobs/${created.id}`);
        if (state.status === 'done') {
          setJob('Прогон моделью записан за этим руководителем');
          return;
        }
        if (state.status === 'failed') throw new Error(state.detail || 'Задание не выполнилось');
      }
      setJob('Прогон ещё идёт. Отчёт появится на странице аудита, когда задание закончится.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось запустить аудит');
    } finally {
      setPending(false);
    }
  }

  async function rebuildAudit() {
    setJob('');
    setError('');
    setPending(true);
    try {
      const created = await api<{ id: string }>('/api/jobs/flow-audit', { method: 'POST', body: '{}' });
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const state = await api<{ status: string; detail: string | null }>(`/api/jobs/${created.id}`);
        if (state.status === 'done') {
          setJob('Отчёт пересобран');
          const fresh = await api<Cabinet>('/api/cabinet');
          setCabinet(fresh);
          return;
        }
        if (state.status === 'failed') throw new Error(state.detail || 'Задание не выполнилось');
      }
      setJob('Задание ещё идёт');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось запустить аудит');
    } finally {
      setPending(false);
    }
  }

  if (user === undefined) {
    return <main className="mx-auto max-w-lg px-4 py-16 text-[#5d6878]">Загрузка…</main>;
  }

  if (!user) {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <h1 className="mb-2 text-2xl font-semibold">Помощник руководителя</h1>
        <p className="mb-6 text-[#5d6878]">Вход на стенд. Решения приходят в Telegram, здесь — отдел и история.</p>
        <Card>
          <form className="grid gap-3" onSubmit={onLogin}>
            <label className="grid gap-1 text-sm">
              Логин
              <Input name="login" autoComplete="username" required />
            </label>
            <label className="grid gap-1 text-sm">
              Пароль
              <Input name="password" type="password" autoComplete="current-password" required />
            </label>
            {error ? <p className="text-sm text-[#a3302a]">{error}</p> : null}
            <Button type="submit" disabled={pending}>
              {pending ? 'Входим…' : 'Войти'}
            </Button>
          </form>
        </Card>
        <p className="mt-6 text-sm text-[#5d6878]">
          <a className="text-[#1f5fbf] underline" href="/form/">
            Форма сдачи
          </a>
          {' · '}
          <a className="text-[#1f5fbf] underline" href="/audit/">
            Аудит потока
          </a>
        </p>
      </main>
    );
  }

  const counts = cabinet?.counts;
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{cabinet?.name ?? user.name}</h1>
          {cabinet?.scene ? <p className="text-sm text-[#5d6878]">{cabinet.scene}</p> : null}
        </div>
        <Button type="button" variant="outline" onClick={logout}>
          Выйти
        </Button>
      </div>
      <nav className="mb-6 flex flex-wrap gap-2">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`rounded-full px-3 py-1 text-sm ${section === item.id ? 'bg-[#1f5fbf] text-white' : 'bg-white text-[#1c2430]'}`}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {error ? <p className="mb-4 text-sm text-[#a3302a]">{error}</p> : null}
      {section === 'home' ? (
        <HomeDesk
          desk={cabinet?.desk}
          pending={pending}
          onDecision={decide}
          onAccept={acceptRules}
          onSeries={seriesAction}
          onSend={sendFocusNow}
          onOpen={(helper) => {
            setSection('helper');
            window.setTimeout(() => document.getElementById(`helper-${helper}`)?.scrollIntoView({ block: 'start' }), 0);
          }}
          onTalk={() => setSection('department')}
        />
      ) : null}
      {section === 'department' ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Люди" value={counts?.people} />
            <Stat label="Письма" value={counts?.emails} />
            <Stat label="Встречи" value={counts?.meetings} />
            <Stat label="Задачи" value={counts?.tasks} />
          </div>
          <Department department={cabinet?.department} origins={cabinet?.desk.people ?? []} onOpen={openHelper} />
          <Goals control={cabinet?.control} onOpen={openHelper} />
          <Signals signals={cabinet?.control.signals ?? []} title="Сигналы KPI" onOpen={openHelper} />
          <Matrix rows={cabinet?.focus.matrix ?? []} onOpen={openHelper} />
          <Mirror mirror={cabinet?.mirror} part="notes" pending={pending} onSend={sendNote} onSeries={seriesAction} onOpen={openHelper} origins={cabinet?.desk.people ?? []} />
        </>
      ) : null}
      {section === 'flow' ? (
        <>
          <Week week={cabinet?.week} mode="flow" pending={pending} onAccept={acceptRules} />
          <Mirror mirror={cabinet?.mirror} part="series" pending={pending} onSend={sendNote} onSeries={seriesAction} onOpen={openHelper} origins={cabinet?.desk.work ?? []} />
          <p className="text-sm">
            <a className="text-[#1f5fbf] underline" href="/audit/">
              Полный аудит потока
            </a>
          </p>
        </>
      ) : null}
      {section === 'feed' ? (
      <Card className="mb-4">
        <h2 className="mb-2 text-lg font-semibold">Что помощник сделал сам</h2>
        {(cabinet?.feed.outside ?? 0) > 0 ? <p className="mb-3 text-sm text-[#5d6878]">Не из отдела: {cabinet?.feed.outside}</p> : null}
        {cabinet && cabinet.feed.items.length ? (
          <ul className="grid gap-2 text-sm">
            {cabinet.feed.items.map((item) => (
              <li key={item.id}>
                <b>{kindLabel(item.kind)}</b> · {categoryWords(item.category)}
                <span className="block">{cleanDots(item.summary)}</span>
                <span className="block text-[#5d6878]">{cleanDots(item.basis)}</span>
                <Origin origin={cabinet.desk.feed.find((row) => row.id === item.id)?.origin} onOpen={openHelper} />
              </li>
            ))}
          </ul>
        ) : cabinet?.feed.outside ? null : (
          <p className="text-sm text-[#5d6878]">Пока пусто. Письма подчинённых читаются из ящика, не из файла.</p>
        )}
      </Card>
      ) : null}
      {section === 'helper' ? <Helpers cards={cabinet?.desk.helpers ?? []} /> : null}
      {section === 'tasks' ? (
        <Card className="mb-4">
          <h2 className="text-lg font-semibold">Задачи</h2>
          <p className="mb-3 text-sm text-[#5d6878]">
            {cabinet?.stand?.tracker.ok
              ? `${cabinet.stand.tracker.detail}. Это те же задачи, что в материалах и в протоколе. В описании — исполнитель и письмо, если тема совпала. Разбор ниже считает помощник.`
              : `${cabinet?.stand?.tracker.detail ?? 'Трекер не подключён'}. Ниже задачи из базы: файл материалов и утверждённый протокол.`}
          </p>
          {cabinet?.stand?.tracker.ok ? (
            <ul className="mb-4 grid gap-2 text-sm">
              {cabinet.stand.tracker.issues.map((item) => (
                <li key={item.key || item.summary}>
                  <b>{item.summary}</b>
                  {item.deadline ? <span className="text-[#5d6878]"> — {whenWords(item.deadline)}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {cabinet?.focus.overdue?.length ? <p className="mb-3 whitespace-pre-wrap text-sm">{cabinet.focus.overdue.join('\n')}</p> : null}
          <ul className="grid gap-2 text-sm">
            {(cabinet?.control.tasks ?? []).map((item) => (
              <li key={item.title}>
                <b>{item.title}</b> — {item.owner}
                <span className="block">{item.recommendation === 'оставить' ? 'Оставить' : item.recommendation === 'снять' ? 'Снять' : item.recommendation === 'перенести' ? 'Перенести' : 'Передать'}. Эффект {item.effect}, срок {item.deadline === 'нет' ? 'сорван' : 'в порядке'}{item.goal ? `, цель «${item.goal}»` : ''}.</span>
                <span className="block text-[#5d6878]">{item.basis}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {section === 'calendar' ? (
        <StubList
          title="Календарь"
          note={
            cabinet?.stand?.calendar.ok
              ? `${cabinet.stand.calendar.detail}. Это те же встречи, что в материалах, и встреча утверждённого протокола. «Отпустить» серию событие не удаляет.`
              : `${cabinet?.stand?.calendar.detail ?? 'Календарь не подключён'}. Ниже встречи из базы.`
          }
          rows={
            cabinet?.stand?.calendar.ok
              ? cabinet.stand.calendar.events.map((item) => `${whenWords(item.start)} — ${item.summary}`)
              : (cabinet?.stubs.meetings ?? []).map((item) => `${whenWords(item.starts)} — ${item.summary}`)
          }
        />
      ) : null}
      {section === 'mailing' ? (
        <StubList
          title="Рассылка протокола"
          note="После «Утвердить» письмо с протоколом и приглашением .ics уходит в тестовый ящик. Настоящие адресаты названы в тексте. Встреча также встаёт в календарь «Стенд», задачи — в Трекер."
          rows={['Задачи из протокола записываются в базу и видны на экране задач.']}
        />
      ) : null}
      {section === 'settings' ? (
        <>
      <ModelsPanel
        data={models}
        onSaved={() => {
          api<ModelSettings>('/api/models').then(setModels).catch(() => setModels(null));
        }}
      />
      <CostPanel data={cost} />
      <Revisions
        rows={cabinet?.revisions ?? []}
        onSaved={async () => {
          const fresh = await api<Cabinet>('/api/cabinet');
          setCabinet(fresh);
        }}
      />
      <Card className="mb-4">
        <h2 className="mb-2 text-lg font-semibold">Подключения</h2>
        <ul className="grid gap-1 text-sm">
          <li>Почта: {cabinet?.mail === 'configured' ? 'учётные данные заданы' : 'не настроена — заглушки отправки нет, ящик синтетики в базе'}</li>
          <li>Telegram: {cabinet?.telegram === 'configured' ? 'токен задан' : 'не настроен — нет токена бота'}</li>
          <li>Код для бота: <code>{cabinet?.linkCode || '…'}</code> — сообщение <code>/start {cabinet?.linkCode}</code></li>
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" onClick={pullMail} disabled={pending}>
            {pending ? 'Разбор…' : 'Разобрать новые письма'}
          </Button>
          {mailNote ? <span className="text-sm text-[#1b7a45]">{mailNote}</span> : null}
          <Button type="button" onClick={rebuildAudit} disabled={pending}>
            {pending ? 'Задание…' : 'Пересобрать отчёт аудита'}
          </Button>
          <Button type="button" variant="outline" onClick={runModelAudit} disabled={pending}>
            {pending ? 'Задание…' : 'Прогнать моделью'}
          </Button>
          {job ? <span className="text-sm text-[#1b7a45]">{job}</span> : null}
        </div>
        <p className="mt-2 text-sm text-[#5d6878]">
          «Пересобрать» не вызывает модель. «Прогнать моделью» сначала показывает цену прошлого прогона и пишет отчёт только этому руководителю.
        </p>
        <div className="mt-4">
          <Button type="button" variant="outline" onClick={measureAccuracy} disabled={pending}>
            {pending ? 'Задание…' : 'Замерить точность 80 писем'}
          </Button>
          {cabinet?.accuracy ? (
            <p className="mt-2 text-sm">
              Точность: {cabinet.accuracy.hit} из {cabinet.accuracy.total}. Цепочек {cabinet.accuracy.calls}, из них код поправил{' '}
              {cabinet.accuracy.forced}. Ответ сам не отправлялся.
              {cabinet.accuracy.misses.length
                ? ` Расхождения: ${cabinet.accuracy.misses.map((row) => `${actionWords(row.pair)} — ${row.count}`).join('; ')}.`
                : ''}
            </p>
          ) : (
            <p className="mt-2 text-sm text-[#5d6878]">Замера ещё нет. Один вызов на цепочку, не на каждое письмо.</p>
          )}
        </div>
        <div className="mt-4">
          <Button type="button" variant="outline" onClick={sendProtocol} disabled={pending}>
            {pending ? 'Задание…' : 'Протокол встречи в Telegram'}
          </Button>
          <p className="mt-2 text-sm text-[#5d6878]">
            {cabinet?.protocol
              ? `Протокол в Telegram: ${cabinet.protocol.status}. Открытых вопросов: ${cabinet.protocol.open}. ${cabinet.protocol.preparation}. После «Утвердить» письмо и приглашение уходят в тестовый ящик.`
              : 'Расшифровка читается с диска стенда и в репозиторий не входит.'}
          </p>
          <span className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setSection('tasks')}>
              Задачи
            </Button>
            <Button type="button" variant="outline" onClick={() => setSection('calendar')}>
              Календарь
            </Button>
            <Button type="button" variant="outline" onClick={() => setSection('mailing')}>
              Рассылка протокола
            </Button>
          </span>
        </div>
      </Card>
      <Card className="mb-4">
        <h2 className="mb-2 text-lg font-semibold">Профиль</h2>
        <div className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{plainProfile(cabinet?.profile ?? '')}</div>
      </Card>
      <p className="text-sm text-[#5d6878]">
        <a className="text-[#1f5fbf] underline" href="/form/">
          Форма сдачи
        </a>
      </p>
        </>
      ) : null}
    </main>
  );
}

function Mirror({
  mirror,
  part,
  pending,
  onSend,
  onSeries,
  onOpen,
  origins,
}: {
  mirror: MirrorScene | undefined;
  part: 'notes' | 'series';
  pending: boolean;
  onSend: () => void;
  onSeries: (key: string, action: 'продлить' | 'отпустить') => void;
  onOpen: (helper: string) => void;
  origins: { id: string; origin: Origin }[];
}) {
  if (!mirror) return null;
  if (part === 'notes') {
    return (
      <Card className="mb-4">
        <h2 className="mb-2 text-lg font-semibold">Записки</h2>
        <p className="mb-2 text-sm text-[#5d6878]">В тестовый ящик уходит записка каждому, кому она ещё не уходила. Адрес в тексте — настоящий, ящик синтетический писем не принимает.</p>
        <details className="text-sm">
          <summary>подробнее</summary>
          <ul className="mt-2 grid gap-2">
            {mirror.notes.map((note) => (
              <li key={note.email}>
                <b>{note.name}</b>
                {note.quiet ? ' · тихая проблема' : ''}
                <span className="block whitespace-pre-wrap text-[#5d6878]">{cleanDots(note.text)}</span>
                <Origin origin={origins.find((row) => row.origin.data.startsWith(`${note.name}:`))?.origin ?? rowOrigin('k14', 'Записка человеку', note.text, [])} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </details>
        <Button className="mt-3" type="button" variant="outline" onClick={onSend} disabled={pending}>
          {pending ? 'Отправка…' : 'Отправить записки'}
        </Button>
      </Card>
    );
  }
  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">Серии встреч</h2>
      <p className="mb-2 text-sm text-[#5d6878]">«Продлить» и «отпустить» записывают решение. Событие в календаре «Стенд» от этого не удаляется.</p>
      <ul className="mt-4 grid gap-3 text-sm">
        {mirror.series.map((item) => (
          <li key={item.title}>
            <b>{item.title}</b>
            {item.kind ? <span className="text-[#5d6878]"> · {item.kind}</span> : null}
            <span className="text-[#5d6878]"> · {verdictWords(item.verdict)}</span>
            <span className="block text-[#5d6878]">
              {cleanDots(item.change)}
              {item.action ? ` Записано: ${item.action}${item.reason ? ` — ${item.reason}` : ''}.` : ''}
            </span>
            <Origin origin={origins.find((row) => row.id === `series:${item.title}`)?.origin ?? rowOrigin('k15', 'Календарь с нуля', item.title, item.change ? [item.change] : [])} onOpen={onOpen} />
            <span className="mt-1 flex gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={() => onSeries(item.title, 'продлить')}>
                Продлить
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => onSeries(item.title, 'отпустить')}>
                Отпустить
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Focus({ focus, pending, onSend }: { focus: FocusScene | undefined; pending: boolean; onSend: () => void }) {
  if (!focus) return null;
  const [lead, rest] = cleanDots(focus.text).split('\n\nНе сегодня:');
  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">Три дела на сегодня</h2>
      {taskLines(lead).length === 0 ? <div className="whitespace-pre-wrap text-sm leading-relaxed">{lead}</div> : null}
      <ul className="grid gap-2 text-sm">
        {taskLines(lead).map((item) => (
          <li key={item.short}>
            <p>{item.short}</p>
            {item.rest ? (
              <details className="text-[#5d6878]">
                <summary>подробнее</summary>
                <p className="mt-1">{item.rest}</p>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      {rest ? (
        <details className="mt-3 text-sm text-[#5d6878]">
          <summary>Не сегодня</summary>
          <div className="mt-2 whitespace-pre-wrap">Не сегодня:{rest}</div>
        </details>
      ) : null}
      {focus.overdue?.length ? <div className="mt-3 whitespace-pre-wrap text-sm">{focus.overdue.join('\n')}</div> : null}
      <p className="mt-2 text-sm text-[#5d6878]">
        Расписание: 8:30 каждый день и пятница в 17:00, часовой пояс Москвы. Кнопка отправляет то же сообщение сейчас. Просрочка считается по сроку и сегодняшней дате.
      </p>
      <Button className="mt-3" type="button" variant="outline" onClick={onSend} disabled={pending}>
        {pending ? 'Отправка…' : 'Прислать сейчас'}
      </Button>
    </Card>
  );
}

function Revisions({ rows, onSaved }: { rows: { id: string; category: string; instead: string }[]; onSaved: () => Promise<void> }) {
  const [category, setCategory] = useState('кадры');
  const [instead, setInstead] = useState('');
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/revisions', { method: 'POST', body: JSON.stringify({ category, instead }) });
      setInstead('');
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не сохранилось');
    }
  }
  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">Правки</h2>
      <p className="mb-2 text-sm text-[#5d6878]">Текст попадает в следующий черновик той же категории. В Telegram кнопка «Поправить» ждёт следующее сообщение.</p>
      <ul className="mb-3 grid gap-1 text-sm">
        {rows.map((row) => (
          <li key={row.id}>
            <b>{row.category.replace(/\.+$/, '')}.</b> {cleanDots(row.instead)}
          </li>
        ))}
      </ul>
      <form className="grid gap-2" onSubmit={save}>
        <label className="grid gap-1 text-sm">
          Категория
          <Input value={category} onChange={(event) => setCategory(event.target.value)} required />
        </label>
        <label className="grid gap-1 text-sm">
          Что поставить вместо
          <Input value={instead} onChange={(event) => setInstead(event.target.value)} required minLength={3} />
        </label>
        {error ? <p className="text-sm text-[#a3302a]">{error}</p> : null}
        <Button type="submit" variant="outline">
          Записать правку
        </Button>
      </form>
    </Card>
  );
}

function HomeDesk({
  desk,
  pending,
  onDecision,
  onAccept,
  onSeries,
  onSend,
  onOpen,
  onTalk,
}: {
  desk: Desk | undefined;
  pending: boolean;
  onDecision: (id: string, action: 'approve' | 'reject' | 'defer') => void;
  onAccept: () => void;
  onSeries: (key: string, action: 'продлить' | 'отпустить') => void;
  onSend: () => void;
  onOpen: (helper: string) => void;
  onTalk: () => void;
}) {
  if (!desk) return null;
  const tasks = desk.work.filter((item) => item.kind === 'task');
  const rest = desk.work.filter((item) => item.kind !== 'task');
  return (
    <>
      <section className="mb-6">
        <h2 className="mb-3 text-lg font-semibold">Что нужно от вас</h2>
        {rest.length + tasks.length === 0 ? <p className="text-sm text-[#5d6878]">Сейчас от вас ничего не ждут.</p> : null}
        <div className="grid gap-3">
          {rest.map((item) => (
            <WorkCard key={item.id} item={item} pending={pending} onDecision={onDecision} onAccept={onAccept} onSeries={onSeries} onOpen={onOpen} onTalk={onTalk} />
          ))}
          {tasks.map((item) => (
            <WorkCard key={item.id} item={item} pending={pending} onDecision={onDecision} onAccept={onAccept} onSeries={onSeries} onOpen={onOpen} onTalk={onTalk} />
          ))}
        </div>
        {tasks.length ? (
          <Button className="mt-3" type="button" variant="outline" disabled={pending} onClick={onSend}>
            Прислать утром
          </Button>
        ) : null}
      </section>
      <section className="mb-6">
        <h2 className="mb-3 text-lg font-semibold">Сделано без вас за неделю</h2>
        <ul className="grid gap-3">
          {desk.done.map((line) => (
            <li key={line.text}>
              <p className="text-sm">{line.text}</p>
              <Origin origin={line.origin} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function WorkCard({
  item,
  pending,
  onDecision,
  onAccept,
  onSeries,
  onOpen,
  onTalk,
}: {
  item: WorkItem;
  pending: boolean;
  onDecision: (id: string, action: 'approve' | 'reject' | 'defer') => void;
  onAccept: () => void;
  onSeries: (key: string, action: 'продлить' | 'отпустить') => void;
  onOpen: (helper: string) => void;
  onTalk: () => void;
}) {
  return (
    <Card>
      <p className="font-semibold">{item.title}</p>
      {item.wait ? <p className="mt-1 text-sm text-[#5d6878]">{item.wait}</p> : null}
      {item.minutes ? <p className="text-sm text-[#5d6878]">{item.minutes}</p> : null}
      <Origin origin={item.origin} onOpen={onOpen} />
      <span className="mt-2 flex flex-wrap gap-2">
        {item.kind === 'decision' ? (
          <>
            <Button type="button" disabled={pending} onClick={() => onDecision(item.id, 'approve')}>
              Утвердить
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onDecision(item.id, 'reject')}>
              Отклонить
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onDecision(item.id, 'defer')}>
              Отложить
            </Button>
          </>
        ) : null}
        {item.kind === 'talk' ? (
          <Button type="button" variant="outline" onClick={onTalk}>
            Открыть в отделе
          </Button>
        ) : null}
        {item.kind === 'right' || item.kind === 'rules' ? (
          <Button type="button" disabled={pending} onClick={onAccept}>
            Принять
          </Button>
        ) : null}
        {item.kind === 'series' && item.lines.length ? (
          <details className="mt-2 text-sm">
            <summary>Список</summary>
            <ul className="mt-2 grid gap-2">
              {item.lines.map((line) => (
                <li key={line.id} className="flex flex-wrap items-center gap-2">
                  <span>{line.title}</span>
                  <Button type="button" variant="outline" disabled={pending} onClick={() => onSeries(line.id.slice('series:'.length), 'отпустить')}>
                    Отпустить
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </span>
    </Card>
  );
}

function Origin({ origin, onOpen }: { origin: Origin | undefined; onOpen: (helper: string) => void }) {
  if (!origin) return null;
  return (
    <details className="mt-2 text-sm text-[#5d6878]">
      <summary>Откуда это и почему можно доверять</summary>
      <div className="mt-2 grid gap-1">
        <p>Кто подготовил: {origin.who}</p>
        <p>Из каких данных: {origin.data}</p>
        <p>Как получено: {origin.how}</p>
        <p>Страховка: {origin.safety}</p>
        {origin.rows.length ? (
          <ul className="grid gap-1">
            {origin.rows.map((row) => (
              <li key={row}>{row}</li>
            ))}
          </ul>
        ) : null}
        <button type="button" className="w-fit text-[#1f5fbf] underline" onClick={() => onOpen(origin.helper)}>
          Как это устроено
        </button>
      </div>
    </details>
  );
}

function Helpers({ cards }: { cards: Desk['helpers'] }) {
  return (
    <section className="grid gap-3">
      <h2 className="text-lg font-semibold">Как работает помощник</h2>
      {cards.map((card) => (
        <Card key={card.id} id={`helper-${card.id}`}>
          <h3 className="font-semibold">
            {card.name} <span className="font-normal text-[#5d6878]">· {card.mode}</span>
          </h3>
          <p className="mt-1 text-sm">Что делает: {card.does}</p>
          <p className="text-sm">Что сделал за неделю: {card.did}</p>
          <p className="text-sm">Результат: {card.result}</p>
          <p className="text-sm">Ценность: {card.value}</p>
        </Card>
      ))}
    </section>
  );
}

function Week({
  week,
  mode,
  pending,
  onAccept,
  onDecision,
}: {
  week: WeekScene | undefined;
  mode: 'home' | 'flow';
  pending: boolean;
  onAccept: () => void;
  onDecision?: (id: string, action: 'approve' | 'reject' | 'defer') => void;
}) {
  if (!week) return null;
  const staff = week.staff;
  return (
    <Card className="mb-4">
      {mode === 'home' ? (
        <>
          <p className="text-sm text-[#5d6878]">Доля потока, которая всё ещё требует руководителя</p>
          <p className="text-5xl font-semibold tabular-nums">{week.current}%</p>
          <p className="mt-2 text-sm text-[#5d6878]">
            {week.accepted
              ? `Было ${week.before}%. Стало ${week.after}%. До руководителя не доходят ${countWords(week.stoppedLetters, 'письмо', 'письма', 'писем')} (${durationWords((week.stoppedLetters * 4) / 60)}) и ${countWords(week.stoppedMeetings, 'встреча', 'встречи', 'встреч')}. Остаются ${countWords(week.stillLetters, 'письмо', 'письма', 'писем')} и ${countWords(week.stillMeetings, 'встреча', 'встречи', 'встреч')}.`
              : `Сейчас на руководителя приходится весь поток: ${countWords(week.letters, 'письмо', 'письма', 'писем')} и ${countWords(week.meetings, 'встреча', 'встречи', 'встреч')}.`}
          </p>
        </>
      ) : (
        <p className="text-sm text-[#5d6878]">
            {week.accepted
            ? `Повторы одной темы приходят один раз: ${countWords(week.gluedLetters, 'письмо', 'письма', 'писем')} и ${countWords(week.gluedMeetings, 'встреча', 'встречи', 'встреч')}. Сводкой: ${countWords(week.digestLetters, 'письмо', 'письма', 'писем')} и ${countWords(week.digestMeetings, 'встреча', 'встречи', 'встреч')}. Оставшееся: ${week.remaining.join('; ') || 'нет'}.`
            : 'Правила недели ещё не приняты.'}
        </p>
      )}
      {mode === 'flow'
        ? week.offers.map((offer) => (
            <p key={offer} className="mt-3 text-sm">
              {offer}
            </p>
          ))
        : null}
      {mode === 'flow' ? (
        week.accepted ? (
          <p className="mt-3 text-sm text-[#1b7a45]">Правила приняты ({week.rules}).</p>
        ) : (
          <Button className="mt-3" type="button" onClick={onAccept} disabled={pending}>
            {pending ? 'Запись…' : 'Принять правила недели'}
          </Button>
        )
      ) : null}
      {mode === 'home'
        ? (week.waiting ?? []).map((item) => (
            <div key={item.id} className="mt-4 border-t border-[#e6ebf2] pt-3 text-sm">
              <p className="font-semibold">Ждёт решения</p>
              <p className="mt-1">{item.summary}</p>
              <details className="mt-2 text-[#5d6878]">
                <summary>подробнее</summary>
                <p className="mt-2">{item.recommendation}</p>
                <p className="mt-1">{item.basis}</p>
              </details>
              <span className="mt-2 flex flex-wrap gap-2">
                <Button type="button" disabled={pending} onClick={() => onDecision?.(item.id, 'approve')}>
                  Утвердить
                </Button>
                <Button type="button" variant="outline" disabled={pending} onClick={() => onDecision?.(item.id, 'reject')}>
                  Отклонить
                </Button>
                <Button type="button" variant="outline" disabled={pending} onClick={() => onDecision?.(item.id, 'defer')}>
                  Отложить
                </Button>
              </span>
            </div>
          ))
        : null}
      {mode === 'home' && staff && (week.waiting ?? []).length === 0 ? (
        <dl className="mt-4 grid gap-2 text-sm">
          <div>
            <dt className="font-semibold">Вывод</dt>
            <dd>{staff.вывод}</dd>
          </div>
          <details className="text-[#5d6878]">
            <summary>подробнее</summary>
            <div className="mt-2 grid gap-2">
              <div>
                <dt className="font-semibold text-[#1c2430]">Рекомендация</dt>
                <dd>{staff.рекомендация}</dd>
              </div>
              <div>
                <dt className="font-semibold text-[#1c2430]">Основание</dt>
                <dd>{staff.основание}</dd>
              </div>
              <div>
                <dt className="font-semibold text-[#1c2430]">Риски</dt>
                <dd>{staff.риски}</dd>
              </div>
              <div>
                <dt className="font-semibold text-[#1c2430]">Если не решить</dt>
                <dd>{staff.если_не_решить}</dd>
              </div>
              <div>
                <dt className="font-semibold text-[#1c2430]">Контекст</dt>
                <dd>{staff.контекст}</dd>
              </div>
            </div>
          </details>
        </dl>
      ) : null}
    </Card>
  );
}

function rowOrigin(helper: string, who: string, data: string, rows: string[]): Origin {
  return {
    helper,
    who,
    data,
    how: 'Посчитано по данным',
    safety:
      'Деньги, кадры, обещания клиентам и письма руководства код всегда оставляет руководителю. Без его кнопки ничего не отправляется, кроме того, что он сам разрешил правилом.',
    rows,
  };
}

function Goals({ control, onOpen }: { control: Cabinet['control'] | undefined; onOpen: (helper: string) => void }) {
  if (!control) return null;
  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">Цели квартала</h2>
      <ul className="grid gap-2 text-sm">
        {control.goals.map((goal) => (
          <li key={goal.n}>
            <b>{goal.n}. {goal.text}</b>
            <span className="block text-[#5d6878]">{goal.owners.length ? goal.owners.join(', ') : 'владельца нет'}{goal.kpis.length ? ` · ${goal.kpis.join(', ')}` : ''}</span>
            <Origin origin={rowOrigin('k6', 'Цели', `${goal.text}. ${goal.owners.join(', ') || 'владельца нет'}`, goal.kpis)} onOpen={onOpen} />
          </li>
        ))}
      </ul>
      {control.holes.length ? (
        <p className="mt-3 text-sm">{cleanDots(`Дыры: ${control.holes.map((hole) => `${hole.kind} — ${hole.text.replace(/\.+$/, '')}`).join('; ')}.`)}</p>
      ) : (
        <p className="mt-3 text-sm text-[#5d6878]">Дыр нет: у каждой цели есть владелец, у людей и задач есть цель.</p>
      )}
    </Card>
  );
}

function Signals({ signals, title, onOpen }: { signals: { text: string; early: boolean }[]; title: string; onOpen: (helper: string) => void }) {
  if (!signals.length) return null;
  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      <ul className="grid gap-2 text-sm">
        {signals.map((item) => (
          <li key={item.text}>
            {item.early ? 'Раньше письма. ' : ''}
            {item.text}
            <Origin origin={rowOrigin('k8', 'Контроль KPI', item.text, [])} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Department({
  department,
  origins,
  onOpen,
}: {
  department: Cabinet['department'] | undefined;
  origins: { id: string; origin: Origin }[];
  onOpen: (helper: string) => void;
}) {
  const people = department?.people ?? [];
  return (
    <section className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">Отдел</h2>
      {department?.errors.length ? (
        <Card className="mb-3">
          <p className="text-sm text-[#a3302a]">{department.errors.join(' ')}</p>
        </Card>
      ) : null}
      <div className="grid gap-3">
        {people.map((person) => (
          <Card key={person.id}>
            <h3 className="font-semibold">
              {person.name} <span className="font-normal text-[#5d6878]">{person.position}</span>
            </h3>
            <p className="mt-1 text-sm">Зона: {person.zone || '—'}</p>
            <p className="text-sm">
              Цель: {person.goal || '—'}
              {person.leaderGoal ? ` · цель профиля ${person.leaderGoal}` : ''}
            </p>
            <p className="text-sm">Писем от человека: {person.emails}</p>
            <ul className="mt-2 grid gap-1 text-sm">
              {person.authorities.map((item) => (
                <li key={item.area}>
                  Полномочие: {item.area} — {item.limit}
                  {item.unit === '—' ? '' : ` ${item.unit}`}
                  {item.note ? ` (${item.note})` : ''}
                </li>
              ))}
            </ul>
            {person.kpis.map((kpi) => (
              <div key={kpi.name} className="mt-2 text-sm">
                <p>
                  KPI: {kpi.name}, {kpi.unit}, лучше когда {kpi.better}
                  {kpi.quarter ? ` · квартал ${kpi.quarter.fact} из ${kpi.quarter.plan}` : ''}
                </p>
                <div className="mt-1 h-2 rounded bg-[#e6ebf2]">
                  <div
                    className={`h-2 rounded ${kpi.weeks.at(-1)?.status === 'отстаёт' ? 'bg-[#a3302a]' : 'bg-[#1f5fbf]'}`}
                    style={{ width: `${barWidth(kpi.quarter?.fact, kpi.quarter?.plan, kpi.better)}%` }}
                  />
                </div>
                <p className="text-[#5d6878]">
                  {kpi.weeks.map((week) => `${dayWords(week.week)} ${week.fact}/${week.plan} ${week.status}`).join(' · ')}
                </p>
              </div>
            ))}
            <Origin origin={origins.find((row) => row.id === person.id)?.origin} onOpen={onOpen} />
          </Card>
        ))}
      </div>
    </section>
  );
}

function taskLines(text: string): { short: string; rest: string }[] {
  return text
    .split('\n')
    .filter((line) => /^\d+\./.test(line))
    .map((line) => {
      const body = line.replace(/^\d+\.\s*/, '');
      const dot = body.indexOf('. ');
      if (dot < 0) return { short: body, rest: '' };
      return { short: body.slice(0, dot), rest: body.slice(dot + 2) };
    });
}

function StubList({ title, note, rows }: { title: string; note: string; rows: string[] }) {
  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      <p className="mb-3 text-sm text-[#a3302a]">{note}</p>
      <ul className="grid gap-1 text-sm">
        {rows.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
    </Card>
  );
}

function whenWords(value: string): string {
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(value);
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : value;
  return dayWords(iso);
}

function cleanDots(text: string): string {
  return text.replace(/\s+\./g, '.').replace(/\.{2,}/g, '.').trim();
}

function countWords(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const tail = abs % 10;
  const hundred = abs % 100;
  const word = tail === 1 && hundred !== 11 ? one : tail >= 2 && tail <= 4 && (hundred < 12 || hundred > 14) ? few : many;
  return `${n} ${word}`;
}

function durationWords(hours: number): string {
  const minutes = Math.max(0, Math.round(hours * 60));
  if (minutes < 60) return countWords(minutes, 'минута', 'минуты', 'минут');
  const whole = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursText = countWords(whole, 'час', 'часа', 'часов');
  return rest === 0 ? hoursText : `${hoursText} ${countWords(rest, 'минута', 'минуты', 'минут')}`;
}

function barWidth(fact: string | undefined, plan: string | undefined, better: string): number {
  const left = Number(fact);
  const right = Number(plan);
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return 0;
  const ratio = better === 'меньше' ? right / Math.max(left, 0.01) : left / right;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

function plainProfile(text: string): string {
  return text.replace(/^#{1,6}\s+/gm, '').replace(/\*\*/g, '');
}

const MATRIX_CELLS = [
  { id: 'один_на_один', title: 'Один на один', hint: 'отстаёт и пишет мало' },
  { id: 'помочь', title: 'Помочь', hint: 'отстаёт и пишет много' },
  { id: 'не_трогать', title: 'Не трогать', hint: 'в норме, пишет мало' },
  { id: 'расширить', title: 'Расширить полномочия', hint: 'в норме, пишет много' },
];

function Matrix({ rows, onOpen }: { rows: { name: string; cell?: string; quiet: boolean; basis?: string }[]; onOpen: (helper: string) => void }) {
  if (!rows.length) return null;
  return (
    <section className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">Матрица отдела</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {MATRIX_CELLS.map((cell) => (
          <Card key={cell.id}>
            <p className="font-semibold">{cell.title}</p>
            <p className="text-sm text-[#5d6878]">{cell.hint}</p>
            <ul className="mt-2 text-sm">
              {rows
                .filter((row) => row.cell === cell.id)
                .map((row) => (
                  <li key={row.name}>
                    {row.name}
                    {row.quiet ? ' · тихая проблема' : ''}
                    <Origin origin={rowOrigin('k3', 'Матрица отдела', row.basis || row.name, [])} onOpen={onOpen} />
                  </li>
                ))}
            </ul>
          </Card>
        ))}
      </div>
    </section>
  );
}

function kindLabel(kind: string): string {
  if (kind === 'нужен_руководитель') return 'Оставил вам';
  if (kind === 'вернуть') return 'Вернул';
  if (kind === 'повтор') return 'Повтор, не спрашиваю';
  if (kind === 'не_из_отдела') return 'Не из отдела';
  if (kind === 'спросить_руководителя') return 'Спросить руководителя';
  if (kind === 'делегировать') return 'Делегировать';
  if (kind === 'в_сводку') return 'В сводку';
  if (kind === 'игнорировать') return 'Игнорировать';
  if (kind === 'авто') return 'По правилу';
  return kind;
}

function actionWords(pair: string): string {
  return pair
    .replaceAll('спросить_руководителя', 'спросить руководителя')
    .replaceAll('в_сводку', 'в сводку')
    .replaceAll('_', ' ');
}

function categoryWords(category: string): string {
  if (category === 'обязательства_клиентам') return 'обещание клиенту';
  if (category === 'руководство') return 'письмо руководства';
  if (category === 'иное') return 'рабочий вопрос';
  if (category === 'не_из_отдела') return 'не из отдела';
  return category;
}

function dayWords(iso: string): string {
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${Number(match[3])} ${months[Number(match[2]) - 1] ?? ''}`.trim();
}

function verdictWords(verdict: string): string {
  if (verdict === 'не_должно') return 'убрать из потока';
  if (verdict === 'в_другом_виде') return 'изменить форму';
  if (verdict === 'должно') return 'оставить';
  return verdict;
}

interface ModelSettings {
  error: string;
  agents: { id: string; name: string; model: string; price: string }[];
  catalog: { id: string; name: string; price: string }[];
}

interface CostView {
  today: string;
  week: string;
  month: string;
  byAgent: { agent: string; name: string; operations: number; total: string; average: string }[];
  byModel: { model: string; operations: number; total: string }[];
  recent: { id: string; at: string; agent: string; title: string; model: string; calls: number; price: string; trace: string; group: number; groupWords: string }[];
}

function ModelsPanel({ data, onSaved }: { data: ModelSettings | null; onSaved: () => void }) {
  const [note, setNote] = useState('');
  if (!data) return <Card className="mb-4"><p className="text-sm text-[#5d6878]">Модели загружаются.</p></Card>;
  async function save(agent: string, model: string) {
    setNote('');
    try {
      await api('/api/models', { method: 'POST', body: JSON.stringify({ agent, model }) });
      setNote('Сохранено. Новый вызов пойдёт в эту модель.');
      onSaved();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Не сохранилось');
    }
  }
  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">Модели</h2>
      <p className="mb-3 text-sm text-[#5d6878]">
        У каждого помощника своя модель. В списке только те, что отвечают по схеме. Цена — за миллион токенов, вход / выход.
      </p>
      {data.error ? <p className="mb-2 text-sm">{data.error}. Пока работает модель по умолчанию.</p> : null}
      <ul className="grid gap-3">
        {data.agents.map((agent) => (
          <li key={agent.id} className="grid gap-1 text-sm">
            <span className="font-medium">{agent.name}</span>
            <select
              className="rounded border border-[#d7dde6] bg-white px-2 py-1"
              value={agent.model}
              onChange={(event) => save(agent.id, event.target.value)}
            >
              {data.catalog.some((item) => item.id === agent.model) ? null : <option value={agent.model}>{agent.model}</option>}
              {data.catalog.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} — {item.price}
                </option>
              ))}
            </select>
            {agent.price ? <span className="text-[#5d6878]">{agent.price}</span> : null}
          </li>
        ))}
      </ul>
      {note ? <p className="mt-2 text-sm">{note}</p> : null}
    </Card>
  );
}

function CostPanel({ data }: { data: CostView | null }) {
  if (!data) return <Card className="mb-4"><p className="text-sm text-[#5d6878]">Стоимость загружается.</p></Card>;
  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">Стоимость</h2>
      <p className="mb-3 text-sm text-[#5d6878]">Считается по Москве. «Нет цены» — провайдер цену не прислал. $0 — вызов был бесплатным.</p>
      <ul className="mb-3 grid gap-1 text-sm sm:grid-cols-3">
        <li>Сегодня: {data.today}</li>
        <li>Неделя: {data.week}</li>
        <li>Месяц: {data.month}</li>
      </ul>
      <h3 className="mb-1 text-sm font-medium">По помощникам</h3>
      <ul className="mb-3 grid gap-1 text-sm">
        {data.byAgent.map((row) => (
          <li key={row.agent}>
            {row.name}: {row.operations} опер., всего {row.total}, в среднем {row.average}
          </li>
        ))}
      </ul>
      {data.byModel.length ? (
        <>
          <h3 className="mb-1 text-sm font-medium">По моделям</h3>
          <ul className="mb-3 grid gap-1 text-sm">
            {data.byModel.map((row) => (
              <li key={row.model}>
                {row.model}: {row.operations} опер., {row.total}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {data.recent.length ? (
        <>
          <h3 className="mb-1 text-sm font-medium">Последние операции</h3>
          <ul className="grid gap-2 text-sm">
            {data.recent.map((row) => (
              <li key={row.id}>
                {row.group > 1 ? (
                  <>
                    {row.agent} — {row.groupWords}, {row.price}
                  </>
                ) : (
                  <>
                    {dayWords(row.at)} · {row.agent} · {row.title} · {row.model} · вызовов {row.calls} · {row.price}
                  </>
                )}
                {row.trace ? (
                  <>
                    {' '}
                    <a className="underline" href={row.trace} target="_blank" rel="noreferrer">
                      подробно в Langfuse
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-[#5d6878]">Операций ещё нет. Цена появится после следующего вызова модели.</p>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card className="p-4">
      <b className="block text-2xl tabular-nums">{value ?? '…'}</b>
      <span className="text-sm text-[#5d6878]">{label}</span>
    </Card>
  );
}
