// Главная руководителя и происхождение цифр. Имена и числа приходят из данных, в коде их нет.
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authorities, decisions, emails, focusPlans, kpis, leaders, llmCalls, mailIn, meetings, people, verdicts } from '../db/schema.ts';
import { confirmationPoints, leaderMustConfirm } from './confirm.ts';
import { draftGap } from './k2.ts';
import { historyForLeader } from './trust.ts';
import { kpiStatus } from './k1.ts';
import { letterHits, meetingHits, readingForLetter, replayWeek, trustOffers, type FlowRule, type HistoryRow } from './replay.ts';
import { letterExcerpt, releaseDeferred } from './decision.ts';
import { listFlowRules, ownProposal } from './week.ts';
import { adviceKind, emailMedian, personLines, type AdviceKind, type PersonKpi } from './focus.ts';
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

export interface DecisionMail {
  fromName: string;
  when: string;
  subject: string;
  excerpt: string;
  body: string;
  replyName: string;
  replyTo: string;
  draft: string;
}

export interface WorkItem {
  id: string;
  title: string;
  wait: string;
  minutes: string;
  kind: 'decision' | 'talk' | 'right' | 'series' | 'task' | 'rules';
  lines: { id: string; title: string }[];
  origin: Origin;
  mail?: DecisionMail;
  today?: boolean;
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
  decisions: { id: string; status: string; summary: string; replyName: string; replyTo?: string; subject?: string; createdAt: string; category: string; draft?: string; draftNote?: string }[];
  verdicts: { id: string; kind: string; category: string; summary: string; basis: string; createdAt: string; area?: string }[];
  letters: { id?: string; fromName: string; fromEmail: string; subject: string; body: string; received: string; reading?: { area: string; value: number; unit: string; others: boolean } | null }[];
  meetings: { summary: string; minutes: number }[];
  rules: FlowRule[];
  people: { id: string; name: string; emails: number; laggingWeeks: { name: string; week: string }[]; kpis?: PersonKpi[] }[];
  authorities: { personId: string; area: string; limit: string; unit: string }[];
  history: HistoryRow[];
  series: { title: string; open: boolean }[];
  relief: { letters: number; meetings: number } | null;
  proposal?: FlowRule[];
  tasks: { title: string; minutes: number; goal: string; why?: string }[];
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
        const hit = letterHits(letter, input.rules, letter.reading);
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

  const openDecisions = input.decisions
    .filter((row) => row.status === 'ждёт')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const paired = new Map<string, DeskInput['tasks'][number]>();
  for (const task of input.tasks) {
    const hit = openDecisions.find((row) => sameMatter(task.title, row.summary) || (row.subject ? sameMatter(task.title, row.subject) : false));
    if (hit && !paired.has(hit.id)) paired.set(hit.id, task);
  }
  const median = emailMedian(input.people.map((person) => person.emails));

