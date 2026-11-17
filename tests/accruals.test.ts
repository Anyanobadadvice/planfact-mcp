import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanFactClient } from "../src/services/planfactClient.js";
import { registerCloseTools } from "../src/tools/closeTools.js";
import { accrualPlan, applyAccruals } from "../src/services/accruals.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PLANFACT_CLOSED_THROUGH;
});

const detail = (typeId: number, fact: number) => ({ factValueInUserCurrency: fact, operationTypeId: typeId });
const turnover = (gpStart = 1000, gpEnd = 1500) => ({
  materials: { outcome: 1000.456, start: 0, end: 0, group: "x", count: 3 },
  packaging: { outcome: 200, start: 0, end: 0 },
  writeoff: { outcome: 50.5, start: 0, end: 0 },
  finishedGoods: { outcome: 0, start: gpStart, end: gpEnd },
});
const inc = (id: number, accountId: number, value: number) => ({ operationId: id, operationType: "Income", value, account: { accountId }, operationParts: [] });

function setup(opts: { hist?: any[]; ops?: any[]; failOn?: (path: string, body: any) => boolean; failBizAfterPost?: boolean } = {}) {
  const posts: { path: string; body: any }[] = [];
  const gets: { path: string; query: URLSearchParams }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any = {}) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/api/v1", "");
      const method = init.method || "GET";
      if (method === "POST") {
        const body = JSON.parse(init.body);
        posts.push({ path, body });
        if (opts.failOn?.(path, body)) return new Response(JSON.stringify({ isSuccess: false, errorMessage: "boom" }), { status: 200 });
        return new Response(JSON.stringify({ isSuccess: true, data: { operationId: 1 } }), { status: 200 });
      }
      if (opts.failBizAfterPost && posts.length > 0 && path.startsWith("/bizinfos")) return new Response(JSON.stringify({ isSuccess: false, errorMessage: "biz down" }), { status: 200 });
      gets.push({ path, query: url.searchParams });
      const json = (data: unknown) => new Response(JSON.stringify({ isSuccess: true, data }), { status: 200 });
      if (path === "/bizinfos/incomeoutcomehistorybyoperationcategories") return json(opts.hist ?? []);
      if (path === "/operations") {
        const type = url.searchParams.get("filter.operationType");
        const offset = Number(url.searchParams.get("paging.offset") ?? 0);
        const limit = Number(url.searchParams.get("paging.limit") ?? 1000);
        const list = (opts.ops ?? []).filter((o) => !type || o.operationType === type);
        return json({ items: list.slice(offset, offset + limit) });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  const client = new PlanFactClient("k", "https://pf.test");
  const handlers: Record<string, (p: any) => Promise<any>> = {};
  registerCloseTools({ registerTool: (n: string, _c: unknown, h: any) => (handlers[n] = h) } as any, client);
  return { client, handlers, posts, gets };
}

const ACC = (debit: number, credit: number, value: number) => ({
  outcomeOperationCategoryId: debit,
  incomeOperationCategoryId: credit,
  value,
  calculationDate: "2026-10-31",
  accrualRecognitionDate: "2026-10-31",
  isCalculationCommitted: true,
  isOpuCalculation: true,
  companyId: 65706,
  currencyCode: "RUB",
});

