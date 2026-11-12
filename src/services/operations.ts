import {
  PLANFACT_INCOME_OPERATION_PATH,
  PLANFACT_OUTCOME_OPERATION_PATH,
} from "../constants.js";
import type { PlanFactClient } from "./planfactClient.js";

export type Rec = Record<string, any>;

export function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** PlanFact list responses: { data: { items } } | { items } | [..] */
export function extractItems(data: unknown): Rec[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];
  if (isRecord(data.data) && Array.isArray(data.data.items)) return data.data.items.filter(isRecord);
  for (const key of ["items", "operations", "data"]) {
    if (Array.isArray(data[key])) return (data[key] as unknown[]).filter(isRecord);
  }
  return [];
}

export function opType(op: Rec): string | undefined {
  return op.operationType ?? op.type;
}

export function opCategory(op: Rec): { id?: number; title?: string } | null {
  if (isRecord(op.operationCategory)) return op.operationCategory;
  if (op.operationCategoryId != null) return { id: op.operationCategoryId };
  return null;
}

export const UNALLOCATED_RE = /нераспредел/i;

export function isUnallocatedCategory(cat: { id?: number; title?: string } | null): boolean {
  return !cat || (typeof cat.title === "string" && UNALLOCATED_RE.test(cat.title));
}

/** Fetch every page of GET /operations for a filter (paging.*). */
export async function listAllOperations(
  client: PlanFactClient,
  filter: Record<string, unknown>,
  maxPages = 20,
): Promise<Rec[]> {
  const limit = 1000;
  const all: Rec[] = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await client.request<unknown>("/operations", {
      query: { ...filter, "paging.offset": page * limit, "paging.limit": limit },
    });
    const items = extractItems(data);
    all.push(...items);
    if (items.length < limit) break;
  }
  return all;
}

/**
 * Single-operation GET: `${endpoint}/${id}`. The operation type is unknown to the caller,
 * so income is tried first and outcome second.
 */
export async function fetchOperation(
  client: PlanFactClient,
  operationId: number,
  operationType?: "Income" | "Outcome",
): Promise<{ operation: Rec; endpoint: string }> {
  const candidates =
    operationType === "Outcome"
      ? [PLANFACT_OUTCOME_OPERATION_PATH]
      : operationType === "Income"
        ? [PLANFACT_INCOME_OPERATION_PATH]
        : [PLANFACT_INCOME_OPERATION_PATH, PLANFACT_OUTCOME_OPERATION_PATH];
  let lastError: unknown;
  for (const endpoint of candidates) {
    try {
      const data = await client.request<unknown>(`${endpoint}/${operationId}`);
      const operation = isRecord(data) && isRecord(data.data) ? data.data : data;
      if (isRecord(operation)) return { operation, endpoint };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? new Error(`Operation ${operationId} not found: ${lastError.message}`)
    : new Error(`Operation ${operationId} not found`);
}
