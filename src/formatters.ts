import type { PaginationMeta, ResponseFormat, ToolOutput } from "./types.js";

export function toolSuccess<T>(
  structuredContent: T,
  text: string,
  responseFormat: ResponseFormat,
): ToolOutput<T> {
  return {
    content: [
      {
        type: "text",
        text: responseFormat === "json" ? JSON.stringify(structuredContent, null, 2) : text,
      },
    ],
    structuredContent,
  };
}

export function toolError(error: unknown): ToolOutput<{ error: string }> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
    structuredContent: { error: message },
  };
}

export function paginationMeta(items: unknown[], offset: number, limit: number): PaginationMeta {
  return {
    count: items.length,
    offset,
    limit,
    has_more: items.length >= limit,
    next_offset: items.length >= limit ? offset + items.length : null,
  };
}

export function markdownTable(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (rows.length === 0) return "No records found.";

  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) =>
    `| ${columns.map((column) => stringifyCell(row[column])).join(" | ")} |`,
  );

  return [header, separator, ...body].join("\n");
}

function stringifyCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).replace(/\|/g, "\\|");
}
