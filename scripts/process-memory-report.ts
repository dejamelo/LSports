import { basename } from "node:path";
const category = (command: string) => {
  const name = basename(command.trim());
  if (/^node(?:js)?$|^npm(?: run.*)?$|^tsx$/.test(name)) return "node_or_npm";
  if (/^(?:Google Chrome|Chromium)(?: Helper(?: \([A-Za-z ]+\))?)?$/.test(name))
    return "chrome_or_chromium";
  if (/^Safari$|^com\.apple\.WebKit\.[A-Za-z]+$/.test(name))
    return "safari_or_webkit";
  if (/^firefox$|^Firefox$|^firefox-bin$/.test(name)) return "firefox";
  if (
    /^(?:Docker|com\.docker\.[A-Za-z.]+|Virtualization|qemu-system-[A-Za-z0-9_]+)$/.test(
      name,
    )
  )
    return "docker_or_vm";
  if (/^(?:Code|Cursor|Electron)(?: Helper(?: \([A-Za-z ]+\))?)?$/.test(name))
    return "editor_or_electron";
  if (/^(?:WindowServer|kernel_task)$/.test(name)) return "system";
  return "other";
};
/** PS comm only, never args, environment, executable paths or unknown process names. */
export function processMemoryReport(
  output: string,
  workerPid?: number,
  collectorPid = process.pid,
) {
  const rows = output
    .split("\n")
    .flatMap((line) => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
      if (!m) return [];
      const pid = Number(m[1]),
        ppid = Number(m[2]),
        rssBytes = Number(m[3]) * 1024;
      if (
        ![pid, ppid, rssBytes].every(Number.isSafeInteger) ||
        pid < 1 ||
        rssBytes < 0
      )
        return [];
      return [
        {
          pid,
          ppid,
          rssBytes,
          category: category(m[4]),
          matchesWorkerLockPid: pid === workerPid,
          collector: pid === collectorPid,
        },
      ];
    })
    .sort((a, b) => b.rssBytes - a.rssBytes);
  return {
    processCount: rows.length,
    worker: rows.find((p) => p.matchesWorkerLockPid) ?? null,
    topProcesses: rows.slice(0, 25),
    nodeProcesses: rows.filter((p) => p.category === "node_or_npm"),
    note: "RSS includes shared pages; sums are not reclaimable RAM. A lock PID match alone is not proof of process identity. No process is stopped.",
  };
}