  const work: WorkItem[] = [];
  if (!input.accepted && input.relief && (input.relief.letters > 0 || input.relief.meetings > 0)) {
    work.push({
      id: 'rules:week',
      title: rulesTitle(input.relief),
      wait: '',
      minutes: '',
      kind: 'rules',
      lines: rulesLines(input.proposal ?? []),
      origin: made('k10', 'Правила потока', 'Подсчёт по отчёту аудита этого руководителя, правила ещё не записаны', 'Посчитано по данным', []),
    });
  }
  for (const decision of openDecisions) {
    const letter = letterOf(decision, input.letters);
    const person = input.people.find((row) => row.name === decision.replyName);
    const named = input.verdicts.find((row) => row.id === `v-${decision.id}`)?.area?.trim().toLowerCase() ?? '';
    const right = person && named ? input.authorities.find((row) => row.personId === person.id && row.area.trim().toLowerCase() === named) : undefined;
    const rows = [letter ? `${letter.fromName}, ${dateWords(letter.received)}: ${letter.subject}` : decision.summary];
    if (right && person) rows.push(`Полномочие ${person.name}: ${right.area} ${right.limit}${right.unit === '—' ? '' : ` ${right.unit}`}`);
    const gap = draftGap(decision.draft ?? '');
    const note = (decision.draftNote ?? '').trim();
    const task = paired.get(decision.id);
    const why = task?.why?.trim() ?? '';
    const lines = [
      ...(gap ? [{ id: `${decision.id}:gap`, title: 'В черновике пропуск. Допишите его перед утверждением.' }] : []),
      ...(note ? [{ id: `${decision.id}:note`, title: note }] : []),
      ...(why ? [{ id: `${decision.id}:why`, title: `Почему в делах дня: ${why}` }] : []),
    ];
    const body = letter?.body ?? '';
    const excerpt = letterExcerpt(body);
    work.push({
      id: decision.id,
      title: shown(`Решите: ${decision.summary}`),
      wait: decision.createdAt ? `Ждёт с ${dateWords(decision.createdAt)}` : '',
      minutes: task && task.minutes > 0 ? `${countWords(task.minutes, 'минута', 'минуты', 'минут')}, так назвала модель` : '',
      kind: 'decision',
      today: Boolean(task),
      lines,
      mail: {
        fromName: letter?.fromName || decision.replyName,
        when: dateWords(letter?.received || decision.createdAt),
        subject: letter?.subject || decision.subject || decision.summary,
        excerpt: excerpt.excerpt,
        body,
        replyName: decision.replyName,
        replyTo: decision.replyTo ?? letter?.fromEmail ?? '',
        draft: decision.draft ?? '',
      },
      origin: made('k2', 'Разбор почты', rows.filter(Boolean).join('. '), howModel(input.calls, 'k2', 'просьба выше полномочия этого человека'), rows),
    });
  }
  for (const person of quiet) {
    const weeks = person.laggingWeeks.map((row) => `${row.name}, неделя ${dateWords(row.week)}`).join('; ');
    const dropped = input.tasks.find((task) => person.name.trim() && task.title.includes(person.name));
    work.push({
      id: `talk:${person.id}`,
      title: `Поговорите: ${person.name}`,
      wait: person.laggingWeeks.length ? `KPI отстаёт ${countWords(person.laggingWeeks.length, 'неделю', 'недели', 'недель')}` : '',
      minutes: dropped && dropped.minutes > 0 ? `${countWords(dropped.minutes, 'минута', 'минуты', 'минут')}, так назвала модель` : '',
      kind: 'talk',
      lines: briefLines(`talk:${person.id}`, 'один_на_один', person, input, median, dropped?.why ?? ''),
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
  for (const task of input.tasks.filter((task) => ![...paired.values()].includes(task) && !waiting.some((summary) => sameMatter(task.title, summary)) && !staleQuiet(task.title, input.people) && !talked(task.title))) {
    const kind = adviceKind(task.title);
    const person = kind ? namedPerson(task.title, input.people) : undefined;
    work.push({
      id: `task:${task.title}`,
      title: shown(`Сделайте: ${task.title}`),
      wait: '',
      minutes: task.minutes > 0 ? `${countWords(task.minutes, 'минута', 'минуты', 'минут')}, так назвала модель` : '',
      kind: 'task',
      lines: person && kind ? briefLines(`task:${task.title}`, kind, person, input, median, task.why ?? '') : [],
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
  await releaseDeferred(db, leaderId);
  const [decisionRows, verdictRows, letterRows, meetingRows, personRows, kpiRows, authRows, callRows, planRows, rules, leaderRows, inbox] = await Promise.all([
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
    db
      .select({
        syntheticId: mailIn.syntheticId,
        messageId: mailIn.messageId,
        fromName: mailIn.fromName,
        fromEmail: mailIn.fromEmail,
        subject: mailIn.subject,
        body: mailIn.body,
        received: mailIn.received,
      })
      .from(mailIn)
      .where(eq(mailIn.leaderId, leaderId)),
  ]);
  const history = await historyForLeader(db, leaderId);
  const mailByPerson = new Map<string, number>();
  for (const letter of letterRows) {
    const person = personRows.find((row) => addressesOf(row).includes(letter.fromEmail.toLowerCase()));
    if (!person) continue;
    mailByPerson.set(person.externalId, (mailByPerson.get(person.externalId) ?? 0) + 1);
  }
  const plan = planRows[0]?.plan as { today?: { title?: string; minutes?: number; goal?: string; why?: string }[] } | undefined;
  const verdictByLetter = new Map(verdictRows.map((row) => [row.messageId, row.category]));
  const readings = verdictRows.map((row) => ({
    id: row.id,
    messageId: row.messageId,
    area: row.authorityArea,
    value: row.authorityValue,
    unit: row.authorityUnit,
    others: row.authorityOthers,
    at: row.createdAt.toISOString(),
  }));
  const letters = letterRows.map((row) => ({
    id: row.externalId,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    subject: row.subject,
    body: row.body,
    received: row.received,
    reading: readingForLetter(row.externalId, readings, inbox),
  }));
  const knownLetters = new Set(letters.map((row) => row.id));
  for (const row of inbox) {
    if (!row.syntheticId || knownLetters.has(row.syntheticId)) continue;
    knownLetters.add(row.syntheticId);
    letters.push({
      id: row.syntheticId,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      subject: row.subject,
      body: row.body,
      received: row.received,
      reading: readingForLetter(row.syntheticId, readings, inbox),
    });
  }
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
      replyTo: row.replyTo,
      subject: row.subject,
      createdAt: row.createdAt.toISOString(),
      category: verdictByLetter.get(row.id) ?? '',
      draft: row.draft,
      draftNote: row.draftNote,
    })),
    verdicts: verdictRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      category: row.category,
      summary: row.summary,
      basis: row.basis,
      area: row.authorityArea,
      createdAt: row.createdAt.toISOString(),
    })),
    letters,
    meetings: meetingList,
    rules,
    relief: proposal.length ? { letters: preview.stoppedLetters + preview.digestLetters, meetings: preview.stoppedMeetings + preview.digestMeetings } : null,
    proposal,
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
        kpis: personKpis(kpiRows, row.externalId),
      })),
    authorities: authRows.map((row) => ({ personId: row.personId, area: row.area, limit: row.limitValue, unit: row.unit })),
    history,
    series,
    tasks: (plan?.today ?? [])
      .filter((row) => row.title)
      .map((row) => ({ title: row.title ?? '', minutes: row.minutes ?? 0, goal: row.goal ?? '', why: row.why ?? '' })),
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
    card('k6', 'Цели', 'код', 'Раскладывает цели руководителя на людей и их KPI и называет дыры.', `Цели собраны по ${input.people.length} человек.`, 'Дыра — цель без владельца, цель без KPI владельца или человек без цели.', 'Модель при открытии кабинета не вызывается.'),
    card('k7', 'Задачи', 'код', 'Смотрит, двигает ли задача цель исполнителя и реален ли срок.', 'Считает по задачам каталога.', 'Задача без цели — кандидат её снять.', remote.tracker ? 'Экран списка читает очередь Трекера.' : 'Экран списка задач — заглушка: Трекер не подключён.'),
    card('k8', 'Контроль KPI', 'код', 'Сравнивает план и факт по неделям и поднимает отставание раньше письма.', `Отстающих недель: ${input.people.reduce((sum, person) => sum + person.laggingWeeks.length, 0)}.`, 'Сигнал появляется, когда писем от человека нет.', 'Прогноз — ещё один шаг того же наклона, не конец квартала.'),
    card('k9', 'Контекст решения', input.calls.some((call) => call.purpose.startsWith('k2')) ? 'модель' : 'код', 'К просьбе, которая осталась у руководителя, добавляет контекст и один вариант решения.', modelDid('k2', 'Отдельного вызова на контекст нет: его пишет разбор письма.'), 'Руководитель видит рекомендацию и основание.', 'Решение всё равно принимает руководитель.'),
    card('k10', 'Правила потока', 'код', 'Принятое изменение становится правилом, и закрытые им письма больше не доходят.', input.accepted ? `Правил: ${input.rules.length}.` : 'Правила недели ещё не приняты.', saved || 'Снятых часов на этих данных нет.', 'Письмо пункта подтверждения правило не забирает.'),
    card('k11', 'Индекс зависимости', 'код', 'Считает, какая доля потока всё ещё требует руководителя.', input.accepted ? `Сейчас ${picture.after}% из ${picture.before}%.` : 'Правил нет, доля — весь каталог.', `Остаются ${picture.stillLetters} писем и ${picture.stillMeetings} встреч.`, 'Это итог блока «Сделано без вас», не отдельная цифра.'),
    card('k12', 'Доверие по решениям', 'код', 'После нескольких утверждений подряд без правок предлагает отдать право.', `В истории ${countWords(input.history.length, 'решение', 'решения', 'решений')}.`, trustOffers(input.history, input.authorities).length ? 'Есть предложение отдать право.' : 'Порога для нового права история не достигла.', 'Пока руководитель не нажмёт «Принять», право не действует.'),
    card('k13', 'Карточка решения', 'код', 'Показывает письмо, кому уйдёт ответ и черновик. Кнопки: отправить, отказать, отложить до даты, поправить.', `Ждут решения: ${input.decisions.filter((row) => row.status === 'ждёт').length}.`, 'Отказ уходит письмом отправителю. Отложенное возвращается в выбранный день.', 'Без кнопки «Отправить ответ» черновик не уходит.'),
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

