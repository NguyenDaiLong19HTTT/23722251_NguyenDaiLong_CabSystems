import {readFileSync} from 'node:fs';
import {Controller,Get,Res} from '@nestjs/common';
import type {Response} from 'express';

type Check='listener'|'database'|'broker'|'mongo'|'workers';
type Probe={checkedAt:number;checks:Partial<Record<Check,boolean>>};
type Component={name:string;status:'UP'|'DOWN'|'UNKNOWN';checkedAt:string;reasonCode?:string};
const services=['identity','customer','driver','booking','trip','payment','rating','notification'] as const;
const database=['identity','customer','driver','booking','trip','payment','rating'] as const;
const brokers=['driver','booking','trip','payment','notification'] as const;
const maxAge=25000;

function snapshot(name:string,now:number,directory:string):Probe|undefined {
  try {
    const value:unknown=JSON.parse(readFileSync(`${directory}/${name}-probe.json`,'utf8'));
    if(typeof value!=='object'||value===null||!('checkedAt' in value)||!('checks' in value))
      return undefined;
    const probe=value as Probe;
    if(!Number.isFinite(probe.checkedAt)||probe.checkedAt>now+1000||
        now-probe.checkedAt>maxAge||typeof probe.checks!=='object'||!probe.checks)
      return undefined;
    return probe;
  } catch {return undefined;}
}
function component(name:string,now:number,probes:Map<string,Probe|undefined>,
  dependencies:readonly string[],check:Check):Component {
  const checkedAt=new Date(dependencies.every(dep=>probes.get(dep))?
    Math.min(...dependencies.map(dep=>probes.get(dep)!.checkedAt)):now).toISOString();
  if(dependencies.some(dep=>!probes.get(dep)))
    return {name,status:'UNKNOWN',checkedAt,reasonCode:'NOT_CHECKED'};
  if(dependencies.some(dep=>probes.get(dep)?.checks[check]!==true))
    return {name,status:'DOWN',checkedAt,reasonCode:'PROBE_FAILED'};
  return {name,status:'UP',checkedAt};
}
export function systemHealth(now=Date.now(),directory=process.env.CAB_HEALTH_DIR??'/cab-health'):
  {status:'UP'|'DEGRADED';checkedAt:string;services:Component[]} {
  const probes=new Map<string,Probe|undefined>(services.map(name=>[name,snapshot(name,now,directory)]));
  probes.set('gateway',snapshot('gateway',now,directory));
  const components:Component[]=[component('gateway',now,probes,['gateway'],'listener')];
  for(const service of services) {
    const probe=probes.get(service);
    const required:Check[]=['listener'];
    if((database as readonly string[]).includes(service)) required.push('database');
    if((brokers as readonly string[]).includes(service)) required.push('broker');
    if(service==='notification') required.push('mongo');
    if(['identity','driver','booking','trip','payment','notification'].includes(service))
      required.push('workers');
    components.push(!probe?{name:`${service}-service`,status:'UNKNOWN',
      checkedAt:new Date(now).toISOString(),reasonCode:'NOT_CHECKED'}:
      required.some(check=>probe.checks[check]!==true)?
        {name:`${service}-service`,status:'DOWN',checkedAt:new Date(probe.checkedAt).toISOString(),
          reasonCode:probe.checks.workers===false?'WORKER_HEARTBEAT_STALE':'PROBE_FAILED'}:
        {name:`${service}-service`,status:'UP',checkedAt:new Date(probe.checkedAt).toISOString()});
  }
  components.push(component('postgres',now,probes,database,'database'));
  components.push(component('rabbitmq',now,probes,brokers,'broker'));
  components.push(component('mongo',now,probes,['notification'],'mongo'));
  return {status:components.every(item=>item.status==='UP')?'UP':'DEGRADED',
    checkedAt:new Date(now).toISOString(),services:components};
}

@Controller()
export class HealthController {
  @Get('health')
  liveness(@Res() response:Response):void {
    response.setHeader('Cache-Control','no-store');
    response.status(200).json({status:'UP'});
  }
  @Get('ready')
  readiness(@Res() response:Response):void {
    response.setHeader('Cache-Control','no-store');
    const report=systemHealth();
    response.status(report.status==='UP'?200:503).json({status:report.status==='UP'?'READY':'NOT_READY'});
  }
  @Get('health/services')
  details(@Res() response:Response):void {
    response.setHeader('Cache-Control','no-store');
    const report=systemHealth();
    response.status(report.status==='UP'?200:503).json(report);
  }
}