describe("accrualPlan", () => {
  it("ГП выросла: капитализация 2947599/2946683", async () => {
    const { client } = setup();
    const plan = await accrualPlan(client, "2026-10", turnover(1000, 1500));
    expect(plan.date).toBe("2026-10-31");
    expect(plan.payDate).toBe("2026-11-30");
    const j = plan.jobs.find((x) => x.code === "4.8")!;
    expect(j).toMatchObject({ debit: 2947599, credit: 2946683, value: 500, duplicate: false });
    expect(j.title).toContain("Капитализация");
  });

  it("ГП упала: списание с/с 9829025/2947599", async () => {
    const { client } = setup();
    const plan = await accrualPlan(client, "2026-10", turnover(1500, 1000.5));
    const j = plan.jobs.find((x) => x.code === "4.8")!;
    expect(j).toMatchObject({ debit: 9829025, credit: 2947599, value: 499.5, duplicate: false });
  });

  it("значения и статьи 4.5–4.7", async () => {
    const { client } = setup();
    const plan = await accrualPlan(client, "2026-10", turnover());
    const by = Object.fromEntries(plan.jobs.map((j) => [j.code, j]));
    expect(by["4.5"]).toMatchObject({ debit: 2946017, credit: 2946683, value: 1000.46 });
    expect(by["4.6"]).toMatchObject({ debit: 2946077, credit: 2962213, value: 200 });
    expect(by["4.7"]).toMatchObject({ debit: 2950844, credit: 2946683, value: 50.5 });
  });

  it("дубль по дебет-статье и нулевая сумма", async () => {
    const { client } = setup({ hist: [{ operationCategoryId: 2946017, details: [detail(2, 300), detail(2, 0.1)] }] });
    const t = turnover();
    t.packaging.outcome = 0;
    const plan = await accrualPlan(client, "2026-10", t);
    expect(plan.jobs.find((j) => j.code === "4.5")!.duplicate).toBe(true);
    const p = plan.jobs.find((j) => j.code === "4.6")!;
    expect(p.note).toBe("сумма 0, пропуск");
  });

  it("база налога: только Income и только три счёта; дубль по 2945176", async () => {
    const ops = [inc(1, 948011, 1000), inc(2, 948030, 2000), inc(3, 205773, 3000), inc(4, 999, 99999), { operationId: 5, operationType: "Outcome", value: 7777, account: { accountId: 948011 }, operationParts: [] }];
    const { client, gets } = setup({ ops });
    const plan = await accrualPlan(client, "2026-10", turnover());
    expect(plan.taxBase).toBe(6000);
    const t = plan.jobs.find((j) => j.code === "4.9")!;
    expect(t).toMatchObject({ debit: 2945176, value: 102, duplicate: false });
    expect(gets.some((g) => g.path === "/operations" && g.query.get("filter.operationType") === "Income")).toBe(true);
    const dup = setup({ ops, hist: [{ operationCategoryId: 2945176, details: [detail(2, 100)] }] });
    const p2 = await accrualPlan(dup.client, "2026-10", turnover());
    expect(p2.jobs.find((j) => j.code === "4.9")!.duplicate).toBe(true);
  });

  it("skip убирает коды", async () => {
    const { client } = setup();
    const plan = await accrualPlan(client, "2026-10", turnover(), ["4.9", "4.5"]);
    expect(plan.jobs.map((j) => j.code)).toEqual(["4.6", "4.7", "4.8"]);
  });
});

