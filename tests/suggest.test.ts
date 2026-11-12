import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanFactClient } from "../src/services/planfactClient.js";
import { suggest } from "../src/services/suggest.js";
import { suggestCategorySchema } from "../src/schemas/operations.js";
import { noCategoryOp, setup, sdekOps } from "./helpers.js";
import { untrusted } from "../src/formatters.js";

afterEach(() => vi.unstubAllGlobals());

describe("untrusted", () => {
  it("wraps text", () => {
    expect(untrusted("x")).toBe("<untrusted_data>x</untrusted_data>");
  });
});

describe("suggest()", () => {
  it("groups СДЭК history by category, excludes unallocated, sorts by count", async () => {
    setup();
    const c = await suggest(new PlanFactClient("k", "https://pf.test"), noCategoryOp);
    expect(c[0]).toMatchObject({ categoryId: 11, categoryName: "Транспортные расходы", count: 3, lastDate: "2026-10-20", contrAgentId: 77, contrAgentName: "СДЭК" });
    expect(c[1]).toMatchObject({ categoryId: 12, count: 1 });
    expect(c.find((x) => x.categoryId === 99)).toBeUndefined();
    expect(c.length).toBeLessThanOrEqual(3);
  });

  it("falls back to comment words when no counterparty", async () => {
    const { calls } = setup();
    await suggest(new PlanFactClient("k", "https://pf.test"), { ...noCategoryOp, contrAgent: null, comment: "Курьерская доставка 12345 ООО" });
    const q = calls.find((x) => x.path === "/operations")!.query;
    expect(q.get("filter.searchString")).toBe("Курьерская доставка");
    expect(q.get("filter.contrAgentId")).toBeNull();
  });
});

describe("planfact_suggest_category", () => {
  it("returns candidates for the operation and wraps names in untrusted_data", async () => {
    const { handlers } = setup({ ops: [...sdekOps, noCategoryOp] });
    const params = suggestCategorySchema.parse({ operationId: 6, response_format: "json" });
    const res = await handlers.planfact_suggest_category(params);
    expect(res.structuredContent.operation.id).toBe(6);
    expect(res.structuredContent.candidates[0]).toMatchObject({ categoryName: "Транспортные расходы", count: 3 });
    const text = (await handlers.planfact_suggest_category(suggestCategorySchema.parse({ operationId: 6 }))).content[0].text;
    expect(text).toContain("<untrusted_data>СДЭК</untrusted_data>");
  });
});
