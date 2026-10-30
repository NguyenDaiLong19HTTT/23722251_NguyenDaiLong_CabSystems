import {describeStartupFailure} from '@cab/grpc-transport';
import {bootstrapNetwork} from './interfaces/bootstrap.js';

try {
  await bootstrapNetwork();
  console.info('notification-service: MongoDB, AMQPS consumer and mTLS listener initialized.');
  process.send?.({type:'cab-ready'});
} catch(error) {
  console.error(`notification-service: bootstrap failed: ${describeStartupFailure(error)}`);
  process.exitCode=1;
}
