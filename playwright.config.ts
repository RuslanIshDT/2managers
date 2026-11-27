import { defineConfig } from '@playwright/test';

// Сценарный тест идёт по стенду. Адрес и вход — из окружения, в репозитории их нет.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: { baseURL: process.env.STAND_URL || 'http://127.0.0.1:8090', locale: 'ru-RU' },
  reporter: 'list',
});
