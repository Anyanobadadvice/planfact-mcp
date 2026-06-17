import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { markdownTable, toolError, toolSuccess } from "../formatters.js";
import { dateStringSchema, responseFormatSchema } from "../schemas/common.js";
import type { PlanFactClient } from "../services/planfactClient.js";

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
      description: "Get income/outcome history grouped by operation categories for a period. Useful for monthly expense analysis.",
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
        const data = await client.request<unknown>("/bizinfos/incomeoutcomehistorybyoperationcategories", {
          query: periodQuery(params),
        });
        const rows = extractRows(data);
        const text = rows.length
          ? markdownTable(rows as Array<Record<string, unknown>>, ["title", "income", "outcome", "value"])
          : JSON.stringify(data, null, 2);
        return toolSuccess({ rows, raw: data }, text, params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "planfact_get_income_outcome_by_projects",
    {
      title: "Get Income Outcome By Projects",
      description: "Get income/outcome history grouped by projects for a period. Useful for deciding which work is profitable.",
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
        const data = await client.request<unknown>("/bizinfos/incomeoutcomehistorybyprojects", {
          query: periodQuery(params),
        });
        const rows = extractRows(data);
        const text = rows.length
          ? markdownTable(rows as Array<Record<string, unknown>>, ["title", "income", "outcome", "value"])
          : JSON.stringify(data, null, 2);
        return toolSuccess({ rows, raw: data }, text, params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );
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

function extractRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  const record = data as Record<string, unknown>;
  for (const key of ["items", "data", "history", "rows", "categories", "projects"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }

  return [];
}
