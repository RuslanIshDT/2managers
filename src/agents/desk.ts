// Главная руководителя и происхождение цифр. Имена и числа приходят из данных, в коде их нет.
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authorities, decisions, emails, focusPlans, kpis, leaders, llmCalls, meetings, people, verdicts } from '../db/schema.ts';
import { confirmationPoints, leaderMustConfirm } from './confirm.ts';
import { historyForLeader } from './trust.ts';
import { kpiStatus } from './k1.ts';
import { letterHits, meetingHits, replayWeek, trustOffers, type FlowRule, type HistoryRow } from './replay.ts';
import { listFlowRules, ownProposal } from './week.ts';
import { calendarConfig } from '../yandex/calendar.ts';
import { trackerConfig } from '../yandex/tracker.ts';

const LETTER_MINUTES = 4;

function safetyText(points: string[]): string {
  if (!points.length) return 'Правила подтверждения в профиле не заданы. К вам идёт то, что разбор сам отдал вам, и просьба выше полномочия.';
  return `Пункты профиля «Никогда без подтверждения руководителя» код всегда оставляет вам: ${points.map((point) => `«${point}»`).join('; ')}. Без вашей кнопки ничего из них не отправляется.`;
}

export interface Origin {
  helper: string;
  who: string;
  data: string;
  how: string;
  safety: string;
  rows: string[];
}

export interface WorkItem {
  id: string;
  title: string;
  wait: string;
  minutes: string;
  kind: 'decision' | 'talk' | 'right' | 'series' | 'task' | 'rules';
  lines: { id: string; title: string }[];
  origin: Origin;
}

export interface DoneLine {
  text: string;
  origin: Origin;
}

export interface HelperCard {
  id: string;
  name: string;
  mode: 'модель' | 'код' | 'заглушка';
  does: string;
  did: string;
  result: string;
  value: string;
}

export interface Desk {
  work: WorkItem[];
  done: DoneLine[];
  helpers: HelperCard[];
  people: { id: string; origin: Origin }[];
  feed: { id: string; origin: Origin }[];
}

export interface DeskInput {
  accepted: boolean;
  decisions: { id: string; status: string; summary: string; replyName: string; createdAt: string; category: string }[];
  verdicts: { id: string; kind: string; category: string; summary: string; basis: string; createdAt: string }[];
  letters: { fromName: string; fromEmail: string; subject: string; body: string; received: string }[];
  meetings: { summary: string; minutes: number }[];
  rules: FlowRule[];
  people: { id: string; name: string; emails: number; laggingWeeks: { name: string; week: string }[] }[];
  authorities: { personId: string; area: string; limit: string; unit: string }[];
  history: HistoryRow[];
  series: { title: string; open: boolean }[];
  relief: { letters: number; meetings: number } | null;
  tasks: { title: string; minutes: number; goal: string }[];
  calls: { purpose: string; at: string }[];
  remote?: { tracker: boolean; calendar: boolean };
  points?: string[];
}

