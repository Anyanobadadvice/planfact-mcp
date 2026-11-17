import type { PlanFactClient } from "./planfactClient.js";
import { extractItems } from "./operations.js";

/**
 * Свёртка ответов /bizinfos/incomeoutcomehistoryby{operationcategories,projects}.
 * Реальная форма (проверено на живом API, 2026-11-17): `data: [{ operationCategoryId | projectId,
 * details: [{ date, factValueInUserCurrency, planValueInUserCurrency, operationTypeId (1 — доход,
 * 2 — расход), operationCategoryType ('Income' | 'Outcome' | 'Assets' | 'Liabilities' | 'Capital'),
 * isUndistributed, … }] }]` — по строке на каждую операцию за период, сотни строк на статью,
 * ~170 КБ за месяц. Модели такое не отдаём: суммируем по статье и возвращаем только итоги.
 */

export type HistoryRow = {
  id: number;
  title: string;
  /** Класс статьи из ПФ; у проектов — класс первой операции. */
  type: string | null;
  income: number;
  outcome: number;
  /** income − outcome. */
  net: number;
  planIncome: number;
  planOutcome: number;
  /** Сколько операций свёрнуто в строку. */
  entries: number;
};

export type HistorySummary = {
  rows: HistoryRow[];
  /** Итоги по всем строкам. */
  totals: { income: number; outcome: number; net: number };
  /** Итоги только по статьям класса Income/Outcome — это и есть ОПИУ без движения активов/капитала. */
  opu: { income: number; outcome: number; net: number };
  /** Сколько строк-деталей пришло из ПФ всего. */
  entries: number;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round2 = (x: number): number => Math.round(x * 100) / 100;

export function summarizeHistory(data: unknown, idKey: "operationCategoryId" | "projectId", titles: Map<number, string>): HistorySummary {
  const groups = extractItems(data);
  const rows: HistoryRow[] = [];
  let entries = 0;
  for (const g of groups) {
    const id = Number(g[idKey] ?? g.id ?? 0);
    const details = Array.isArray(g.details) ? g.details.filter(isRec) : [];
    const row: HistoryRow = {
      id,
      title: titles.get(id) ?? `#${id}`,
      type: null,
      income: 0,
      outcome: 0,
      net: 0,
      planIncome: 0,
      planOutcome: 0,
      entries: details.length,
    };
    for (const d of details) {
      entries++;
      if (row.type === null && typeof d.operationCategoryType === "string") row.type = d.operationCategoryType;
      const fact = num(d.factValueInUserCurrency ?? d.factValue);
      const plan = num(d.planValueInUserCurrency ?? d.planValue);
      if (d.operationTypeId === 1) {
        row.income += fact;
        row.planIncome += plan;
      } else if (d.operationTypeId === 2) {
        row.outcome += fact;
        row.planOutcome += plan;
      }
    }
    row.income = round2(row.income);
    row.outcome = round2(row.outcome);
    row.planIncome = round2(row.planIncome);
    row.planOutcome = round2(row.planOutcome);
    row.net = round2(row.income - row.outcome);
    if (row.income !== 0 || row.outcome !== 0) rows.push(row);
  }
  rows.sort((a, b) => Math.abs(b.income) + Math.abs(b.outcome) - (Math.abs(a.income) + Math.abs(a.outcome)));
  const sum = (list: HistoryRow[]) => {
    const income = round2(list.reduce((s, r) => s + r.income, 0));
    const outcome = round2(list.reduce((s, r) => s + r.outcome, 0));
    return { income, outcome, net: round2(income - outcome) };
  };
  return {
    rows,
    totals: sum(rows),
    opu: sum(rows.filter((r) => r.type === "Income" || r.type === "Outcome")),
    entries,
  };
}

/** Названия статей: один запрос к /operationcategories. */
export async function loadCategoryTitles(client: PlanFactClient): Promise<Map<number, string>> {
  const items = extractItems(await client.request<unknown>("/operationcategories", { query: { "paging.offset": 0, "paging.limit": 1000 } }));
  return titlesOf(items, "operationCategoryId");
}

/** Названия проектов: один запрос к /projects. */
export async function loadProjectTitles(client: PlanFactClient): Promise<Map<number, string>> {
  const items = extractItems(await client.request<unknown>("/projects", { query: { "paging.offset": 0, "paging.limit": 1000 } }));
  return titlesOf(items, "projectId");
}

function titlesOf(items: Rec[], idKey: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const it of items) {
    const id = it[idKey] ?? it.id;
    if (id != null && typeof it.title === "string") m.set(Number(id), it.title.trim());
  }
  return m;
}
