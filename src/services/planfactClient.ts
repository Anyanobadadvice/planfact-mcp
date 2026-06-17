import { PLANFACT_API_PREFIX, PLANFACT_BASE_URL } from "../constants.js";
import type { HttpMethod, PlanFactErrorBody } from "../types.js";

export class PlanFactClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = PLANFACT_BASE_URL) {
    if (!apiKey) {
      throw new Error(
        "PLANFACT_API_KEY is missing. Add it to .env or the MCP client environment.",
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request<T>(
    path: string,
    options: {
      method?: HttpMethod;
      query?: Record<string, unknown>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const method = options.method || "GET";
    const url = this.buildUrl(path, options.query);
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-ApiKey": this.apiKey,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    const data = text ? this.parseJson(text) : null;

    if (!response.ok) {
      throw new Error(this.formatApiError(response.status, data));
    }

    if (this.isPlanFactFailure(data)) {
      throw new Error(this.formatApiError(response.status, data));
    }

    return data as T;
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const fullPath = normalizedPath.startsWith(PLANFACT_API_PREFIX)
      ? normalizedPath
      : `${PLANFACT_API_PREFIX}${normalizedPath}`;
    const url = new URL(`${this.baseUrl}${fullPath}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(key, String(item));
          }
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private formatApiError(status: number, data: unknown): string {
    if (data && typeof data === "object") {
      const errorBody = data as PlanFactErrorBody;
      const details = [
        errorBody.errorMessage,
        errorBody.errorCodeTitle,
        ...(errorBody.errors || []).map((error) => error.message),
      ].filter(Boolean);

      if (details.length > 0) {
        return `PlanFact API error ${status}: ${details.join("; ")}`;
      }
    }

    return `PlanFact API error ${status}. Check PLANFACT_API_KEY permissions and request parameters.`;
  }

  private isPlanFactFailure(data: unknown): boolean {
    return Boolean(
      data &&
        typeof data === "object" &&
        "isSuccess" in data &&
        (data as PlanFactErrorBody).isSuccess === false,
    );
  }
}
