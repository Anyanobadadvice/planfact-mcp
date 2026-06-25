# PlanFact MCP Server

[English](README.md) · **Русский**

PlanFact это система учёта для малого бизнеса. API у неё хороший, а ассистента сверху нет. Этот сервер его добавляет.

Это локальный [MCP](https://modelcontextprotocol.io)-сервер: AI-клиент (Claude Code, Codex, любой MCP-хост) читает вашу реальную финансовую картину и заносит операции обратно, через подтверждение, чтобы ничего не попало в учёт, пока вы не скажете «да». Сделано под микробизнес: держать записи в актуальном виде, видеть, где деньги, закрывать месяц без десяти открытых вкладок.

Я делаю интеграции на заказ: ту самую скучную, но критичную обвязку, которая превращает AI в рабочий инструмент внутри бизнеса. Та часть, где всё должно сойтись с реальной системой и при этом ничего не сломать.

Подробный разбор, как устроен и работает этот MCP, смотрите у меня на сайте: [nobadadvice.com](https://nobadadvice.com).

## Что умеет

- Читать остатки, счета, проекты, контрагентов, категории и операции.
- Создавать операции прихода и расхода, только после подтверждения.
- Создавать контрагентов и переводы между счетами, только после подтверждения.
- Создавать ОПУ-начисления для списаний на конец месяца, только после подтверждения.
- Считать приход и расход за месяц по категориям и по проектам.
- Готовить разбор месяца и план на следующий, которые реально можно прочитать.

## Как устроено

- **TypeScript**, ESM, сборка через `tsc`. Node 20+.
- **MCP поверх stdio** через `@modelcontextprotocol/sdk`, любой MCP-клиент монтирует его локально.
- **`zod`-схемы** на каждый вход инструмента, валидация до того, как запрос уйдёт с вашей машины.
- Чистое разделение: `tools/` (что может вызвать ассистент), `schemas/` (типизированные входы), `services/planfactClient.ts` (REST-клиент), `formatters.ts` (человекочитаемый вывод).
- **Запись под защитой.** Каждый инструмент записи требует `confirmed=true`. Логика в два шага: ассистент готовит операцию, показывает сводку, и создаёт её только после вашего подтверждения. Денежная операция не должна быть в одном случайном сообщении от записи в учёт.
- Конфиг через переменные окружения, с переопределением эндпоинтов, если ваш аккаунт PlanFact ждёт другие маршруты.

## Инструменты

**Чтение**

`planfact_list_accounts` · `planfact_list_account_groups` · `planfact_list_projects` · `planfact_list_project_groups` · `planfact_list_counterparties` · `planfact_list_companies` · `planfact_list_operation_categories` · `planfact_list_operations` · `planfact_get_account_history` · `planfact_get_income_outcome_by_categories` · `planfact_get_income_outcome_by_projects` · `planfact_get_current_balances` · `planfact_find_data_gaps` · `planfact_prepare_monthly_review` · `planfact_prepare_next_month_plan`

**Запись** (требуют `confirmed=true`)

`planfact_create_operation` · `planfact_update_operation` · `planfact_create_move_operation` · `planfact_create_counterparty` · `planfact_create_opu_accrual`

## Установка

```bash
git clone https://github.com/Anyanobadadvice/planfact-mcp.git
cd planfact-mcp
npm install
cp .env.example .env
npm run build
```

Дальше отредактируйте `.env`:

```bash
PLANFACT_API_KEY=ваш-реальный-токен
PLANFACT_BASE_URL=https://api.planfact.io
PLANFACT_REQUIRE_CONFIRMATION_FOR_WRITES=true
```

Не вставляйте API-ключ в чат. Он лежит в `.env`, который добавлен в `.gitignore`.

Если PlanFact ждёт в вашем аккаунте другие маршруты, переопределите их:

```bash
PLANFACT_INCOME_OPERATION_PATH=/operations/income
PLANFACT_OUTCOME_OPERATION_PATH=/operations/outcome
PLANFACT_MOVE_OPERATION_PATH=/operations/move
PLANFACT_COUNTERPARTY_PATH=/contragents
PLANFACT_OPU_ACCRUAL_PATH=/operations/accrual
```

## Подключение

**Claude Code**

```bash
claude mcp add planfact -- node /path/to/planfact-mcp/dist/index.js
```

**Codex** (или любой MCP-хост с JSON-конфигом)

```json
{
  "mcpServers": {
    "planfact": {
      "command": "node",
      "args": ["/path/to/planfact-mcp/dist/index.js"],
      "env": {
        "PLANFACT_API_KEY": "ваш-реальный-токен"
      }
    }
  }
}
```

Один локальный сервер, на него могут смотреть сразу несколько клиентов.

## Как я этим пользуюсь

Смысл в том, чтобы относиться к нему как к финансовому ассистенту, а не к обёртке над API.

```text
Покажи текущие остатки, сгруппируй по валюте и компании. Подсвети всё, что выглядит устаревшим.
```

```text
Проверь операции за этот месяц и найди пропущенные категории, проекты, контрагентов или неподтверждённые записи.
```

```text
Подготовь расход: 120 GEL, Canva, сегодня, со счёта <account-id>, категория software. Не создавай, пока не подтвержу.
```

```text
Подготовь разбор прошлого месяца: cashflow, крупнейшие операции, категории, проекты, пробелы в данных. Потом объясни простым языком, что произошло.
```

```text
Подготовь план на следующий месяц на основе этого: что контролировать, что собрать, где можно улучшить, что решить.
```

Инструменты записи останавливаются и ждут. Вы читаете сводку, потом подтверждаете.

## Лицензия

MIT — см. [LICENSE](LICENSE).

## Об авторе

Сделала Анна Сиделева, **No Bad Advice**. Делаю AI-автоматизацию и интеграции: воркфлоу на n8n, ботов, обвязку для CRM и платежей, собственные MCP-серверы вроде этого.

[nobadadvice.com](https://nobadadvice.com)
