import 'reflect-metadata';
import {NestFactory} from '@nestjs/core';
import type * as grpc from '@grpc/grpc-js';
import {readTlsFromEnvironment} from '@cab/grpc-transport';
import {TripCoreModule,TripModule} from '../app.module.js';
import {TripCommands} from '../application/trip-commands.js';
import {TripDatabase} from '../infrastructure/trip-database.js';
import {TripGrpcTransport} from '../infrastructure/grpc-transport.js';
import {ClosureWorker} from '../infrastructure/closure-worker.js';
import {TripNotificationPublisher} from '../infrastructure/notification-publisher.js';

export async function bootstrapCoreSmoke() {
  return NestFactory.createApplicationContext(TripCoreModule,{logger:false,abortOnError:false});
}
export async function bootstrapNetwork() {
  const app=await NestFactory.createApplicationContext(TripModule,{logger:false,abortOnError:false});
  app.enableShutdownHooks();
  try {
    const address=process.env.TRIP_SERVICE_GRPC_BIND;
    if(!address) throw new Error('Trip bind configuration missing');
    const commands=new TripCommands(app.get(TripDatabase).client);
    const closureWorker=new ClosureWorker(app.get(TripDatabase).client,commands.owners);
    const publisher=new TripNotificationPublisher(app.get(TripDatabase).client);
    const wrap=(fn:(request:unknown,metadata:grpc.Metadata)=>Promise<unknown>)=>
      (call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>)=>{
        void fn(call.request,call.metadata).then(value=>callback(null,value),error=>callback(error));};
    try {await app.get(TripGrpcTransport).start(readTlsFromEnvironment('TRIP_SERVICE'),address,{
      PrepareTrip:wrap(request=>commands.prepare(request)),
      GetTripPreparation:wrap(request=>commands.getPreparation(request)),
      ActivateTrip:wrap(request=>commands.activate(request)),
      CancelTripPreparation:wrap(request=>commands.cancelPreparation(request)),
      GetClosureContext:wrap(request=>commands.internalClosure(request)),
      GetTripRatingContext:wrap((request,metadata)=>commands.ratingContext(request,metadata)),
      HasCustomerDriverTrip:wrap((request,metadata)=>commands.customerDriverRelation(request,metadata)),
      GetTripPaymentContext:wrap((request,metadata)=>commands.paymentContext(request,metadata)),
      GetActiveTripContactContext:wrap((request,metadata)=>commands.contactContext(request,metadata)),
      GetFareContext:wrap(request=>commands.fareContext()),
      RecordAssignedLocation:wrap(request=>commands.recordAssignedLocation(request)),
    },{
      GetTrip:wrap((request,metadata)=>commands.getTrip(request,metadata)),
      GetTripTracking:wrap((request,metadata)=>commands.tracking(request,metadata)),
      ListMyTrips:wrap((request,metadata)=>commands.list(request,metadata)),
      UpdateTripStatus:wrap((request,metadata)=>commands.status(request,metadata)),
      CancelTrip:wrap((request,metadata)=>commands.cancel(request,metadata)),
      ReportTripIncident:wrap((request,metadata)=>commands.incident(request,metadata)),
      GetTripClosure:wrap((request,metadata)=>commands.closure(request,metadata)),
      ResolveTripError:wrap((request,metadata)=>commands.resolveError(request,metadata)),
    });} catch(error) {commands.close();throw error;}
    closureWorker.start();
    publisher.start();
    const close=app.close.bind(app);app.close=async()=>{
      await closureWorker.close();await publisher.close();commands.close();await close();};
    return app;
  } catch(error) {await app.close();throw error;}
}
