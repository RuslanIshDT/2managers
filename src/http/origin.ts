export function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function requestOrigin(headers: Record<string, string | string[] | undefined>): string {
  const proto = (firstHeader(headers['x-forwarded-proto']) ?? 'http').split(',')[0].trim();
  const host = (firstHeader(headers['x-forwarded-host']) ?? firstHeader(headers.host) ?? 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

// Адрес стенда для формы сдачи. Если задан STAND_ORIGIN, подставляем его:
// и с localhost, и с публичного адреса в форме один и тот же стенд.
export function formOrigin(headers: Record<string, string | string[] | undefined>, standOrigin: string | undefined): string {
  const fixed = standOrigin?.trim().replace(/\/+$/, '');
  if (fixed) return fixed;
  return requestOrigin(headers);
}

export function applyOrigin(text: string, origin: string): string {
  return text.replaceAll('{{origin}}', origin);
}
