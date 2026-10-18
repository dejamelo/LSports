export function homologationAdmission(
  env: NodeJS.ProcessEnv,
  now = Date.now(),
) {
  if (env.ADL_CAPACITY_APPROVED !== "yes")
    return { allowed: false, reason: "capacity_not_reviewed" };
  if (env.ADL_MAC_WORKER_STOPPED !== "yes")
    return { allowed: false, reason: "mac_shutdown_not_confirmed" };
  const time = env.ADL_SUPPLIER_NOT_BEFORE_UTC || "";
  const timestamp = Date.parse(time);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(time) ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().replace(".000Z", "Z") !==
      time.replace(".000Z", "Z")
  )
    return { allowed: false, reason: "supplier_cooldown_not_confirmed" };
  if (now < timestamp)
    return { allowed: false, reason: "supplier_cooldown_pending" };
  return { allowed: true, reason: "operator_confirmed" };
}
