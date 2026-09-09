// v0.1.598 — Alle Firmen eines Vorgangs seitenweise laden. Das Gateway
// erlaubt pageSize max 200; groessere Werte antworten mit 400 (das war die
// Ursache fuer "gateway 400" im Warten-Node und im stillen Vorgangs-Watcher).

export interface TransactionEntityRow {
  companyId: string;
  state?: string;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 25;

export async function fetchAllTransactionEntities(
  gatewayRequest: <T>(path: string) => Promise<T>,
  transactionId: string,
): Promise<TransactionEntityRow[]> {
  const out: TransactionEntityRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await gatewayRequest<{ items?: TransactionEntityRow[]; total?: number }>(
      `/v1/transactions/${encodeURIComponent(transactionId)}/entities?page=${page}&pageSize=${PAGE_SIZE}`,
    );
    const items = r.items ?? [];
    out.push(...items);
    if (items.length < PAGE_SIZE) break;
    if (typeof r.total === "number" && out.length >= r.total) break;
  }
  return out;
}
