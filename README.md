# ecompras

ИИ-помощник руководителя, трек «Цифровой аватар». Постановка — [docs/tz.md](docs/tz.md), архитектура — [docs/architecture.md](docs/architecture.md), задачи — [docs/backlog.md](docs/backlog.md).

Устройство — [docs/architecture.md](docs/architecture.md). Правила для любого агента — [AGENTS.md](AGENTS.md).

## Стенд

Нужны Docker и файл `.env` по образцу `.env.example`: пароль базы, пароль входа, каталог сертификата, адрес стенда. Секреты в репозиторий не кладутся.

```bash
npm ci
npm test
docker compose up -d --build
```

Стенд слушает HTTP на `127.0.0.1` и порт `HTTP_PORT` (по умолчанию 8090) и HTTPS на `PUBLIC_BIND` и порт `HTTPS_PORT` (по умолчанию 8443). Вход — логин из `LEADER_LOGIN`. Страницы `/form/` и `/audit/` открываются без входа. Проверка: `GET /api/health` отвечает `{"ok":true}`.

Кнопка «Пересобрать отчёт аудита» ставит задание очереди: оно собирает страницу из уже посчитанного отчёта и модель не вызывает. Новый прогон модели — `npm run flow-audit`.

Почта Яндекса и Telegram подключаются переменными `.env`. Пока их нет, стенд это показывает и письма не отправляет.

Сброс стенда перед чистым прогоном стирает решения, вердикты, ленту входящих и принятые правила руководителя, у которого привязан Telegram. Каталог людей и писем не трогает. После сброса в «Ждёт решения» остаётся письмо каталога, где скидка выше полномочия этого человека: id в скрипт не зашит, письмо выбирается по тексту и лимиту из базы. Без `--yes` ничего не удаляется.

Второй адрес человека хранится только в базе стенда. Если основной адрес в базе разошёлся с каталогом, при старте каталожный становится основным, а прежний остаётся вторым. Письмо с любого из двух адресов относится к этому человеку. В репозиторий второй адрес не пишется.

```bash
docker compose exec -T app npm run reset-stand
docker compose exec -T app npm run reset-stand -- --yes
```

## Аудитор потока (K5)

Агент смотрит на письма и встречи руководителя и говорит, каких из них не должно быть, почему и какое оргизменение их убирает. Работает на синтетике `data/synthetic`.

Нужен Node.js 22.18 или новее и файл `.env` с `LLM_BASE_URL` и `LLM_API_KEY` (OpenAI-совместимый API). Для OpenRouter адрес `https://openrouter.ai/api/v1` и отдельный ключ этого проекта. Модель по умолчанию — `LLM_MODEL`, `anthropic/claude-sonnet-5.5`. В настройках стенда у каждого помощника своя модель из каталога, если провайдер отдаёт список с ответом по схеме.

Трассировка — Langfuse, если заданы `LANGFUSE_PUBLIC_KEY` и `LANGFUSE_SECRET_KEY`. Без ключей разбор идёт, в кабинете ссылки нет. `LANGFUSE_PROJECT_URL` — адрес проекта в браузере, например `http://127.0.0.1:3001/project/ecompras`. Контейнер приложения входит в сеть `langfuse_default` и пишет на `LANGFUSE_HOST`.

```
npm run flow-audit:dry   # без модели: цепочки, серии и пример запроса
npm run flow-audit       # аудит: reports/flow-audit.md и reports/flow-audit.json
```

Последний отчёт — [reports/flow-audit.md](reports/flow-audit.md); на стенде — страница `/audit/` ([web/audit/index.html](web/audit/index.html) читает `reports/flow-audit.json`).

Итог в Telegram: в `.env` — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `STAND_ORIGIN` (образец — `.env.example`).

```
npm run tg:chats             # после /start боту: какие чаты ему писали — отсюда TELEGRAM_CHAT_ID
npm run audit:telegram:dry   # показать сообщение
npm run audit:telegram       # отправить
```
