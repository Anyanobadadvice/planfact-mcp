import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanFactClient } from "../src/services/planfactClient.js";
import { registerAnalysisTools } from "../src/tools/analysisTools.js";
import { summarizeHistory } from "../src/services/history.js";
import { untrusted } from "../src/formatters.js";

afterEach(() => vi.unstubAllGlobals());

// Реальная форма /bizinfos/incomeoutcomehistorybyoperationcategories (2026-11-17): строка на операцию.
const detail = (typeId: number, fact: number, catType: string, extra: Record<string, unknown> = {}) => ({
  date: "2026-10-01T00:00:00",
  factValue: fact,
  planValue: fact,
  factValueInUserCurrency: fact,
  planValueInUserCurrency: fact,
  accountCurrencyUserCurrencyRate: 1,
  isUndistributed: false,
  operationCategoryType: catType,
  operationTypeId: typeId,
  ...extra,
});
const history = {
  data: [
    { operationCategoryId: 2945160, details: [detail(1, 1000000.5, "Income"), detail(1, 255076.03, "Income")] },
    { operationCategoryId: 2945167, details: [detail(2, 480644, "Outcome")] },
    { operationCategoryId: 2945128, details: [detail(1, 5000, "Assets"), detail(2, 5000, "Assets")] },
    { operationCategoryId: 2945176, details: [] },
  ],
  isSuccess: true,
};
const categories = {
  items: [
    { operationCategoryId: 2945160, title: "Производство и продажа кожаных изделий " },
    { operationCategoryId: 2945167, title: "Производственный персонал" },
    { operationCategoryId: 2945128, title: "Переводы в пути" },
    { operationCategoryId: 2945176, title: "Налог на прибыль (доходы)" },
  ],
};

function setup() {
  const calls: { path: string; query: URLSearchParams }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const path = url.pathname.replace("/api/v1", "");
      calls.push({ path, query: url.searchParams });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/operationcategories") return json(categories);
      if (path === "/bizinfos/incomeoutcomehistorybyoperationcategories") return json(history);
      if (path === "/projects") return json({ items: [{ projectId: 375927, title: "Основной" }] });
      if (path === "/bizinfos/incomeoutcomehistorybyprojects") {
        return json({ data: [{ projectId: 375927, details: [detail(1, 100, "Income"), detail(2, 40, "Outcome")] }], isSuccess: true });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  const handlers: Record<string, (p: any) => Promise<any>> = {};
  const fakeServer = { registerTool: (name: string, _c: unknown, h: any) => (handlers[name] = h) };
  registerAnalysisTools(fakeServer as any, new PlanFactClient("test-key", "https://pf.test"));
  return { handlers, calls };
}

describe("summarizeHistory", () => {
  it("сворачивает детали по статье: доход по typeId 1, расход по 2, нулевые строки выкидывает", () => {
    const s = summarizeHistory(history, "operationCategoryId", new Map([[2945160, "Продажи"]]));
    expect(s.rows.map((r) => r.id)).toEqual([2945160, 2945167, 2945128]); // по убыванию оборота; пустая статья отброшена
    expect(s.rows[0]).toMatchObject({ title: untrusted("Продажи"), type: "Income", income: 1255076.53, outcome: 0, net: 1255076.53, entries: 2 });
    expect(s.rows[1]).toMatchObject({ title: untrusted("#2945167"), type: "Outcome", outcome: 480644 });
    expect(s.totals).toEqual({ income: 1260076.53, outcome: 485644, net: 774432.53 });
    // ОПИУ — только Income/Outcome, без «Переводов в пути» (Assets)
    expect(s.opu).toEqual({ income: 1255076.53, outcome: 480644, net: 774432.53 });
    expect(s.entries).toBe(5);
  });
});

describe("planfact_get_income_outcome_by_categories", () => {
  it("отдаёт компактные строки с названиями, без raw; названия статей запрашивает один раз", async () => {
    const { handlers, calls } = setup();
    const res = await handlers.planfact_get_income_outcome_by_categories({
      periodStartDate: "2026-10-01",
      periodEndDate: "2026-10-31",
      isCalculation: true,
      ignoreMove: true,
      response_format: "json",
    });
    const out = res.structuredContent;
    expect(out.raw).toBeUndefined();
    expect(out.basis).toBe("accrual");
    expect(out.rows[0]).toMatchObject({ title: untrusted("Производство и продажа кожаных изделий"), income: 1255076.53 });
    expect(out.opu.income).toBe(1255076.53);
    expect(JSON.stringify(out).length).toBeLessThan(3000);
    expect(calls.filter((c) => c.path === "/operationcategories")).toHaveLength(1);
    const q = calls.find((c) => c.path.startsWith("/bizinfos/"))!.query;
    expect(q.get("filter.isCalculation")).toBe("true");
    expect(q.get("filter.periodStartDate")).toBe("2026-10-01");
    // markdown-текст с таблицей
    const md = await handlers.planfact_get_income_outcome_by_categories({
      periodStartDate: "2026-10-01",
      periodEndDate: "2026-10-31",
      isCalculation: false,
      ignoreMove: true,
      response_format: "markdown",
    });
    expect(md.content[0].text).toContain(`| ${untrusted("Производство и продажа кожаных изделий")} |`);
    expect(md.content[0].text).toContain("ДДС");
  });
});

describe("planfact_get_income_outcome_by_projects", () => {
  it("та же свёртка по проектам с названиями из /projects", async () => {
    const { handlers } = setup();
    const res = await handlers.planfact_get_income_outcome_by_projects({
      periodStartDate: "2026-10-01",
      periodEndDate: "2026-10-31",
      isCalculation: false,
      ignoreMove: true,
      response_format: "json",
    });
    expect(res.structuredContent.rows[0]).toMatchObject({ id: 375927, title: untrusted("Основной"), income: 100, outcome: 40, net: 60 });
    expect(res.structuredContent.raw).toBeUndefined();
  });
});
