import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { markdownTable, toolError, toolSuccess } from "../formatters.js";
import { dateStringSchema, responseFormatSchema } from "../schemas/common.js";
import type { PlanFactClient } from "../services/planfactClient.js";
import { loadCategoryTitles, loadProjectTitles, summarizeHistory, type HistorySummary } from "../services/history.js";

const periodAnalysisSchema = z
  .object({
    periodStartDate: dateStringSchema,
    periodEndDate: dateStringSchema,
    userCurrencyCode: z.string().length(3).optional().describe("Currency code such as GEL, USD, EUR."),
    isCalculation: z.boolean().default(false).describe("Use accrual date instead of payment date."),
    ignoreMove: z.boolean().default(true).describe("Ignore internal transfers."),
    response_format: responseFormatSchema,
  })
  .strict();

export function registerAnalysisTools(server: McpServer, client: PlanFactClient): void {
  server.registerTool(
    "planfact_get_account_history",
    {
      title: "Get PlanFact Account History",
      description: "Get account balance movement history. Useful for computing current balances and cash runway.",
      inputSchema: z
        .object({
          response_format: responseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const data = await client.request<unknown>("/bizinfos/accountshistory");
        return toolSuccess({ raw: data }, JSON.stringify(data, null, 2), params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "planfact_get_income_outcome_by_categories",
    {
      title: "Get Income Outcome By Categories",
      description:
        "Доходы и расходы по статьям за период, свёрнуто по статье (без построчных деталей). isCalculation: true — по дате начисления (ОПИУ), false — по дате оплаты (ДДС). Поле opu — итоги только по статьям класса Income/Outcome, без движения активов, кредитов и дивидендов. Названия обёрнуты в <untrusted_data>.",
      inputSchema: periodAnalysisSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const [data, titles] = await Promise.all([
          client.request<unknown>("/bizinfos/incomeoutcomehistorybyoperationcategories", { query: periodQuery(params) }),
          loadCategoryTitles(client),
        ]);
        const summary = summarizeHistory(data, "operationCategoryId", titles);
        const output = historyOutput(params, summary, "статьям");
        return toolSuccess(output, historyText(output), params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "planfact_get_income_outcome_by_projects",
    {
      title: "Get Income Outcome By Projects",
      description: "Доходы и расходы по проектам за период, свёрнуто по проекту. isCalculation: true — по начислению, false — по оплате. Названия обёрнуты в <untrusted_data>.",
      inputSchema: periodAnalysisSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const [data, titles] = await Promise.all([
          client.request<unknown>("/bizinfos/incomeoutcomehistorybyprojects", { query: periodQuery(params) }),
          loadProjectTitles(client),
        ]);
        const summary = summarizeHistory(data, "projectId", titles);
        const output = historyOutput(params, summary, "проектам");
        return toolSuccess(output, historyText(output), params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

type HistoryOutput = {
  period: { start: string; end: string };
  basis: "accrual" | "cash";
  groupedBy: string;
  rows: HistorySummary["rows"];
  totals: HistorySummary["totals"];
  opu: HistorySummary["opu"];
  entries: number;
};

function historyOutput(params: Record<string, unknown>, summary: HistorySummary, groupedBy: string): HistoryOutput {
  return {
    period: { start: String(params.periodStartDate), end: String(params.periodEndDate) },
    basis: params.isCalculation ? "accrual" : "cash",
    groupedBy,
    rows: summary.rows,
    totals: summary.totals,
    opu: summary.opu,
    entries: summary.entries,
  };
}

function historyText(out: HistoryOutput): string {
  const head = `${out.basis === "accrual" ? "ОПИУ (по начислению)" : "ДДС (по оплате)"} по ${out.groupedBy}, ${out.period.start} — ${out.period.end}`;
  if (out.rows.length === 0) return `${head}\n\nNo records found.`;
  const table = markdownTable(
    out.rows.map((r) => ({ title: r.title, type: r.type ?? "", income: r.income, outcome: r.outcome, net: r.net })),
    ["title", "type", "income", "outcome", "net"],
  );
  const opu = `Итого по статьям Income/Outcome: доход ${out.opu.income}, расход ${out.opu.outcome}, результат ${out.opu.net}`;
  const all = `Итого по всем строкам: доход ${out.totals.income}, расход ${out.totals.outcome}, результат ${out.totals.net}`;
  return [head, "", table, "", opu, all].join("\n");
}

function periodQuery(params: Record<string, unknown>): Record<string, unknown> {
  return {
    "filter.periodStartDate": params.periodStartDate,
    "filter.periodEndDate": params.periodEndDate,
    "filter.userCurrencyCode": params.userCurrencyCode,
    "filter.isCalculation": params.isCalculation,
    "filter.ignoreMove": params.ignoreMove,
  };
}
