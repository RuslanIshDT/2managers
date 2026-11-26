import { useEffect, useState, type FormEvent } from 'react';
import { Button } from './components/ui/button.tsx';
import { Card } from './components/ui/card.tsx';
import { Input } from './components/ui/input.tsx';

interface User {
  name: string;
  login: string;
}

interface Cabinet {
  name: string;
  profile: string;
  linkCode: string;
  counts: { people: number; emails: number; meetings: number; tasks: number };
  mail: 'configured' | 'missing';
  telegram: 'configured' | 'missing';
  lastAudit: { status: string; mode: string; at: string } | null;
}

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
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{cabinet?.name ?? user.name}</h1>
          <p className="text-[#5d6878]">Каталог загружен в базу. Профиль правится файлом, здесь только просмотр.</p>
        </div>
        <Button type="button" variant="outline" onClick={logout}>
          Выйти
        </Button>
      </div>
      {error ? <p className="mb-4 text-sm text-[#a3302a]">{error}</p> : null}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Люди" value={counts?.people} />
        <Stat label="Письма" value={counts?.emails} />
        <Stat label="Встречи" value={counts?.meetings} />
        <Stat label="Задачи" value={counts?.tasks} />
      </div>
      <Card className="mb-4">
        <h2 className="mb-2 text-lg font-semibold">Подключения</h2>
        <ul className="grid gap-1 text-sm">
          <li>Почта: {cabinet?.mail === 'configured' ? 'учётные данные заданы' : 'не настроена — заглушки отправки нет, ящик синтетики в базе'}</li>
          <li>Telegram: {cabinet?.telegram === 'configured' ? 'токен задан' : 'не настроен — нет токена бота'}</li>
          <li>Код для бота: <code>{cabinet?.linkCode || '…'}</code> — сообщение <code>/start {cabinet?.linkCode}</code></li>
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" onClick={rebuildAudit} disabled={pending}>
            {pending ? 'Задание…' : 'Пересобрать отчёт аудита'}
          </Button>
          {job ? <span className="text-sm text-[#1b7a45]">{job}</span> : null}
        </div>
        <p className="mt-2 text-sm text-[#5d6878]">Задание очереди пересобирает уже посчитанный отчёт и модель не вызывает.</p>
      </Card>
      <Card className="mb-4">
        <h2 className="mb-2 text-lg font-semibold">Профиль</h2>
        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{cabinet?.profile}</pre>
      </Card>
      <p className="text-sm text-[#5d6878]">
        <a className="text-[#1f5fbf] underline" href="/audit/">
          Аудит потока
        </a>
        {' · '}
        <a className="text-[#1f5fbf] underline" href="/form/">
          Форма сдачи
        </a>
      </p>
    </main>
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
