import 'reflect-metadata';
import {NestFactory} from '@nestjs/core';
import type * as grpc from '@grpc/grpc-js';
import {readTlsFromEnvironment} from '@cab/grpc-transport';
import {RatingCoreModule,RatingModule} from '../app.module.js';
import {RatingCommands} from '../application/rating-commands.js';
import {RatingDatabase} from '../infrastructure/rating-database.js';
import {RatingGrpcTransport} from '../infrastructure/grpc-transport.js';

export async function bootstrapCoreSmoke() {
  return NestFactory.createApplicationContext(RatingCoreModule,{logger:false,abortOnError:false});
}
export async function bootstrapNetwork() {
  const app=await NestFactory.createApplicationContext(RatingModule,{logger:false,abortOnError:false});
  app.enableShutdownHooks();
  try {
    const address=process.env.RATING_SERVICE_GRPC_BIND;
    if(!address) throw new Error('Rating bind configuration missing');
    const commands=new RatingCommands(app.get(RatingDatabase).client);
    const wrap=(fn:(request:unknown,metadata:grpc.Metadata)=>Promise<unknown>)=>
      (call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>)=>{
        void fn(call.request,call.metadata).then(value=>callback(null,value),error=>callback(error));};
    try {await app.get(RatingGrpcTransport).start(readTlsFromEnvironment('RATING_SERVICE'),address,{
      CreateTripRating:wrap((request,metadata)=>commands.create(request,metadata)),
      GetTripRating:wrap((request,metadata)=>commands.get(request,metadata)),
      ListMyDriverRatings:wrap((request,metadata)=>commands.driverList(request,metadata)),
      ListOperationalRatings:wrap((request,metadata)=>commands.operationsList(request,metadata)),
    });} catch(error) {commands.close();throw error;}
    const close=app.close.bind(app);app.close=async()=>{commands.close();await close();};
    return app;
  } catch(error) {await app.close();throw error;}
}