describe("planfact_month_accruals", () => {
  const call = (h: any, extra: Record<string, unknown> = {}) =>
    h.planfact_month_accruals({ month: "2026-10", turnover: turnover(), confirmed: false, response_format: "json", ...extra });
  const ops = [inc(1, 948011, 10000)];

  it("предпросмотр: нет POST, есть предупреждение ЕНП, < 8000", async () => {
    const { handlers, posts } = setup({ ops });
    const r = await call(handlers);
    expect(posts).toHaveLength(0);
    const s = r.structuredContent;
    expect(s.month).toBe("2026-10");
    expect(s.date).toBe("2026-10-31");
    expect(s.payDate).toBe("2026-11-30");
    expect(s.taxBase).toBe(10000);
    expect(s.warning).toContain("skip: ['4.9']");
    expect(s.jobs).toHaveLength(5);
    expect(JSON.stringify(s, null, 2).length + JSON.stringify(s).length).toBeLessThan(8000);
  });

  it("запись: точные тела POST, дубль не пишется, сбой одного не останавливает остальные", async () => {
    const { handlers, posts } = setup({
      ops,
      hist: [{ operationCategoryId: 2946077, details: [detail(2, 5)] }],
      failOn: (_p, b) => b.outcomeOperationCategoryId === 2950844,
    });
    const r = await call(handlers, { confirmed: true });
    expect(posts.map((p) => p.path)).toEqual(["/operations/accrual", "/operations/accrual", "/operations/accrual", "/operations/outcome"]);
    expect(posts[0].body).toEqual(ACC(2946017, 2946683, 1000.46));
    expect(posts[1].body).toEqual(ACC(2950844, 2946683, 50.5));
    expect(posts[2].body).toEqual(ACC(2947599, 2946683, 500));
    expect(posts[3].body).toEqual({
      operationDate: "2026-11-30",
      calculationDate: "2026-10-31",
      isCommitted: false,
      isCalculationCommitted: true,
      accountId: 948011,
      value: 170,
      operationCategoryId: 2945176,
      comment: "Налог на прибыль 1.7% от поступлений 2026-10 (база 10000)",
      items: [{ calculationDate: "2026-10-31", isCalculationCommitted: true, value: 170, operationCategoryId: 2945176 }],
    });
    const res = r.structuredContent.results;
    expect(res.map((x: any) => [x.code, x.ok])).toEqual([["4.5", true], ["4.7", false], ["4.8", true], ["4.9", true]]);
    expect(res[1].err).toBeTruthy();
    expect(Object.keys(r.structuredContent.after).sort()).toEqual(["2945176", "2946017", "2946077", "2947599", "2950844"]);
    expect(JSON.stringify(r.structuredContent, null, 2).length + JSON.stringify(r.structuredContent).length).toBeLessThan(8000);
  });

  it("skip учитывается при записи", async () => {
    const { handlers, posts } = setup({ ops });
    await call(handlers, { confirmed: true, skip: ["4.9", "4.5", "4.6", "4.7"] });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual(ACC(2947599, 2946683, 500));
  });

  it("закрытый месяц: отказ, ничего не пишет; предпросмотр доступен", async () => {
    process.env.PLANFACT_CLOSED_THROUGH = "2026-10";
    const { handlers, posts } = setup({ ops });
    const r = await call(handlers, { confirmed: true });
    expect(posts).toHaveLength(0);
    expect(r.structuredContent.refused).toBe("month_closed");
    expect((await call(handlers)).structuredContent.jobs).toHaveLength(5);
  });

  it("перепроверка упала после записи: results сохранены, afterError, не isError", async () => {
    const { handlers, posts } = setup({ ops, failBizAfterPost: true });
    const r = await call(handlers, { confirmed: true });
    expect(posts.length).toBeGreaterThan(0);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.results.length).toBe(posts.length);
    expect(r.structuredContent.afterError).toBeTruthy();
    expect(r.structuredContent.after).toBeUndefined();
    const s2 = setup({ ops, failBizAfterPost: true });
    const md = await call(s2.handlers, { confirmed: true, response_format: "markdown" });
    expect(md.content[0].text).toContain("перепроверка не удалась");
  });

  it("expectedValues: расхождение — отказ без POST; совпадение — запись", async () => {
    const { handlers, posts } = setup({ ops });
    const pv = (await call(handlers)).structuredContent;
    expect(pv.values["4.8"]).toBe(500);
    const bad = await call(handlers, { confirmed: true, expectedValues: { ...pv.values, "4.5": 1 } });
    expect(posts).toHaveLength(0);
    expect(bad.structuredContent.refused).toBe("plan_changed");
    const good = await call(handlers, { confirmed: true, expectedValues: pv.values });
    expect(posts).toHaveLength(5);
    expect(good.structuredContent.refused).toBeUndefined();
  });

  it("values: только то, что будет записано (без дублей, нулей и пропущенных)", async () => {
    const { handlers } = setup({ ops });
    const pv = (await call(handlers)).structuredContent;
    const writable = pv.jobs.filter((j: any) => !j.duplicate && j.value >= 0.01).map((j: any) => j.code).sort();
    expect(Object.keys(pv.values).sort()).toEqual(writable);
    const sk = (await call(handlers, { skip: ["4.8"] })).structuredContent;
    expect(sk.values["4.8"]).toBeUndefined();
    const zero = pv.jobs.filter((j: any) => j.value < 0.01);
    for (const j of zero) expect(pv.values[j.code]).toBeUndefined();
  });

  it("налог: дробная база, комментарий с округлённой базой, credit null", async () => {
    const { handlers, posts } = setup({ ops: [inc(1, 948011, 1000.6), inc(2, 948030, 0.3)] });
    const r = await call(handlers, { confirmed: true, skip: ["4.5", "4.6", "4.7", "4.8"] });
    expect(posts[0].body.comment).toBe("Налог на прибыль 1.7% от поступлений 2026-10 (база 1001)");
    expect(posts[0].body.value).toBe(17.02);
    expect(r.structuredContent.jobs[0].credit).toBeNull();
  });

  it("applyAccruals: isSuccess:false -> ok:false, err", async () => {
    const { client, posts } = setup({ failOn: () => true });
    const plan = await accrualPlan(client, "2026-10", turnover());
    const res = await applyAccruals(client, plan);
    expect(posts.length).toBeGreaterThan(0);
    expect(res.results.every((x) => x.ok === false && x.err)).toBe(true);
  });

  it("частичный сбой: isError, results сохранены, текст говорит что записано и что нет", async () => {
    const { handlers } = setup({ ops, failOn: (_p, b) => b.outcomeOperationCategoryId === 2950844 });
    for (const fmt of ["json", "markdown"]) {
      const r = await call(handlers, { confirmed: true, response_format: fmt });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.results.find((x: any) => x.code === "4.7").ok).toBe(false);
      expect(r.structuredContent.after).toBeDefined();
      expect(r.content[0].text.startsWith("Частичный сбой")).toBe(true);
      expect(r.content[0].text).toContain("НЕ записано: 4.7");
      expect(r.content[0].text).toContain("записано 4 из 5");
    }
    const ok = setup({ ops });
    expect((await call(ok.handlers, { confirmed: true })).isError).toBeFalsy();
  });

  it("отказы — isError: закрытый месяц и plan_changed", async () => {
    process.env.PLANFACT_CLOSED_THROUGH = "2026-10";
    const a = setup({ ops });
    const closed = await call(a.handlers, { confirmed: true });
    expect(closed.isError).toBe(true);
    expect(closed.content[0].text).toContain("ничего не записано");
    expect((await call(a.handlers)).isError).toBeFalsy();
    delete process.env.PLANFACT_CLOSED_THROUGH;
    const b = setup({ ops });
    const pv = (await call(b.handlers)).structuredContent;
    const bad = await call(b.handlers, { confirmed: true, expectedValues: { ...pv.values, "4.5": 1 } });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.refused).toBe("plan_changed");
    expect(b.posts).toHaveLength(0);
  });

  it("4.8 со знаком: списание с/с — минус в values, сверка со знаком", async () => {
    const callDown = (h: any, extra: Record<string, unknown> = {}) =>
      h.planfact_month_accruals({ month: "2026-10", turnover: turnover(1500, 1000), confirmed: false, response_format: "json", skip: ["4.5", "4.6", "4.7", "4.9"], ...extra });
    const { handlers, posts } = setup({ ops });
    const pv = (await callDown(handlers)).structuredContent;
    expect(pv.values["4.8"]).toBe(-500);
    expect(pv.jobs[0]).toMatchObject({ code: "4.8", debit: 9829025, credit: 2947599, value: 500 });
    // модель передала модуль без знака (направление «капитализация») — отказ без POST
    const flipped = await callDown(handlers, { confirmed: true, expectedValues: { "4.8": 500 } });
    expect(flipped.isError).toBe(true);
    expect(flipped.structuredContent.refused).toBe("plan_changed");
    expect(posts).toHaveLength(0);
    const good = await callDown(handlers, { confirmed: true, expectedValues: { "4.8": -500 } });
    expect(good.isError).toBeFalsy();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual(ACC(9829025, 2947599, 500));
    // капитализация: плюс; минус в expectedValues — отказ
    const up = setup({ ops });
    const pvUp = (await call(up.handlers, { skip: ["4.5", "4.6", "4.7", "4.9"] })).structuredContent;
    expect(pvUp.values["4.8"]).toBe(500);
    const wrong = await call(up.handlers, { confirmed: true, skip: ["4.5", "4.6", "4.7", "4.9"], expectedValues: { "4.8": -500 } });
    expect(wrong.structuredContent.refused).toBe("plan_changed");
    expect(up.posts).toHaveLength(0);
  });

  it("turnover.month: совпадает — работает; не совпадает — отказ turnover_month_mismatch без POST", async () => {
    const { handlers, posts } = setup({ ops });
    const same = await call(handlers, { turnover: { ...turnover(), month: "2026-10" } });
    expect(same.isError).toBeFalsy();
    expect(same.structuredContent.jobs).toHaveLength(5);
    for (const confirmed of [false, true]) {
      const r = await call(handlers, { confirmed, turnover: { ...turnover(), month: "2026-09" } });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.refused).toBe("turnover_month_mismatch");
    }
    expect(posts).toHaveLength(0);
  });
});
