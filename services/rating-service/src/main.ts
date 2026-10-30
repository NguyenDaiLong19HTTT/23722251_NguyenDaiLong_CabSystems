import {bootstrapNetwork} from './interfaces/bootstrap.js';
import {describeStartupFailure} from '@cab/grpc-transport';
try {await bootstrapNetwork();console.info('rating-service: mTLS gRPC listener initialized.');
  process.send?.({type:'cab-ready'});}
catch(error) {console.error(`rating-service: bootstrap failed: ${describeStartupFailure(error)}`);
  process.exitCode=1;}