function personKpis(
  rows: { personId: string; name: string; unit: string; better: string; week: string; plan: string; fact: string }[],
  personId: string,
): PersonKpi[] {
  const own = rows
    .filter((row) => row.personId === personId && row.week !== 'квартал')
    .sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name, 'ru'));
  const byName = new Map<string, PersonKpi>();
  for (const row of own) {
    const item = byName.get(row.name) ?? { name: row.name, unit: row.unit, weeks: [] };
    item.weeks.push({ week: row.week, plan: row.plan, fact: row.fact, lagging: kpiStatus(row.better, row.plan, row.fact) === 'отстаёт' });
    byName.set(row.name, item);
  }
  return [...byName.values()];
}

function namedPerson(title: string, people: DeskInput['people']) {
  return people.filter((person) => person.name.trim() && title.includes(person.name)).sort((a, b) => b.name.length - a.name.length)[0];
}

function briefLines(id: string, advice: AdviceKind, person: DeskInput['people'][number], input: DeskInput, median: number, why: string) {
  const waiting = input.decisions
    .filter((row) => row.status === 'ждёт' && row.replyName.trim() === person.name.trim())
    .map((row) => (row.subject || row.summary).trim())
    .filter(Boolean);
  return personLines({ advice, kpis: person.kpis ?? [], emails: person.emails, median, waiting, why }).map((title, index) => ({
    id: `${id}:${index}`,
    title,
  }));
}

