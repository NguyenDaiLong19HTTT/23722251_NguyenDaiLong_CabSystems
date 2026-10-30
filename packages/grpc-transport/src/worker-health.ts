import {writeFileSync} from 'node:fs';

// A successful worker iteration is observable by the Compose health probe.
// Disabled outside Compose; health reporting must never change business results.
export function markWorkerHealthy(service:string,worker:string):void {
  const directory=process.env.CAB_HEALTH_DIR;
  if (!directory) return;
  if (!/^[a-z-]+$/.test(service)||!/^[a-z-]+$/.test(worker)) return;
  try {writeFileSync(`${directory}/${service}-${worker}`,String(Date.now()));}
  catch { /* The probe reports a missing/stale heartbeat. */ }
}
