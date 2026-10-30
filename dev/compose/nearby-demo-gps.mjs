// Development-only GPS feed for five nearby plus one Postman accept Driver.
import {readFileSync,writeFileSync} from 'node:fs';

if(process.env.NODE_ENV==='production'||process.env.CAB_DEMO_NEARBY_GPS_ENABLED!=='1')
  throw new Error('Nearby demo GPS feed is disabled');
const fixturePath=process.env.CAB_NEARBY_FIXTURE_FILE??'/cab-demo/drivers.json';
const healthPath=process.env.CAB_NEARBY_HEALTH_FILE??'/tmp/nearby-demo-heartbeat';
const base=process.env.CAB_GATEWAY_INTERNAL_URL??'http://api-gateway:33201';
const priorityDriverId=process.env.CAB_DEMO_PRIORITY_DRIVER_ID;
const drivers=JSON.parse(readFileSync(fixturePath,'utf8'));
if(!Array.isArray(drivers)||drivers.length<5||drivers.length>6||
    new Set(drivers.map(item=>item.driverId)).size!==drivers.length||
    drivers.some(item=>typeof item.email!=='string'||typeof item.password!=='string'||
      !Number.isFinite(item.latitude)||!Number.isFinite(item.longitude)))
  throw new Error('Five or six valid nearby demo Drivers are required');
if(priorityDriverId&&!drivers.some(item=>item.driverId===priorityDriverId))
  throw new Error('Priority demo Driver is missing from the fixture');
const tokens=new Map();
async function call(path,{method='GET',token,body}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(token?{Authorization:`Bearer ${token}`}:{ }),
    ...(body?{'Content-Type':'application/json'}:{ })},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  return {status:response.status,body:await response.json()};
}
async function login(item) {
  const result=await call('/v1/auth/login',{method:'POST',body:{
    emailOrPhone:item.email,password:item.password}});
  if(result.status!==200||typeof result.body.accessToken!=='string')
    throw new Error('Fixture login failed');
  tokens.set(item.driverId,result.body.accessToken);
  return result.body.accessToken;
}
async function authorized(item,path,options={}) {
  let token=tokens.get(item.driverId)??await login(item);
  let result=await call(path,{...options,token});
  if(result.status===401) {
    token=await login(item);
    result=await call(path,{...options,token});
  }
  return result;
}
async function cycle() {
  let refreshed=0;
  for(const item of drivers) {
    const profile=await authorized(item,'/v1/drivers/me');
    if(profile.status!==200||profile.body.driver?.driverId!==item.driverId||
        profile.body.driver?.approvalStatus!=='APPROVED'||
        profile.body.vehicle?.vehicleType!=='MOTORBIKE'||
        profile.body.vehicle?.vehicleStatus!=='ACTIVE')
      throw new Error('Demo Driver is no longer eligible');
    const status=profile.body.driver?.driverStatus;
    if(status==='BUSY'||status==='OFFLINE'&&item.driverId!==priorityDriverId) continue;
    if(status!=='AVAILABLE'&&status!=='OFFLINE')
      throw new Error('Demo Driver status is invalid');
    const location=await authorized(item,'/v1/drivers/me/location',{
      method:'PUT',body:{latitude:item.latitude,longitude:item.longitude,
        recordedAt:new Date(Date.now()-1000).toISOString()}});
    if(location.status!==200) throw new Error('Demo GPS update failed');
    if(status==='OFFLINE') {
      const availability=await authorized(item,'/v1/drivers/me/availability',{
        method:'PUT',body:{expectedVersion:profile.body.driver.version,
          driverStatus:'AVAILABLE'}});
      if(availability.status===409&&['VERSION_CONFLICT','RESOURCE_RESERVED'].includes(
          availability.body?.errorCode)) continue;
      if(availability.status!==200||availability.body?.driverStatus!=='AVAILABLE')
        throw new Error('Priority demo Driver availability update failed');
    }
    refreshed++;
  }
  if(refreshed<5) throw new Error('Fewer than five demo Drivers are available');
  writeFileSync(healthPath,String(Date.now()));
}
if(process.argv.includes('--once')) {
  await cycle();
  console.log(`${drivers.length} demo GPS locations refreshed through authenticated Gateway requests.`);
} else {
  let stopping=false,wake;
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
    stopping=true;wake?.();
  });
  while(!stopping) {
    try {await cycle();}
    catch {console.error('Nearby demo GPS refresh failed; retrying');}
    if(stopping) break;
    await new Promise(resolve=>{
      const timer=setTimeout(resolve,12000);
      wake=()=>{clearTimeout(timer);resolve();};
    });
    wake=undefined;
  }
}
