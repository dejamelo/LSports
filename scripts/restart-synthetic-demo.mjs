// Development-only restart. Never match processes by a broad npm/node/worker name.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const emit = (v) =>
  console.log(JSON.stringify({ operation: "synthetic.restart", ...v }));
const check = (ok, reason) => {
  if (!ok) throw Error(reason);
};
export function verifiedDemo(identity, expectedRoot, uid) {
  return (
    !!identity &&
    identity.uid === uid &&
    identity.cwd === expectedRoot &&
    identity.scriptVerified === true &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 1 &&
    !!identity.started
  );
}
const same = (a, b) =>
  a &&
  b &&
  a.pid === b.pid &&
  a.uid === b.uid &&
  a.started === b.started &&
  a.cwd === b.cwd &&
  a.scriptVerified === b.scriptVerified;
export async function stopVerifiedDemo({
  owners,
  inspect,
  signal,
  wait = delay,
  now = Date.now,
  expectedRoot,
  uid,
  timeout = 30000,
}) {
  const initial = await owners();
  if (initial.every((pids) => pids.length === 0))
    return { status: "not_running", signalSent: false };
  check(
    initial.length === 2 &&
      initial.every((pids) => pids.length === 1) &&
      initial[0][0] === initial[1][0],
    "DEMO_PORT_OWNERS_NOT_ONE_PROCESS",
  );
  const pid = initial[0][0],
    identity = await inspect(pid);
  check(
    verifiedDemo(identity, expectedRoot, uid),
    "DEMO_PROCESS_IDENTITY_UNVERIFIED_NO_SIGNAL",
  );
  const again = await owners();
  check(
    again.length === 2 &&
      again.every((pids) => pids.length === 1 && pids[0] === pid) &&
      same(identity, await inspect(pid)),
    "DEMO_IDENTITY_CHANGED_NO_SIGNAL",
  );
  signal(pid, "SIGTERM"); // One normal signal to the verified demo only. Never force.
  const deadline = now() + timeout;
  while (now() < deadline) {
    const current = await inspect(pid);
    if (!same(identity, current)) {
      check(
        (await owners()).every((pids) => pids.length === 0),
        "DEMO_PORTS_NOT_RELEASED_NO_START",
      );
      return { status: "stopped", signalSent: true };
    }
    await wait(250);
  }
  throw Error("DEMO_SHUTDOWN_TIMEOUT_NO_MORE_SIGNALS");
}
async function command(bin, args) {
  try {
    return (
      await exec(bin, args, {
        cwd: root,
        env: { ...process.env, LC_ALL: "C" },
        timeout: 5000,
        maxBuffer: 65536,
      })
    ).stdout;
  } catch (error) {
    if (error.code === 1 && !error.stdout) return "";
    throw Error("DEMO_INSPECTION_FAILED_NO_RAW_OUTPUT");
  }
}
async function owners(ports = [3101, 5174]) {
  return Promise.all(
    ports.map(async (port) => [
      ...new Set(
        (
          await command("lsof", [
            "-nP",
            "-a",
            "-iTCP:" + port,
            "-sTCP:LISTEN",
            "-t",
          ])
        )
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number),
      ),
    ]),
  );
}
async function inspect(pid) {
  const [uid, started, cmd, cwd, parentPid] = await Promise.all([
    command("ps", ["-p", String(pid), "-o", "uid="]),
    command("ps", ["-p", String(pid), "-o", "lstart="]),
    command("ps", ["-p", String(pid), "-o", "command="]),
    command("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]),
    command("ps", ["-p", String(pid), "-o", "ppid="]),
  ]);
  if (!started.trim()) return null;
  const directories = cwd
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
  return {
    pid,
    uid: Number(uid.trim()),
    parentPid: Number(parentPid.trim()),
    controllerVerified:/^(?:\S*\/)?node\s+(?:\S*\/)?scripts\/restart-synthetic-demo\.mjs\s*$/.test(cmd.trim()),
    started: started.trim(),
    cwd: directories.length === 1 ? directories[0] : "",
    scriptVerified:
      /^(?:\S*\/)?node\s+--import(?:=|\s+)tsx\s+(?:\S*\/)?scripts\/synthetic-demo\.ts\s*$/.test(
        cmd.trim(),
      ),
  };
}
async function main() {
  check(process.env.NODE_ENV !== "production", "SYNTHETIC_DEVELOPMENT_ONLY");
  const lease = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      lease.once("error", () => reject(Error("DEMO_RESTART_ALREADY_RUNNING")));
      lease.listen(
        { host: "127.0.0.1", port: 43763, exclusive: true },
        resolve,
      );
    });
    // Older versions held 43762 for the entire demo lifetime. Verify that
    // exact controller and its listening child before requesting normal stop.
    const [legacy] = await owners([43762]);
    if(legacy.length){
      check(legacy.length===1,'LEGACY_DEMO_CONTROLLER_UNVERIFIED');
      const controller=await inspect(legacy[0]),listening=await owners();
      check(listening.every(pids=>pids.length===1)&&listening[0][0]===listening[1][0],'LEGACY_DEMO_CHILD_UNVERIFIED');
      const child=await inspect(listening[0][0]),expectedRoot=await realpath(root);
      check(controller?.controllerVerified&&controller.uid===process.getuid()&&controller.cwd===expectedRoot&&verifiedDemo(child,expectedRoot,process.getuid())&&child.parentPid===controller.pid,'LEGACY_DEMO_CONTROLLER_UNVERIFIED');
      await stopVerifiedDemo({owners:async()=>{const [ids]=await owners([43762]);return [ids,ids];},inspect:async pid=>{const owner=await inspect(pid);return owner?{...owner,scriptVerified:owner.controllerVerified}:null;},signal:process.kill,expectedRoot,uid:process.getuid()});
      emit({stage:'legacy_demo_controller',status:'stopped',workersChanged:false});
    }
    const result = await stopVerifiedDemo({
      owners,
      inspect,
      signal: process.kill,
      expectedRoot: await realpath(root),
      uid: process.getuid(),
    });
    emit({ stage: "previous_demo", ...result, workersChanged: false });
    check(
      (await owners()).every((pids) => pids.length === 0),
      "DEMO_PORTS_IN_USE_NO_START",
    );
    emit({
      stage: "start_demo",
      status: "starting",
      workersChanged: false,
      productionChanged: false,
    });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/synthetic-demo.ts"],
      { cwd: root, stdio: "inherit" },
    );
    let stopRequested=false;const stop = () => {stopRequested=true;child.kill("SIGTERM");};
    process.once("SIGTERM", stop);
    const closed=new Promise((resolve,reject)=>{child.once("error",()=>reject(Error("DEMO_START_FAILED")));child.once("close",resolve);});void closed.catch(()=>{});
    try {
      const deadline=Date.now()+20000;let ready=false;
      while(Date.now()<deadline&&child.exitCode===null){
        try{const response=await fetch('http://localhost:3101/api/control/status',{signal:AbortSignal.timeout(1000)});if(response.ok&&response.headers.get('X-ADL-Test-Only')==='synthetic-isolated'&&(await response.json()).initialized===true){const listeners=await owners();if(listeners.every(ids=>ids.length===1&&ids[0]===child.pid)){ready=true;break;}}}catch{}
        await delay(100);
      }
      if(stopRequested){process.exitCode=(await closed)??0;return;}
      check(ready,'DEMO_NOT_READY_NO_FORCE');
      // Exclusion protects restart/start, not the entire lifetime of the demo.
      await new Promise(resolve=>lease.close(resolve));
      emit({stage:'demo_ready',status:'ok',restartLeaseReleased:true,workersChanged:false});
      const code = await closed;
      process.exitCode = code ?? 1;
    } finally {
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    if (lease.listening) await new Promise((resolve) => lease.close(resolve));
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  main().catch((error) => {
    emit({
      status: "blocked",
      reason: /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "DEMO_RESTART_FAILED",
      workersChanged: false,
      note: "No forced shutdown or broad process matching. Existing data preserved; no raw commands, secrets or errors printed.",
    });
    process.exitCode = 2;
  });
