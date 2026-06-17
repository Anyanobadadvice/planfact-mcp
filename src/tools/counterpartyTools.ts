import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PLANFACT_COUNTERPARTY_PATH, REQUIRE_CONFIRMATION_FOR_WRITES } from "../constants.js";
import { markdownTable, toolError, toolSuccess } from "../formatters.js";
import { createCounterpartySchema } from "../schemas/counterparties.js";
import type { PlanFactClient } from "../services/planfactClient.js";

export function registerCounterpartyTools(server: McpServer, client: PlanFactClient): void {
  server.registerTool(
    "planfact_create_counterparty",
    {
      title: "Create PlanFact Counterparty",
      description: `Create a PlanFact counterparty for a client, vendor, contractor, or partner.

Safety rule: by default this tool only prepares the payload. To actually create the counterparty, call it with confirmed=true after the user explicitly approves the summary.`,
      inputSchema: createCounterpartySchema,
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
          title: params.title,
        };

        for (const key of ["inn", "comment", "externalId"]) {
          if (params[key as keyof typeof params] !== undefined) {
            payload[key] = params[key as keyof typeof params];
          }
        }

        if (REQUIRE_CONFIRMATION_FOR_WRITES && !params.confirmed) {
          const output = {
            needs_confirmation: true,
            message: "Confirm with confirmed=true to create this PlanFact counterparty.",
            payload,
          };
          return toolSuccess(
            output,
            [
              "Ready to create PlanFact counterparty. Confirm before writing.",
              "",
              markdownTable([payload], ["title", "inn", "comment", "externalId"]),
            ].join("\n"),
            params.response_format,
          );
        }

        const data = await client.request<unknown>(PLANFACT_COUNTERPARTY_PATH, {
          method: "POST",
          body: payload,
        });

        return toolSuccess(
          { created: true, counterparty: data },
          "Counterparty created in PlanFact.",
          params.response_format,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
