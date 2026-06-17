import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PLANFACT_INCOME_OPERATION_PATH,
  PLANFACT_MOVE_OPERATION_PATH,
  PLANFACT_OPU_ACCRUAL_PATH,
  PLANFACT_OUTCOME_OPERATION_PATH,
  REQUIRE_CONFIRMATION_FOR_WRITES,
} from "../constants.js";
import { markdownTable, paginationMeta, toolError, toolSuccess } from "../formatters.js";
import {
  createMoveOperationSchema,
  createOpuAccrualSchema,
  createOperationSchema,
  listOperationsSchema,
  updateOperationSchema,
} from "../schemas/operations.js";
import type { PlanFactClient } from "../services/planfactClient.js";

export function registerOperationTools(server: McpServer, client: PlanFactClient): void {
  server.registerTool(
    "planfact_list_operations",
    {
      title: "List PlanFact Operations",
      description: `List financial operations with filters by date, type, account, category, project, counterparty, amount, and search text.

Use this for financial snapshots, monthly analysis, checking data completeness, and finding operations before updating them.`,
      inputSchema: listOperationsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const query = buildOperationFilterQuery(params);
        const data = await client.request<unknown>("/operations", { query });
        const operations = extractOperations(data);
        const output = {
          ...paginationMeta(operations, params.offset, params.limit),
          operations,
          raw: data,
        };
        const text = markdownTable(operations as Array<Record<string, unknown>>, [
          "id",
          "operationDate",
          "operationType",
          "value",
          "comment",
          "accountId",
          "contrAgentId",
          "operationCategoryId",
        ]);
        return toolSuccess(output, text, params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "planfact_create_operation",
    {
      title: "Create PlanFact Operation",
      description: `Create an Income or Outcome operation in PlanFact.

Safety rule: by default this tool only prepares the payload. To actually create the operation, call it with confirmed=true after the user explicitly approves the summary.`,
      inputSchema: createOperationSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const payload = operationPayload(params);

        if (REQUIRE_CONFIRMATION_FOR_WRITES && !params.confirmed) {
          const output = {
            needs_confirmation: true,
            message: "Confirm with confirmed=true to create this PlanFact operation.",
            payload,
          };
          return toolSuccess(
            output,
            [
              "Ready to create PlanFact operation. Confirm before writing.",
              "",
              markdownTable([payload], ["operationType", "operationDate", "value", "comment", "accountId"]),
            ].join("\n"),
            params.response_format,
          );
        }

        const endpoint =
          params.operationType === "Income"
            ? PLANFACT_INCOME_OPERATION_PATH
            : PLANFACT_OUTCOME_OPERATION_PATH;
        const data = await client.request<unknown>(endpoint, {
          method: "POST",
          body: payload,
        });
        return toolSuccess({ created: true, operation: data }, "Operation created in PlanFact.", params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "planfact_update_operation",
    {
      title: "Update PlanFact Operation",
      description: `Update an existing Income or Outcome operation.

Safety rule: call once with confirmed=false to preview payload, then confirmed=true only after explicit user approval. This tool does not delete operations.`,
      inputSchema: updateOperationSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const payload = operationPayload(params);

        if (REQUIRE_CONFIRMATION_FOR_WRITES && !params.confirmed) {
          const output = {
            needs_confirmation: true,
            message: "Confirm with confirmed=true to update this PlanFact operation.",
            operationId: params.operationId,
            payload,
          };
          return toolSuccess(
            output,
            `Ready to update PlanFact operation ${params.operationId}. Confirm before writing.`,
            params.response_format,
          );
        }

        const endpoint =
          params.operationType === "Outcome"
            ? PLANFACT_OUTCOME_OPERATION_PATH
            : PLANFACT_INCOME_OPERATION_PATH;
        const data = await client.request<unknown>(`${endpoint}/${params.operationId}`, {
          method: "PUT",
          body: payload,
        });
        return toolSuccess({ updated: true, operation: data }, "Operation updated in PlanFact.", params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "planfact_create_move_operation",
    {
      title: "Create PlanFact Transfer Operation",
      description: `Create a transfer between two PlanFact accounts.

Use this for moving money between accounts, not for income or expenses. Safety rule: preview first, then call with confirmed=true only after explicit user approval.`,
      inputSchema: createMoveOperationSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const payload: Record<string, unknown> = {
          operationDate: params.operationDate,
          fromAccountId: params.fromAccountId,
          toAccountId: params.toAccountId,
          value: params.value,
          receivedValue: params.receivedValue ?? params.value,
          comment: params.comment,
          isCommitted: params.isCommitted,
        };

        if (params.externalId !== undefined) payload.externalId = params.externalId;

        if (REQUIRE_CONFIRMATION_FOR_WRITES && !params.confirmed) {
          const output = {
            needs_confirmation: true,
            message: "Confirm with confirmed=true to create this PlanFact transfer.",
            payload,
          };
          return toolSuccess(
            output,
            [
              "Ready to create PlanFact transfer. Confirm before writing.",
              "",
              markdownTable(
                [payload],
                ["operationDate", "fromAccountId", "toAccountId", "value", "receivedValue", "comment"],
              ),
            ].join("\n"),
            params.response_format,
          );
        }

        const data = await client.request<unknown>(PLANFACT_MOVE_OPERATION_PATH, {
          method: "POST",
          body: payload,
        });
        return toolSuccess({ created: true, transfer: data }, "Transfer created in PlanFact.", params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "planfact_create_opu_accrual",
    {
      title: "Create PlanFact OPU Accrual",
      description: `Create an OPU accrual for month-end inventory write-off/accounting adjustments.

This models the PlanFact UI tab "Начисление": debit article is the expense category sent as outcomeOperationCategoryId, credit article is the asset/inventory category sent as incomeOperationCategoryId, and calculationDate/accrualRecognitionDate are the accrual dates.

Safety rule: preview first, then call with confirmed=true only after explicit user approval. If calculationDate is in the future, isCalculationCommitted is forced to false to avoid PlanFact errorCode 40.`,
      inputSchema: createOpuAccrualSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const payload = opuAccrualPayload(params);

        if (REQUIRE_CONFIRMATION_FOR_WRITES && !params.confirmed) {
          const output = {
            needs_confirmation: true,
            message: "Confirm with confirmed=true to create this PlanFact OPU accrual.",
            endpoint: PLANFACT_OPU_ACCRUAL_PATH,
            payload,
          };
          return toolSuccess(
            output,
            [
              "Ready to create PlanFact OPU accrual. Confirm before writing.",
              "",
              markdownTable(
                [payload],
                [
                  "calculationDate",
                  "accrualRecognitionDate",
                  "value",
                  "outcomeOperationCategoryId",
                  "incomeOperationCategoryId",
                  "isCalculationCommitted",
                  "companyId",
                  "currencyCode",
                ],
              ),
            ].join("\n"),
            params.response_format,
          );
        }

        const data = await client.request<unknown>(PLANFACT_OPU_ACCRUAL_PATH, {
          method: "POST",
          body: payload,
        });
        return toolSuccess(
          { created: true, accrual: data },
          "OPU accrual created in PlanFact.",
          params.response_format,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

function buildOperationFilterQuery(params: Record<string, unknown>): Record<string, unknown> {
  const query: Record<string, unknown> = {
    "paging.offset": params.offset,
    "paging.limit": params.limit,
  };

  const filterMap: Record<string, string> = {
    operationDateStart: "filter.operationDateStart",
    operationDateEnd: "filter.operationDateEnd",
    operationType: "filter.operationType",
    accountId: "filter.accountId",
    contrAgentId: "filter.contrAgentId",
    operationCategoryId: "filter.operationCategoryId",
    projectId: "filter.projectId",
    searchString: "filter.searchString",
    valueMin: "filter.valueMin",
    valueMax: "filter.valueMax",
    isCommitted: "filter.isCommitted",
  };

  for (const [inputKey, queryKey] of Object.entries(filterMap)) {
    if (params[inputKey] !== undefined) query[queryKey] = params[inputKey];
  }

  return query;
}

function operationPayload(params: Record<string, unknown>): Record<string, unknown> {
  const calculationDate = params.calculationDate || params.operationDate;
  const item: Record<string, unknown> = {
    calculationDate,
    isCalculationCommitted: params.isCalculationCommitted ?? true,
    value: params.value,
  };

  for (const key of [
    "contrAgentId",
    "operationCategoryId",
    "projectId",
    "firstAdditionalOperationAttributeId",
  ]) {
    if (params[key] !== undefined) item[key] = params[key];
  }

  const payload: Record<string, unknown> = {
    operationDate: params.operationDate,
    calculationDate,
    isCalculationCommitted: params.isCalculationCommitted ?? true,
    accountId: params.accountId,
    value: params.value,
    comment: params.comment,
    isCommitted: params.isCommitted ?? true,
    items: [item],
  };

  for (const key of ["contrAgentId", "operationCategoryId", "externalId"]) {
    if (params[key] !== undefined) payload[key] = params[key];
  }

  return payload;
}

function opuAccrualPayload(params: Record<string, unknown>): Record<string, unknown> {
  const calculationDate = String(params.calculationDate);
  const isCalculationCommitted =
    isFutureDate(calculationDate) ? false : params.isCalculationCommitted ?? true;

  const payload: Record<string, unknown> = {
    outcomeOperationCategoryId: params.debitCategoryId,
    incomeOperationCategoryId: params.creditCategoryId,
    value: params.value,
    calculationDate,
    accrualRecognitionDate: calculationDate,
    isCalculationCommitted,
    isOpuCalculation: true,
    companyId: params.companyId,
    currencyCode: params.currencyCode,
    comment: params.comment,
    contrAgentId: params.contrAgentId,
    incomeProjectId: params.incomeProjectId,
    outcomeProjectId: params.outcomeProjectId,
  };

  if (params.additionalPayload && typeof params.additionalPayload === "object") {
    Object.assign(payload, params.additionalPayload);
  }

  return removeUndefined(payload);
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function isFutureDate(date: string): boolean {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return false;

  const today = new Date();
  const parsedDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  return parsedDay > todayDay;
}

function extractOperations(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  const record = data as Record<string, unknown>;
  for (const key of ["operations", "items", "data"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }

  return [];
}
