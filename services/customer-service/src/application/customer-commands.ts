import { Injectable } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import { CustomerPersistence } from '../infrastructure/persistence.js';
import type { PrismaClient } from '../infrastructure/prisma/generated/client.js';
import { CustomerProvisionAdapter, ProvisionConflict, ProvisionUnavailable } from
  '../infrastructure/prisma/provision-adapter.js';
import type { ProvisionCommand } from '../infrastructure/prisma/provision-adapter.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function status(code:grpc.status,details:string):grpc.ServiceError {
  return Object.assign(new Error(details),{code,details,metadata:new grpc.Metadata()});
}
@Injectable()
export class CustomerCommands {
  private adapter?:CustomerProvisionAdapter;
  constructor(private readonly persistence:CustomerPersistence) {}
  private get db():CustomerProvisionAdapter {
    if (!this.adapter) {
      const keyFile = process.env.CAB_CUSTOMER_RECEIPT_KEY_FILE;
      if (!keyFile) throw new Error('Customer receipt key configuration is missing');
      this.adapter = new CustomerProvisionAdapter(this.persistence.client as PrismaClient,keyFile);
    }
    return this.adapter;
  }
  ensureReady():void { void this.db; }
  private command(value:unknown,cancel=false):ProvisionCommand {
    const request = value as Record<string,unknown>;
    const c = request?.command as Record<string,unknown> | undefined;
    const commandId = c?.command_id, operationId = c?.operation_id;
    const accountId = request?.account_id;
    const customerId = request?.[cancel ? 'profile_id' : 'customer_id'];
    if (typeof commandId !== 'string' || !uuid.test(commandId) ||
        typeof operationId !== 'string' || operationId.length < 1 || operationId.length > 128 ||
        typeof accountId !== 'string' || !uuid.test(accountId) ||
        typeof customerId !== 'string' || !uuid.test(customerId))
      throw status(grpc.status.INVALID_ARGUMENT,'Invalid provision command');
    return {commandId,operationId,accountId,customerId};
  }
  async provision(request:unknown) {
    try { return await this.db.provision(this.command(request)); }
    catch (error) { throw this.map(error); }
  }
  async cancel(request:unknown) {
    try { return await this.db.cancel(this.command(request,true)); }
    catch (error) { throw this.map(error); }
  }
  async get(request:unknown) {
    const id = (request as Record<string,unknown>)?.id;
    if (typeof id !== 'string' || !id || id.length > 128)
      throw status(grpc.status.INVALID_ARGUMENT,'Invalid operation identifier');
    try {
      const row = await this.db.get(id);
      if (!row) throw status(grpc.status.NOT_FOUND,'Provision not found');
      return row;
    } catch (error) { throw this.map(error); }
  }
  private map(error:unknown):grpc.ServiceError {
    if (error instanceof ProvisionConflict) return status(grpc.status.ALREADY_EXISTS,'Provision conflict');
    if (error instanceof ProvisionUnavailable) return status(grpc.status.UNAVAILABLE,'Customer persistence unavailable');
    if (typeof error === 'object' && error !== null && 'code' in error) return error as grpc.ServiceError;
    return status(grpc.status.UNAVAILABLE,'Customer operation unavailable');
  }
}
