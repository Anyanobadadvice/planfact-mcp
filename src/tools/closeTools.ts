import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { markdownTable, toolError, toolSuccess } from "../formatters.js";
import { responseFormatSchema } from "../schemas/common.js";
import type { PlanFactClient } from "../services/planfactClient.js";
import { cdekUnaccrued, fitBudget, preflight, receivables, revenueCheck } from "../services/close.js";

const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM, for example 2026-10.")
  .describe("Закрываемый месяц, YYYY-MM.");

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerCloseTools(server: McpServer, client: PlanFactClient): void {
  server.registerTool(
    "planfact_revenue_check",
    {
      title: "Revenue check for month close",
      description:
        "Сверка выручки ПФ (статьи 2945160 + 10087234 по начислению) с выручкой МойСклад. target = ПФ − МС; needDefer = target > 0 (нужно перенести начисление на будущее). Только чтение.",
      inputSchema: z.object({ month: monthSchema, msRevenue: z.number().describe("Выручка МС за месяц, руб."), response_format: responseFormatSchema }).strict(),
      annotations: readOnly,
    },
    async (p) => {
      try {
        const r = await revenueCheck(client, p.month, p.msRevenue);
        const text = `Выручка ${r.month}: ПФ ${r.pfRevenue}, МС ${r.msRevenue}, разница ${r.target}. ${r.needDefer ? "Нужен перенос начисления." : "Переносить нечего."}`;
        return toolSuccess(r, text, p.response_format);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "planfact_receivables",
    {
      title: "Receivables for month close",
      description:
        "Дебиторка месяца (3.2): оплаченные операции, у которых часть не начислена (operationParts[].isCalculationCommitted=false). Сгруппировано по контрагенту, до 20 строк. Названия обёрнуты в <untrusted_data>. Только чтение.",
      inputSchema: z.object({ month: monthSchema, response_format: responseFormatSchema }).strict(),
      annotations: readOnly,
    },
    async (p) => {
      try {
        const r = fitBudget(await receivables(client, p.month), ["items", "byContrAgent"]);
        const text = [
          `Дебиторка ${r.month}: ${r.count} операций на ${r.total}${r.truncated ? " (список обрезан)" : ""}`,
          "",
          markdownTable(r.byContrAgent as unknown as Array<Record<string, unknown>>, ["contrAgent", "count", "total"]),
        ].join("\n");
        return toolSuccess(r, text, p.response_format);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "planfact_cdek_unaccrued",
    {
      title: "СДЭК payments without accrual",
      description:
        "Платежи контрагента «СДЭК» (outcome) в месяце без начисления в этом месяце (3.7): часть не начислена или calculationDate вне месяца. До 20 строк. Только чтение.",
      inputSchema: z.object({ month: monthSchema, response_format: responseFormatSchema }).strict(),
      annotations: readOnly,
    },
    async (p) => {
      try {
        const r = fitBudget(await cdekUnaccrued(client, p.month), ["items"]);
        const text = [
          `СДЭК без начисления ${r.month}: ${r.count} платежей на ${r.total}${r.truncated ? " (список обрезан)" : ""}`,
          "",
          markdownTable(r.items as unknown as Array<Record<string, unknown>>, ["operationId", "operationDate", "value", "calculationDate"]),
        ].join("\n");
        return toolSuccess(r, text, p.response_format);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "planfact_close_preflight",
    {
      title: "Pre-flight for month close",
      description:
        "Предполётная проверка закрытия месяца: число нераспределённых операций, начисленная ЗП по статьям персонала (0 = не начислена), закрыт ли предыдущий месяц (env PLANFACT_CLOSED_THROUGH; null если не задан). Только чтение.",
      inputSchema: z.object({ month: monthSchema, response_format: responseFormatSchema }).strict(),
      annotations: readOnly,
    },
    async (p) => {
      try {
        const r = await preflight(client, p.month);
        const pr = r.payroll;
        const text = [
          `Pre-flight ${r.month}: нераспределённых ${r.unallocated}; предыдущий месяц закрыт: ${r.prevMonthClosed === null ? "неизвестно" : r.prevMonthClosed ? "да" : "нет"}`,
          `ЗП: производство ${pr.production}, коммерция ${pr.commercial}, админ ${pr.admin}, директор ${pr.director}, налог по ЗП ${pr.payrollTax}`,
        ].join("\n");
        return toolSuccess(r, text, p.response_format);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
