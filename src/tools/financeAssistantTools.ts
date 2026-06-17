import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PLANFACT_DEFAULT_LIMIT } from "../constants.js";
import { markdownTable, toolError, toolSuccess } from "../formatters.js";
import { dateStringSchema, responseFormatSchema } from "../schemas/common.js";
import type { PlanFactClient } from "../services/planfactClient.js";

const currentBalancesSchema = z
  .object({
    activeOnly: z.boolean().default(true).describe("Show only active accounts."),
    includeZeroBalances: z.boolean().default(false).describe("Include accounts with zero balance."),
    asOfDate: dateStringSchema
      .optional()
      .describe("Calculate balances up to this date. Defaults to today."),
    includeRaw: z
      .boolean()
      .default(false)
      .describe("Include raw PlanFact API responses. Usually false because responses can be very large."),
    response_format: responseFormatSchema,
  })
  .strict();

const periodSchema = z
  .object({
    periodStartDate: dateStringSchema,
    periodEndDate: dateStringSchema,
    currency: z.string().length(3).optional().describe("Preferred reporting currency, for example GEL."),
    response_format: responseFormatSchema,
  })
  .strict();

const dataGapsSchema = periodSchema.extend({
  limit: z.number().int().min(1).max(1000).default(250),
  includeCommittedChecks: z.boolean().default(true),
});

