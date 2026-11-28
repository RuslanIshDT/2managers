// Карточки раздела «Помощник». Числа — только из данных этого руководителя.
import { dateWords } from './scene.ts';
import { trustOffers, type HistoryRow } from './replay.ts';

export interface HelperCard {
  id: string;
  name: string;
  mode: 'модель' | 'код' | 'заглушка';
  does: string;
  did: string;
  result: string;
  value: string;
}

export interface HelperFacts {
  revisions: number;
  protocols: number;
  reminders: number;
  notes: number;
  seriesKinds: number;
  acts: number;
  tasks: number;
  goals: number;
}

interface ModelCall {
  purpose: string;
  at: string;
  agent?: string;
}

export interface HelperSource {
  people: { laggingWeeks: unknown[] }[];
  calls: ModelCall[];
  tasks: unknown[];
  rules: unknown[];
  decisions: { status: string; draftNote?: string }[];
  history: HistoryRow[];
  authorities: { personId: string; area: string; limit: string }[];
  series: { open: boolean }[];
  letters: unknown[];
  meetings: { summary: string }[];
  accepted: boolean;
  remote?: { tracker: boolean; calendar: boolean };
  facts?: HelperFacts;
}

const EMPTY_FACTS: HelperFacts = {
  revisions: 0,
  protocols: 0,
  reminders: 0,
  notes: 0,
  seriesKinds: 0,
  acts: 0,
  tasks: 0,
  goals: 0,
};