function letterOf(
  decision: { id: string; summary: string; replyName: string; subject?: string },
  letters: { id?: string; fromName: string; fromEmail: string; subject: string; body: string; received: string }[],
) {
  const byId = letters.find((row) => row.id && row.id === decision.id);
  if (byId) return byId;
  const subject = (decision.subject ?? '').trim();
  if (subject) {
    const named = letters.find((row) => row.subject === subject && row.fromName === decision.replyName);
    if (named) return named;
    const same = letters.find((row) => row.subject === subject);
    if (same) return same;
  }
  return (
    letters.find((row) => row.subject === decision.summary) ??
    letters.find((row) => row.fromName === decision.replyName && row.subject.length > 0 && decision.summary.includes(row.subject))
  );
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

function singularCount(n: number): boolean {
  const abs = Math.abs(n);
  return abs % 10 === 1 && abs % 100 !== 11;
}

function rulesTitle(relief: { letters: number; meetings: number }): string {
  const parts: string[] = [];
  if (relief.letters > 0) parts.push(countWords(relief.letters, 'письмо', 'письма', 'писем'));
  if (relief.meetings > 0) parts.push(countWords(relief.meetings, 'встреча', 'встречи', 'встреч'));
  const named = parts.length === 2 ? `${parts[0]} и ${parts[1]}` : (parts[0] ?? '');
  const alone = parts.length === 1 ? (relief.letters > 0 ? relief.letters : relief.meetings) : 0;
  const verb = parts.length === 1 && singularCount(alone) ? 'дойдёт' : 'дойдут';
  return `Примите правила недели: до вас не ${verb} ${named}`;
}

function blocksFlow(rule: FlowRule): boolean {
  return rule.effect === 'стоп' || rule.effect === 'дайджест';
}

function rulesLines(proposal: FlowRule[]): { id: string; title: string }[] {
  const chains = proposal.filter((rule) => rule.kind === 'письмо' && blocksFlow(rule)).length;
  const series = proposal.filter((rule) => rule.kind === 'встреча' && blocksFlow(rule)).length;
  const rights = proposal.filter((rule) => rule.kind === 'полномочие').length;
  const lines: { id: string; title: string }[] = [];
  const removed = [chains > 0 ? countWords(chains, 'цепочку', 'цепочки', 'цепочек') : '', series > 0 ? countWords(series, 'серию', 'серии', 'серий') : ''].filter(Boolean);
  const parts: string[] = [];
  if (removed.length) {
    const named = removed.length === 2 ? `${removed[0]} и ${removed[1]}` : removed[0];
    const reach = chains > 0 && series > 0 ? 'их письма и встречи до вас не доходят' : chains > 0 ? 'их письма до вас не доходят' : 'их встречи до вас не доходят';
    parts.push(`Аудит потока признал лишними ${named}: ${reach}`);
  }
  if (rights > 0) parts.push(`Подчинённым предлагается ${countWords(rights, 'право', 'права', 'прав')} решать самому до предела`);
  if (parts.length) lines.push({ id: 'rules:made', title: `${parts.join('. ')}.` });
  lines.push({ id: 'rules:where', title: 'Где смотреть: раздел «Поток» и «Полный аудит потока».' });
  lines.push({
    id: 'rules:after',
    title:
      'После принятия по новым письмам в пределах права помощник сам отвечает подчинённому «это в вашем праве», вас не спрашивают. По кнопке «Принять» письма никому не уходят. Темы, которые вы по профилю подтверждаете сами, и важные адресаты правилами не отсекаются.',
  });
  return lines;
}
