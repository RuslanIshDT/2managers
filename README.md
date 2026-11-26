# ecompras

ИИ-помощник руководителя, трек «Цифровой аватар». Постановка — [docs/tz.md](docs/tz.md), архитектура — [docs/architecture.md](docs/architecture.md), задачи — [docs/backlog.md](docs/backlog.md).

Приложение ещё не собрано. Как запустить стенд — появится вместе с ним.

## Аудитор потока (K5)

Агент смотрит на письма и встречи руководителя и говорит, каких из них не должно быть, почему и какое оргизменение их убирает. Работает на синтетике `data/synthetic`.

Нужен Node.js 22.18 или новее и файл `.env` с `LLM_BASE_URL` и `LLM_API_KEY` (OpenAI-совместимый API; у нас Kodik Router). Модель — `LLM_MODEL`, по умолчанию `anthropic/claude-sonnet-5.5`.

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
