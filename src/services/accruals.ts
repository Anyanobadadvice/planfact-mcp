import { z } from "zod";
import type { PlanFactClient } from "./planfactClient.js";
import { bizinfosByCategory, fetchMonthOperations, monthBounds, round2 } from "./close.js";

const flow = z.object({ outcome: z.number(), start: z.number(), end: z.number() }).passthrough();
export const turnoverSchema = z
  .object({
    month: z.string().optional().describe("Месяц оборотов (как вернул moysklad_folder_turnover); если передан, должен совпадать с month."),
    materials: flow,
    packaging: flow,
    writeoff: flow,
    finishedGoods: flow,
  })
  .passthrough()
  .describe("Структурированный результат moysklad_folder_turnover({folder:'all'}) как есть: month и materials/packaging/writeoff/finishedGoods, у каждого outcome/start/end (руб.).");
export type Turnover = z.infer<typeof turnoverSchema>;

export type AccrualJob = { code: string; title: string; debit: number; credit: number | null; value: number; duplicate: boolean; note?: string };
export type AccrualPlan = { month: string; date: string; payDate: string; jobs: AccrualJob[]; taxBase: number };
export type AccrualResult = { code: string; ok: boolean; err?: string };

export const TAX_CATEGORY = 2945176;
export const TAX_ACCOUNT = 948011;
export const TAX_BASE_ACCOUNTS = [948011, 948030, 205773];
export const TAX_RATE = 0.017;
export const COMPANY_ID = 65706;
export const ENP_WARNING = "Если бухгалтер уже оплатил/разнёс квартальный платёж (ЕНП) по месяцам — налог не начислять: спросите Марию и при подтверждении передайте skip: ['4.9']";

const nextMonth = (ym: string): string => {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** Дебет 4.8 при списании с/с ГП (остаток ГП уменьшился). */
export const GP_WRITEOFF_DEBIT = 9829025;

/**
 * Сумма проводки со знаком направления: для 4.8 капитализация ГП (дебет 2947599) — плюс,
 * списание с/с ГП (дебет 9829025) — минус; остальные коды — как есть.
 */
export function signedValue(j: AccrualJob): number {
  return j.code === "4.8" && j.debit === GP_WRITEOFF_DEBIT ? -j.value : j.value;
}

/** values для предпросмотра и сверки: только записываемые проводки (без дублей, нулей, пропущенных), 4.8 — со знаком. */
export function planValues(plan: AccrualPlan): Record<string, number> {
  return Object.fromEntries(plan.jobs.filter((j) => !j.duplicate && j.value >= 0.01).map((j) => [j.code, signedValue(j)]));
}

/** План начислений 4.5–4.9 (порт month-accruals.mjs); `skip` — коды, которые не включать. */
export async function accrualPlan(client: PlanFactClient, ym: string, turnover: Turnover, skip: string[] = []): Promise<AccrualPlan> {
  const date = monthBounds(ym).end;
  const payDate = monthBounds(nextMonth(ym)).end;
  const have = await bizinfosByCategory(client, ym);
  const haveOf = (id: number): number => {
    const s = have.get(id);
    return s ? s.income + s.outcome : 0;
  };
  const gpDelta = turnover.finishedGoods.end - turnover.finishedGoods.start;
  const defs: Array<Omit<AccrualJob, "duplicate" | "note">> = [
    { code: "4.5", title: "Материалы", debit: 2946017, credit: 2946683, value: round2(turnover.materials.outcome) },
    { code: "4.6", title: "Упаковка", debit: 2946077, credit: 2962213, value: round2(turnover.packaging.outcome) },
    { code: "4.7", title: "Списание", debit: 2950844, credit: 2946683, value: round2(turnover.writeoff.outcome) },
    gpDelta >= 0
      ? { code: "4.8", title: "Капитализация ГП", debit: 2947599, credit: 2946683, value: round2(gpDelta) }
      : { code: "4.8", title: "Списание с/с ГП", debit: GP_WRITEOFF_DEBIT, credit: 2947599, value: round2(-gpDelta) },
  ];

  const income = await fetchMonthOperations(client, ym, "Income");
  let base = 0;
  for (const o of income) {
    if (TAX_BASE_ACCOUNTS.includes(Number(o.account?.accountId))) base += Number(o.value) || 0;
  }
  const taxBase = round2(base);
  defs.push({ code: "4.9", title: "Налог на прибыль 1.7%", debit: TAX_CATEGORY, credit: null, value: round2(base * TAX_RATE) });

  const jobs: AccrualJob[] = defs
    .filter((d) => !skip.includes(d.code))
    .map((d) => {
      const job: AccrualJob = { ...d, duplicate: Math.abs(haveOf(d.debit)) > 0.5 };
      if (d.value < 0.01) job.note = "сумма 0, пропуск";
      return job;
    });
  return { month: ym, date, payDate, jobs, taxBase };
}

/** Запись начислений: дубли и нули пропускаются; сбой одной проводки не останавливает остальные. */
export async function applyAccruals(client: PlanFactClient, plan: AccrualPlan): Promise<{ results: AccrualResult[]; after?: Record<string, number>; afterError?: string }> {
  const results: AccrualResult[] = [];
  for (const j of plan.jobs) {
    if (j.duplicate || j.value < 0.01) continue;
    try {
      if (j.code === "4.9") {
        await client.request("/operations/outcome", {
          method: "POST",
          body: {
            operationDate: plan.payDate,
            calculationDate: plan.date,
            isCommitted: false,
            isCalculationCommitted: true,
            accountId: TAX_ACCOUNT,
            value: j.value,
            operationCategoryId: TAX_CATEGORY,
            comment: `Налог на прибыль 1.7% от поступлений ${plan.month} (база ${Math.round(plan.taxBase)})`,
            items: [{ calculationDate: plan.date, isCalculationCommitted: true, value: j.value, operationCategoryId: TAX_CATEGORY }],
          },
        });
      } else {
        await client.request("/operations/accrual", {
          method: "POST",
          body: {
            outcomeOperationCategoryId: j.debit,
            incomeOperationCategoryId: j.credit,
            value: j.value,
            calculationDate: plan.date,
            accrualRecognitionDate: plan.date,
            isCalculationCommitted: true,
            isOpuCalculation: true,
            companyId: COMPANY_ID,
            currencyCode: "RUB",
          },
        });
      }
      results.push({ code: j.code, ok: true });
    } catch (e) {
      results.push({ code: j.code, ok: false, err: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  }
  try {
    const sums = await bizinfosByCategory(client, plan.month);
    const gp = plan.jobs.find((j) => j.code === "4.8")?.debit ?? 2947599;
    const after: Record<string, number> = {};
    for (const id of [2946017, 2946077, 2950844, gp, TAX_CATEGORY]) {
      const s = sums.get(id);
      after[String(id)] = round2(s ? s.income + s.outcome : 0);
    }
    return { results, after };
  } catch (e) {
    return { results, afterError: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}
