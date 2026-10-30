import {Module} from '@nestjs/common';
import {RatingDatabase} from './infrastructure/rating-database.js';
import {RatingGrpcTransport} from './infrastructure/grpc-transport.js';
@Module({providers:[RatingGrpcTransport]})
export class RatingCoreModule {}
@Module({imports:[RatingCoreModule],providers:[RatingDatabase]})
export class RatingModule {}
