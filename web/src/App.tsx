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
}

interface MirrorScene {
  notes: { name: string; email: string; text: string; quiet: boolean }[];
  series: { title: string; verdict: string; change: string; hours: number; action: string; reason: string; kind: string }[];
}

interface Cabinet {
  name: string;
  profile: string;
  linkCode: string;
  counts: { people: number; emails: number; meetings: number; tasks: number };
  mail: 'configured' | 'missing';
  telegram: 'configured' | 'missing';
  department: { errors: string[]; people: DepartmentPerson[] };
  feed: FeedItem[];
  week: WeekScene;
  focus: FocusScene;
  mirror: MirrorScene;
  revisions: { id: string; category: string; instead: string }[];
  accuracy: { total: number; hit: number; calls: number; forced: number; misses: { pair: string; count: number }[] } | null;
  protocol: { status: string; open: number } | null;
  lastAudit: { status: string; mode: string; at: string } | null;
}

type Section = 'home' | 'department' | 'flow' | 'feed' | 'settings';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'home', label: 'Главная' },
  { id: 'department', label: 'Отдел' },
  { id: 'flow', label: 'Поток' },
  { id: 'feed', label: 'Лента' },
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
      const result = await api<{ name: string }>('/api/mirror/send', { method: 'POST', body: '{}' });
      setJob(`Записка для ${result.name} ушла в тестовый ящик`);
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
      const week = await api<WeekScene>('/api/rules/accept', { method: 'POST', body: '{}' });
      setCabinet((prev) => (prev ? { ...prev, week } : prev));
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
        <h1 className="text-2xl font-semibold">{cabinet?.name ?? user.name}</h1>
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
        <>
          <Week
            week={cabinet?.week}
            mode="home"
            pending={pending}
            onAccept={acceptRules}
            onDecision={decide}
          />
          <Focus focus={cabinet?.focus} pending={pending} onSend={sendFocusNow} />
        </>
      ) : null}
      {section === 'department' ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Люди" value={counts?.people} />
            <Stat label="Письма" value={counts?.emails} />
            <Stat label="Встречи" value={counts?.meetings} />
            <Stat label="Задачи" value={counts?.tasks} />
          </div>
          <Department department={cabinet?.department} />
          <Matrix rows={cabinet?.focus.matrix ?? []} />
          <Mirror mirror={cabinet?.mirror} part="notes" pending={pending} onSend={sendNote} onSeries={seriesAction} />
        </>
      ) : null}
      {section === 'flow' ? (
        <>
          <Week week={cabinet?.week} mode="flow" pending={pending} onAccept={acceptRules} />
          <Mirror mirror={cabinet?.mirror} part="series" pending={pending} onSend={sendNote} onSeries={seriesAction} />
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
        {cabinet?.feed.length ? (
          <ul className="grid gap-2 text-sm">
            {cabinet.feed.map((item) => (
              <li key={item.id}>
                <b>{kindLabel(item.kind)}</b> · {categoryWords(item.category)}
                <span className="block">{item.summary}</span>
                <span className="block text-[#5d6878]">{item.basis}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[#5d6878]">Пока пусто. Письма подчинённых читаются из ящика, не из файла.</p>
        )}
      </Card>
      ) : null}
      {section === 'settings' ? (
        <>
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
              ? `Протокол в Telegram: ${cabinet.protocol.status}. Открытых вопросов: ${cabinet.protocol.open}. Рассылка участникам — заглушка, письма не уходят.`
              : 'Расшифровка читается с диска стенда и в репозиторий не входит. Рассылка — заглушка.'}
          </p>
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
}: {
  mirror: MirrorScene | undefined;
  part: 'notes' | 'series';
  pending: boolean;
  onSend: () => void;
  onSeries: (key: string, action: 'продлить' | 'отпустить') => void;
}) {
  if (!mirror) return null;
  if (part === 'notes') {
    return (
      <Card className="mb-4">
        <h2 className="mb-2 text-lg font-semibold">Записки</h2>
        <p className="mb-2 text-sm text-[#5d6878]">В ящик уходит одна записка. Остальные видны здесь.</p>
        <ul className="grid gap-2 text-sm">
          {mirror.notes.map((note) => (
            <li key={note.email}>
              <b>{note.name}</b>
              {note.quiet ? ' · тихая проблема' : ''}
              <span className="block whitespace-pre-wrap text-[#5d6878]">{note.text}</span>
            </li>
          ))}
        </ul>
        <Button className="mt-3" type="button" variant="outline" onClick={onSend} disabled={pending}>
          {pending ? 'Отправка…' : 'Отправить одну записку'}
        </Button>
      </Card>
    );
  }
  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-lg font-semibold">Серии встреч</h2>
      <p className="mb-2 text-sm text-[#5d6878]">Календарь не подключён: «продлить» и «отпустить» только записывают решение.</p>
      <ul className="mt-4 grid gap-3 text-sm">
        {mirror.series.map((item) => (
          <li key={item.title}>
            <b>{item.title}</b>
            {item.kind ? <span className="text-[#5d6878]"> · {item.kind}</span> : null}
            <span className="text-[#5d6878]"> · {verdictWords(item.verdict)}</span>
            <span className="block text-[#5d6878]">
              {item.hours} ч. {item.change}
              {item.action ? ` Записано: ${item.action}${item.reason ? ` — ${item.reason}` : ''}.` : ''}
            </span>
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
  const [lead, rest] = focus.text.split('\n\nНе сегодня:');
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
      <p className="mt-2 text-sm text-[#5d6878]">
        Расписание: 8:30 каждый день и пятница в 17:00, часовой пояс Москвы. Кнопка отправляет то же сообщение сейчас.
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
            <b>{row.category}.</b> {row.instead}
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
              ? `Было ${week.before}%. Стало ${week.after}%. До руководителя не доходят ${week.stoppedLetters} писем (около ${letterHours(week.stoppedLetters)} ч) и ${week.stoppedMeetings} встреч. Остаются ${week.stillLetters} писем и ${week.stillMeetings} встреч.`
              : `Сейчас на руководителя приходится весь поток: ${week.letters} писем и ${week.meetings} встреч.`}
          </p>
        </>
      ) : (
        <p className="text-sm text-[#5d6878]">
          {week.accepted
            ? `Повторы склеены: ${week.gluedLetters} писем и ${week.gluedMeetings} встреч. Сводкой: ${week.digestLetters} писем и ${week.digestMeetings} встреч. Оставшееся: ${week.remaining.join('; ') || 'нет'}.`
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

function Department({ department }: { department: Cabinet['department'] | undefined }) {
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
                    className={`h-2 rounded ${kpi.quarter && kpiBehind(kpi.quarter.fact, kpi.quarter.plan, kpi.better) ? 'bg-[#a3302a]' : 'bg-[#1f5fbf]'}`}
                    style={{ width: `${barWidth(kpi.quarter?.fact, kpi.quarter?.plan, kpi.better)}%` }}
                  />
                </div>
                <p className="text-[#5d6878]">
                  {kpi.weeks.map((week) => `${dayWords(week.week)} ${week.fact}/${week.plan} ${week.status}`).join(' · ')}
                </p>
              </div>
            ))}
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

function letterHours(letters: number): number {
  return Math.round((letters * 4) / 60);
}

function barWidth(fact: string | undefined, plan: string | undefined, better: string): number {
  const left = Number(fact);
  const right = Number(plan);
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return 0;
  const ratio = better === 'меньше' ? right / Math.max(left, 0.01) : left / right;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

function kpiBehind(fact: string, plan: string, better: string): boolean {
  return better === 'меньше' ? Number(fact) > Number(plan) : Number(fact) < Number(plan);
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

function Matrix({ rows }: { rows: { name: string; cell?: string; quiet: boolean }[] }) {
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
  if (kind === 'нужен_руководитель') return 'Нужно ваше решение';
  if (kind === 'вернуть') return 'Вернул';
  if (kind === 'повтор') return 'Повтор, не спрашиваю';
  if (kind === 'не_из_отдела') return 'Не из отдела';
  return kind;
}

function actionWords(pair: string): string {
  return pair
    .replaceAll('спросить_руководителя', 'спросить руководителя')
    .replaceAll('в_сводку', 'в сводку')
    .replaceAll('_', ' ');
}

function categoryWords(category: string): string {
  if (category === 'обязательства_клиентам') return 'обязательства клиентам';
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

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card className="p-4">
      <b className="block text-2xl tabular-nums">{value ?? '…'}</b>
      <span className="text-sm text-[#5d6878]">{label}</span>
    </Card>
  );
}
