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

// ---- Real PlanFact operation shape (verified on live API) -----------------------------------
// operationId (no `id`); account {accountId,title,currencyCode}; operationCategory {operationCategoryId,title}
// (id 0 / title null = none); top-level contrAgent/project may be null, per-part values live in
// operationParts[i] = {operationPartId, calculationDate, isCalculationCommitted,
// contrAgent{contrAgentId,title,isUndistributed}, project{projectId,...}, operationCategory{...}, value}.
// There are NO flat accountId/contrAgentId/operationCategoryId/projectId fields.

export function opId(op: Rec): number | undefined {
  return op.operationId != null ? Number(op.operationId) : undefined;
}

export function opType(op: Rec): string | undefined {
  return op.operationType ?? op.type;
}

export function opParts(op: Rec): Rec[] {
  return Array.isArray(op.operationParts) ? op.operationParts.filter(isRecord) : [];
}

export interface Ref {
  id?: number;
  title?: string;
}

function catRef(c: unknown): Ref | null {
  if (!isRecord(c)) return null;
  const id = c.operationCategoryId != null ? Number(c.operationCategoryId) : undefined;
  if (!id && !c.title) return null; // id 0 / null and no title = no category
  return { id: id || undefined, title: typeof c.title === "string" ? c.title : undefined };
}

/** Every category of the operation: top-level one if set, else each part's. */
export function opCategories(op: Rec): Array<Ref | null> {
  const top = catRef(op.operationCategory);
  if (top) return [top];
  const parts = opParts(op);
  if (parts.length === 0) return [null];
  return parts.map((p) => catRef(p.operationCategory));
}

/** The first category (used for display and history grouping). */
export function opCategory(op: Rec): Ref | null {
  return opCategories(op)[0] ?? null;
}

export interface Agent {
  id?: number;
  title?: string;
}

/** Counterparty: part-level first, then top-level. «Не выбран» (isUndistributed) = none. */
export function opContrAgent(op: Rec): Agent | null {
  const candidates = [opParts(op)[0]?.contrAgent, op.contrAgent];
  for (const c of candidates) {
    if (!isRecord(c) || c.isUndistributed === true) continue;
    const id = c.contrAgentId != null ? Number(c.contrAgentId) : undefined;
    if (!id && !c.title) continue;
    return { id, title: typeof c.title === "string" ? c.title : undefined };
  }
  return null;
}

export const UNALLOCATED_RE = /нераспредел/i;

export function isUnallocatedCategory(cat: Ref | null, unallocatedIds?: Set<number>): boolean {
  if (!cat) return true;
  if (cat.id == null && !cat.title) return true;
  if (typeof cat.title === "string" && UNALLOCATED_RE.test(cat.title)) return true;
  return cat.id != null && !!unallocatedIds?.has(cat.id);
}

export function isUnallocatedOperation(op: Rec, ids?: Set<number>): boolean {
  return opCategories(op).some((c) => isUnallocatedCategory(c, ids));
}

/** Ids of «нераспределённые» categories (one request). */
export async function loadUnallocatedCategoryIds(client: PlanFactClient): Promise<Set<number>> {
  const categories = extractItems(
    await client.request<unknown>("/operationcategories", {
      query: { "paging.offset": 0, "paging.limit": 1000 },
    }),
  );
  const ids = new Set<number>();
  for (const c of categories) {
    if (typeof c.title === "string" && UNALLOCATED_RE.test(c.title)) {
      const id = c.operationCategoryId ?? c.id;
      if (id != null) ids.add(Number(id));
    }
  }
  return ids;
}

/** Fetch every page of GET /operations (paging.*); throws when truncated or when paging does not advance. */
export async function listAllOperations(
  client: PlanFactClient,
  filter: Record<string, unknown>,
  opts: { limit?: number; maxPages?: number } = {},
): Promise<Rec[]> {
  const limit = opts.limit ?? 1000;
  const maxPages = opts.maxPages ?? 20;
  const all: Rec[] = [];
  const seen = new Set<number>();
  for (let page = 0; page < maxPages; page++) {
    const data = await client.request<unknown>("/operations", {
      query: { ...filter, "paging.offset": page * limit, "paging.limit": limit },
    });
    const items = extractItems(data);
    let fresh = 0;
    for (const it of items) {
      const id = opId(it);
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      all.push(it);
      fresh++;
    }
    if (items.length < limit) return all;
    if (fresh === 0) {
      throw new Error("PlanFact paging did not advance (a page returned no new operationIds); aborting.");
    }
  }
  throw new Error(
    `Result exceeds ${maxPages * limit} operations (page cap reached); narrow the period or filters.`,
  );
}

