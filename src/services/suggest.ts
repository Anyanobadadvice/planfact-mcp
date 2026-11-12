import type { PlanFactClient } from "./planfactClient.js";
import {
  isUnallocatedCategory,
  listAllOperations,
  loadUnallocatedCategoryIds,
  opCategories,
  opContrAgent,
  opId,
  opType,
  type Rec,
} from "./operations.js";

export interface Candidate {
  categoryId: number;
  categoryName?: string;
  count: number;
  lastDate: string;
  contrAgentId?: number;
  contrAgentName?: string;
}

const DAY_MS = 86_400_000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First two unicode-letter words (4..32 letters), at most 80 chars in total. */
export function significantWords(comment: unknown): string {
  if (typeof comment !== "string") return "";
  const words = comment.match(/(?<!\p{L})\p{L}{4,32}(?!\p{L})/gu) ?? [];
  return words.slice(0, 2).join(" ").slice(0, 80);
}

/** Suggest categories from the last 365 days of same-type operations of the same counterparty (or comment words). */
export async function suggest(
  client: PlanFactClient,
  op: Rec,
  unallocatedIds?: Set<number>,
): Promise<Candidate[]> {
  const ids = unallocatedIds ?? (await loadUnallocatedCategoryIds(client));
  const agent = opContrAgent(op);
  const filter: Record<string, unknown> = {
    "filter.operationDateStart": isoDay(new Date(Date.now() - 365 * DAY_MS)),
    "filter.operationDateEnd": isoDay(new Date()),
  };
  const type = opType(op);
  if (type) filter["filter.operationType"] = type;
  if (agent?.id != null) {
    filter["filter.contrAgentId"] = agent.id;
  } else {
    const search = significantWords(op.comment);
    if (!search) return [];
    filter["filter.searchString"] = search;
  }

  const selfId = opId(op);
  const history = await listAllOperations(client, filter);
  const groups = new Map<number, Candidate>();
  for (const h of history) {
    if (selfId != null && opId(h) === selfId) continue;
    const date = String(h.operationDate ?? "").slice(0, 10);
    const hAgent = opContrAgent(h);
    for (const cat of opCategories(h)) {
      if (isUnallocatedCategory(cat, ids) || cat?.id == null) continue;
      const g = groups.get(cat.id);
      if (g) {
        g.count += 1;
        if (date > g.lastDate) g.lastDate = date;
      } else {
        groups.set(cat.id, {
          categoryId: cat.id,
          categoryName: cat.title,
          count: 1,
          lastDate: date,
          ...(hAgent?.id != null ? { contrAgentId: hAgent.id } : {}),
          ...(hAgent?.title ? { contrAgentName: hAgent.title } : {}),
        });
      }
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0))
    .slice(0, 3);
}
