import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeWithTools, MAX_STEPS, runTool, stepsWords, type K2Context } from '../src/agents/k2-tools.ts';

const ctx: K2Context = {
  person: { name: 'Тестовый Сотрудник', position: 'менеджер', zone: 'витрина', goal: 'выручка витрины', leaderGoal: '2' },
  authorities: [{ area: 'скидка витрины', limitValue: '5', unit: '%', note: 'постоянным клиентам' }],
  kpi: [
    { name: 'Выручка', unit: 'тыс', better: 'выше', week: '2026-W48', plan: '100', fact: '90' },
    { name: 'Выручка', unit: 'тыс', better: 'выше', week: '2026-W49', plan: '100', fact: '104' },
  ],
  tasks: [{ title: 'Баннеры', dueOn: '2026-12-12', status: 'в работе' }],
  history: [
    { area: 'скидка', subject: 'Скидка 3% клиенту', outcome: 'утверждено', at: '2026-11-01' },
    { area: 'сроки', subject: 'Перенос запуска', outcome: 'отклонено', at: '2026-11-05' },
  ],
  thread: [],
  revisions: [],
};

const verdict = {
  действие: 'ответить',
  кому_передать: '',
  в_полномочиях: 'да',
  есть_предложение: 'да',
  только_руководитель: 'нет',
  категория: 'иное',
  суть: 'Скидка в пределах права',
  контекст: '',
  рекомендация: '',
  черновик_ответа: 'Решите сами',
  предложение_полномочия: '',
  основание: 'Полномочие скидка витрины до 5%',
  риски: '',
  если_не_решить: '',
  уверенность: 0.9,
  область: 'нет',
  число: 0,
  единица: '',
  другие_просьбы: 'нет',
};

function reply(message: Record<string, unknown>) {
  return new Response(JSON.stringify({ model: 'test/model', choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function toolCall(id: string, name: string, args: string) {
  return { id, type: 'function', function: { name, arguments: args } };
}

describe('T53: агент полномочий с инструментами', () => {
  let bodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    bodies = [];
    vi.stubEnv('LLM_BASE_URL', 'http://provider.test/v1');
    vi.stubEnv('LLM_API_KEY', 'test');
    vi.stubEnv('LLM_LOG', join(tmpdir(), `ecompras-k2-tools-${process.pid}.jsonl`));
    vi.stubEnv('LANGFUSE_HOST', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('модель сама выбирает инструменты, получает данные и выносит вердикт по схеме', async () => {
    const answers = [
      reply({ content: 'Проверю', tool_calls: [toolCall('c1', 'authorities', '{}'), toolCall('c2', 'past_decisions', '{"query":"скидка"}')] }),
      reply({ content: 'готово' }),
      reply({ content: JSON.stringify(verdict) }),
    ];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return answers.shift() ?? reply({ content: '' });
    }));
    const run = await judgeWithTools({ purpose: 'test', profile: 'Профиль', subject: 'Скидка 4%', body: 'Можно скидку 4%?', ctx });
    expect(run.verdict.действие).toBe('ответить');
    expect(run.rounds).toBe(2);
    expect(run.steps.map((step) => step.tool)).toEqual(['authorities', 'past_decisions']);
    expect(bodies).toHaveLength(3);
    expect(bodies[0].tool_choice).toBe('auto');
    const second = bodies[1].messages as { role: string; content: string; tool_call_id?: string }[];
    const tools = second.filter((m) => m.role === 'tool');
    expect(tools.find((m) => m.tool_call_id === 'c1')?.content).toContain('скидка витрины: до 5%');
    expect(tools.find((m) => m.tool_call_id === 'c2')?.content).toContain('Скидка 3% клиенту');
    expect(tools.find((m) => m.tool_call_id === 'c2')?.content).not.toContain('Перенос запуска');
    expect(bodies[2].response_format).toBeTruthy();
    expect(bodies[2].tool_choice).toBe('none');
    expect(stepsWords(run.steps)).toBe('Помощник посмотрел: полномочия, прошлые решения («скидка»)');
  });

  it('шагов не больше предела, затем всё равно вердикт', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.response_format) return reply({ content: JSON.stringify(verdict) });
      n += 1;
      return reply({ content: '', tool_calls: [toolCall(`k${n}`, 'kpi', '{}')] });
    }));
    const run = await judgeWithTools({ purpose: 'test', profile: 'Профиль', subject: 'Тема', body: 'Текст', ctx });
    expect(run.rounds).toBe(MAX_STEPS);
    expect(bodies).toHaveLength(MAX_STEPS + 1);
    expect(run.verdict.основание).toContain('5%');
  });

  it('инструменты отдают только данные контекста', () => {
    expect(runTool('kpi', {}, ctx)).toContain('отстаёт');
    expect(runTool('open_tasks', {}, ctx)).toContain('Баннеры');
    expect(runTool('thread', {}, ctx)).toBe('Прежних писем нет');
    expect(runTool('drop_table', {}, ctx)).toContain('нет');
    expect(stepsWords([])).toContain('не запрашивал');
  });
});
