// Имя в документации и имя карточки «Помощника» совпадают.
// Уточнение в скобках («Разбор почты (внутр.)») — тот же агент, отдельной таблицы нет.

export function agentBaseName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/u, '').trim();
}

export function helperIdForName(name: string, cards: { id: string; name: string }[]): string | undefined {
  const exact = cards.find((card) => card.name === name);
  if (exact) return exact.id;
  const base = agentBaseName(name);
  if (base === name) return undefined;
  return cards.find((card) => card.name === base)?.id;
}
