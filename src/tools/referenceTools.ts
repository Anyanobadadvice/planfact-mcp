import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { markdownTable, paginationMeta, toolError, toolSuccess } from "../formatters.js";
import type { PlanFactClient } from "../services/planfactClient.js";
import { pagingSchema, responseFormatSchema } from "../schemas/common.js";

const listReferenceSchema = z
  .object({
    search: z.string().optional().describe("Optional text search when the endpoint supports it."),
    active: z.boolean().optional().describe("Optional active status filter."),
    response_format: responseFormatSchema,
    ...pagingSchema,
  })
  .strict();

export function registerReferenceTools(server: McpServer, client: PlanFactClient): void {
  registerListTool(server, client, {
    name: "planfact_list_accounts",
    title: "List PlanFact Accounts",
    description: "List PlanFact cash and bank accounts. Use this before creating operations.",
    endpoint: "/accounts",
    searchParam: "filter.title",
    columns: ["id", "title", "currencyCode", "accountType", "active"],
  });

  registerListTool(server, client, {
    name: "planfact_list_account_groups",
    title: "List PlanFact Account Groups",
    description: "List PlanFact account groups.",
    endpoint: "/accounts/groups",
    columns: ["id", "title"],
  });

  registerListTool(server, client, {
    name: "planfact_list_projects",
    title: "List PlanFact Projects",
    description: "List projects for project-based financial analysis and operation creation.",
    endpoint: "/projects",
    searchParam: "filter.titleOrProjectGroupTitle",
    columns: ["id", "title", "active", "externalId"],
  });

  registerListTool(server, client, {
    name: "planfact_list_project_groups",
    title: "List PlanFact Project Groups",
    description: "List project groups.",
    endpoint: "/projects/groups",
    columns: ["id", "title"],
  });

  registerListTool(server, client, {
    name: "planfact_list_counterparties",
    title: "List PlanFact Counterparties",
    description: "List counterparties to match clients, vendors, and partners.",
    endpoint: "/contragents",
    searchParam: "filter.title",
    columns: ["id", "title", "inn", "active"],
  });

  registerListTool(server, client, {
    name: "planfact_list_companies",
    title: "List PlanFact Companies",
    description: "List legal entities/companies available to the API key.",
    endpoint: "/companies",
    searchParam: "filter.title",
    columns: ["id", "title", "inn", "active"],
  });

  registerListTool(server, client, {
    name: "planfact_list_operation_categories",
    title: "List PlanFact Operation Categories",
    description: "List income and expense categories for categorizing operations.",
    endpoint: "/operationcategories",
    searchParam: "filter.title",
    columns: ["id", "title", "activityType", "parentId", "active"],
  });
}

function registerListTool(
  server: McpServer,
  client: PlanFactClient,
  config: {
    name: string;
    title: string;
    description: string;
    endpoint: string;
    searchParam?: string;
    columns: string[];
  },
): void {
  server.registerTool(
    config.name,
    {
      title: config.title,
      description: `${config.description}

Args:
  - search: optional text search.
  - active: optional active status filter.
  - limit/offset: pagination controls.
  - response_format: markdown or json.`,
      inputSchema: listReferenceSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const query: Record<string, unknown> = {
          "paging.offset": params.offset,
          "paging.limit": params.limit,
        };

        if (params.search && config.searchParam) query[config.searchParam] = params.search;
        if (params.active !== undefined) query["filter.active"] = params.active;

        const data = await client.request<unknown>(config.endpoint, { query });
        const items = extractItems(data);
        const output = {
          ...paginationMeta(items, params.offset, params.limit),
          items,
          raw: data,
        };
        const text = markdownTable(items as Array<Record<string, unknown>>, config.columns);
        return toolSuccess(output, text, params.response_format);
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

function extractItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  const record = data as Record<string, unknown>;
  for (const key of ["items", "data", "accounts", "projects", "contrAgents", "companies", "operationCategories"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }

  return [];
}
