import {Module} from '@nestjs/common';
import {NotificationMongoStore} from './infrastructure/mongo-store.js';
import {NotificationQueries} from './application/queries.js';
import {NotificationGrpcTransport} from './infrastructure/grpc-transport.js';

@Module({providers:[NotificationMongoStore,NotificationQueries,NotificationGrpcTransport]})
export class NotificationModule {}
