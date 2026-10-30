import 'reflect-metadata';
import {NestFactory} from '@nestjs/core';
import type * as grpc from '@grpc/grpc-js';
import {readTlsFromEnvironment} from '@cab/grpc-transport';
import {BookingCoreModule,BookingModule} from '../app.module.js';
import {BookingDatabase} from '../infrastructure/booking-database.js';
import {BookingGrpcTransport} from '../infrastructure/grpc-transport.js';
import {BookingCommands} from '../application/booking-commands.js';
import {DispatchWorker} from '../infrastructure/dispatch-worker.js';
import {BookingNotificationPublisher} from '../infrastructure/notification-publisher.js';

export async function bootstrapCoreSmoke() {
  return NestFactory.createApplicationContext(BookingCoreModule,
    {logger:false,abortOnError:false});
}
export async function bootstrapNetwork() {
  const app=await NestFactory.createApplicationContext(BookingModule,
    {logger:false,abortOnError:false});
  app.enableShutdownHooks();
  try {
    const address=process.env.BOOKING_SERVICE_GRPC_BIND;
    if(!address) throw new Error('Booking bind configuration missing');
    const commands=new BookingCommands(app.get(BookingDatabase).client);
    const wrap=(fn:(request:unknown,metadata:grpc.Metadata)=>Promise<unknown>)=>
      (call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>)=>{
        void fn(call.request,call.metadata).then(value=>callback(null,value),error=>callback(error));};
    try {await app.get(BookingGrpcTransport).start(readTlsFromEnvironment('BOOKING_SERVICE'),
      address,{
        GetAssignmentDecision:wrap(request=>commands.assignmentDecision(request)),
        GetBookingGuardDecision:wrap(request=>commands.guardDecision(request)),
        GetBookingPaymentContext:wrap(request=>commands.paymentContext(request)),
      },{
        CreateBooking:wrap((request,metadata)=>commands.create(request,metadata)),
        GetBookingOperation:wrap((request,metadata)=>commands.operation(request,metadata)),
        ListMyBookings:wrap((request,metadata)=>commands.list(request,metadata)),
        GetBooking:wrap((request,metadata)=>commands.get(request,metadata)),
        GetBookingStatus:wrap((request,metadata)=>commands.status(request,metadata)),
        CancelBooking:wrap((request,metadata)=>commands.cancel(request,metadata)),
        GetDispatchStatus:wrap((request,metadata)=>commands.dispatchStatus(request,metadata)),
        ListMyPendingTripRequests:wrap((request,metadata)=>commands.driverOffers(request,metadata)),
        GetMyTripRequest:wrap((request,metadata)=>commands.driverOffer(request,metadata)),
        AcceptTripRequest:wrap((request,metadata)=>commands.accept(request,metadata)),
        RejectTripRequest:wrap((request,metadata)=>commands.reject(request,metadata)),
        GetMyAssignmentOperation:wrap((request,metadata)=>
          commands.assignmentOperation(request,metadata)),
      });} catch(error) {commands.close();throw error;}
    const worker=new DispatchWorker(commands);
    const publisher=new BookingNotificationPublisher(app.get(BookingDatabase).client);
    worker.start();publisher.start();
    const close=app.close.bind(app);app.close=async()=>{
      await worker.close();await publisher.close();commands.close();await close();};
    return app;
  } catch(error) {await app.close();throw error;}
}
