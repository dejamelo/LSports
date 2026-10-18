import { OperationTickets } from "./operation-tickets.js";
import { PlatformStore } from "./platform.js";
import type { EventFeed } from "@lsports/contracts";
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
    for (const id of this.platform.allOperationIds())
      this.store(id).reconcile(feed);
  }
  close() {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}
