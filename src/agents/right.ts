// Короткий вопрос: входит ли письмо в уже принятое право этого человека. Область и предел сверяет код.
import { z } from 'zod';
import { callJson, type JsonSchema } from '../llm.ts';

export interface RightQuestion {
  topic: string;
  area: string;
  value: number;
  unit: string;
  whole: 'да' | 'нет';
}

export async function askRight(
  letter: { subject: string; body: string },
  rights: { area: string; limitValue: string; title: string }[],
): Promise<RightQuestion> {
  const areas = [...new Set(rights.map((right) => right.area.trim()).filter(Boolean))];
  const choices = [...areas, 'нет'];
  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['о_чём', 'область', 'число', 'единица', 'целиком'],
    properties: {
      о_чём: { type: 'string' },
      область: { type: 'string', enum: choices },
      число: { type: 'number' },
      единица: { type: 'string' },
      целиком: { type: 'string', enum: ['да', 'нет'] },
    },
  };
  const listed = rights.map((right) => `${right.area}: до ${right.limitValue}. ${right.title}`).join('\n');
  const result = await callJson<unknown>({
    purpose: 'right',
    system: [
      'Тебе даны письмо и права этого человека, которые руководитель уже принял.',
      'о_чём — одна фраза, о чём просьба.',
      'область — одна из данных областей права или «нет», если просьба не про эти области.',
      'число и единица — из просьбы. Числа нет — 0 и пустая единица. Единица как в праве: %, ₽ или ч.',
      'целиком — да, только если вся просьба укладывается в одну названную область и нет другой просьбы. Сомнение — нет.',
    ].join(' '),
    user: `Права:\n${listed}\n\nПисьмо:\n${letter.subject}\n${letter.body}`,
    schemaName: 'right_question',
    schema,
  });
  const parsed = z
    .object({
      о_чём: z.string(),
      область: z.string(),
      число: z.number(),
      единица: z.string(),
      целиком: z.enum(['да', 'нет']),
    })
    .safeParse(result.data);
  if (!parsed.success) throw new Error('Ответ о праве не совпал со схемой');
  return {
    topic: parsed.data.о_чём,
    area: parsed.data.область,
    value: parsed.data.число,
    unit: parsed.data.единица,
    whole: parsed.data.целиком,
  };
}