export function buildDesk(input: DeskInput): Desk {
  const points = input.points ?? [];
  shownSafety = safetyText(points);
  const picture = replayWeek(input.letters, input.meetings, input.rules, input.accepted);
  const heldLetters = input.accepted
    ? input.letters.filter((letter) => {
        const hit = letterHits(letter, input.rules);
        return Boolean(hit && hit.effect !== 'карточка');
      })
    : [];
  const heldMeetings = input.accepted
    ? input.meetings.filter((meeting) => {
        const hit = meetingHits(meeting.summary, input.rules);
        return Boolean(hit && hit.effect !== 'карточка');
      })
    : [];
  const meetingMinutes = heldMeetings.reduce((sum, meeting) => sum + (meeting.minutes > 0 ? meeting.minutes : 0), 0);
  const returned = input.verdicts.filter((row) => row.kind === 'вернуть' || row.kind === 'делегировать');
  const protectedRows = input.verdicts.filter((row) => row.kind === 'нужен_руководитель' && leaderMustConfirm(row.category, points));
  const quiet = input.people.filter((person) => person.laggingWeeks.length > 0 && person.emails === 0);
  const names = new Map(input.people.map((person) => [person.id, person.name]));
  const offers = trustOffers(input.history, input.authorities).map((offer) => ({ ...offer, name: names.get(offer.personId) ?? '' }));

  const work: WorkItem[] = [];
  if (!input.accepted && input.relief && (input.relief.letters > 0 || input.relief.meetings > 0)) {
    work.push({
      id: 'rules:week',
      title: `Примите правила недели: уйдёт ${countWords(input.relief.letters, 'письмо', 'письма', 'писем')} и ${countWords(input.relief.meetings, 'встреча', 'встречи', 'встреч')}`,
      wait: '',
      minutes: '',
      kind: 'rules',
      lines: [],
      origin: made('k10', 'Правила потока', 'Подсчёт по отчёту аудита этого руководителя, правила ещё не записаны', 'Посчитано по данным', []),
    });
  }
  for (const decision of input.decisions.filter((row) => row.status === 'ждёт')) {
    const letter =
      input.letters.find((row) => row.subject === decision.summary) ??
      input.letters.find((row) => row.fromName === decision.replyName && row.subject.length > 0 && decision.summary.includes(row.subject));
    const person = input.people.find((row) => row.name === decision.replyName);
    const right = person ? input.authorities.find((row) => row.personId === person.id && row.area.toLowerCase().includes('скидк')) : undefined;
    const rows = [letter ? `${letter.fromName}, ${dateWords(letter.received)}: ${letter.subject}` : decision.summary];
    if (right && person) rows.push(`Полномочие ${person.name}: ${right.area} ${right.limit}${right.unit === '—' ? '' : ` ${right.unit}`}`);
    work.push({
      id: decision.id,
      title: shown(`Решите: ${decision.summary}`),
      wait: decision.createdAt ? `Ждёт с ${dateWords(decision.createdAt)}` : '',
      minutes: '',
      kind: 'decision',
      lines: [],
      origin: made('k2', 'Разбор почты', rows.filter(Boolean).join('. '), howModel(input.calls, 'k2', 'просьба выше полномочия этого человека'), rows),
    });
  }
  for (const person of quiet) {
    const weeks = person.laggingWeeks.map((row) => `${row.name}, неделя ${dateWords(row.week)}`).join('; ');
    work.push({
      id: `talk:${person.id}`,
      title: `Поговорите: ${person.name}`,
      wait: person.laggingWeeks.length ? `KPI отстаёт ${countWords(person.laggingWeeks.length, 'неделю', 'недели', 'недель')}` : '',
      minutes: '',
      kind: 'talk',
      lines: [],
      origin: made('k8', 'Контроль KPI', `${person.name}: писем ${person.emails}. ${weeks}`, 'Посчитано по данным', person.laggingWeeks.map((row) => `${person.name}, ${row.name}, ${dateWords(row.week)}`)),
    });
  }
  for (const offer of offers) {
    const past = input.history.filter((row) => row.personId === offer.personId && row.area === offer.area && row.outcome === 'утверждено');
    work.push({
      id: `right:${offer.personId}:${offer.area}`,
      title: shown(offer.title),
      wait: '',
      minutes: '',
      kind: 'right',
      lines: [],
      origin: made(
        'k12',
        'Доверие по решениям',
        `${past.length} утверждений подряд без правок, область «${offer.area}»${offer.name ? `, ${offer.name}` : ''}`,
        'Посчитано по данным',
        past.map((row) => `${dateWords(row.at)}: ${row.subject}`),
      ),
    });
  }
  const openSeries = input.series.filter((row) => row.open);
  if (openSeries.length) {
    const lines = openSeries.map((series) => {
      const minutes = input.meetings
        .filter((meeting) => meeting.summary === series.title)
        .reduce((sum, meeting) => sum + (meeting.minutes > 0 ? meeting.minutes : 0), 0);
      const time = minutes > 0 ? `, ${countWords(minutes, 'минута', 'минуты', 'минут')}` : '';
      return { id: `series:${series.title}`, title: `${series.title}${time}` };
    });
    const minutes = openSeries.reduce((sum, series) => {
      return sum + input.meetings.filter((meeting) => meeting.summary === series.title).reduce((part, meeting) => part + (meeting.minutes > 0 ? meeting.minutes : 0), 0);
    }, 0);
    const time = calendarWords(minutes);
    work.push({
      id: 'series:all',
      title: `Отпустите ${countWords(openSeries.length, 'серию', 'серии', 'серий')}${time ? ` — ${time}` : ''}`,
      wait: '',
      minutes: '',
      kind: 'series',
      lines,
      origin: made('k15', 'Календарь с нуля', 'Открытые серии встреч и их длительность в календаре', 'Посчитано по данным', lines.map((line) => line.title)),
    });
  }
  const waiting = input.decisions.filter((row) => row.status === 'ждёт').map((row) => row.summary);
  // Дело «поговорить» с тихой проблемой уже стоит карточкой «Поговорите» выше — второй раз не показываем.
  const talked = (title: string) => quiet.some((person) => person.name.trim() && title.includes(person.name));
  for (const task of input.tasks.filter((task) => !waiting.some((summary) => sameMatter(task.title, summary)) && !staleQuiet(task.title, input.people) && !talked(task.title))) {
    work.push({
      id: `task:${task.title}`,
      title: shown(`Сделайте: ${task.title}`),
      wait: '',
      minutes: task.minutes > 0 ? `${countWords(task.minutes, 'минута', 'минуты', 'минут')}, так назвала модель` : '',
      kind: 'task',
      lines: [],
      origin: made('k4', 'Три дела на сегодня', task.goal ? `Цель: ${task.goal}` : 'План на сегодня', howModel(input.calls, 'k4', ''), task.goal ? [task.goal] : []),
    });
  }

  const done: DoneLine[] = [];
  if (heldLetters.length > 0) {
    const minutes = heldLetters.length * LETTER_MINUTES;
    done.push({
      text: `До вас не дошло ${countWords(heldLetters.length, 'письмо', 'письма', 'писем')} (${countWords(minutes, 'минута', 'минуты', 'минут')}, оценка: одно письмо — ${countWords(LETTER_MINUTES, 'минута', 'минуты', 'минут')})`,
      origin: made('k10', 'Правила потока', 'Письма каталога, которые закрыты принятым правилом', 'Посчитано по данным', heldLetters.map((letter) => `${letter.fromName}, ${dateWords(letter.received)}: ${letter.subject}`)),
    });
  }
  if (heldMeetings.length > 0) {
    const time = meetingMinutes > 0 ? ` (${countWords(meetingMinutes, 'минута', 'минуты', 'минут')} по календарю)` : '';
    done.push({
      text: `До вас не дошло ${countWords(heldMeetings.length, 'встреча', 'встречи', 'встреч')}${time}`,
      origin: made('k10', 'Правила потока', 'Встречи календаря, которые закрыты принятым правилом', 'Посчитано по данным', heldMeetings.map((meeting) => (meeting.minutes > 0 ? `${meeting.summary}, ${meeting.minutes} мин` : meeting.summary))),
    });
  }
  if (returned.length > 0) {
    done.push({
      text: `Помощник ответил сам или передал сотруднику: ${countWords(returned.length, 'письмо', 'письма', 'писем')}`,
      origin: made('k2', 'Разбор почты', 'Письма, на которые помощник ответил сам или которые передал сотруднику', howModel(input.calls, 'k2', ''), returned.map((row) => shown(row.summary))),
    });
  }
  if (quiet.length > 0) {
    done.push({
      text: `Раньше письма замечено отставание: ${quiet.map((person) => person.name).join(', ')}`,
      origin: made('k8', 'Контроль KPI', 'Недели, где факт хуже плана, и ноль писем от человека', 'Посчитано по данным', quiet.flatMap((person) => person.laggingWeeks.map((row) => `${person.name}, ${row.name}, ${dateWords(row.week)}`))),
    });
  }
  if (protectedRows.length > 0) {
    done.push({
      text: points.length
        ? `Под вашим решением остались ${countWords(protectedRows.length, 'просьба', 'просьбы', 'просьб')} по правилам подтверждения`
        : `Под вашим решением остались ${countWords(protectedRows.length, 'просьба', 'просьбы', 'просьб')}`,
      origin: made('k2', 'Разбор почты', 'Пункты профиля, которые код не отдаёт без кнопки', 'Посчитано по данным', protectedRows.map((row) => shown(row.summary))),
    });
  } else if (points.length) {
    done.push({
      text: 'Письма из правил подтверждения без вашей кнопки не уходят',
      origin: made('k2', 'Разбор почты', 'Пункты профиля. Таких открытых просьб в ленте сейчас нет', 'Посчитано по данным', points),
    });
  } else {
    done.push({
      text: 'Правила подтверждения не заданы: обязательного подтверждения нет',
      origin: made('k2', 'Разбор почты', 'В профиле нет раздела с пунктами подтверждения', 'Посчитано по данным', []),
    });
  }
  const indexRows = picture.remaining.map((row) => shown(row));
  done.push({
    text: input.accepted
      ? `Было ${picture.before}% → стало ${picture.after}%. До вас доходит ${countWords(picture.stillLetters, 'письмо', 'письма', 'писем')} и ${countWords(picture.stillMeetings, 'встреча', 'встречи', 'встреч')} из ${picture.letters} и ${picture.meetings}`
      : `Весь поток пока доходит до вас: ${countWords(picture.letters, 'письмо', 'письма', 'писем')} и ${countWords(picture.meetings, 'встреча', 'встречи', 'встреч')}. Правил, которые его убирают, нет`,
    origin: made('k11', 'Индекс зависимости', input.accepted ? 'Доля писем и встреч, которые правило не закрыло' : 'Принятых правил нет, поэтому доля — весь каталог', 'Посчитано по данным', indexRows),
  });

  return {
    work: work.map(cleanWork),
    done: done.map((line) => ({ text: shown(line.text), origin: cleanOrigin(line.origin) })),
    helpers: helperCards(input, picture, returned.length, heldLetters.length, heldMeetings.length, meetingMinutes),
    people: input.people.map((person) => ({
      id: person.id,
      origin: made(
        'k1',
        'Карточка отдела',
        `${person.name}: писем ${person.emails}. ${person.laggingWeeks.length ? `Отставание: ${person.laggingWeeks.map((row) => dateWords(row.week)).join(', ')}` : 'Недели KPI в норме или их нет'}`,
        'Посчитано по данным',
        person.laggingWeeks.map((row) => `${row.name}, ${dateWords(row.week)}`),
      ),
    })),
    feed: input.verdicts.map((row) => ({
      id: row.id,
      origin: made('k2', 'Разбор почты', shown(row.basis || row.summary), howModel(input.calls, 'k2', ''), [shown(row.summary)].filter(Boolean)),
    })),
  };
}