export function registerFinanceAssistantTools(server: McpServer, client: PlanFactClient): void {
  server.registerTool(
    "planfact_get_current_balances",
    {
      title: "Get Current PlanFact Balances",
      description: `Build a practical current balance snapshot from PlanFact accounts and account history.

Use this as the first step for "how much money do we have now?" questions. The tool groups balances by currency and company when the API returns those fields.`,
      inputSchema: currentBalancesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const [accountsRaw, historyRaw] = await Promise.all([
          client.request<unknown>("/accounts", {
            query: { "paging.offset": 0, "paging.limit": 1000 },
          }),
          client.request<unknown>("/bizinfos/accountshistory").catch(() => null),
        ]);

        const accounts = extractItems(accountsRaw);
        const historyRows = extractItems(historyRaw);
        const historyByAccount = new Map<string, Record<string, unknown>>();

        for (const row of historyRows) {
          const accountId = firstValue(row, ["accountId", "id", "account.id"]);
          if (accountId !== undefined) historyByAccount.set(String(accountId), row);
        }

        const asOfDate = startOfDay(params.asOfDate ? new Date(params.asOfDate) : new Date());
        const balances = accounts
          .map((account) => normalizeAccountBalance(account, historyByAccount, asOfDate))
          .filter((account) => !params.activeOnly || account.active !== false)
          .filter((account) => params.includeZeroBalances || account.balance !== 0);

        const totalsByCurrency = groupTotals(balances, "currencyCode");
        const totalsByCompany = groupTotals(balances, "companyTitle");
        const output = {
          asOfDate: asOfDate.toISOString().slice(0, 10),
          count: balances.length,
          totalsByCurrency,
          totalsByCompany,
          balances,
          ...(params.includeRaw ? { raw: { accounts: accountsRaw, accountHistory: historyRaw } } : {}),
        };
        const text = [
          "Current PlanFact balances",
          "",
          markdownTable(balances, ["id", "title", "currencyCode", "balance", "active", "companyTitle", "groupTitle"]),
          "",
          "Totals by currency",
          markdownTable(totalsByCurrency, ["currencyCode", "balance"]),
        ].join("\n");

        return toolSuccess(output, text, params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "planfact_find_data_gaps",
    {
      title: "Find PlanFact Data Gaps",
      description: `Find operations that make financial analysis unreliable: missing category, project, counterparty, comment, amount/date, or uncommitted status.

Use this before monthly review or when the user says PlanFact may not be current.`,
      inputSchema: dataGapsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const operationsRaw = await client.request<unknown>("/operations", {
          query: {
            "paging.offset": 0,
            "paging.limit": params.limit,
            "filter.operationDateStart": params.periodStartDate,
            "filter.operationDateEnd": params.periodEndDate,
          },
        });
        const operations = extractItems(operationsRaw);
        const gaps = operations
          .map((operation) => ({
            operation,
            issues: operationIssues(operation, params.includeCommittedChecks),
          }))
          .filter((entry) => entry.issues.length > 0);

        const issueCounts = countIssues(gaps.flatMap((gap) => gap.issues));
        const rows = gaps.map((gap) => ({
          id: firstValue(gap.operation, ["id", "operationId"]),
          operationDate: firstValue(gap.operation, ["operationDate", "date"]),
          operationType: firstValue(gap.operation, ["operationType", "type"]),
          value: firstValue(gap.operation, ["value", "amount", "sum"]),
          comment: firstValue(gap.operation, ["comment", "description"]),
          issues: gap.issues.join(", "),
        }));
        const output = {
          checked_count: operations.length,
          gap_count: gaps.length,
          issueCounts,
          gaps,
          raw: operationsRaw,
        };
        const text = [
          `Checked ${operations.length} operations. Found ${gaps.length} operations with data gaps.`,
          "",
          markdownTable(rows, ["id", "operationDate", "operationType", "value", "comment", "issues"]),
        ].join("\n");

        return toolSuccess(output, text, params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "planfact_prepare_monthly_review",
    {
      title: "Prepare PlanFact Monthly Review",
      description: `Collect the data needed for a micro-business monthly financial review.

Returns operations, category/project analytics when available, totals by type, largest operations, and data quality gaps. The agent should turn this into a narrative review for the user.`,
      inputSchema: periodSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const [operationsRaw, byCategoriesRaw, byProjectsRaw, balancesRaw] = await Promise.all([
          client.request<unknown>("/operations", {
            query: {
              "paging.offset": 0,
              "paging.limit": PLANFACT_DEFAULT_LIMIT,
              "filter.operationDateStart": params.periodStartDate,
              "filter.operationDateEnd": params.periodEndDate,
            },
          }),
          client
            .request<unknown>("/bizinfos/incomeoutcomehistorybyoperationcategories", {
              query: assistantPeriodQuery(params),
            })
            .catch(() => null),
          client
            .request<unknown>("/bizinfos/incomeoutcomehistorybyprojects", {
              query: assistantPeriodQuery(params),
            })
            .catch(() => null),
          client.request<unknown>("/bizinfos/accountshistory").catch(() => null),
        ]);

        const operations = extractItems(operationsRaw);
        const totals = summarizeOperations(operations);
        const gaps = operations
          .map((operation) => ({ operation, issues: operationIssues(operation, true) }))
          .filter((entry) => entry.issues.length > 0);
        const largestOperations = [...operations]
          .sort((a, b) => numericValue(b) - numericValue(a))
          .slice(0, 10);

        const output = {
          period: {
            start: params.periodStartDate,
            end: params.periodEndDate,
            currency: params.currency,
          },
          totals,
          operation_count: operations.length,
          data_gap_count: gaps.length,
          issueCounts: countIssues(gaps.flatMap((gap) => gap.issues)),
          largestOperations,
          categoryAnalytics: byCategoriesRaw,
          projectAnalytics: byProjectsRaw,
          accountHistory: balancesRaw,
          rawOperations: operationsRaw,
        };
        const text = [
          `Monthly review data for ${params.periodStartDate} - ${params.periodEndDate}`,
          "",
          markdownTable([totals], ["income", "outcome", "net", "moves", "unknown"]),
          "",
          `Data gaps: ${gaps.length}`,
          "",
          "Largest operations",
          markdownTable(
            largestOperations as Array<Record<string, unknown>>,
            ["id", "operationDate", "operationType", "value", "comment"],
          ),
        ].join("\n");

        return toolSuccess(output, text, params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "planfact_prepare_next_month_plan",
    {
      title: "Prepare Next Month Financial Plan",
      description: `Collect PlanFact data needed to propose next month's financial actions.

The tool does not invent strategy by itself. It returns a decision packet: balances, current month review, data gaps, and suggested focus areas for the agent to discuss with the user.`,
      inputSchema: periodSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const [accountsRaw, operationsRaw, categoriesRaw, projectsRaw] = await Promise.all([
          client.request<unknown>("/accounts", {
            query: { "paging.offset": 0, "paging.limit": 1000, "filter.active": true },
          }),
          client.request<unknown>("/operations", {
            query: {
              "paging.offset": 0,
              "paging.limit": PLANFACT_DEFAULT_LIMIT,
              "filter.operationDateStart": params.periodStartDate,
              "filter.operationDateEnd": params.periodEndDate,
            },
          }),
          client
            .request<unknown>("/bizinfos/incomeoutcomehistorybyoperationcategories", {
              query: assistantPeriodQuery(params),
            })
            .catch(() => null),
          client
            .request<unknown>("/bizinfos/incomeoutcomehistorybyprojects", {
              query: assistantPeriodQuery(params),
            })
            .catch(() => null),
        ]);

        const accounts = extractItems(accountsRaw).map((account) =>
          normalizeAccountBalance(account, new Map(), startOfDay(new Date())),
        );
        const operations = extractItems(operationsRaw);
        const totals = summarizeOperations(operations);
        const gaps = operations
          .map((operation) => ({ operation, issues: operationIssues(operation, true) }))
          .filter((entry) => entry.issues.length > 0);
        const focusAreas = buildFocusAreas(totals, gaps.length, operations.length);
        const output = {
          period: {
            start: params.periodStartDate,
            end: params.periodEndDate,
            currency: params.currency,
          },
          totals,
          activeAccounts: accounts,
          categoryAnalytics: categoriesRaw,
          projectAnalytics: projectsRaw,
          data_gap_count: gaps.length,
          focusAreas,
        };
        const text = [
          "Next month planning packet",
          "",
          markdownTable([totals], ["income", "outcome", "net", "moves", "unknown"]),
          "",
          "Focus areas",
          ...focusAreas.map((area) => `- ${area}`),
        ].join("\n");

        return toolSuccess(output, text, params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

function assistantPeriodQuery(params: Record<string, unknown>): Record<string, unknown> {
  return {
    "filter.periodStartDate": params.periodStartDate,
    "filter.periodEndDate": params.periodEndDate,
    "filter.userCurrencyCode": params.currency,
    "filter.isCalculation": false,
    "filter.ignoreMove": true,
  };
}

function extractItems(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];

  if (Array.isArray(data.data)) return data.data.filter(isRecord);
  if (isRecord(data.data) && Array.isArray(data.data.items)) {
    return data.data.items.filter(isRecord);
  }

  for (const key of [
    "items",
    "data",
    "accounts",
    "history",
    "operations",
    "operationCategories",
    "projects",
    "rows",
  ]) {
    const value = data[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }

  return [];
}

function normalizeAccountBalance(
  account: Record<string, unknown>,
  historyByAccount: Map<string, Record<string, unknown>>,
  asOfDate: Date,
): Record<string, unknown> {
  const id = firstValue(account, ["id", "accountId"]);
  const history = id === undefined ? undefined : historyByAccount.get(String(id));
  const startingRemainder = toNumber(firstValue(account, ["startingRemainderValue", "remainder"]));
  const historyDelta = sumAccountHistory(history, asOfDate);
  const balance = startingRemainder + historyDelta;

  return {
    id,
    title: firstValue(account, ["title", "name"]),
    currencyCode: firstValue(account, ["currencyCode", "currency.code", "currency"]),
    balance: roundMoney(balance),
    startingRemainder: roundMoney(startingRemainder),
    historyDelta: roundMoney(historyDelta),
    active: firstValue(account, ["active", "isActive"]),
    companyTitle: firstValue(account, ["company.title", "companyTitle", "company.name"]),
    groupTitle: firstValue(account, ["group.title", "accountGroup.title", "groupTitle"]),
  };
}

function sumAccountHistory(history: Record<string, unknown> | undefined, asOfDate: Date): number {
  if (!history) return 0;

  const details = Array.isArray(history.details) ? history.details.filter(isRecord) : [];
  let total = 0;

  for (const detail of details) {
    const rawDate = firstValue(detail, ["date", "operationDate"]);
    if (!rawDate) continue;

    const detailDate = startOfDay(new Date(String(rawDate)));
    if (Number.isNaN(detailDate.getTime()) || detailDate > asOfDate) continue;

    total += toNumber(firstValue(detail, ["factValue", "value", "amount"]));
  }

  return total;
}

function summarizeOperations(operations: Array<Record<string, unknown>>): Record<string, number> {
  const totals = {
    income: 0,
    outcome: 0,
    net: 0,
    moves: 0,
    unknown: 0,
  };

  for (const operation of operations) {
    const type = String(firstValue(operation, ["operationType", "type"]) || "").toLowerCase();
    const value = numericValue(operation);

    if (type.includes("income")) totals.income += value;
    else if (type.includes("outcome")) totals.outcome += value;
    else if (type.includes("move")) totals.moves += value;
    else totals.unknown += value;
  }

  totals.net = totals.income - totals.outcome;
  return totals;
}

function operationIssues(operation: Record<string, unknown>, includeCommittedChecks: boolean): string[] {
  const issues: string[] = [];

  if (!hasValue(firstValue(operation, ["operationCategoryId", "operationCategory.id", "categoryId"]))) {
    issues.push("missing_category");
  }
  if (!hasValue(firstValue(operation, ["projectId", "project.id"]))) {
    issues.push("missing_project");
  }
  if (!hasValue(firstValue(operation, ["contrAgentId", "contrAgent.id", "counterpartyId"]))) {
    issues.push("missing_counterparty");
  }
  if (!hasValue(firstValue(operation, ["comment", "description"]))) {
    issues.push("missing_comment");
  }
  if (!hasValue(firstValue(operation, ["operationDate", "date"]))) {
    issues.push("missing_date");
  }
  if (numericValue(operation) <= 0) {
    issues.push("missing_or_zero_amount");
  }
  if (includeCommittedChecks && firstValue(operation, ["isCommitted"]) === false) {
    issues.push("not_committed");
  }

  return issues;
}

function countIssues(issues: string[]): Record<string, number> {
  return issues.reduce<Record<string, number>>((acc, issue) => {
    acc[issue] = (acc[issue] || 0) + 1;
    return acc;
  }, {});
}

function groupTotals(rows: Array<Record<string, unknown>>, key: string): Array<Record<string, unknown>> {
  const totals = new Map<string, number>();

  for (const row of rows) {
    const group = String(row[key] || "unknown");
    totals.set(group, (totals.get(group) || 0) + toNumber(row.balance));
  }

  return [...totals.entries()].map(([group, balance]) => ({ [key]: group, balance }));
}

function buildFocusAreas(
  totals: Record<string, number>,
  gapCount: number,
  operationCount: number,
): string[] {
  const focusAreas: string[] = [];

  if (gapCount > 0) {
    focusAreas.push(`Clean up ${gapCount} incomplete operations before trusting the month review.`);
  }
  if (totals.net < 0) {
    focusAreas.push("Net cashflow is negative: review large expenses and required revenue for next month.");
  } else if (totals.net > 0) {
    focusAreas.push("Net cashflow is positive: decide what portion should go to reserves, taxes, or growth.");
  }
  if (operationCount < 5) {
    focusAreas.push("Very few operations found: confirm PlanFact is current before making decisions.");
  }
  if (totals.outcome > 0) {
    focusAreas.push("Review top expense categories and choose one cost-control action.");
  }
  if (totals.income > 0) {
    focusAreas.push("Review top revenue sources and decide which clients/projects to prioritize.");
  }

  return focusAreas;
}

function numericValue(operation: Record<string, unknown>): number {
  return toNumber(firstValue(operation, ["value", "amount", "sum", "total"]));
}

function firstValue(
  record: Record<string, unknown> | undefined,
  paths: string[],
): unknown {
  if (!record) return undefined;

  for (const path of paths) {
    const value = getPath(record, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }

  return undefined;
}

function getPath(record: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) return undefined;
    return current[part];
  }, record);
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
