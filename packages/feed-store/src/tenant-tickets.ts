import { OperationTickets } from "./operation-tickets.js";
import { PlatformStore } from "./platform.js";
import type { EventFeed } from "@lsports/contracts";

// Snapshot projections expose settlement metadata as lazy iterables. Replaying
// those iterables independently for every operation repeats a full walk over
// millions of selections. Share the small result sets across tenant stores,
// but bound retained objects so a large settlement batch cannot consume the
// worker's checkpoint heap reserve.
export const MAX_SHARED_RECONCILIATION_RECORDS = 16_384;
export function sharedReconciliationFeed(feed: EventFeed): EventFeed {
  let remaining = MAX_SHARED_RECONCILIATION_RECORDS;
  const collect = <T>(source: Iterable<T> | undefined): T[] | undefined => {
    if (!source) return [];
    if (Array.isArray(source)) return source;
    const values: T[] = [];
    for (const value of source) {
      if (values.length >= remaining) return undefined;
      values.push(value);
    }
    remaining -= values.length;
    return values;
  };
  const ticketOutcomes = collect(feed.ticketOutcomes);
  const ticketVersionRecoveries = collect(feed.ticketVersionRecoveries);
  if (ticketOutcomes === undefined || ticketVersionRecoveries === undefined)
    return feed;
  return { ...feed, ticketOutcomes, ticketVersionRecoveries };
}

export class TenantTickets {
  private stores = new Map<string, OperationTickets>();
  constructor(private platform: PlatformStore) {}
  store(operationId: string) {
    if (!this.platform.operation(operationId))
      throw new Error("Unknown operation");
    let store = this.stores.get(operationId);
    if (!store) {
      store = new OperationTickets(this.platform, operationId);
      this.stores.set(operationId, store);
    }
    return store;
  }
  reconcile(feed: EventFeed) {
    const shared = sharedReconciliationFeed(feed);
    for (const id of this.platform.allOperationIds())
      this.store(id).reconcile(shared);
  }
  close() {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}