export function buildHelperCards(
  source: HelperSource,
  picture: { before: number; after: number; stillLetters: number; stillMeetings: number },
  returned: number,
  heldLetters: number,
  heldMeetings: number,
  meetingMinutes: number,
  safety: string,
): HelperCard[] {
  const facts = source.facts ?? EMPTY_FACTS;
  const remote = source.remote ?? { tracker: false, calendar: false };
  const calls = source.calls;
  const inner = pick(calls, 'k2', 'k2:');
  const outer = pick(calls, 'mail_ext', 'mail_ext');
  const focus = calls.filter((call) => call.agent === 'k4' || (call.purpose.startsWith('k4:') && !call.purpose.startsWith('k4:series')));
  const seriesType = pick(calls, 'k15', 'k4:series');
  const audit = pick(calls, 'k5', 'аудитор');
  const draft = pick(calls, 'draft-check', 'draft-check');
  const right = pick(calls, 'right', 'right');
  const morning = pick(calls, 'morning', 'morning-rule');
  const oneOnOne = pick(calls, 'one-on-one', 'one-on-one');
  const protocol = pick(calls, 'protocol', 'protocol');
  const offers = trustOffers(source.history, source.authorities);
  const topics = new Set(source.meetings.map((meeting) => meeting.summary.trim()).filter(Boolean)).size;
  const gaps = source.decisions.filter((row) => (row.draftNote ?? '').trim()).length;
  const waiting = source.decisions.filter((row) => row.status === 'ждёт').length;
  const lagging = source.people.reduce((sum, person) => sum + person.laggingWeeks.length, 0);
  const letterValue = heldLetters > 0 ? `${countWords(heldLetters * 4, 'минута', 'минуты', 'минут')} писем, оценка` : '';
  const meetingValue = meetingMinutes > 0 ? `${countWords(meetingMinutes, 'минута', 'минуты', 'минут')} встреч по календарю` : '';
  const saved = [letterValue, meetingValue].filter(Boolean).join(', ');
  const openSeries = source.series.filter((row) => row.open).length;

  const cards: HelperCard[] = [
    card('k1', 'Карточка отдела', 'код', 'Собирает зону, цель, KPI и полномочия человека из выгрузки отдела.', peopleLine(source.people.length), source.people.length ? 'Карточки отдела заполнены из этих данных.' : 'Людей в отделе нет.', 'Пока кадровая система не подключена, источник — файлы руководителя.'),
    card('k2', 'Разбор почты', 'модель', 'Читает письмо и решает: руководителю, ответить, передать, в сводку или без ответа.', mailDid(inner, outer), returned ? `Ответил сам или передал: ${returned}.` : 'Ответов и пересылок на этих данных нет.', safety),
    card('draft-check', 'Сверка черновика', 'модель', 'Сверяет факты черновика с письмом и данными и ставит пропуск вместо неподтверждённого.', told(draft, 'Вызовов сверки на этих данных нет.'), gaps ? `Черновиков с пометкой сверки: ${gaps}.` : 'Пометок сверки на карточках нет.', 'Черновик с пропуском или без сверки без вас не уходит.'),
    card('k12', 'Принятое право', 'модель', 'После решений без правок предлагает отдать право и проверяет, входит ли новая просьба в уже принятое.', `${historyLine(source.history.length)} ${told(right, 'Проверок моделью на этих данных нет.')}`, offers.length ? 'Есть предложение отдать право.' : 'Порога для нового права история не достигла.', 'Пока вы не нажмёте «Принять», новое право не действует.'),
    card('mail-poll', 'Проверка почты', 'код', 'Забирает новые письма и до модели отсеивает копии, повторы и письма, закрытые вашим правилом.', source.letters.length ? `Писем в базе: ${source.letters.length}.` : 'Писем на этих данных нет.', 'До модели не доходят копия, повтор без новых условий и письмо, которое закрыло правило.', 'Ящик проверяется раз в минуту.'),
    card('k3', 'Матрица отдела', 'код', 'Кладёт каждого по KPI и числу писем: поговорить, помочь, расширить право или не трогать.', source.people.length ? `Людей в матрице: ${source.people.length}.` : 'Людей для матрицы нет.', 'Тихие проблемы — те, у кого KPI отстаёт и писем нет.', 'Модель для матрицы не вызывается.'),
    card('k8', 'Контроль KPI', 'код', 'Сравнивает план и факт по неделям и поднимает отставание раньше письма.', lagging ? `Отстающих недель: ${lagging}.` : 'Отстающих недель на этих данных нет.', 'Сигнал появляется, когда писем от человека нет.', 'Прогноз — ещё один шаг того же наклона.'),
    card('one-on-one', 'К встрече один на один', 'модель', 'Перед встречей один на один решает, ждёт ли сотрудник вашего действия.', told(oneOnOne, 'Сводок к встрече на этих данных нет.'), 'Строка есть, только если ход уже за вами и это подтверждено решением, протоколом или закрытой задачей.', 'Источник, которого нет в наборе, в строку не попадает.'),
    card('k4', 'Три дела на сегодня', 'модель', 'Утром выбирает до трёх дел с наибольшим смыслом на ваш час.', told(focus, 'Сохранённого выбора модели на этих данных нет.'), source.tasks.length ? `В плане ${countWords(source.tasks.length, 'дело', 'дела', 'дел')}.` : 'Плана на сегодня нет.', 'Остальные дела в сообщение не идут.'),
    card('morning', 'Правило утра', 'модель', 'Разбирает сохранённое правило утра в порядок блоков, скрытый блок, предел строк и указание для трёх дел.', told(morning, 'Разобранных правил утра на этих данных нет.'), 'Если правило так не выразить, оно не становится действующим.', 'Действуют все разобранные правила вместе, более позднее перекрывает раннее.'),
    card('k5', 'Аудит потока', 'модель', 'Говорит, каких писем и встреч не должно быть и какое изменение организации их убирает.', told(audit, 'Прогона аудита на этих данных нет.'), source.rules.length ? `Принятых правил: ${source.rules.length}.` : 'Принятых правил нет.', 'Эталонные метки писем в запрос модели не входят.'),
    card('k10', 'Правила потока', 'код', 'Принятое изменение становится правилом, и закрытые им письма и встречи больше не доходят.', source.accepted ? `Правил: ${source.rules.length}.` : 'Правила недели ещё не приняты.', saved || 'Снятых часов на этих данных нет.', 'Письмо, которое вы подтверждаете сами, правило не забирает.'),
    card('k11', 'Индекс зависимости', 'код', 'Считает, какая доля потока всё ещё требует руководителя.', source.accepted ? `Сейчас ${picture.after}% из ${picture.before}%.` : 'Правил нет, доля — весь поток.', `Остаются ${picture.stillLetters} писем и ${picture.stillMeetings} встреч.`, 'Это итог блока «Сделано без вас».'),
    card('k15', 'Календарь с нуля', 'код', 'Предлагает отпустить регулярную встречу, на которой нет решения.', openSeries ? `Открытых серий: ${openSeries}.` : 'Открытых серий к отпуску нет.', 'Продление хранится у вас.', remote.calendar ? '«Отпустить» убирает будущие встречи серии и ставит на это время выбранный приоритет.' : 'Календарь не подключён: освобождение видно только в кабинете.'),
    card('series-kind', 'Тип встреч', 'модель', 'Определяет тип серии встреч, и по типу считается время на ваши цели.', kindDid(seriesType, facts.seriesKinds), facts.seriesKinds ? `Типов серий в базе: ${facts.seriesKinds}.` : 'Типов серий на этих данных нет.', 'Серия из пункта профиля «Никогда без подтверждения» сгорающей не становится.'),
    card('k6', 'Цели', 'код', 'Раскладывает ваши цели на людей и их KPI и называет дыры.', facts.goals ? `Целей у людей: ${facts.goals}.` : 'Целей в карточках людей нет.', 'Дыра — цель без владельца, цель без KPI владельца или человек без цели.', 'Модель при открытии кабинета не вызывается.'),
    card('k7', 'Задачи', 'код', 'Смотрит, двигает ли задача цель исполнителя и реален ли срок.', facts.tasks ? `Задач в базе: ${facts.tasks}.` : 'Задач на этих данных нет.', 'Задача без цели — кандидат её снять.', remote.tracker ? 'Список задач читает очередь Трекера.' : 'Список задач без Трекера остаётся заглушкой.'),
    card('deadlines', 'Сроки', 'код', 'Утром пишет исполнителям о сроке сегодня и о просрочке и собирает короткий список для вас.', facts.reminders ? `Напоминаний: ${facts.reminders}.` : 'Напоминаний о сроке на этих данных нет.', 'Одной задаче — не больше одного письма в день.', 'Ваши задачи в эти письма не попадают: они в утреннем сообщении.'),
    card('protocol', 'Протокол встречи', 'модель', 'По расшифровке и прошлому протоколу пишет протокол и по «Поправить» переписывает его.', protocolDid(protocol, facts.protocols), facts.protocols ? `Протоколов: ${facts.protocols}.` : 'Протоколов на этих данных нет.', 'Пока вы не утвердили, задачи и письма не уходят.'),
    card('topic', 'Тема встреч', 'код', 'Связывает встречи с одним названием, находит прошлый протокол и пишет цепочку в описание.', topics ? `Тем встреч: ${topics}.` : 'Встреч на этих данных нет.', 'У следующей встречи темы — вопросы по прошлому протоколу.', 'Встречи без общего названия в одну тему не склеиваются.'),
    card('r5', 'Рассылка протокола', 'код', 'После «Утвердить» ставит задачи, закрывает сделанное, рассылает письма и новые встречи.', facts.protocols ? `Протоколов, из которых может уйти рассылка: ${facts.protocols}.` : 'Протоколов для рассылки нет.', 'Одно поручение — одна задача со своим сроком.', remote.tracker || remote.calendar ? 'Задачи пишутся в Трекер, протокол и новые встречи — в календарь.' : 'Трекер и календарь не подключены: уходит письмо и файл приглашения.'),
    card('memory', 'Память руководителя', 'код', 'Хранит правило только после «Запомнить» и применяет его со следующего материала.', facts.revisions ? `Запомненных правил: ${facts.revisions}.` : 'Запомненных правил нет.', facts.acts ? `Ваших решений в журнале: ${facts.acts}.` : 'Ваших решений в журнале нет.', '«Только сейчас» правило не создаёт.'),
    card('k9', 'Контекст решения', 'модель', 'К просьбе, которая осталась у вас, добавляет контекст и один вариант решения.', inner.length || outer.length ? 'Контекст пишет тот же разбор письма, отдельного вызова нет.' : 'Разбора писем на этих данных нет, контекст не из чего собрать.', waiting ? `Ждут решения: ${waiting}.` : 'Ждущих решений нет.', 'Решение всё равно принимаете вы.'),
    card('k13', 'Карточка решения', 'код', 'Показывает письмо, кому уйдёт ответ и черновик и ждёт кнопку: отправить, отказать, отложить или поправить.', waiting ? `Ждут решения: ${waiting}.` : 'Ждущих решений нет.', 'Отказ уходит письмом отправителю, отложенное возвращается в выбранный день.', 'Без кнопки «Отправить ответ» черновик не уходит.'),
    card('k14', 'Записка человеку', 'код', 'Собирает человеку, с чем он приходил и что решает сам.', facts.notes ? `Отправленных записок: ${facts.notes}.` : 'Записок на этих данных ещё не отправляли.', 'Повторно тому, кому уже уходила, не отправляется.', 'Человек видит, с чем приходил и что решает сам.'),
    card('stub-tasks', 'Список задач', remote.tracker ? 'код' : 'заглушка', 'Показывает задачи из ваших данных и из утверждённого протокола.', facts.tasks ? `Задач в базе: ${facts.tasks}.` : 'Задач на этих данных нет.', remote.tracker ? 'Экран читает очередь Трекера.' : 'Строки во внешнюю систему не уходят.', remote.tracker ? 'В описании — исполнитель и письмо, если тема совпала.' : 'Это заглушка: списка Трекера нет.'),
    card('stub-calendar', 'Календарь', remote.calendar ? 'код' : 'заглушка', 'Показывает встречи из ваших данных.', topics ? `Тем встреч: ${topics}.` : 'Встреч на этих данных нет.', remote.calendar ? 'Встреча протокола встаёт в тот же календарь.' : 'Встреча по протоколу приходит файлом приглашения и сама в календарь не встаёт.', remote.calendar ? '«Отпустить» серию убирает её будущие встречи.' : 'Это заглушка: календаря нет.'),
  ];
  return cards;
}

