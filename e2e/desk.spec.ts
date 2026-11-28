import { expect, test } from '@playwright/test';

const login = process.env.E2E_LOGIN ?? '';
const password = process.env.E2E_PASSWORD ?? '';

test.skip(!login || !password, 'нужны E2E_LOGIN и E2E_PASSWORD');

test('главная: что нужно от вас, решение с кнопками, откуда это, без служебных слов', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[name="login"]').fill(login);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();

  await expect(page.getByRole('heading', { name: 'Что нужно от вас' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Сделано без вас за неделю' })).toBeVisible();
  await expect(page.getByText(/^Сегодня в данных руководителя:/)).toBeVisible();

  const work = page.locator('section', { has: page.getByRole('heading', { name: 'Что нужно от вас' }) });
  await expect(work.getByRole('button').first()).toBeVisible();
  if (process.env.E2E_DECISION !== '0') {
    const decision = work.getByText(/^Решите:/).first();
    if (await decision.count()) await expect(work.getByRole('button', { name: /Отправить ответ|Утвердить|Согласовать|Одобрить|Да/ }).first()).toBeVisible();
  }

  const origin = page.locator('details', { has: page.getByText('Откуда это и почему можно доверять') }).first();
  await origin.locator('summary').click();
  await expect(origin.getByText(/^Кто подготовил:/)).toBeVisible();
  await expect(origin.getByText(/^Из каких данных:/)).toBeVisible();
  await expect(origin.getByText(/^Как получено:/)).toBeVisible();
  await expect(origin.getByText(/^Страховка:/)).toBeVisible();

  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/вердикт|склеен|дайджест|(^|[^а-яё])иное([^а-яё]|$)/im);
  expect(text).not.toMatch(/[a-zа-яё]+_[a-zа-яё]/i);
  expect(text).not.toMatch(/(?<![\w-])20\d\d-\d\d-\d\d(?![\dT:])/);
});