export async function deskForLeader(db: Db, leaderId: string, series: { title: string; open: boolean }[] = []): Promise<Desk> {
  const [decisionRows, verdictRows, letterRows, meetingRows, personRows, kpiRows, authRows, callRows, planRows, rules, leaderRows] = await Promise.all([
    db.select().from(decisions).where(eq(decisions.leaderId, leaderId)),
    db.select().from(verdicts).where(eq(verdicts.leaderId, leaderId)).orderBy(desc(verdicts.createdAt)),
    db.select().from(emails).where(eq(emails.leaderId, leaderId)),
    db.select().from(meetings).where(eq(meetings.leaderId, leaderId)),
    db.select().from(people).where(eq(people.leaderId, leaderId)),
    db.select().from(kpis).where(eq(kpis.leaderId, leaderId)),
    db.select().from(authorities).where(eq(authorities.leaderId, leaderId)),
    db.select({ purpose: llmCalls.purpose, at: llmCalls.at }).from(llmCalls).where(eq(llmCalls.leaderId, leaderId)),
    db.select().from(focusPlans).where(eq(focusPlans.leaderId, leaderId)).limit(1),
    listFlowRules(db, leaderId),
    db.select({ profile: leaders.profile }).from(leaders).where(eq(leaders.id, leaderId)).limit(1),
  ]);
  const history = await historyForLeader(db, leaderId);
  const mailByPerson = new Map<string, number>();
  for (const letter of letterRows) {
    const person = personRows.find((row) => addressesOf(row).includes(letter.fromEmail.toLowerCase()));
    if (!person) continue;
    mailByPerson.set(person.externalId, (mailByPerson.get(person.externalId) ?? 0) + 1);
  }
  const plan = planRows[0]?.plan as { today?: { title?: string; minutes?: number; goal?: string }[] } | undefined;
  const verdictByLetter = new Map(verdictRows.map((row) => [row.messageId, row.category]));
  const letters = letterRows.map((row) => ({
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    subject: row.subject,
    body: row.body,
    received: row.received,
  }));
  const meetingList = meetingRows.map((row) => ({ summary: row.summary, minutes: row.minutes }));
  const proposal = rules.length ? [] : await ownProposal(db, leaderId);
  const preview = replayWeek(letters, meetingList, proposal, proposal.length > 0);
  return buildDesk({
    accepted: rules.length > 0,
    decisions: decisionRows.map((row) => ({
      id: row.id,
      status: row.status,
      summary: row.summary,
      replyName: row.replyName,
      createdAt: row.createdAt.toISOString(),
      category: verdictByLetter.get(row.id) ?? '',
    })),
    verdicts: verdictRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      category: row.category,
      summary: row.summary,
      basis: row.basis,
      createdAt: row.createdAt.toISOString(),
    })),
    letters,
    meetings: meetingList,
    rules,
    relief: proposal.length ? { letters: preview.stoppedLetters + preview.digestLetters, meetings: preview.stoppedMeetings + preview.digestMeetings } : null,
    people: personRows
      .filter((row) => row.role === 'подчинённый')
      .map((row) => ({
        id: row.externalId,
        name: row.name,
        emails: mailByPerson.get(row.externalId) ?? 0,
        laggingWeeks: kpiRows
          .filter((kpi) => kpi.personId === row.externalId && kpi.week !== 'квартал')
          .filter((kpi) => kpiStatus(kpi.better, kpi.plan, kpi.fact) === 'отстаёт')
          .map((kpi) => ({ name: kpi.name, week: kpi.week })),
      })),
    authorities: authRows.map((row) => ({ personId: row.personId, area: row.area, limit: row.limitValue, unit: row.unit })),
    history,
    series,
    tasks: (plan?.today ?? [])
      .filter((row) => row.title)
      .map((row) => ({ title: row.title ?? '', minutes: row.minutes ?? 0, goal: row.goal ?? '' })),
    calls: callRows.map((row) => ({ purpose: row.purpose, at: row.at.toISOString() })),
    remote: { tracker: Boolean(trackerConfig()), calendar: Boolean(calendarConfig()) },
    points: confirmationPoints(leaderRows[0]?.profile ?? ''),
  });
}

