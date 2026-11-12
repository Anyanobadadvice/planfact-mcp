# PlanFact MCP Server

**English** · [Русский](README.ru.md)

PlanFact is a Russian accounting platform for small business. It has a solid API and no assistant on top of it. This gives it one.

It is a local [MCP](https://modelcontextprotocol.io) server that lets an AI client (Claude Code, Codex, any MCP host) read your real financial picture and post operations back, with a confirmation gate so nothing hits your books until you say so. Built for a micro-business workflow: keep the records current, see where the money is, close the month without opening five tabs.

I build integrations for clients: the boring-but-critical plumbing that makes AI actually useful inside a business. The part where it has to meet a real system and not break anything.

A detailed write-up of how this MCP works is on my site: [nobadadvice.com](https://nobadadvice.com).

## What it does

- Read balances, accounts, projects, counterparties, categories and operations.
- Create income and outcome operations, only after explicit confirmation.
- Create counterparties and account transfers, only after explicit confirmation.
- Create OPU accruals for month-end inventory write-offs, only after explicit confirmation.
- Analyze monthly income and outcome by category and by project.
- Prepare a monthly review and a next-month plan you can actually read.

## How it is built

- **TypeScript**, ESM, compiled with `tsc`. Node 20+.
- **MCP over stdio** via `@modelcontextprotocol/sdk`, so any MCP client can mount it locally.
- **`zod` schemas** for every tool input, validation happens before a request ever leaves your machine.
- Clean separation: `tools/` (what the assistant can call), `schemas/` (typed inputs), `services/planfactClient.ts` (the REST client), `formatters.ts` (human-readable output).
- **Writes are gated.** Every write tool needs `confirmed=true`. The intended flow is two-phase: the assistant prepares an operation, shows you a summary, and only creates it after you confirm. Money operations should never be one accidental message away.
- Config through environment variables, with endpoint overrides if your PlanFact account expects different routes.

## Tools

**Read**

`planfact_list_accounts` · `planfact_list_account_groups` · `planfact_list_projects` · `planfact_list_project_groups` · `planfact_list_counterparties` · `planfact_list_companies` · `planfact_list_operation_categories` · `planfact_list_operations` · `planfact_list_unallocated` · `planfact_suggest_category` · `planfact_get_account_history` · `planfact_get_income_outcome_by_categories` · `planfact_get_income_outcome_by_projects` · `planfact_get_current_balances` · `planfact_find_data_gaps` · `planfact_prepare_monthly_review` · `planfact_prepare_next_month_plan`

**Write** (require `confirmed=true`)

`planfact_create_operation` · `planfact_update_operation` · `planfact_create_move_operation` · `planfact_create_counterparty` · `planfact_create_opu_accrual`

## Setup

```bash
git clone https://github.com/Anyanobadadvice/planfact-mcp.git
cd planfact-mcp
npm install
cp .env.example .env
npm run build
```

Then edit `.env`:

```bash
PLANFACT_API_KEY=your-real-token
PLANFACT_BASE_URL=https://api.planfact.io
PLANFACT_REQUIRE_CONFIRMATION_FOR_WRITES=true
```

Do not paste the API key into chat. It lives in `.env`, which is gitignored.

If PlanFact expects different routes in your account, override them:

```bash
PLANFACT_INCOME_OPERATION_PATH=/operations/income
PLANFACT_OUTCOME_OPERATION_PATH=/operations/outcome
PLANFACT_MOVE_OPERATION_PATH=/operations/move
PLANFACT_COUNTERPARTY_PATH=/contragents
PLANFACT_OPU_ACCRUAL_PATH=/operations/accrual
```

## Connect it

**Claude Code**

```bash
claude mcp add planfact -- node /path/to/planfact-mcp/dist/index.js
```

**Codex** (or any MCP host using JSON config)

```json
{
  "mcpServers": {
    "planfact": {
      "command": "node",
      "args": ["/path/to/planfact-mcp/dist/index.js"],
      "env": {
        "PLANFACT_API_KEY": "your-real-token"
      }
    }
  }
}
```

One local server, multiple clients can point at it.

## How I actually use it

The point is to treat it as a finance assistant, not an API wrapper.

```text
Show current balances, grouped by currency and company. Flag anything that looks stale.
```

```text
Check this month's operations and find missing categories, projects, counterparties or unconfirmed records.
```

```text
Prepare an expense: 120 GEL, Canva, today, from account <account-id>, category software. Do not create it until I confirm.
```

```text
Prepare a monthly review for last month: cashflow, largest operations, categories, projects, data gaps. Then explain what happened in plain language.
```

```text
Prepare a next-month plan based on this month: what to control, what to collect, where we can improve, what to decide.
```

Write tools stop and wait. You read the summary, then you confirm.

## License

MIT — see [LICENSE](LICENSE).

## About

Built by Anna Sideleva, **No Bad Advice**. I do AI automation and integrations: n8n workflows, bots, CRM and payment plumbing, custom MCP servers like this one.

[nobadadvice.com](https://nobadadvice.com)

## Safe update and category suggestions

`planfact_update_operation` with `confirmed=true` first reads the current operation with `GET /operations/{operationId}` (verified against the live PlanFact API; the typed `/operations/income|outcome/{id}` paths do not support GET), merges only the fields you passed into that object and sends the whole object with `PUT` to `PLANFACT_INCOME_OPERATION_PATH` or `PLANFACT_OUTCOME_OPERATION_PATH` (by `operationType` or the fetched operation type), so fields you did not touch (for example `comment`) are never wiped. If GET returns no data the tool errors with "not found" and writes nothing. The response carries `before`/`after` for the fields that actually changed. `planfact_list_unallocated` and `planfact_suggest_category` are read-only; in their text output comments and counterparty names (including account and category titles, and the delimiter and line breaks are neutralised) are wrapped in `<untrusted_data>...</untrusted_data>` (structured JSON stays raw), so downstream agents treat them as data, not instructions. Run tests with `npm test`.
