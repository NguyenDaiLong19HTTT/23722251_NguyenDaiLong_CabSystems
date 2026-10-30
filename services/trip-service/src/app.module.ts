import {Module} from '@nestjs/common';
import {TripDatabase} from './infrastructure/trip-database.js';
import {TripGrpcTransport} from './infrastructure/grpc-transport.js';
@Module({providers:[TripGrpcTransport]})
export class TripCoreModule {}
@Module({imports:[TripCoreModule],providers:[TripDatabase]})
export class TripModule {}