function helperCards(
  input: DeskInput,
  picture: ReturnType<typeof replayWeek>,
  returned: number,
  heldLetters: number,
  heldMeetings: number,
  meetingMinutes: number,
): HelperCard[] {
  const last = (prefix: string) => {
    const rows = input.calls.filter((call) => call.purpose.startsWith(prefix)).sort((a, b) => b.at.localeCompare(a.at));
    return rows[0] ? dateWords(rows[0].at) : '';
  };
  const modelDid = (prefix: string, empty: string) => {
    const when = last(prefix);
    const count = input.calls.filter((call) => call.purpose.startsWith(prefix)).length;
    if (!count) return empty;
    return `${countWords(count, 'вызов', 'вызова', 'вызовов')} модели${when ? `, последний ${when}` : ''}`;
  };
  const letterValue = heldLetters > 0 ? `${countWords(heldLetters * LETTER_MINUTES, 'минута', 'минуты', 'минут')} писем, оценка` : '';
  const meetingValue = meetingMinutes > 0 ? `${countWords(meetingMinutes, 'минута', 'минуты', 'минут')} встреч по календарю` : '';
  const saved = [letterValue, meetingValue].filter(Boolean).join(', ');
  const remote = input.remote ?? { tracker: false, calendar: false };
  const cards: HelperCard[] = [
    card('k1', 'Карточка отдела', 'код', 'Собирает зону, цель, KPI и полномочия человека из файлов отдела.', `В каталоге ${input.people.length} человек.`, 'Карточки отдела заполнены из этих файлов.', 'Коннектор кадровой системы — заглушка, поэтому источник — файлы.'),
    card('k2', 'Разбор почты', input.calls.some((call) => call.purpose.startsWith('k2') || call.purpose.startsWith('mail_ext')) ? 'модель' : 'код', 'Читает письмо и контекст и решает: ответить самому, передать сотруднику, в сводку, без ответа или руководителю. Внутренние письма (сотрудники, коллеги, начальник) и внешние разбираются отдельно.', modelDid('k2', 'Вызовов модели по письмам на этих данных нет.'), returned ? `Ответил сам или передал: ${returned}.` : 'Ответов и пересылок на этих данных нет.', shownSafety),
    card('k3', 'Матрица отдела', 'код', 'Кладёт каждого по KPI и числу писем: поговорить, помочь, расширить право или не трогать.', `Посчитано по ${input.people.length} человек.`, 'Тихие проблемы — те, у кого KPI отстаёт и писем нет.', 'Модель для матрицы не вызывается.'),
    card('k4', 'Три дела на сегодня', input.calls.some((call) => call.purpose.startsWith('k4')) ? 'модель' : 'код', 'Утром выбирает до трёх дел с наибольшим смыслом на час руководителя.', modelDid('k4', 'Сохранённого выбора модели на этих данных нет.'), input.tasks.length ? `В плане ${countWords(input.tasks.length, 'дело', 'дела', 'дел')}.` : 'Плана на сегодня нет.', 'Протокол после утверждения уходит письмом в тестовый ящик.'),
    card('k5', 'Аудит потока', input.calls.some((call) => call.purpose.startsWith('аудитор')) ? 'модель' : 'код', 'Говорит, каких писем и встреч не должно быть и какое изменение организации их убирает.', modelDid('аудитор', 'Прогона аудита на этих данных нет.'), input.rules.length ? `Правил в базе: ${input.rules.length}.` : 'Принятых правил нет.', 'Эталонные метки писем в запрос модели не входят.'),
    card('k6', 'Цели', 'код', 'Раскладывает цели руководителя на людей и их KPI и называет дыры.', `Цели собраны по ${input.people.length} человек.`, 'Дыра — цель без владельца или человек без цели.', 'Модель при открытии кабинета не вызывается.'),
    card('k7', 'Задачи', 'код', 'Смотрит, двигает ли задача цель исполнителя и реален ли срок.', 'Считает по задачам каталога.', 'Задача без цели — кандидат её снять.', remote.tracker ? 'Экран списка читает очередь Трекера.' : 'Экран списка задач — заглушка: Трекер не подключён.'),
    card('k8', 'Контроль KPI', 'код', 'Сравнивает план и факт по неделям и поднимает отставание раньше письма.', `Отстающих недель: ${input.people.reduce((sum, person) => sum + person.laggingWeeks.length, 0)}.`, 'Сигнал появляется, когда писем от человека нет.', 'Прогноз — ещё один шаг того же наклона, не конец квартала.'),
    card('k9', 'Контекст решения', input.calls.some((call) => call.purpose.startsWith('k2')) ? 'модель' : 'код', 'К просьбе, которая осталась у руководителя, добавляет контекст и один вариант решения.', modelDid('k2', 'Отдельного вызова на контекст нет: его пишет разбор письма.'), 'Руководитель видит рекомендацию и основание.', 'Решение всё равно принимает руководитель.'),
    card('k10', 'Правила потока', 'код', 'Принятое изменение становится правилом, и закрытые им письма больше не доходят.', input.accepted ? `Правил: ${input.rules.length}.` : 'Правила недели ещё не приняты.', saved || 'Снятых часов на этих данных нет.', 'Письмо пункта подтверждения правило не забирает.'),
    card('k11', 'Индекс зависимости', 'код', 'Считает, какая доля потока всё ещё требует руководителя.', input.accepted ? `Сейчас ${picture.after}% из ${picture.before}%.` : 'Правил нет, доля — весь каталог.', `Остаются ${picture.stillLetters} писем и ${picture.stillMeetings} встреч.`, 'Это итог блока «Сделано без вас», не отдельная цифра.'),
    card('k12', 'Доверие по решениям', 'код', 'После нескольких утверждений подряд без правок предлагает отдать право.', `В истории ${countWords(input.history.length, 'решение', 'решения', 'решений')}.`, trustOffers(input.history, input.authorities).length ? 'Есть предложение отдать право.' : 'Порога для нового права история не достигла.', 'Пока руководитель не нажмёт «Принять», право не действует.'),
    card('k13', 'Карточка решения', 'код', 'Оставляет руководителю одну строку, рекомендацию, основание и кнопки.', `Ждут решения: ${input.decisions.filter((row) => row.status === 'ждёт').length}.`, 'Кнопки: утвердить, отклонить, отложить.', 'Без кнопки ответ по такой карточке не отправляется.'),
    card('k14', 'Записка человеку', 'код', 'Раз в неделю пишет человеку, с чем он приходил и что решает сам.', 'Текст собирается из его писем и принятых правил.', 'В ящик уходит записка каждому, кому она ещё не уходила.', 'Адрес в синтетике писем не принимает, поэтому письмо уходит в тестовый ящик.'),
    card('k15', 'Календарь с нуля', 'код', 'Регулярная встреча без решения предлагается к отпуску.', `Открытых серий в списке работы: ${input.series.filter((row) => row.open).length}.`, 'Продление хранится в базе.', remote.calendar ? '«Отпустить» убирает будущие встречи серии из календаря «Стенд» и ставит на их время выбранный приоритет: встречу один на один или время на цель из профиля.' : 'Календарь не подключён: освобождение записывается только на стенде.'),
  ];
  cards.push(
    card('stub-tasks', 'Список задач', remote.tracker ? 'код' : 'заглушка', 'Показывает задачи из файла и из утверждённого протокола.', remote.tracker ? 'Те же задачи лежат в очереди Трекера.' : 'Трекер не подключён.', remote.tracker ? 'Экран читает очередь.' : 'Строки не уходят во внешнюю систему.', remote.tracker ? 'Рядом в описании — письмо, если тема совпала.' : 'Это заглушка: список есть, Трекера нет.'),
    card('stub-calendar', 'Календарь', remote.calendar ? 'код' : 'заглушка', 'Показывает встречи из файла.', remote.calendar ? 'Те же встречи стоят в календаре «Стенд».' : 'Календарь не подключён.', remote.calendar ? 'Встреча протокола встаёт туда же.' : 'Встреча по протоколу приходит файлом .ics в письме, в календарь сама не встаёт.', remote.calendar ? '«Отпустить» серию убирает её будущие встречи и ставит блок приоритета.' : 'Это заглушка.'),
    card('r5', 'Рассылка протокола', 'код', 'После «Утвердить» каждому участнику — письмо с его поручениями, протокол и приглашение .ics.', 'Письма уходят на ящик стенда, получатель назван в тексте.', 'Одно поручение — одна задача со своим сроком.', remote.tracker || remote.calendar ? 'Задачи пишутся в Трекер, протокол и новые встречи — в календарь «Стенд».' : 'Календарь и Трекер не подключаются.'),
  );
  return cards;
}

