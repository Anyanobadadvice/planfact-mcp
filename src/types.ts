export type ResponseFormat = "markdown" | "json";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface PlanFactErrorBody {
  isSuccess?: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  errorCodeTitle?: string | null;
  errors?: Array<{ code?: string | null; message?: string | null }>;
}

export interface PaginationMeta {
  count: number;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
}

export interface ToolOutput<T> {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: T;
  isError?: boolean;
}
