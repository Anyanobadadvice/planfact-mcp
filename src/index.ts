#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PlanFactClient } from "./services/planfactClient.js";
import { registerAnalysisTools } from "./tools/analysisTools.js";
import { registerCounterpartyTools } from "./tools/counterpartyTools.js";
import { registerFinanceAssistantTools } from "./tools/financeAssistantTools.js";
import { registerOperationTools } from "./tools/operationTools.js";
import { registerReferenceTools } from "./tools/referenceTools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../.env") });
dotenv.config();

const server = new McpServer({
  name: "planfact-mcp-server",
  version: "0.1.0",
});

const client = new PlanFactClient(process.env.PLANFACT_API_KEY || "");

registerReferenceTools(server, client);
registerOperationTools(server, client);
registerAnalysisTools(server, client);
registerFinanceAssistantTools(server, client);
registerCounterpartyTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
