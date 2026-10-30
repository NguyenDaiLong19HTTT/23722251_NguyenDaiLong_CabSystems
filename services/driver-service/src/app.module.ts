import { Module } from '@nestjs/common';
import { DriverConfig } from './infrastructure/runtime-config.js';
import { DriverGrpcTransport } from './infrastructure/grpc-transport.js';
import { DriverRuntime } from './infrastructure/runtime.js';
import { DriverPersistence, DRIVER_RUNTIME_DATABASE_URL } from './infrastructure/persistence.js';

@Module({providers:[DriverConfig,DriverRuntime,DriverGrpcTransport]})
export class DriverCoreModule {}
@Module({imports:[DriverCoreModule],providers:[
  {provide:DRIVER_RUNTIME_DATABASE_URL,useFactory:()=>{
    const value=process.env.CAB_DRIVER_RUNTIME_URL;
    if (!value) throw new Error('Driver runtime database configuration is missing');
    return value;
  }},DriverPersistence,
]})
export class DriverModule {}