function peopleLine(count: number): string {
  if (!count) return 'Людей в отделе нет.';
  return `В отделе ${countWords(count, 'человек', 'человека', 'человек')}.`;
}

function historyLine(count: number): string {
  if (!count) return 'Решений в истории нет.';
  return `В истории ${countWords(count, 'решение', 'решения', 'решений')}.`;
}

function mailDid(inner: ModelCall[], outer: ModelCall[]): string {
  if (!inner.length && !outer.length) return 'Вызовов модели по письмам на этих данных нет.';
  return `Из организации: ${side(inner)}. Извне: ${side(outer)}.`;
}

function kindDid(calls: ModelCall[], stored: number): string {
  const model = told(calls, 'Вызовов модели на этих данных нет.');
  return stored ? `${model} Типов в базе: ${stored}.` : model;
}

function protocolDid(calls: ModelCall[], stored: number): string {
  const model = told(calls, 'Вызовов модели на этих данных нет.');
  return stored ? `${model} Протоколов: ${stored}.` : model;
}

function side(rows: ModelCall[]): string {
  if (!rows.length) return 'вызовов нет';
  return told(rows, 'вызовов нет');
}

function pick(calls: ModelCall[], agent: string, purpose: string): ModelCall[] {
  return calls.filter((call) => call.agent === agent || call.purpose.startsWith(purpose));
}

function told(rows: ModelCall[], empty: string): string {
  if (!rows.length) return empty;
  const last = [...rows].sort((a, b) => b.at.localeCompare(a.at))[0];
  const when = last ? dateWords(last.at) : '';
  return `${countWords(rows.length, 'вызов', 'вызова', 'вызовов')} модели${when ? `, последний ${when}` : ''}`;
}

function card(id: string, name: string, mode: HelperCard['mode'], does: string, did: string, result: string, value: string): HelperCard {
  return { id, name, mode, does, did, result, value };
}

function countWords(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const tail = abs % 10;
  const hundred = abs % 100;
  const word = tail === 1 && hundred !== 11 ? one : tail >= 2 && tail <= 4 && (hundred < 12 || hundred > 14) ? few : many;
  return `${n} ${word}`;
}
