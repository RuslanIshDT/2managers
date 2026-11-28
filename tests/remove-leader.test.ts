import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { removalRefusal } from '../src/scripts/remove-leader.ts';

describe('удаление руководителя', () => {
  it('без записи и с Telegram не удаляет, обычного пропускает к удалению', () => {
    expect(removalRefusal(undefined)).toMatch(/не найден/);
    expect(removalRefusal({ telegramChatId: '1' })).toMatch(/Telegram/);
    expect(removalRefusal({ telegramChatId: null })).toBeNull();
  });

  it('пароль второго каталога из окружения больше не читается', () => {
    const seed = readFileSync('src/db/seed.ts', 'utf8');
    const example = readFileSync('.env.example', 'utf8');
    expect(seed).not.toContain('LEADER2_PASSWORD');
    expect(seed).not.toContain('seedMissingCatalogs');
    expect(example).not.toContain('LEADER2_PASSWORD');
  });
});
