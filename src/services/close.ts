import type { PlanFactClient } from "./planfactClient.js";
import { extractItems, isUnallocatedOperation, listAllOperations, loadUnallocatedCategoryIds, opId, opParts, type Rec } from "./operations.js";
import { loadCategoryTitles } from "./history.js";
import { untrusted } from "../formatters.js";

/** Статьи выручки ПФ: «Производство и продажа» + «Продажа товаров». */
export const REVENUE_CATEGORY_IDS = [2945160, 10087234] as const;
export const LIST_CAP = 20;
export const GROUP_CAP = 15;
export const TITLE_CAP = 80;
export const RESPONSE_BUDGET = 7500;
export const OPS_PAGE_LIMIT = 500;

export const round2 = (x: number): number => Math.round(x * 100) / 100;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export type MonthBounds = { start: string; end: string; prev: string };

/** `YYYY-MM` → первый/последний день месяца и предыдущий месяц (`YYYY-MM`). */
export function monthBounds(ym: string): MonthBounds {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`Invalid month "${ym}", expected YYYY-MM.`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const prev = mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`;
  return { start: `${y}-${pad(mo)}-01`, end: `${y}-${pad(mo)}-${pad(last)}`, prev };
}

/** Предыдущий календарный месяц по UTC (значение по умолчанию для вызывающих). */
export function defaultMonth(now = new Date()): string {
  const cur = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return monthBounds(cur).prev;
}

export type CategorySums = Map<number, { income: number; outcome: number; net: number }>;

/** Отчёт bizinfos по статьям за месяц (по начислению, без движений): суммы fact по статье. */
export async function bizinfosByCategory(client: PlanFactClient, ym: string): Promise<CategorySums> {
  const { start, end } = monthBounds(ym);
  const data = await client.request<unknown>("/bizinfos/incomeoutcomehistorybyoperationcategories", {
    query: {
      "filter.periodStartDate": start,
      "filter.periodEndDate": end,
      "filter.isCalculation": true,
      "filter.ignoreMove": true,
    },
  });
  const sums: CategorySums = new Map();
  for (const g of extractItems(data)) {
    const id = Number(g.operationCategoryId ?? g.id ?? 0);
    const cur = sums.get(id) ?? { income: 0, outcome: 0, net: 0 };
    for (const d of Array.isArray(g.details) ? g.details : []) {
      const fact = num(d?.factValueInUserCurrency ?? d?.factValue);
      if (d?.operationTypeId === 1) cur.income += fact;
      else if (d?.operationTypeId === 2) cur.outcome += fact;
    }
    sums.set(id, cur);
  }
  for (const v of sums.values()) v.net = round2(v.income - v.outcome);
  return sums;
}

/** Выручка ПФ за месяц: статьи 2945160 + 10087234 по дате начисления. */
export async function revenueAccrued(client: PlanFactClient, ym: string): Promise<number> {
  const sums = await bizinfosByCategory(client, ym);
  let total = 0;
  for (const id of REVENUE_CATEGORY_IDS) {
    const s = sums.get(id);
    if (s) total += s.income + s.outcome;
  }
  return round2(total);
}

export type RevenueCheck = { month: string; pfRevenue: number; msRevenue: number; target: number; needDefer: boolean };

export async function revenueCheck(client: PlanFactClient, ym: string, msRevenue: number): Promise<RevenueCheck> {
  const pfRevenue = await revenueAccrued(client, ym);
  const target = round2(pfRevenue - msRevenue);
  return { month: ym, pfRevenue, msRevenue: round2(msRevenue), target, needDefer: target > 0 };
}

/** Все операции месяца (по дате операции), страницами по 500; бросает, если пагинация не двигается. */
export async function fetchMonthOperations(client: PlanFactClient, ym: string, operationType?: "Income" | "Outcome"): Promise<Rec[]> {
  const { start, end } = monthBounds(ym);
  return listAllOperations(
    client,
    {
      "filter.operationDateStart": start,
      "filter.operationDateEnd": end,
      ...(operationType ? { "filter.operationType": operationType } : {}),
    },
    { limit: OPS_PAGE_LIMIT, maxPages: 40 },
  );
}

const day = (v: unknown): string => (typeof v === "string" ? v.slice(0, 10) : "");
const clip = (t: string): string => (t.length > TITLE_CAP ? `${t.slice(0, TITLE_CAP)}…` : t);
const agentTitle = (a: unknown): string => (a && typeof a === "object" && typeof (a as Rec).title === "string" ? clip((a as Rec).title as string) : "");

/**
 * Держит ответ в бюджете: меряет pretty-JSON (текст) + compact (structuredContent) и, пока не влезает,
 * убирает хвост самого длинного списка из `lists`, выставляя `truncated` (для byContrAgent — `groupsTruncated`).
 */
export function fitBudget<T extends Record<string, any>>(out: T, lists: string[], budget = RESPONSE_BUDGET): T {
  const size = () => JSON.stringify(out, null, 2).length + JSON.stringify(out).length;
  while (size() > budget) {
    let best: string | null = null;
    for (const k of lists) if (Array.isArray(out[k]) && out[k].length > 0 && (best === null || out[k].length > out[best].length)) best = k;
    if (best === null) break;
    out[best].pop();
    if (best === "byContrAgent") (out as any).groupsTruncated = true;
    else (out as any).truncated = true;
  }
  return out;
}

export type ReceivableItem = { operationId: number | undefined; operationDate: string; value: number; contrAgent: string | null };
export type ReceivablesResult = {
  month: string;
  count: number;
  total: number;
  byContrAgent: Array<{ contrAgent: string; count: number; total: number }>;
  /** Хвост групп свёрнут в «прочие» (sum сохранена) или отрезан бюджетом ответа. */
  groupsTruncated: boolean;
  items: ReceivableItem[];
  truncated: boolean;
};

/**
 * Дебиторка (3.2): операция оплачена (`isCommitted`), а часть не начислена
 * (`operationParts[].isCalculationCommitted === false`). Флаг операции не смотрим.
 */
export async function receivables(client: PlanFactClient, ym: string): Promise<ReceivablesResult> {
  const ops = await fetchMonthOperations(client, ym);
  const items: ReceivableItem[] = [];
  const groups = new Map<string, { count: number; total: number }>();
  let total = 0;
  for (const o of ops) {
    if (o.isCommitted !== true) continue;
    const bad = opParts(o).filter((p) => p.isCalculationCommitted === false);
    if (bad.length === 0) continue;
    const value = round2(bad.reduce((s, p) => s + num(p.value), 0));
    const title = agentTitle(o.contrAgent) || agentTitle(bad[0].contrAgent);
    items.push({ operationId: opId(o), operationDate: day(o.operationDate), value, contrAgent: title ? untrusted(title) : null });
    total += value;
    const key = title ? untrusted(title) : "—";
    const g = groups.get(key) ?? { count: 0, total: 0 };
    g.count++;
    g.total = round2(g.total + value);
    groups.set(key, g);
  }
  const sorted = [...groups.entries()].map(([contrAgent, g]) => ({ contrAgent, ...g })).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const byContrAgent = sorted.slice(0, GROUP_CAP);
  const tail = sorted.slice(GROUP_CAP);
  const groupsTruncated = tail.length > 0;
  if (groupsTruncated) {
    byContrAgent.push({ contrAgent: "прочие", count: tail.reduce((a, g) => a + g.count, 0), total: round2(tail.reduce((a, g) => a + g.total, 0)) });
  }
  return { month: ym, count: items.length, total: round2(total), byContrAgent, groupsTruncated, items: items.slice(0, LIST_CAP), truncated: items.length > LIST_CAP };
}

export type CdekItem = { operationId: number | undefined; operationDate: string; value: number; calculationDate: string | null };
export type CdekResult = { month: string; count: number; total: number; items: CdekItem[]; truncated: boolean };

const CDEK_RE = /сдэк|cdek/i;

/** Платежи СДЭК (outcome) в месяце, у которых нет ни одной части, начисленной в этом месяце (3.7). */
export async function cdekUnaccrued(client: PlanFactClient, ym: string): Promise<CdekResult> {
  const { start, end } = monthBounds(ym);
  const ops = await fetchMonthOperations(client, ym, "Outcome");
  const items: CdekItem[] = [];
  let total = 0;
  for (const o of ops) {
    const parts = opParts(o);
    if (parts.length === 0) continue;
    const isCdek = CDEK_RE.test(agentTitle(o.contrAgent)) || parts.some((p) => CDEK_RE.test(agentTitle(p.contrAgent)));
    if (!isCdek) continue;
    const accruedInMonth = parts.some((p) => {
      const d = day(p.calculationDate);
      return p.isCalculationCommitted !== false && d >= start && d <= end;
    });
    if (accruedInMonth) continue;
    const value = round2(num(o.value));
    items.push({ operationId: opId(o), operationDate: day(o.operationDate), value, calculationDate: day(parts[0].calculationDate) || null });
    total += value;
  }
  return { month: ym, count: items.length, total: round2(total), items: items.slice(0, LIST_CAP), truncated: items.length > LIST_CAP };
}

export function normTitle(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

export type Payroll = { production: number; commercial: number; admin: number; director: number; payrollTax: number };
export type PreflightResult = { month: string; unallocated: number; payroll: Payroll; prevMonthClosed: boolean | null };

function payrollKey(title: string): keyof Payroll | null {
  const t = normTitle(title);
  if (t === "производственный персонал") return "production";
  if (t === "коммерческий персонал") return "commercial";
  if (t === "административный персонал") return "admin";
  if (/налог по зп/.test(t)) return "payrollTax";
  if (t.includes("директора")) return "director";
  return null;
}

/** `PLANFACT_CLOSED_THROUGH` (YYYY-MM) >= предыдущий месяц; env нет/пуст → null. */
export function prevMonthClosed(ym: string, closedThrough = process.env.PLANFACT_CLOSED_THROUGH): boolean | null {
  const v = closedThrough?.trim();
  if (!v || !/^\d{4}-\d{2}$/.test(v)) return null;
  return v >= monthBounds(ym).prev;
}

export async function preflight(client: PlanFactClient, ym: string): Promise<PreflightResult> {
  const [sums, titles, unallocIds, ops] = await Promise.all([
    bizinfosByCategory(client, ym),
    loadCategoryTitles(client),
    loadUnallocatedCategoryIds(client),
    fetchMonthOperations(client, ym),
  ]);
  const payroll: Payroll = { production: 0, commercial: 0, admin: 0, director: 0, payrollTax: 0 };
  for (const [id, title] of titles) {
    const key = payrollKey(title);
    const s = sums.get(id);
    if (key && s) payroll[key] += s.income + s.outcome;
  }
  for (const k of Object.keys(payroll) as Array<keyof Payroll>) payroll[k] = round2(payroll[k]);
  const unallocated = ops.filter((o) => (o.operationType ? o.operationType !== "Move" : true) && isUnallocatedOperation(o, unallocIds)).length;
  return { month: ym, unallocated, payroll, prevMonthClosed: prevMonthClosed(ym) };
}
