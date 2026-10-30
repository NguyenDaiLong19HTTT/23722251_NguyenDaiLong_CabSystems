import { GatewayGrpcClients } from './infrastructure/grpc-clients.js';
import { Module } from '@nestjs/common';
import { GatewayConfig } from './infrastructure/runtime-config.js';
import { GatewayRuntime } from './infrastructure/runtime.js';
import { CustomerController } from './interfaces/customer-controller.js';
import { DriverController } from './interfaces/driver-controller.js';
import { DriverRegistrationController } from './interfaces/driver-registration-controller.js';
import { NotificationController } from './interfaces/notification-controller.js';
import { PaymentController } from './interfaces/payment-controller.js';
import { TripController } from './interfaces/trip-controller.js';
import { BookingController } from './interfaces/booking-controller.js';
import { RatingController } from './interfaces/rating-controller.js';
import { BookingCreateLimiter } from './infrastructure/booking-create-limiter.js';
import { HealthController } from './interfaces/health-controller.js';

@Module({
  controllers: [HealthController,CustomerController,DriverController,DriverRegistrationController,
    NotificationController,PaymentController,TripController,BookingController,RatingController],
  providers: [GatewayGrpcClients, GatewayConfig, GatewayRuntime, BookingCreateLimiter],
})
export class GatewayModule {}
