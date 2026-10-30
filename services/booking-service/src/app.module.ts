import {Module} from '@nestjs/common';
import {BookingDatabase} from './infrastructure/booking-database.js';
import {BookingGrpcTransport} from './infrastructure/grpc-transport.js';
@Module({providers:[BookingGrpcTransport]})
export class BookingCoreModule {}
@Module({imports:[BookingCoreModule],providers:[BookingDatabase]})
export class BookingModule {}
