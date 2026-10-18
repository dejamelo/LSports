export function serverConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT || 3001);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid API port");
  if (env.NODE_ENV === "production") {
    if (env.PLATFORM_ENABLED !== "true" || env.DATA_MODE !== "connected")
      throw new Error(
        "Production requires authenticated platform and connected data mode",
      );
    let origin: URL;
    try {
      origin = new URL(env.PLATFORM_PUBLIC_ORIGIN || "");
    } catch {
      throw new Error("Production requires PLATFORM_PUBLIC_ORIGIN HTTPS");
    }
    if (
      origin.protocol !== "https:" ||
      origin.origin !== env.PLATFORM_PUBLIC_ORIGIN ||
      origin.username ||
      origin.password
    )
      throw new Error("Production requires an exact HTTPS public origin");
  }
  return { port, host: env.HOST || "127.0.0.1" };
}
