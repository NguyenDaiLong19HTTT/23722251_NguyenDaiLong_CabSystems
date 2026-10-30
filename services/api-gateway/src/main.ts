import { bootstrap } from './interfaces/bootstrap.js';
import { describeStartupFailure } from '@cab/grpc-transport';

try {
  await bootstrap();
  console.info('api-gateway: HTTP listener initialized.');
  process.send?.({type:'cab-ready'});
} catch (error) {
  console.error(`api-gateway: bootstrap failed: ${describeStartupFailure(error)}`);
  process.exitCode = 1;
}
