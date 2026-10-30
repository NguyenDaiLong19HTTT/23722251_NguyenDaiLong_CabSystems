import {Module} from '@nestjs/common';
import {PaymentDatabase} from './infrastructure/payment-database.js';
import {PaymentGrpcTransport} from './infrastructure/grpc-transport.js';

@Module({providers:[PaymentGrpcTransport]})
export class PaymentCoreModule {}
@Module({imports:[PaymentCoreModule],providers:[PaymentDatabase]})
export class PaymentModule {}
