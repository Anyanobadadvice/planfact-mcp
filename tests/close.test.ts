import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanFactClient } from "../src/services/planfactClient.js";
import { registerCloseTools } from "../src/tools/closeTools.js";
import { cdekUnaccrued, monthBounds, preflight, receivables, revenueAccrued } from "../src/services/close.js";
import { untrusted } from "../src/formatters.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PLANFACT_CLOSED_THROUGH;
});

const detail = (typeId: number, fact: number) => ({ factValueInUserCurrency: fact, operationTypeId: typeId, operationCategoryType: typeId === 1 ? "Income" : "Outcome" });
const history = {
  isSuccess: true,
  data: [
    { operationCategoryId: 2945160, details: [detail(1, 1000.25), detail(1, 500)] },
    { operationCategoryId: 10087234, details: [detail(1, 250)] },
    { operationCategoryId: 777, details: [detail(1, 99999)] },
    { operationCategoryId: 1, details: [detail(2, 100)] }, // Производственный персонал
    { operationCategoryId: 3, details: [detail(2, 300), detail(2, 50)] }, // Административный
    { operationCategoryId: 5, details: [detail(2, 40)] }, // ЗП директора
  ],
};
const categories = [
  { operationCategoryId: 1, title: " Производственный  персонал " },
  { operationCategoryId: 2, title: "Коммерческий персонал" },
  { operationCategoryId: 3, title: "Административный персонал" },
  { operationCategoryId: 5, title: "ЗП директора" },
  { operationCategoryId: 6, title: "Налог по ЗП" },
  { operationCategoryId: 99, title: "Нераспределённый расход" },
];

const part = (id: number, over: Record<string, unknown> = {}) => ({
  operationPartId: id * 10,
  calculationDate: "2026-10-15",
  isCalculationCommitted: true,
  value: 100,
  operationCategory: { operationCategoryId: 11, title: "Транспорт" },
  contrAgent: null,
  ...over,
});
const op = (id: number, over: Record<string, unknown> = {}, parts = [part(id)]) => ({
  operationId: id,
  operationDate: "2026-10-10",
  isCommitted: true,
  isCalculationCommitted: true,
  value: 100,
  account: { accountId: 1, title: "Р/с" },
  contrAgent: null,
  operationParts: parts,
  ...over,
});

