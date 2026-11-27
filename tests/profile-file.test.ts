import { describe, expect, it } from 'vitest';
import { nextProfile } from '../src/agents/profile-file.ts';

describe('профиль из файла', () => {
  it('обновляет текст, если файл изменился, и не трогает тот же текст', () => {
    expect(nextProfile('старый', 'новый')).toBe('новый');
    expect(nextProfile('тот же', 'тот же')).toBeNull();
  });
});