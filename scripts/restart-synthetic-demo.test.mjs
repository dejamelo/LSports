import { test } from "node:test";
import assert from "node:assert/strict";
import { stopVerifiedDemo } from "./restart-synthetic-demo.mjs";
const identity = {
  pid: 123,
  uid: 1000,
  cwd: "/test/demo",
  started: "same-start",
  scriptVerified: true,
};
const options = () => ({
  owners: async () => [[123], [123]],
  inspect: async () => identity,
  signal: () => assert.fail("No signal expected"),
  wait: async () => {},
  expectedRoot: "/test/demo",
  uid: 1000,
});
test("unrelated service, worker, different user or directory never receives a signal", async () => {
  for (const change of [
    { scriptVerified: false },
    { uid: 0 },
    { cwd: "/other" },
  ])
    await assert.rejects(
      stopVerifiedDemo({
        ...options(),
        inspect: async () => ({ ...identity, ...change }),
      }),
      /IDENTITY_UNVERIFIED_NO_SIGNAL/,
    );
});
test("split ports and PID reuse before shutdown are rejected without signals", async () => {
  await assert.rejects(
    stopVerifiedDemo({ ...options(), owners: async () => [[123], [456]] }),
    /OWNERS_NOT_ONE_PROCESS/,
  );
  let reads = 0;
  await assert.rejects(
    stopVerifiedDemo({
      ...options(),
      inspect: async () => ({
        ...identity,
        started: ++reads === 1 ? "same-start" : "new-start",
      }),
    }),
    /IDENTITY_CHANGED_NO_SIGNAL/,
  );
});
test("single SIGTERM, confirmed original exit and released ports permit restart", async () => {
  let reads = 0,
    signals = 0,
    ports = 0;
  const result = await stopVerifiedDemo({
    ...options(),
    inspect: async () => (++reads <= 2 ? identity : null),
    owners: async () => (++ports <= 2 ? [[123], [123]] : [[], []]),
    signal: (pid, sig) => {
      assert.equal(pid, 123);
      assert.equal(sig, "SIGTERM");
      signals++;
    },
  });
  assert.equal(result.status, "stopped");
  assert.equal(signals, 1);
});
test("shutdown timeout never escalates or repeats a signal", async () => {
  let clock = 0,
    signals = 0;
  await assert.rejects(
    stopVerifiedDemo({
      ...options(),
      now: () => clock++,
      timeout: 2,
      signal: () => signals++,
    }),
    /TIMEOUT_NO_MORE_SIGNALS/,
  );
  assert.equal(signals, 1);
});
test("no existing demo requires no process signal", async () =>
  assert.equal(
    (await stopVerifiedDemo({ ...options(), owners: async () => [[], []] }))
      .status,
    "not_running",
  ));

test(
  "restart command replaces only an isolated real demo and preserves its manifest",
  { timeout: 30000 },
  async (t) => {
    const { execFile, spawn } = await import("node:child_process"),
      { promisify } = await import("node:util"),
      fs = await import("node:fs/promises"),
      { tmpdir } = await import("node:os"),
      path = await import("node:path"),
      { fileURLToPath, pathToFileURL } = await import("node:url");
    const exec = promisify(execFile);
    for (const port of [3101, 5174, 43762, 43763]) {
      try {
        const { stdout } = await exec("lsof", [
          "-nP",
          "-iTCP:" + port,
          "-sTCP:LISTEN",
          "-t",
        ]);
        if (stdout.trim()) {
          t.skip("Isolated test ports occupied; no process touched.");
          return;
        }
      } catch (error) {
        if (error.code !== 1) throw error;
      }
    }
    const root = await fs.mkdtemp(path.join(tmpdir(), "adl-demo-restart-")),
      repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await fs.symlink(
      path.join(repo, "node_modules"),
      path.join(root, "node_modules"),
      "dir",
    );
    await fs.copyFile(
      path.join(repo, "scripts/restart-synthetic-demo.mjs"),
      path.join(root, "scripts/restart-synthetic-demo.mjs"),
    );
    await fs.writeFile(
      path.join(root, "scripts/synthetic-demo.ts"),
      `import {startSyntheticDemo} from ${JSON.stringify(pathToFileURL(path.join(repo, "scripts/synthetic-demo.ts")).href)};const demo=await startSyntheticDemo({directory:${JSON.stringify(path.join(root, "isolated-data"))}});console.log('isolated-demo-ready');for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>void demo.close());`,
    );
    let old, helper, replacement;
    const ready = (child, marker="isolated-demo-ready") =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("Isolated demo not ready")),
          10000,
        );
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
          if (out.includes(marker)) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (!out.includes(marker))
            reject(Error("Isolated demo exited " + code));
        });
        child.stderr.resume();
      });
    const exited = (child) =>
      child.exitCode !== null
        ? Promise.resolve(child.exitCode)
        : new Promise((resolve) => child.once("exit", resolve));
    try {
      const modern=await fs.readFile(path.join(root,'scripts/restart-synthetic-demo.mjs'),'utf8');
      // Reproduce the released controller that held its port while the demo ran.
      await fs.writeFile(path.join(root,'scripts/restart-synthetic-demo.mjs'),`import{createServer}from'node:net';import{spawn}from'node:child_process';const lease=createServer();await new Promise(r=>lease.listen(43762,'127.0.0.1',r));const child=spawn(process.execPath,['--import','tsx','scripts/synthetic-demo.ts'],{stdio:'inherit'});process.once('SIGTERM',()=>child.kill('SIGTERM'));await new Promise(r=>child.once('exit',r));await new Promise(r=>lease.close(r));`);
      old=spawn(process.execPath,['scripts/restart-synthetic-demo.mjs'],{cwd:root,stdio:['ignore','pipe','pipe']});
      await ready(old);
      await fs.writeFile(path.join(root,'scripts/restart-synthetic-demo.mjs'),modern);
      const manifest = await fs.readFile(
        path.join(root, "isolated-data/manifest.json"),
        "utf8",
      );
      helper = spawn(process.execPath, ["scripts/restart-synthetic-demo.mjs"], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await ready(helper,'"stage":"demo_ready"');
      assert.equal(await exited(old), 0);
      assert.equal(
        await fs.readFile(
          path.join(root, "isolated-data/manifest.json"),
          "utf8",
        ),
        manifest,
      );
      replacement=spawn(process.execPath,['scripts/restart-synthetic-demo.mjs'],{cwd:root,stdio:['ignore','pipe','pipe']});
      await ready(replacement,'"stage":"demo_ready"');assert.equal(await exited(helper),0);
      replacement.kill('SIGTERM');assert.equal(await exited(replacement),0);
    } finally {
      if(replacement&&replacement.exitCode===null){replacement.kill('SIGTERM');await exited(replacement);}
      if (helper && helper.exitCode === null) {
        helper.kill("SIGTERM");
        await exited(helper);
      }
      if (old && old.exitCode === null) {
        old.kill("SIGTERM");
        await exited(old);
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