function card(id: string, name: string, mode: HelperCard['mode'], does: string, did: string, result: string, value: string): HelperCard {
  return { id, name, mode, does, did, result, value };
}

let shownSafety = safetyText([]);

function made(helper: string, who: string, data: string, how: string, rows: string[], safety = shownSafety): Origin {
  return { helper, who, data: data || 'Записей для этой строки нет', how: how || 'Посчитано по данным', safety, rows: rows.filter(Boolean).map(shown) };
}

function howModel(calls: { purpose: string; at: string }[], prefix: string, rule: string): string {
  const hit = calls.some((call) => call.purpose.startsWith(prefix));
  if (!hit) return rule ? `Посчитано по данным: ${rule}` : 'Посчитано по данным';
  return rule ? `Предложила модель, проверено правилом: ${rule}` : 'Предложила модель, проверено правилом';
}

function cleanWork(item: WorkItem): WorkItem {
  return {
    ...item,
    title: shown(item.title),
    wait: shown(item.wait),
    minutes: shown(item.minutes),
    lines: item.lines.map((line) => ({ id: line.id, title: shown(line.title) })),
    origin: cleanOrigin(item.origin),
  };
}

function addressesOf(person: { email: string; extraEmail: string }): string[] {
  return [person.email, person.extraEmail].map((value) => value.trim().toLowerCase()).filter((value, index, all) => value && all.indexOf(value) === index);
}

