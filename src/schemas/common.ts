import { z } from "zod";
import { PLANFACT_DEFAULT_LIMIT } from "../constants.js";

export const responseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: markdown for human-readable answers, json for structured data.");

export const pagingSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(PLANFACT_DEFAULT_LIMIT)
    .describe("Maximum number of records to return."),
  offset: z.number().int().min(0).default(0).describe("Number of records to skip."),
};

export const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, "Use ISO date format, for example 2026-05-22.")
  .describe("ISO date string, for example 2026-05-22 or 2026-05-22T00:00:00Z.");

export const idListSchema = z
  .array(z.union([z.string(), z.number()]))
  .optional()
  .describe("Optional list of PlanFact IDs.");
