import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { markdownTable, toolError, toolSuccess, untrusted } from "../formatters.js";
import { responseFormatSchema } from "../schemas/common.js";
import type { PlanFactClient } from "../services/planfactClient.js";
import { applyDefer, backupOf, cdekUnaccrued, deferPlan, fitBudget, preflight, receivables, revenueCheck, RESPONSE_BUDGET } from "../services/close.js";

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

  server.registerTool(
    "planfact_defer_revenue",
    {
      title: "Defer revenue accrual to next month",
      description:
        "Перенос начисления выручки на конец следующего месяца (4.1). target = выручка ПФ − выручка МС; отбираются одночастные операции с конца месяца + добивка минимальной. confirmed:false — только предпросмотр плана (pickIds, бэкап [operationId, исходная calculationDate]), ничего не пишет. confirmed:true — PUT по каждой операции (calculationDate = конец следующего месяца, isCalculationCommitted=false) и перепроверка выручки; передайте expectedOperationIds = pickIds из предпросмотра: если план изменился, запись отклоняется (refused:'plan_changed'). Ответ содержит written (id записанных). Запись только после явного подтверждения пользователя. Названия обёрнуты в <untrusted_data>.",
      inputSchema: z
        .object({
          month: monthSchema,
          msRevenue: z.number().nonnegative().describe("Выручка МС за месяц, руб."),
          confirmed: z.boolean().describe("true — записать перенос (только после явного подтверждения пользователя); false — только предпросмотр."),
          expectedOperationIds: z.array(z.number()).optional().describe("pickIds из предпросмотра; при confirmed:true план сверяется с ними."),
          response_format: responseFormatSchema,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (p) => {
      try {
        const confirmed = p.confirmed === true;
        const closed = process.env.PLANFACT_CLOSED_THROUGH?.trim();
        if (confirmed && closed && /^\d{4}-\d{2}$/.test(closed) && p.month <= closed) {
          return toolSuccess({ refused: "month_closed", month: p.month, closedThrough: closed }, `Месяц ${p.month} закрыт (по ${closed}) — запись отклонена. Предпросмотр доступен.`, p.response_format);
        }
        const plan = await deferPlan(client, p.month, p.msRevenue);
        const { raw, pick, ...rest } = plan;
        const pickIds = pick.map((x) => x.operationId).filter((x): x is number => x !== undefined);
        const out: Record<string, any> = { ...rest, pick: pick.slice(0, 10), pickIds, confirmed };
        const head = `ПФ доход ${plan.pfRevenue} − МС отгрузки ${plan.msRevenue} = ${plan.target} ₽`;
        if (!plan.needDefer) {
          out.ok = 0;
          out.failed = [];
          out.written = [];
          return toolSuccess(out, `${head}. Записывать нечего: перенос не нужен.`, p.response_format);
        }
        if (plan.picked === 0) {
          out.noCandidates = true;
          out.ok = 0;
          out.failed = [];
          out.written = [];
          return toolSuccess(out, `${head}: нет подходящих одночастных операций, остаток ${plan.target} ₽ разнести вручную.`, p.response_format);
        }
        const summary = `${head}. Отобрано ${plan.picked} операций на ${plan.pickedSum} ₽ (перебор ${plan.overshoot}${plan.shortfall > 0 ? `, не хватает ${plan.shortfall}` : ""}). Многочастных пропущено: ${plan.multiSkipped.count} на ${plan.multiSkipped.sum} ₽.`;
        const backupLog = () => console.error(JSON.stringify({ tool: "planfact_defer_revenue", stage: confirmed ? "write" : "preview", month: p.month, backup: backupOf(raw) }));
        if (!confirmed) {
          out.backup = backupOf(raw);
          if (JSON.stringify(out, null, 2).length + JSON.stringify(out).length > RESPONSE_BUDGET) {
            out.backup = backupOf(raw, true);
            out.backupTrimmed = true;
          }
          fitBudget(out, ["pick"]);
          backupLog();
          return toolSuccess(out, `${summary}\nПредпросмотр: ничего не записано. Подтвердите, чтобы перенести начисление на ${plan.nextMonthEnd}.`, p.response_format);
        }
        if (p.expectedOperationIds) {
          const exp = new Set(p.expectedOperationIds);
          const act = new Set(pickIds);
          if (exp.size !== act.size || [...act].some((i) => !exp.has(i))) {
            const refused = { refused: "plan_changed", expected: [...exp], actual: pickIds };
            return toolSuccess(refused, `План изменился с момента предпросмотра (ожидалось ${exp.size} операций, сейчас ${act.size}) — ничего не записано. Запустите предпросмотр заново и подтвердите новый план.`, p.response_format);
          }
        }
        backupLog();
        const res = await applyDefer(client, plan);
        out.ok = res.ok;
        out.written = res.written;
        out.failed = res.failed.slice(0, 20).map((f) => ({ id: f.id, err: untrusted(f.err.slice(0, 200)) }));
        out.failedCount = res.failed.length;
        out.after = res.after;
        fitBudget(out, ["pick", "failed"]);
        const text = `${summary}\nПеренесено ${res.ok} из ${plan.picked}${res.failed.length ? `, ошибок ${res.failed.length}` : ""}. Выручка после переноса: ПФ ${res.after.pfRevenue}, МС ${res.after.msRevenue}, Δ ${res.after.delta} ₽.`;
        return toolSuccess(out, text, p.response_format);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
