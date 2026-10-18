import { PlatformStore } from "../platform.js";
import { TenantTickets } from "../tenant-tickets.js";
import type { EventFeed } from "@lsports/contracts";
const platform = new PlatformStore(process.argv[2], true),
  registry = new TenantTickets(platform),
  op = platform.operation(process.argv[3])!;
const store = registry.store(op.id);
const feed = {
  mode: "connected",
  updatedAt: new Date().toISOString(),
  connections: { prematch: { phase: "connected" } },
  events: [
    {
      id: "prematch:9001",
      source: "prematch",
      available: true,
      status: 1,
      markets: [
        {
          id: "160",
          name: "ISOLATED",
          status: 1,
          selections: [
            {
              id: "runner",
              label: "ISOLATED",
              available: true,
              status: 1,
              odds: 2,
            },
          ],
        },
      ],
    },
  ],
} as EventFeed;
process.once("message", () => {
  try {
    const ticket = store.create(
      {
        clientId: op.clientId,
        operationId: op.id,
        currency: op.currency,
        stakeMinor: "600",
        channel: process.argv[5],
        selections: [
          {
            eventId: "prematch:9001",
            marketId: "160",
            selectionId: "runner",
            expectedOdds: 2,
          },
        ],
      },
      "stable-player",
      process.argv[4],
      () => feed,
    );
    process.send?.({ status: "accepted", id: ticket.id });
  } catch (error) {
    process.send?.({
      status: "rejected",
      code: (error as { code?: string }).code || "FAILED",
    });
  } finally {
    registry.close();
    platform.close();
    process.disconnect();
  }
});
process.send?.({ ready: true });
