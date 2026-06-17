import { z } from "zod";
import { PLANFACT_DEFAULT_COMPANY_ID } from "../constants.js";
import { dateStringSchema, idListSchema, pagingSchema, responseFormatSchema } from "./common.js";

const companyIdSchema = PLANFACT_DEFAULT_COMPANY_ID
  ? z.number().int().positive().default(PLANFACT_DEFAULT_COMPANY_ID)
  : z.number().int().positive();

export const listOperationsSchema = z
  .object({
    operationDateStart: dateStringSchema.optional(),
    operationDateEnd: dateStringSchema.optional(),
    operationType: z
      .array(z.enum(["Income", "Outcome", "Move", "Accrual", "Shipment", "Supply"]))
      .optional()
      .describe("Filter by operation types."),
    accountId: idListSchema,
    contrAgentId: idListSchema,
    operationCategoryId: idListSchema,
    projectId: idListSchema,
    searchString: z.string().optional().describe("Search in comments and related names."),
    valueMin: z.number().optional(),
    valueMax: z.number().optional(),
    isCommitted: z.boolean().optional(),
    response_format: responseFormatSchema,
    ...pagingSchema,
  })
  .strict();

export const createOperationSchema = z
  .object({
    operationType: z
      .enum(["Income", "Outcome"])
      .describe("Use Income for incoming money and Outcome for expenses."),
    operationDate: dateStringSchema,
    accountId: z.number().int().positive().describe("PlanFact account ID."),
    value: z.number().positive().describe("Operation amount."),
    comment: z.string().min(1).max(1000).describe("Human-readable operation comment."),
    calculationDate: dateStringSchema.optional(),
    isCommitted: z.boolean().default(true).describe("Whether payment date is confirmed."),
    isCalculationCommitted: z
      .boolean()
      .default(true)
      .describe("Whether accrual date is confirmed."),
    contrAgentId: z.number().int().positive().optional(),
    operationCategoryId: z.number().int().positive().optional(),
    projectId: z.number().int().positive().optional(),
    firstAdditionalOperationAttributeId: z.number().int().positive().optional(),
    externalId: z.string().max(255).optional(),
    confirmed: z
      .boolean()
      .default(false)
      .describe("Must be true to actually create the operation."),
    response_format: responseFormatSchema,
  })
  .strict();

export const updateOperationSchema = z
  .object({
    operationId: z.number().int().positive().describe("PlanFact operation ID to update."),
    operationType: z.enum(["Income", "Outcome"]).optional(),
    operationDate: dateStringSchema.optional(),
    accountId: z.number().int().positive().optional(),
    value: z.number().positive().optional(),
    comment: z.string().min(1).max(1000).optional(),
    calculationDate: dateStringSchema.optional(),
    isCommitted: z.boolean().optional(),
    isCalculationCommitted: z.boolean().optional(),
    contrAgentId: z.number().int().positive().optional(),
    operationCategoryId: z.number().int().positive().optional(),
    projectId: z.number().int().positive().optional(),
    confirmed: z
      .boolean()
      .default(false)
      .describe("Must be true to actually update the operation."),
    response_format: responseFormatSchema,
  })
  .strict();

export const createMoveOperationSchema = z
  .object({
    operationDate: dateStringSchema,
    fromAccountId: z.number().int().positive().describe("Source PlanFact account ID."),
    toAccountId: z.number().int().positive().describe("Destination PlanFact account ID."),
    value: z.number().positive().describe("Transfer amount from the source account."),
    receivedValue: z
      .number()
      .positive()
      .optional()
      .describe("Amount received on destination account when currencies differ."),
    comment: z.string().min(1).max(1000).describe("Human-readable transfer comment."),
    isCommitted: z.boolean().default(true),
    externalId: z.string().max(255).optional(),
    confirmed: z
      .boolean()
      .default(false)
      .describe("Must be true to actually create the transfer."),
    response_format: responseFormatSchema,
  })
  .strict();

export const createOpuAccrualSchema = z
  .object({
    debitCategoryId: z
      .number()
      .int()
      .positive()
      .describe("Expense category ID used as debit article. Sent as outcomeOperationCategoryId."),
    creditCategoryId: z
      .number()
      .int()
      .positive()
      .describe("Asset category ID used as credit article. Sent as incomeOperationCategoryId."),
    value: z.number().positive().describe("Accrual amount."),
    calculationDate: dateStringSchema.describe("Accrual date. Future dates are automatically uncommitted."),
    comment: z.string().min(1).max(1000).optional(),
    isCalculationCommitted: z
      .boolean()
      .default(true)
      .describe("Whether accrual date is confirmed. Forced to false for future dates."),
    companyId: companyIdSchema.describe("PlanFact legal entity/company ID."),
    currencyCode: z.string().length(3).default("RUB").describe("Operation currency code, for example RUB."),
    contrAgentId: z.number().int().positive().nullable().default(null),
    incomeProjectId: z.number().int().positive().nullable().default(null),
    outcomeProjectId: z.number().int().positive().nullable().default(null),
    additionalPayload: z
      .record(z.unknown())
      .optional()
      .describe("Optional extra fields copied into the payload for compatibility with PlanFact UI requests."),
    confirmed: z
      .boolean()
      .default(false)
      .describe("Must be true to actually create the accrual."),
    response_format: responseFormatSchema,
  })
  .strict();