/** Single-operation GET: `/operations/{id}` (verified on live PlanFact API). Validates operationId. */
export async function fetchOperation(client: PlanFactClient, operationId: number): Promise<Rec> {
  const data = await client.request<unknown>(`/operations/${operationId}`);
  const operation = isRecord(data) && isRecord(data.data) ? data.data : null;
  if (!operation || Number(operation.operationId) !== operationId) {
    throw new Error(`Operation ${operationId} not found`);
  }
  return operation;
}

// ---- Canonical update payload ---------------------------------------------------------------

export const PAYLOAD_FIELDS = [
  "operationDate",
  "accountId",
  "value",
  "comment",
  "isCommitted",
  "operationCategoryId",
  "contrAgentId",
  "projectId",
  "calculationDate",
  "isCalculationCommitted",
  "externalId",
] as const;
export type PayloadField = (typeof PAYLOAD_FIELDS)[number];

/** Fields that live on operationParts[i] (cannot be edited safely on a split operation). */
export const PART_FIELDS: PayloadField[] = [
  "operationCategoryId",
  "value",
  "calculationDate",
  "projectId",
  "contrAgentId",
  "isCalculationCommitted",
];

function positive(n: unknown): number | undefined {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** flat field -> nested object id -> operationParts[0] -> undefined */
export function fieldOf(current: Rec, name: PayloadField): unknown {
  const part = opParts(current)[0] ?? {};
  switch (name) {
    case "accountId":
      return current.accountId ?? positive(current.account?.accountId);
    case "operationCategoryId":
      return (
        current.operationCategoryId ??
        positive(current.operationCategory?.operationCategoryId) ??
        positive(part.operationCategory?.operationCategoryId)
      );
    case "contrAgentId":
      return (
        current.contrAgentId ??
        positive(part.contrAgent?.contrAgentId) ??
        positive(current.contrAgent?.contrAgentId)
      );
    case "projectId":
      return (
        current.projectId ??
        positive(part.project?.projectId) ??
        positive(current.project?.projectId)
      );
    case "calculationDate":
      return current.calculationDate ?? part.calculationDate;
    case "isCalculationCommitted":
      return part.isCalculationCommitted ?? current.isCalculationCommitted;
    case "value":
      return current.value ?? part.value;
    default:
      return current[name] ?? undefined;
  }
}

export type Changes = Partial<Record<PayloadField, unknown>>;

/**
 * Refuses edits touching a closed month: the current operationDate / calculationDate
 * (top level or operationParts[0]) or the new ones in `changes`, month <= closedThrough (YYYY-MM).
 * closedThrough unset -> no check.
 */
export function assertOpenPeriod(
  current: Rec,
  changes: Changes,
  closedThrough: string | undefined = process.env.PLANFACT_CLOSED_THROUGH,
): void {
  if (!closedThrough || !/^\d{4}-\d{2}$/.test(closedThrough)) return;
  const part = opParts(current)[0] ?? {};
  const dates = [
    ["current operationDate", current.operationDate],
    ["current calculationDate", current.calculationDate],
    ["current calculationDate", part.calculationDate],
    ["new operationDate", changes.operationDate],
    ["new calculationDate", changes.calculationDate],
  ] as const;
  for (const [label, d] of dates) {
    if (typeof d === "string" && /^\d{4}-\d{2}/.test(d) && d.slice(0, 7) <= closedThrough) {
      throw new Error(`closed period: ${label} ${d.slice(0, 10)} is in a closed month (through ${closedThrough})`);
    }
  }
}

/**
 * Builds the PUT body explicitly from the fixed field list (never spreads the GET object).
 * Mirrors the shape of the create payload: flat fields plus items[0] for single-part operations.
 */
export function buildUpdatePayload(
  current: Rec,
  changes: Changes,
): { body: Rec; before: Rec; after: Rec } {
  const multi = opParts(current).length > 1;
  if (multi && PART_FIELDS.some((f) => changes[f] !== undefined)) {
    throw new Error("split operation: edit in PlanFact UI");
  }
  const body: Rec = {};
  const before: Rec = {};
  const after: Rec = {};
  for (const name of PAYLOAD_FIELDS) {
    const old = fieldOf(current, name);
    const nu = changes[name];
    if (multi && PART_FIELDS.includes(name) && name !== "value") continue; // not ours to resend
    const val = nu !== undefined ? nu : old;
    if (val !== undefined) body[name] = val;
    if (nu !== undefined && JSON.stringify(nu) !== JSON.stringify(old)) {
      before[name] = old ?? null;
      after[name] = nu;
    }
  }
  if (!multi) {
    const item: Rec = {};
    for (const k of ["calculationDate", "isCalculationCommitted", "value", "contrAgentId", "operationCategoryId", "projectId"]) {
      if (body[k] !== undefined) item[k] = body[k];
    }
    body.items = [item];
  }
  return { body, before, after };
}