function staleQuiet(title: string, people: DeskInput['people']): boolean {
  const text = title.toLowerCase();
  if (!text.includes('писем 0') && !text.includes('тихая проблема')) return false;
  return people.some((person) => person.emails > 0 && person.name.trim() && text.includes(person.name.toLowerCase()));
}

function sameMatter(task: string, summary: string): boolean {
  const left = task.trim().toLowerCase();
  const right = summary.trim().toLowerCase();
  if (left.length < 8 || right.length < 8) return false;
  return left.includes(right) || right.includes(left);
}

function calendarWords(minutes: number): string {
  if (minutes <= 0) return '';
  if (minutes < 60) return `${countWords(minutes, 'минута', 'минуты', 'минут')} в календаре`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const head = countWords(hours, 'час', 'часа', 'часов');
  if (!rest) return `${head} в календаре`;
  return `${head} ${countWords(rest, 'минута', 'минуты', 'минут')} в календаре`;
}

function cleanOrigin(origin: Origin): Origin {
  return { ...origin, data: shown(origin.data), how: shown(origin.how), rows: origin.rows.map(shown) };
}

function shown(text: string): string {
  return text
    .replace(/\b[a-z]{1,3}\d{2,}\b/gi, '')
    .replace(/\S+@\S+/g, '')
    .replace(/вердикт\w*/gi, 'разбор')
    .replace(/дайджест\w*/gi, 'сводка')
    .replace(/склеен\w*/gi, 'собраны в одну тему')
    .replace(/\bиное\b/gi, 'рабочий вопрос')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

function dateWords(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return '';
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return `${Number(match[3])} ${months[Number(match[2]) - 1] ?? ''}`.trim();
}

function countWords(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const tail = abs % 10;
  const hundred = abs % 100;
  const word = tail === 1 && hundred !== 11 ? one : tail >= 2 && tail <= 4 && (hundred < 12 || hundred > 14) ? few : many;
  return `${n} ${word}`;
}
