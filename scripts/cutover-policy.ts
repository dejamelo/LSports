type Schedule = { nextAt: number; due: Record<string,number>; failures: Record<string,number> };
export function cutoverBarrier(schedules: unknown[], connections: unknown, now: number, refreshMs: number) {
  if (!schedules.length || !Number.isSafeInteger(refreshMs) || refreshMs < 60000 || !Number.isFinite(now)) throw new Error('COOLDOWN_UNPROVEN');
  let deadline=now+refreshMs;
  for (const value of schedules) {
    if (!value || typeof value!=='object') throw new Error('INVALID_SCHEDULE');
    const s=value as Schedule;
    if (!Number.isFinite(s.nextAt) || s.nextAt<0 || !s.due || !s.failures || Array.isArray(s.due)) throw new Error('INVALID_SCHEDULE');
    for (const n of [s.nextAt,...Object.values(s.due)]) {
      if (!Number.isFinite(n) || n<0) throw new Error('INVALID_SCHEDULE');
      deadline=Math.max(deadline,n);
    }
  }
  if (!connections || typeof connections!=='object' || !('prematch' in connections) || !('inplay' in connections)) throw new Error('LANE_EVIDENCE_MISSING');
  function walk(value:unknown,depth=0) {
    if (!value || typeof value!=='object' || depth>12) return;
    for (const [key,v] of Object.entries(value)) {
      if (key==='retryAt' || key==='lastSnapshotAttemptAt') {
        if (v===undefined || v===null) continue;
        if (typeof v!=='string' || !/Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error('INVALID_COOLDOWN_DATE');
        deadline=Math.max(deadline,Date.parse(v)+(key==='lastSnapshotAttemptAt'?refreshMs:0));
      } else walk(v,depth+1);
    }
  }
  walk(connections);
  return new Date(deadline+5000).toISOString(); // Positive clock/transport margin, never shortens a supplier deadline.
}
