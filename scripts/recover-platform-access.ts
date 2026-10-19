// Local operator recovery. No email, public reset endpoint, secrets in argv or logs.
import { fstatSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { PlatformStore, platformDirectory } from "@lsports/feed-store/platform";
let store: PlatformStore | undefined;
try {
  const input = fstatSync(0),
    directory = platformDirectory(),
    db = lstatSync(join(directory, "control.sqlite"));
  if (
    !input.isFile() ||
    input.mode & 0o077 ||
    input.uid !== process.getuid?.() ||
    input.size > 4096 ||
    !db.isFile() ||
    db.isSymbolicLink()
  )
    throw Error();
  const data = JSON.parse(readFileSync(0, "utf8"));
  if (data.action !== "recover_platform_access") throw Error();
  store = new PlatformStore(directory);
  await store.recoverPlatformAccess(data.email, data.newPassword);
  console.log(
    JSON.stringify({
      operation: "platform.access.recovery",
      status: "ok",
      sessionsRevoked: true,
      audited: true,
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      operation: "platform.access.recovery",
      status: "blocked",
      note: "Use an existing platform database and a private owner-only regular JSON file on stdin. No secrets or raw errors printed.",
    }),
  );
  process.exitCode = 2;
} finally {
  store?.close();
}
