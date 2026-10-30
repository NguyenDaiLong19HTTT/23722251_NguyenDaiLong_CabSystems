import 'reflect-metadata';
import {NestFactory} from '@nestjs/core';
import * as grpc from '@grpc/grpc-js';
import {readTlsFromEnvironment} from '@cab/grpc-transport';
import {NotificationModule} from '../app.module.js';
import {NotificationQueries} from '../application/queries.js';
import {NotificationDelivery} from '../application/delivery.js';
import {NotificationMongoStore} from '../infrastructure/mongo-store.js';
import {NotificationGrpcTransport} from '../infrastructure/grpc-transport.js';

export async function bootstrapNetwork() {
  const app=await NestFactory.createApplicationContext(NotificationModule,
    {logger:false,abortOnError:false});
  app.enableShutdownHooks();
  const queries=app.get(NotificationQueries);
  const delivery=new NotificationDelivery(app.get(NotificationMongoStore));
  try {
    const address=process.env.NOTIFICATION_SERVICE_GRPC_BIND;
    if (!address) throw new Error('Notification bind missing');
    await delivery.start();
    const wrap=(fn:(request:unknown,metadata:grpc.Metadata)=>Promise<unknown>)=>
      (call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>)=>{
        void fn(call.request,call.metadata).then(value=>callback(null,value),error=>callback(error));
      };
    await app.get(NotificationGrpcTransport).start(readTlsFromEnvironment('NOTIFICATION_SERVICE'),
      address,{ListMyNotifications:wrap((request,metadata)=>queries.list(request,metadata)),
        MarkMyNotificationRead:wrap((request,metadata)=>queries.read(request,metadata))});
    const close=app.close.bind(app);
    app.close=async()=>{await delivery.close();queries.close();await close();};
    return app;
  } catch(error) {await delivery.close();queries.close();await app.close();throw error;}
}
