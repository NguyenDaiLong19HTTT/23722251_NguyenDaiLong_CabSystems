import {X509Certificate,createPrivateKey} from 'node:crypto';
import {certificateIdentity,identityPrefix} from '../../packages/grpc-transport/dist/index.js';

export const maxWorkloadLifetimeMs=24*60*60*1000;

export function validWorkloadWindow(cert,now=Date.now(),minimumRemainingMs=0) {
  const from=Date.parse(cert.validFrom),to=Date.parse(cert.validTo);
  return Number.isFinite(from)&&Number.isFinite(to)&&from<=now&&
    to>now+minimumRemainingMs&&to>from&&to-from<=maxWorkloadLifetimeMs;
}

export function validateWorkload(bytes,{name,ca,key,now=Date.now(),minimumRemainingMs=0}) {
  const cert=new X509Certificate(bytes);
  const purpose=name==='gateway'?'client':'server';
  const service=name==='gateway'?'api-gateway':`${name}-service`;
  if(!validWorkloadWindow(cert,now,minimumRemainingMs)||
      certificateIdentity(bytes,purpose)!==identityPrefix+service||
      (name!=='gateway'&&certificateIdentity(bytes,'client')!==identityPrefix+service)||
      !cert.verify(new X509Certificate(ca).publicKey)||
      !cert.checkPrivateKey(createPrivateKey(key)))
    throw new Error(`Invalid ${name} workload certificate`);
  return cert;
}
