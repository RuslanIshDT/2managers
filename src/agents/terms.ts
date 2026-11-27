// Условия в письме: проценты, суммы, сроки, обязательства. Нужны, чтобы письмо в той же цепочке
// с новыми условиями не сочли повтором: прежнее решение принималось на прежних условиях.

export type TermKind = 'процент' | 'сумма' | 'количество' | 'срок' | 'обязательство';

export interface TermChange {
  kind: TermKind;
  was: string[];
  now: string[];
}

const KINDS: TermKind[] = ['процент', 'сумма', 'количество', 'срок', 'обязательство'];

const MONTHS = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
const WEEKDAYS: [RegExp, string][] = [
  [/понедельник/, 'понедельник'],
  [/вторник/, 'вторник'],
  [/сред[уыае]/, 'среда'],
  [/четверг/, 'четверг'],
  [/пятниц/, 'пятница'],
  [/суббот/, 'суббота'],
  [/воскресен/, 'воскресенье'],
];
const COMMITMENTS: [RegExp, string][] = [
  [/гарантир|гаранти[яюи]/, 'гарантия'],
  [/обеща/, 'обещание'],
  [/обязу[ею]|обязательств/, 'обязательство'],
  [/штраф|неустойк|пени(?![а-я])/, 'штраф'],
  [/компенсац|компенсир/, 'компенсация'],
  [/\bsla\b/, 'SLA'],
  [/бесплатн/, 'бесплатно'],
  [/эксклюзив/, 'эксклюзив'],
];

export function letterTerms(text: string): Record<TermKind, string[]> {
  const source = text.toLowerCase().replace(/ё/g, 'е').replace(/ /g, ' ');
  const found = empty();

  for (const match of source.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:%|процент)/g)) found.процент.add(`${number(match[1])}%`);

  const money = /(\d[\d ]*(?:[.,]\d+)?)\s*(млрд|млн|тыс\.?)?\s*(₽|руб(?:\.|л[а-я]*)?)?/g;
  for (const match of source.matchAll(money)) {
    if (!match[2] && !match[3]) continue;
    const scale = match[2] ? (match[2].startsWith('млрд') ? 'млрд' : match[2].startsWith('млн') ? 'млн' : 'тыс') : '';
    found.сумма.add(`${number(match[1].replace(/ /g, ''))}${scale ? ` ${scale}` : ''} ₽`);
  }

  // Число с единицей: «4 часа», «50 лицензий», «2 смены». Проценты, деньги и даты — выше.
  const units = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s+([а-я]{2,})/g;
  for (const match of source.matchAll(units)) {
    const unit = match[2];
    if (new RegExp(`^(?:${MONTHS})$`).test(unit) || /^(?:млн|млрд|тыс|руб|процент)/.test(unit)) continue;
    found.количество.add(`${number(match[1])} ${unit}`);
  }

  for (const match of source.matchAll(new RegExp(`(\\d{1,2})(?:\\s*[–—-]\\s*(\\d{1,2}))?\\s+(${MONTHS})`, 'g'))) {
    found.срок.add(`${match[2] ? `${Number(match[1])}–${Number(match[2])}` : Number(match[1])} ${match[3]}`);
  }
  for (const match of source.matchAll(/(?<![\d.,])(\d{1,2})\.(\d{2})(?:\.(\d{2,4}))?(?![\d,]|\s*(?:%|млн|млрд|тыс|₽|руб))/g)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;
    found.срок.add(`${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}`);
  }
  for (const match of source.matchAll(/(?:^|[^а-я])(?:до|к|ко|в|во|на|по)\s+([а-я]+)/g)) {
    const day = WEEKDAYS.find(([pattern]) => pattern.test(match[1]));
    if (day) found.срок.add(day[1]);
  }

  for (const [pattern, name] of COMMITMENTS) if (pattern.test(source)) found.обязательство.add(name);

  return {
    процент: [...found.процент],
    сумма: [...found.сумма],
    количество: [...found.количество],
    срок: [...found.срок],
    обязательство: [...found.обязательство],
  };
}

function empty(): Record<TermKind, Set<string>> {
  return { процент: new Set(), сумма: new Set(), количество: new Set(), срок: new Set(), обязательство: new Set() };
}

// Что в новом письме появилось такого, чего не было ни в одном прежнем письме цепочки.
export function termChanges(before: string[], text: string): TermChange[] {
  const known = empty();
  for (const previous of before) {
    const terms = letterTerms(previous);
    for (const kind of KINDS) for (const value of terms[kind]) known[kind].add(value);
  }
  const current = letterTerms(text);
  const changes: TermChange[] = [];
  for (const kind of KINDS) {
    const seen = new Set([...known[kind]].map((value) => same(kind, value)));
    const fresh = current[kind].filter((value) => !seen.has(same(kind, value)));
    if (fresh.length) changes.push({ kind, was: [...known[kind]], now: fresh });
  }
  return changes;
}

export function changeWords(changes: TermChange[]): string {
  return changes
    .map((change) => {
      const label = change.kind;
      if (change.kind === 'обязательство') return `${label}: новое — ${change.now.join(', ')}`;
      return change.was.length ? `${label}: в письме ${change.now.join(', ')}, раньше в цепочке ${change.was.join(', ')}` : `${label}: появилось ${change.now.join(', ')}`;
    })
    .join('; ');
}

// «4 часа» и «4 часов» — одно и то же количество: единица сравнивается по началу слова.
function same(kind: TermKind, value: string): string {
  if (kind !== 'количество') return value;
  const [count, unit = ''] = value.split(' ');
  return `${count} ${unit.slice(0, 3)}`;
}

function number(value: string): string {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? String(parsed).replace('.', ',') : value;
}
