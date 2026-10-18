import type { OperationScope, IntegrationChannel } from "@lsports/contracts";
export const embedded = /^\/embed\/[a-f0-9-]+\/[a-f0-9-]+\/sportsbook$/.test(
  location.pathname,
);
let accessToken = "";
let context:
  | (OperationScope & { channel: IntegrationChannel; terminalId?: string })
  | undefined;
export const getEmbedContext = () => context;
export function setEmbedContext(value: NonNullable<typeof context>) {
  context = value;
}
export function setEmbedAccess(value: string) {
  accessToken = value;
}
export function sportsbookApi(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (embedded) {
    if (!accessToken) return Promise.reject(Error("Sesión requerida"));
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  return fetch(`${embedded ? "/api/integration/v1" : "/api"}${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
  });
}
