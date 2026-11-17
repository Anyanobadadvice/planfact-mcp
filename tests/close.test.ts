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

  it("список ограничен 20 и помечен truncated", async () => {
    const ops = Array.from({ length: 60 }, (_, i) => op(i + 1, {}, [part(i + 1, { isCalculationCommitted: false })]));
    const { client } = setup(ops);
    const r = await receivables(client, "2026-10");
    expect(r.count).toBe(60);
    expect(r.items).toHaveLength(20);
    expect(r.truncated).toBe(true);
  });
});

describe("receivables groups and size", () => {
  const long = (i: number) => `Очень длинное название контрагента номер ${i} `.repeat(8);
  const worst = () =>
    Array.from({ length: 60 }, (_, i) =>
      op(i + 1, { contrAgent: { contrAgentId: i + 1, title: long(i) } }, [part(i + 1, { isCalculationCommitted: false, value: 100 + i })]),
    );

  it("хвост групп сворачивается в «прочие» с суммой и флагом groupsTruncated", async () => {
    const { client } = setup(worst());
    const r = await receivables(client, "2026-10");
    expect(r.groupsTruncated).toBe(true);
    expect(r.byContrAgent).toHaveLength(16);
    expect(r.byContrAgent[15].contrAgent).toBe("прочие");
    expect(r.byContrAgent[15].count).toBe(45);
    expect(r.byContrAgent.reduce((a, g) => a + g.total, 0)).toBeCloseTo(r.total, 2);
  });

  it("худший случай (60 операций, длинные названия) < 8000 символов в json и markdown", async () => {
    const { handlers } = setup(worst());
    for (const response_format of ["json", "markdown"]) {
      const r = await handlers.planfact_receivables({ month: "2026-10", response_format });
      expect(r.content[0].text.length).toBeLessThan(8000);
      expect(JSON.stringify(r.structuredContent).length + r.content[0].text.length).toBeLessThan(16000);
    }
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

describe("cdek size", () => {
  it("худший случай < 8000 символов в json и markdown", async () => {
    const cdek = { contrAgentId: 77, title: "СДЭК ".repeat(40) };
    const ops = Array.from({ length: 60 }, (_, i) => op(i + 1, { operationType: "Outcome" }, [part(i + 1, { contrAgent: cdek, isCalculationCommitted: false })]));
    const { handlers } = setup(ops);
    for (const response_format of ["json", "markdown"]) {
      const r = await handlers.planfact_cdek_unaccrued({ month: "2026-10", response_format });
      expect(r.content[0].text.length).toBeLessThan(8000);
      expect(r.structuredContent.truncated).toBe(true);
      expect(r.structuredContent.count).toBe(60);
    }
  });
});

describe("preflight", () => {
  it("«Налог по ЗП директора» относится к налогу, а не к директору", async () => {
    categories.push({ operationCategoryId: 8, title: "Налог по ЗП директора" });
    const h = { ...history, data: [...history.data, { operationCategoryId: 8, details: [detail(2, 7)] }] };
    const { client } = setup([], h);
    const r = await preflight(client, "2026-10");
    categories.pop();
    expect(r.payroll.payrollTax).toBe(7);
    expect(r.payroll.director).toBe(40);
  });

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

// ---------- Task 5: перенос выручки (4.1) ----------
import { applyDefer, deferPlan } from "../src/services/close.js";

const REV = 2945160;
const revPart = (id: number, v: number, over: Record<string, unknown> = {}) =>
  part(id, { value: v, calculationDate: "2026-10-20", operationCategory: { operationCategoryId: REV, title: "Производство и продажа" }, contrAgent: { contrAgentId: 55, title: "Клиент" }, project: { projectId: 7 }, ...over });
const rop = (id: number, date: string, v: number, over: Record<string, unknown> = {}, parts?: any[]) =>
  op(id, { operationDate: date, value: v, comment: `c${id}`, account: { accountId: 900 + id, title: "Р/с <b>" }, contrAgent: { contrAgentId: 55, title: "Клиент" }, ...over }, parts ?? [revPart(id, v)]);

// pfRev по history = 1000.25 + 500 + 250 = 1750.25
const PF = 1750.25;

function setupDefer(ops: any[], opts: { failIds?: number[]; afterHist?: unknown } = {}) {
  const puts: { id: string; body: any }[] = [];
  let histCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: any) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/api/v1", "");
      const json = (data: unknown) => new Response(JSON.stringify({ isSuccess: true, data }), { status: 200 });
      if (init?.method === "PUT") {
        const id = path.split("/").pop()!;
        puts.push({ id, body: JSON.parse(init.body) });
        if (opts.failIds?.includes(Number(id))) return new Response(JSON.stringify({ isSuccess: false, errorMessage: "boom <x>" }), { status: 200 });
        return json({});
      }
      if (path === "/bizinfos/incomeoutcomehistorybyoperationcategories") {
        histCalls++;
        return new Response(JSON.stringify(histCalls > 1 && opts.afterHist ? opts.afterHist : history), { status: 200 });
      }
      if (path === "/operations") {
        const offset = Number(url.searchParams.get("paging.offset") ?? 0);
        const limit = Number(url.searchParams.get("paging.limit") ?? 1000);
        return json({ items: ops.slice(offset, offset + limit) });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  const client = new PlanFactClient("k", "https://pf.test");
  const handlers: Record<string, (p: any) => Promise<any>> = {};
  registerCloseTools({ registerTool: (n: string, _c: unknown, h: any) => (handlers[n] = h) } as any, client);
  return { client, handlers, puts };
}

describe("deferPlan / applyDefer / planfact_defer_revenue", () => {
  it("target <= 0: no defer, empty pick, no PUT even when confirmed", async () => {
    const { client, handlers, puts } = setupDefer([rop(1, "2026-10-31", 500)]);
    const plan = await deferPlan(client, "2026-10", PF + 10);
    expect(plan.needDefer).toBe(false);
    expect(plan.pick).toEqual([]);
    expect(plan.target).toBeLessThanOrEqual(0);
    const r = await handlers.planfact_defer_revenue({ month: "2026-10", msRevenue: PF + 10, confirmed: true, response_format: "markdown" });
    expect(puts).toHaveLength(0);
    expect(r.structuredContent.needDefer).toBe(false);
    expect(r.content[0].text).toContain("перенос не нужен");
  });

  it("picks from month end and the final добивка takes the minimal covering candidate", async () => {
    const ops = [rop(1, "2026-10-31", 900), rop(2, "2026-10-30", 400), rop(3, "2026-10-29", 350)];
    const { client } = setupDefer(ops);
    const plan = await deferPlan(client, "2026-10", PF - 340);
    expect(plan.target).toBe(340);
    expect(plan.nextMonthEnd).toBe("2026-11-30");
    expect(plan.pick.map((p) => p.operationId)).toEqual([3]);
    expect(plan.overshoot).toBe(10);
    expect(plan.shortfall).toBe(0);
    expect(plan.candidates).toBe(3);

    const plan2 = await deferPlan(client, "2026-10", PF - 1000);
    // 900 (<1000), then 400 covers -> popped, need 100 -> min >=100 among unused = 350
    expect(plan2.pick.map((p) => p.operationId)).toEqual([1, 3]);
    expect(plan2.picked).toBe(2);
    expect(plan2.overshoot).toBe(250);
  });

  it("reports shortfall when candidates cannot cover the target", async () => {
    const { client } = setupDefer([rop(1, "2026-10-31", 100)]);
    const plan = await deferPlan(client, "2026-10", PF - 500);
    expect(plan.pick.map((p) => p.operationId)).toEqual([1]);
    expect(plan.shortfall).toBe(400);
    expect(plan.overshoot).toBe(0);
  });

  it("skips multi-part operations and counts them; ignores non-month / uncommitted / foreign-category parts", async () => {
    const multi = rop(10, "2026-10-31", 700, {}, [revPart(10, 400), revPart(11, 300)]);
    const outOfMonth = rop(11, "2026-10-31", 700, {}, [revPart(11, 700, { calculationDate: "2026-09-30" })]);
    const tail = rop(12, "2026-10-31", 700, {}, [revPart(12, 700, { isCalculationCommitted: false })]);
    const foreign = rop(13, "2026-10-31", 700, {}, [revPart(13, 700, { operationCategory: { operationCategoryId: 5, title: "X" } })]);
    const good = rop(1, "2026-10-20", 300);
    const { client } = setupDefer([multi, outOfMonth, tail, foreign, good]);
    const plan = await deferPlan(client, "2026-10", PF - 200);
    expect(plan.multiSkipped).toEqual({ count: 1, sum: 700 });
    expect(plan.candidates).toBe(1);
    expect(plan.pick.map((p) => p.operationId)).toEqual([1]);
  });

  it("applyDefer sends the full payload; isSuccess:false goes to failed, the rest is still written", async () => {
    const ops = [rop(1, "2026-10-31", 300), rop(2, "2026-10-30", 300), rop(3, "2026-10-29", 300)];
    const { client, puts } = setupDefer(ops, { failIds: [2], afterHist: { isSuccess: true, data: [{ operationCategoryId: REV, details: [detail(1, 1000)] }] } });
    const plan = await deferPlan(client, "2026-10", PF - 900);
    expect(plan.pick).toHaveLength(3);
    const res = await applyDefer(client, plan);
    expect(res.ok).toBe(2);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].id).toBe(2);
    expect(res.failed[0].err).toContain("boom");
    expect(puts.map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(res.after).toEqual({ pfRevenue: 1000, msRevenue: 850.25, delta: 149.75 });
    expect(puts[0].body).toEqual({
      operationDate: "2026-10-31",
      calculationDate: "2026-11-30",
      isCalculationCommitted: false,
      accountId: 901,
      value: 300,
      comment: "c1",
      isCommitted: true,
      contrAgentId: 55,
      operationCategoryId: REV,
      items: [{ calculationDate: "2026-11-30", isCalculationCommitted: false, value: 300, contrAgentId: 55, operationCategoryId: REV, projectId: 7 }],
    });
  });

  it("tool: preview (and missing confirmed) never PUTs, wraps titles, stays under 8 KB with a big plan", async () => {
    const ops = Array.from({ length: 80 }, (_, i) =>
      rop(i + 1, "2026-10-30", 100 + i, { comment: "x".repeat(300), account: { accountId: 1, title: "A".repeat(200) } }),
    );
    const { handlers, puts } = setupDefer(ops);
    for (const confirmed of [false, undefined]) {
      for (const fmt of ["json", "markdown"]) {
        const r = await handlers.planfact_defer_revenue({ month: "2026-10", msRevenue: PF - 6000, confirmed, response_format: fmt });
        expect(puts).toHaveLength(0);
        const s = r.structuredContent;
        expect(s.needDefer).toBe(true);
        expect(s.pick.length).toBeGreaterThan(0);
        expect(s.pick.length).toBeLessThanOrEqual(10);
        expect(s.picked).toBeGreaterThan(10);
        expect(s.pick[0].account).toContain("<untrusted_data>");
        expect(s.pick[0].category).toContain("<untrusted_data>");
        expect(JSON.stringify(s).length).toBeLessThan(8000);
        expect(r.content[0].text.length).toBeLessThan(8000);
        expect(JSON.stringify(s, null, 2).length + JSON.stringify(s).length).toBeLessThanOrEqual(7600);
        expect(s.backupTrimmed).toBe(true);
        expect(s.backup).toHaveLength(s.picked);
        expect(s.pickIds).toHaveLength(s.picked);
        for (const id of s.pickIds) expect(s.backup.some((b: any[]) => b[0] === id && b[1] === "2026-10-20")).toBe(true);
      }
    }
  });

  it("tool: small plan keeps the full backup; confirmed:true writes and returns ok/failed/after", async () => {
    const ops = [rop(1, "2026-10-31", 300)];
    const { handlers, puts } = setupDefer(ops);
    const prev = await handlers.planfact_defer_revenue({ month: "2026-10", msRevenue: PF - 200, confirmed: false, response_format: "json" });
    expect(prev.structuredContent.backupTrimmed).toBeFalsy();
    expect(prev.structuredContent.backup[0].parts[0].calculationDate).toBe("2026-10-20");
    expect(puts).toHaveLength(0);
    const r = await handlers.planfact_defer_revenue({ month: "2026-10", msRevenue: PF - 200, confirmed: true, response_format: "json" });
    expect(puts).toHaveLength(1);
    expect(r.structuredContent.ok).toBe(1);
    expect(r.structuredContent.failed).toEqual([]);
    expect(r.structuredContent.after).toBeDefined();
  });
});

describe("planfact_defer_revenue: fix round 1", () => {
  const ops = () => [rop(1, "2026-10-31", 300), rop(2, "2026-10-30", 300)];
  const call = (h: any, extra: Record<string, unknown>) =>
    h.planfact_defer_revenue({ month: "2026-10", msRevenue: PF - 500, response_format: "json", ...extra });

  it("plan_changed: expectedOperationIds mismatch -> no PUT", async () => {
    const { handlers, puts } = setupDefer(ops());
    const r = await call(handlers, { confirmed: true, expectedOperationIds: [1, 99] });
    expect(puts).toHaveLength(0);
    expect(r.structuredContent.refused).toBe("plan_changed");
    expect(r.structuredContent.actual).toEqual([1, 2]);
  });

  it("match (as sets) -> PUT and written lists the ids", async () => {
    const { handlers, puts } = setupDefer(ops(), { failIds: [2] });
    const prev = await call(handlers, { confirmed: false });
    expect(prev.structuredContent.pickIds).toEqual([1, 2]);
    const r = await call(handlers, { confirmed: true, expectedOperationIds: [2, 1] });
    expect(puts).toHaveLength(2);
    expect(r.structuredContent.written).toEqual([1]);
    expect(r.structuredContent.failed[0].id).toBe(2);
  });

  it("closed month refuses confirmed but allows preview", async () => {
    process.env.PLANFACT_CLOSED_THROUGH = "2026-10";
    const { handlers, puts } = setupDefer(ops());
    const r = await call(handlers, { confirmed: true });
    expect(puts).toHaveLength(0);
    expect(r.structuredContent.refused).toBe("month_closed");
    const pv = await call(handlers, { confirmed: false });
    expect(pv.structuredContent.needDefer).toBe(true);
  });

  it("no candidates: plain message and noCandidates flag", async () => {
    const { handlers, puts } = setupDefer([]);
    const r = await handlers.planfact_defer_revenue({ month: "2026-10", msRevenue: PF - 500, confirmed: true, response_format: "markdown" });
    expect(puts).toHaveLength(0);
    expect(r.structuredContent.noCandidates).toBe(true);
    expect(r.content[0].text).toContain("нет подходящих одночастных операций, остаток 500");
  });

  it("operation without operationId is skipped into failed, not PUT", async () => {
    const { client, puts } = setupDefer([]);
    const plan: any = { month: "2026-10", msRevenue: 0, nextMonthEnd: "2026-11-30", raw: [{ operationParts: [{}] }] };
    const res = await applyDefer(client, plan);
    expect(puts).toHaveLength(0);
    expect(res.failed).toHaveLength(1);
  });
});
