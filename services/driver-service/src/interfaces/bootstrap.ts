import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DriverCoreModule,DriverModule } from '../app.module.js';
import { DriverGrpcTransport } from '../infrastructure/grpc-transport.js';
import { DriverPersistence } from '../infrastructure/persistence.js';
import { readTlsFromEnvironment } from '@cab/grpc-transport';
import { DriverNotificationPublisher } from '../infrastructure/notification-publisher.js';
import { DriverLocationHandoff } from '../infrastructure/location-handoff.js';
import { TripVehicleLookup } from '../application/trip-vehicle.js';
import type * as grpc from '@grpc/grpc-js';

export async function bootstrapCoreSmoke() {
  return NestFactory.createApplicationContext(DriverCoreModule,{logger:false,abortOnError:false});
}
export async function bootstrapNetwork() {
  const app=await NestFactory.createApplicationContext(DriverModule,{logger:false,abortOnError:false});
  app.enableShutdownHooks();
  try {
    const address=process.env.DRIVER_SERVICE_GRPC_BIND;
    if (!address) throw new Error('Missing Driver gRPC bind configuration');
    const { DriverCommands }=await import('../application/driver-commands.js');
    const commands=new DriverCommands(app.get(DriverPersistence).client);
    const {DriverApplications}=await import('../application/driver-applications.js');
    const applications=new DriverApplications(app.get(DriverPersistence).client);
    const {DriverDispatchCandidates}=await import('../application/dispatch-candidates.js');
    const candidates=new DriverDispatchCandidates(app.get(DriverPersistence).client);
    const {NearbyDrivers}=await import('../application/nearby-drivers.js');
    const nearby=new NearbyDrivers(app.get(DriverPersistence).client);
    const {DriverReservations}=await import('../application/driver-reservations.js');
    const reservations=new DriverReservations(app.get(DriverPersistence).client);
    const publisher=process.env.CAB_DRIVER_AMQPS_URL
      ?new DriverNotificationPublisher(app.get(DriverPersistence).client):undefined;
    const handoff=new DriverLocationHandoff(app.get(DriverPersistence).client);
    const tripVehicle=new TripVehicleLookup(app.get(DriverPersistence).client);
    const wrap=(fn:(request:unknown,metadata:grpc.Metadata)=>Promise<unknown>)=>
      (call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>)=>{
        void fn(call.request,call.metadata).then(value=>callback(null,value),error=>callback(error));
      };
    try {
      await app.get(DriverGrpcTransport).start(readTlsFromEnvironment('DRIVER_SERVICE'),address,{
        GetMyDriverProfile:wrap((request,metadata)=>commands.profile(request,metadata)),
        GetDriverById:wrap((request,metadata)=>commands.publicProfile(request,metadata)),
        SetMyDriverAvailability:wrap((request,metadata)=>commands.availability(request,metadata)),
        UpdateMyDriverLocation:wrap((request,metadata)=>commands.location(request,metadata)),
        SearchNearbyDrivers:wrap((request,metadata)=>nearby.search(request,metadata)),
      },{
        GetMyDriverApplication:wrap((request,metadata)=>applications.my(request,metadata)),
        ListDriverApplications:wrap((request,metadata)=>applications.list(request,metadata)),
        GetDriverApplication:wrap((request,metadata)=>applications.detail(request,metadata)),
        ReviewDriverApplication:wrap((request,metadata)=>applications.review(request,metadata)),
      },{
        ProvisionDriver:wrap(request=>applications.provision(request)),
        GetDriverProvision:wrap(request=>applications.getProvision(request)),
        CancelDriverProvision:wrap(request=>applications.cancelProvision(request)),
        FindDispatchCandidates:wrap(request=>candidates.find(request)),
        ReserveDriver:wrap(request=>reservations.reserve(request)),
        GetReservation:wrap(request=>reservations.get(request)),
        BindReservation:wrap(request=>reservations.bind(request)),
        CancelReservation:wrap(request=>reservations.cancel(request)),
        ReleaseReservation:wrap(request=>reservations.release(request)),
        GetTripVehicle:wrap((request,metadata)=>tripVehicle.get(request,metadata)),
        CheckTripRestoreEligibility:wrap(request=>reservations.checkTripRestore(request)),
      });
      const close=app.close.bind(app);
      publisher?.start();
      handoff.start();
      app.close=async()=>{await handoff.close();await publisher?.close();commands.close();applications.close();candidates.close();nearby.close();reservations.close();tripVehicle.close();await close();};
      return app;
    } catch(error) {await handoff.close();await publisher?.close();commands.close();applications.close();candidates.close();nearby.close();reservations.close();tripVehicle.close();throw error;}
  } catch(error) {await app.close();throw error;}
}
