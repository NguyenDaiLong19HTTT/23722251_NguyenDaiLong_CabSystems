import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,afterEach,beforeEach,expect,it} from 'vitest';
import request from 'supertest';
import {createHttpApplication} from '../src/interfaces/bootstrap.js';
import {systemHealth} from '../src/interfaces/health-controller.js';

const names=['gateway','identity','customer','driver','booking','trip','payment','rating','notification'];
const directory=mkdtempSync(join(tmpdir(),'cab-health-test-'));
const prior=process.env.CAB_HEALTH_DIR;
beforeEach(()=>{process.env.CAB_HEALTH_DIR=directory;});
afterEach(()=>{
  for(const name of names) rmSync(join(directory,`${name}-probe.json`),{force:true});
});

function writeHealthy(now:number):void {
  for(const name of names) writeFileSync(join(directory,`${name}-probe.json`),JSON.stringify({
    checkedAt:now,checks:{listener:true,database:true,broker:true,mongo:true,workers:true}}));
}

it('reports READY only from all fresh successful service, data and worker probes',async()=>{
  const now=Date.now();writeHealthy(now);
  const app=await createHttpApplication();
  try {
    await app.init();
    expect((await request(app.getHttpServer()).get('/health').expect(200)).body).toEqual({status:'UP'});
    expect((await request(app.getHttpServer()).get('/ready').expect(200)).body).toEqual({status:'READY'});
    const report=systemHealth(now,directory);
    expect(report.services).toHaveLength(12);
    expect(report.services.map(item=>item.name)).toContain('mongo');
    expect(report.services.map(item=>item.name)).not.toContain('redis');
    const details=(await request(app.getHttpServer()).get('/health/services').expect(200)).body;
    expect(details.status).toBe('UP');
    expect(details.services).toHaveLength(12);
    expect((await request(app.getHttpServer()).get('/health/services')
      .set('Authorization','Bearer invalid-token').expect(200)).body.status).toBe('UP');
  } finally {await app.close();}
});

it('fails closed for a dependency failure and a stale heartbeat without touching demo infrastructure',async()=>{
  const now=Date.now();writeHealthy(now);
  writeFileSync(join(directory,'notification-probe.json'),JSON.stringify({checkedAt:now,
    checks:{listener:true,broker:true,mongo:false,workers:true}}));
  const app=await createHttpApplication();
  try {
    await app.init();
    expect((await request(app.getHttpServer()).get('/ready').expect(503)).body)
      .toEqual({status:'NOT_READY'});
    const failed=systemHealth(now,directory);
    expect(failed.services.find(item=>item.name==='notification-service')?.status).toBe('DOWN');
    expect(failed.services.find(item=>item.name==='mongo')?.status).toBe('DOWN');
    const publicFailure=(await request(app.getHttpServer()).get('/health/services').expect(503)).body;
    expect(publicFailure.status).toBe('DEGRADED');
    expect(publicFailure.services.find((item:{name:string})=>item.name==='mongo')?.status).toBe('DOWN');
    writeFileSync(join(directory,'notification-probe.json'),JSON.stringify({checkedAt:now-26000,
      checks:{listener:true,broker:true,mongo:true,workers:true}}));
    const stale=systemHealth(now,directory);
    expect(stale.services.find(item=>item.name==='notification-service')?.status).toBe('UNKNOWN');
    expect(stale.services.find(item=>item.name==='mongo')?.status).toBe('UNKNOWN');
  } finally {await app.close();}
});

afterEach(()=>{if(prior===undefined) delete process.env.CAB_HEALTH_DIR;
  else process.env.CAB_HEALTH_DIR=prior;});
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