function setup(ops: any[], hist: unknown = history, stuck = false) {
  const calls: { path: string; query: URLSearchParams }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/api/v1", "");
      calls.push({ path, query: url.searchParams });
      const json = (data: unknown) => new Response(JSON.stringify({ isSuccess: true, data }), { status: 200 });
      if (path === "/bizinfos/incomeoutcomehistorybyoperationcategories") return new Response(JSON.stringify(hist), { status: 200 });
      if (path === "/operationcategories") return json({ items: categories });
      if (path === "/operations") {
        const offset = Number(url.searchParams.get("paging.offset") ?? 0);
        const limit = Number(url.searchParams.get("paging.limit") ?? 1000);
        const type = url.searchParams.get("filter.operationType");
        const list = ops.filter((o) => !type || !o.operationType || o.operationType === type);
        return json({ items: list.slice(stuck ? 0 : offset, (stuck ? 0 : offset) + limit) });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  const client = new PlanFactClient("k", "https://pf.test");
  const handlers: Record<string, (p: any) => Promise<any>> = {};
  registerCloseTools({ registerTool: (n: string, _c: unknown, h: any) => (handlers[n] = h) } as any, client);
  return { client, handlers, calls };
}

describe("monthBounds", () => {
  it("границы месяца и предыдущий", () => {
    expect(monthBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28", prev: "2026-01" });
    expect(monthBounds("2026-01").prev).toBe("2025-12");
    expect(() => monthBounds("2026-13")).toThrow();
  });
});

describe("revenueAccrued", () => {
  it("суммирует ровно две статьи выручки и игнорирует чужие; фильтры начисления", async () => {
    const { client, calls } = setup([]);
    expect(await revenueAccrued(client, "2026-10")).toBe(1750.25);
    const q = calls[0].query;
    expect(q.get("filter.isCalculation")).toBe("true");
    expect(q.get("filter.ignoreMove")).toBe("true");
    expect(q.get("filter.periodStartDate")).toBe("2026-10-01");
    expect(q.get("filter.periodEndDate")).toBe("2026-10-31");
  });

  it("planfact_revenue_check: target = pf − ms, needDefer при target>0", async () => {
    const { handlers } = setup([]);
    const r = await handlers.planfact_revenue_check({ month: "2026-10", msRevenue: 1500, response_format: "json" });
    expect(r.structuredContent).toEqual({ month: "2026-10", pfRevenue: 1750.25, msRevenue: 1500, target: 250.25, needDefer: true });
    const r2 = await handlers.planfact_revenue_check({ month: "2026-10", msRevenue: 2000, response_format: "json" });
    expect(r2.structuredContent.target).toBe(-249.75);
    expect(r2.structuredContent.needDefer).toBe(false);
  });
});

describe("receivables", () => {
  it("дебиторка определяется по части, а не по флагу операции", async () => {
    const ops = [
      // флаг операции true, но часть не начислена -> дебиторка
      op(1, { isCalculationCommitted: true, contrAgent: { contrAgentId: 9, title: "Клиент <A>" } }, [part(1, { isCalculationCommitted: false, value: 70 })]),
      // флаг операции false, а все части начислены -> не дебиторка
      op(2, { isCalculationCommitted: false }, [part(2)]),
      // не оплачена -> не дебиторка
      op(3, { isCommitted: false }, [part(3, { isCalculationCommitted: false })]),
    ];
    const { client } = setup(ops);
    const r = await receivables(client, "2026-10");
    expect(r.count).toBe(1);
    expect(r.total).toBe(70);
    expect(r.items[0]).toMatchObject({ operationId: 1, value: 70 });
    expect(r.items[0].contrAgent).toBe(untrusted("Клиент <A>"));
  });

  it("список ограничен 50 и помечен truncated", async () => {
    const ops = Array.from({ length: 60 }, (_, i) => op(i + 1, {}, [part(i + 1, { isCalculationCommitted: false })]));
    const { client } = setup(ops);
    const r = await receivables(client, "2026-10");
    expect(r.count).toBe(60);
    expect(r.items).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });
});

describe("cdekUnaccrued", () => {
  it("находит платежи СДЭК без начисления в месяце", async () => {
    const cdek = { contrAgentId: 77, title: "СДЭК" };
    const ops = [
      op(1, { operationType: "Outcome" }, [part(1, { contrAgent: cdek, isCalculationCommitted: false })]),
      op(2, { operationType: "Outcome", contrAgent: cdek }, [part(2, { calculationDate: "2026-11-05" })]), // начислено вне месяца
      op(3, { operationType: "Outcome" }, [part(3, { contrAgent: cdek })]), // начислено в месяце -> ок
      op(4, { operationType: "Outcome" }, [part(4, { contrAgent: { contrAgentId: 1, title: "Другой" }, isCalculationCommitted: false })]),
      op(5, { operationType: "Outcome" }, [part(5, { contrAgent: cdek }), part(6, { contrAgent: cdek, isCalculationCommitted: false })]), // одна часть в месяце -> ок
    ];
    const { client } = setup(ops);
    const r = await cdekUnaccrued(client, "2026-10");
    expect(r.items.map((i) => i.operationId)).toEqual([1, 2]);
    expect(r.items[1].calculationDate).toBe("2026-11-05");
    expect(r.count).toBe(2);
    expect(r.truncated).toBe(false);
  });
});

describe("preflight", () => {
  it("ЗП по статьям, нули = не начислена, нераспределённые, prevMonthClosed", async () => {
    process.env.PLANFACT_CLOSED_THROUGH = "2026-09";
    const ops = [op(1, {}, [part(1, { operationCategory: { operationCategoryId: 99, title: "Нераспределённый расход" } })]), op(2)];
    const { client } = setup(ops);
    const r = await preflight(client, "2026-10");
    expect(r.unallocated).toBe(1);
    expect(r.payroll).toEqual({ production: 100, commercial: 0, admin: 350, director: 40, payrollTax: 0 });
    expect(r.prevMonthClosed).toBe(true);
    process.env.PLANFACT_CLOSED_THROUGH = "2026-08";
    expect((await preflight(client, "2026-10")).prevMonthClosed).toBe(false);
    delete process.env.PLANFACT_CLOSED_THROUGH;
    expect((await preflight(client, "2026-10")).prevMonthClosed).toBeNull();
  });

  it("инструмент отдаёт компактный json", async () => {
    const { handlers } = setup([op(1)]);
    const r = await handlers.planfact_close_preflight({ month: "2026-10", response_format: "json" });
    expect(r.structuredContent.payroll.production).toBe(100);
    expect(JSON.stringify(r.structuredContent).length).toBeLessThan(1000);
  });
});

describe("пагинация", () => {
  it("стоит на месте -> ошибка; страницы по 500 склеиваются", async () => {
    const same = Array.from({ length: 500 }, (_, i) => op(i + 1, {}, [part(i + 1, { isCalculationCommitted: false })]));
    const { client } = setup(same, history, true);
    await expect(receivables(client, "2026-10")).rejects.toThrow(/paging did not advance/);
    const many = Array.from({ length: 620 }, (_, i) => op(i + 1, {}, [part(i + 1, { isCalculationCommitted: false })]));
    const s2 = setup(many);
    expect((await receivables(s2.client, "2026-10")).count).toBe(620);
    const offsets = s2.calls.filter((c) => c.path === "/operations").map((c) => c.query.get("paging.offset"));
    expect(offsets).toEqual(["0", "500"]);
    expect(s2.calls.find((c) => c.path === "/operations")!.query.get("paging.limit")).toBe("500");
  });

  it("isSuccess:false при HTTP 200 -> ошибка инструмента", async () => {
    const { handlers } = setup([], { isSuccess: false, errorMessage: "boom" });
    const r = await handlers.planfact_revenue_check({ month: "2026-10", msRevenue: 1, response_format: "json" });
    expect(r.isError).toBe(true);
  });
});
