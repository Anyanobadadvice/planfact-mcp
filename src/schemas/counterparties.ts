import { z } from "zod";
import { responseFormatSchema } from "./common.js";

export const createCounterpartySchema = z
  .object({
    title: z.string().min(1).max(255).describe("Counterparty name."),
    inn: z.string().max(64).optional().describe("Tax ID, if known."),
    comment: z.string().max(1000).optional(),
    externalId: z.string().max(255).optional(),
    confirmed: z
      .boolean()
      .default(false)
      .describe("Must be true to actually create the counterparty."),
    response_format: responseFormatSchema,
  })
  .strict();
