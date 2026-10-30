import {readFileSync} from 'node:fs';
try {
  const stamp=Number(readFileSync('/tmp/nearby-demo-heartbeat','utf8'));
  if(!Number.isFinite(stamp)||stamp>Date.now()+1000||Date.now()-stamp>25000)
    throw new Error('stale');
} catch {
  console.error('Nearby demo GPS feed is not ready');
  process.exitCode=1;
}
