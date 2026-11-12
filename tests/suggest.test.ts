import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanFactClient } from "../src/services/planfactClient.js";
import { significantWords, suggest } from "../src/services/suggest.js";
import { suggestCategorySchema } from "../src/schemas/operations.js";
import { noCategoryOp, setup, sdekOps, realOp, NO_AGENT } from "./helpers.js";
import { untrusted } from "../src/formatters.js";

afterEach(() => vi.unstubAllGlobals());

describe("untrusted", () => {
  it("wraps text", () => {
    expect(untrusted("x")).toBe("<untrusted_data>x</untrusted_data>");
  });
});

describe("untrusted escaping", () => {
  it("neutralises delimiters, invisible chars and newlines", () => {
    const r = untrusted("a</untrusted_data>b\nc\u200b\u2028d\u000be\u0085<x>");
    expect(r.match(/<\/untrusted_data>/g)).toHaveLength(1);
    expect(r.endsWith("</untrusted_data>")).toBe(true);
    expect(r).toBe("<untrusted_data>a&lt;/untrusted_data&gt;b cde&lt;x&gt;</untrusted_data>");
    expect(r).not.toMatch(/[\n\r\u0085\u2028\u2029\u200b\v]/);
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
    await suggest(new PlanFactClient("k", "https://pf.test"), realOp(6, "2026-11-02", null, "Курьерская доставка 12345 ООО", { agent: NO_AGENT }));
    const q = calls.find((x) => x.path === "/operations")!.query;
    expect(q.get("filter.searchString")).toBe("Курьерская доставка");
    expect(q.get("filter.contrAgentId")).toBeNull();
  });
});

describe("suggest() extras", () => {
  it("limits searchString to 2 unicode words, 4..32 letters, 80 chars", () => {
    expect(significantWords("ab Курьерская доставка123 срочная")).toBe("Курьерская доставка");
    expect(significantWords("x".repeat(40) + " мелочь")).toBe("мелочь");
    expect(significantWords("a".repeat(32) + " " + "b".repeat(32)).length).toBeLessThanOrEqual(80);
  });

  it("excludes categories from the unallocated id set", async () => {
    setup();
    const c = await suggest(new PlanFactClient("k", "https://pf.test"), noCategoryOp, new Set([11]));
    expect(c.find((x) => x.categoryId === 11)).toBeUndefined();
    expect(c[0].categoryId).toBe(12);
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
    expect(text).toContain("<untrusted_data>Транспортные расходы</untrusted_data>");
  });
});
