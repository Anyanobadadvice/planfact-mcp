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

/**
 * Marks externally-sourced text (comments, names) as data, not instructions.
 * Escapes every < and >, strips invisible format chars and line separators, collapses line breaks.
 */
export function untrusted(s: string): string {
  const safe = String(s)
    .replace(/[\p{Cf}\u0085\u2028\u2029\v]/gu, "")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<untrusted_data>${safe}</untrusted_data>`;
}
