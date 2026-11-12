import type { PlanFactClient } from "./planfactClient.js";
import {
  isUnallocatedCategory,
  listAllOperations,
  opCategory,
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

/** First two words of the comment with >= 4 letters and no digits. */
export function significantWords(comment: unknown): string {
  if (typeof comment !== "string") return "";
  return comment
    .split(/[\s,.;:()"«»]+/)
    .filter((w) => w.length >= 4 && !/\d/.test(w))
    .slice(0, 2)
    .join(" ");
}

/** Suggest categories from the last 365 days of same-type operations of the same counterparty (or comment words). */
export async function suggest(client: PlanFactClient, op: Rec): Promise<Candidate[]> {
  const contrAgentId: number | undefined = op.contrAgent?.id ?? op.contrAgentId ?? undefined;
  const filter: Record<string, unknown> = {
    "filter.operationDateStart": isoDay(new Date(Date.now() - 365 * DAY_MS)),
    "filter.operationDateEnd": isoDay(new Date()),
  };
  const type = opType(op);
  if (type) filter["filter.operationType"] = type;
  if (contrAgentId != null) {
    filter["filter.contrAgentId"] = contrAgentId;
  } else {
    const search = significantWords(op.comment);
    if (!search) return [];
    filter["filter.searchString"] = search;
  }

  const history = await listAllOperations(client, filter);
  const groups = new Map<number, Candidate>();
  for (const h of history) {
    if (h.id === op.id) continue;
    const cat = opCategory(h);
    if (isUnallocatedCategory(cat) || cat?.id == null) continue;
    const date = String(h.operationDate ?? "").slice(0, 10);
    const g = groups.get(cat.id);
    if (g) {
      g.count += 1;
      if (date > g.lastDate) g.lastDate = date;
    } else {
      const agentId = h.contrAgent?.id ?? h.contrAgentId;
      groups.set(cat.id, {
        categoryId: cat.id,
        categoryName: cat.title,
        count: 1,
        lastDate: date,
        ...(agentId != null ? { contrAgentId: agentId } : {}),
        ...(h.contrAgent?.title ? { contrAgentName: h.contrAgent.title } : {}),
      });
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0))
    .slice(0, 3);
}
