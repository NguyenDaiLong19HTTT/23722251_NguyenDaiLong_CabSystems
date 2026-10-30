import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from './generated/client.js';

export interface ProvisionCommand { commandId:string; operationId:string; accountId:string; customerId:string }
export interface ProvisionResult { operation_id:string; account_id:string; customer_id:string; state:'PROVISIONED'|'PROVISION_CANCELLED' }
export class ProvisionConflict extends Error {}
export class ProvisionUnavailable extends Error {}
type Method = 'ProvisionCustomer'|'CancelCustomerProvision';

export class CustomerProvisionAdapter {
  private readonly receiptKey:Buffer;
  constructor(private readonly db:PrismaClient, keyFile:string) {
    try { this.receiptKey = Buffer.from(readFileSync(keyFile,'utf8').trim(),'base64url'); }
    catch { throw new Error('Customer receipt key configuration is invalid'); }
    if (this.receiptKey.length !== 32) throw new Error('Customer receipt key configuration is invalid');
  }
  private fingerprint(method:Method,command:ProvisionCommand):Buffer {
    return createHmac('sha256',this.receiptKey)
      .update(JSON.stringify([method,command.operationId,command.accountId,command.customerId]))
      .digest();
  }
  private async historical(method:Method,command:ProvisionCommand):Promise<ProvisionResult|null> {
    const rows = await this.db.$queryRaw<{fingerprint_hmac:Uint8Array;result_operation_id:string;
      result_account_id:string;result_customer_id:string;result_state:'PROVISIONED'|'PROVISION_CANCELLED'}[]>`
      SELECT fingerprint_hmac,result_operation_id,result_account_id,result_customer_id,result_state
      FROM customer_rpc_receipt WHERE caller_service='identity-service'
        AND full_method=${'/cab.internal.v1.CustomerInternalService/'+method}
        AND command_id=${command.commandId}::uuid`;
    const row = rows[0];
    if (!row) return null;
    const fingerprint = this.fingerprint(method,command);
    if (!timingSafeEqual(Buffer.from(row.fingerprint_hmac),fingerprint)) throw new ProvisionConflict('Command payload conflict');
    return {operation_id:row.result_operation_id,account_id:row.result_account_id,
      customer_id:row.result_customer_id,state:row.result_state};
  }
  async get(operationId:string):Promise<ProvisionResult|null> {
    const rows = await this.db.$queryRaw<ProvisionResult[]>`
      SELECT operation_id,account_id,customer_id,state FROM customer_provision
      WHERE operation_id=${operationId}`;
    return rows[0] ?? null;
  }
  private async mutate(method:Method,command:ProvisionCommand):Promise<ProvisionResult> {
    const historical = await this.historical(method,command);
    if (historical) return historical;
    const fingerprint = this.fingerprint(method,command);
    const state = method === 'ProvisionCustomer' ? 'PROVISIONED' : 'PROVISION_CANCELLED';
    try {
      return await this.db.$transaction(async tx => {
        const existing = await tx.$queryRaw<ProvisionResult[]>`
          SELECT operation_id,account_id,customer_id,state FROM customer_provision
          WHERE operation_id=${command.operationId} FOR UPDATE`;
        const found = existing[0];
        if (found && (found.account_id !== command.accountId || found.customer_id !== command.customerId))
          throw new ProvisionConflict('Provision binding conflict');
        if (method === 'ProvisionCustomer') {
          if (found) throw new ProvisionConflict('Provision fenced');
          await tx.$executeRaw`INSERT INTO customer_provision(operation_id,account_id,customer_id,state)
            VALUES (${command.operationId},${command.accountId}::uuid,${command.customerId}::uuid,'PROVISIONED')`;
          await tx.$executeRaw`INSERT INTO customer(customer_id,account_id,provision_operation_id)
            VALUES (${command.customerId}::uuid,${command.accountId}::uuid,${command.operationId})`;
        } else if (!found) {
          await tx.$executeRaw`INSERT INTO customer_provision
            (operation_id,account_id,customer_id,state,cancelled_at)
            VALUES (${command.operationId},${command.accountId}::uuid,${command.customerId}::uuid,
              'PROVISION_CANCELLED',now())`;
        } else if (found.state === 'PROVISIONED') {
          // The current slice has no completed Customer activity. Never delete a profile
          // whose version has advanced; coordinator must prove cancellation is allowed.
          const removed = await tx.$executeRaw`DELETE FROM customer WHERE customer_id=${command.customerId}::uuid
            AND account_id=${command.accountId}::uuid AND provision_operation_id=${command.operationId}
            AND version=1`;
          if (removed !== 1) throw new ProvisionConflict('Customer profile is no longer compensatable');
          await tx.$executeRaw`UPDATE customer_provision SET state='PROVISION_CANCELLED',
            cancelled_at=now(),updated_at=now(),version=version+1
            WHERE operation_id=${command.operationId} AND state='PROVISIONED'`;
        }
        const result:ProvisionResult = {operation_id:command.operationId,account_id:command.accountId,
          customer_id:command.customerId,state};
        await tx.$executeRaw`INSERT INTO customer_rpc_receipt(receipt_id,caller_service,full_method,
          command_id,operation_id,fingerprint_hmac,fingerprint_key_version,result_operation_id,
          result_account_id,result_customer_id,result_state)
          VALUES (${randomUUID()}::uuid,'identity-service',
            ${'/cab.internal.v1.CustomerInternalService/'+method},${command.commandId}::uuid,
            ${command.operationId},${fingerprint},'local-v1',${result.operation_id},
            ${result.account_id}::uuid,${result.customer_id}::uuid,${result.state})`;
        await tx.$executeRaw`INSERT INTO customer_audit(audit_id,operation_id,customer_id,action)
          VALUES (${randomUUID()}::uuid,${command.operationId},${command.customerId}::uuid,${state})`;
        return result;
      },{timeout:5000});
    } catch (error) {
      // A concurrent invocation with the same command can observe the provision
      // row after its first receipt check. Re-read the committed receipt before
      // treating that row as a different-command business conflict.
      if (error instanceof ProvisionConflict) {
        const replay = await this.historical(method,command);
        if (replay) return replay;
        throw error;
      }
      const replay = await this.historical(method,command);
      if (replay) return replay;
      // Unique conflicts are business conflicts; other failures are dependencies.
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const meta='meta' in error && typeof error.meta==='object' && error.meta!==null ?
          error.meta as Record<string,unknown> : {};
        if (['P2002','23505'].includes(String(error.code)) ||
            error.code==='P2010' && String(meta.code)==='23505')
          throw new ProvisionConflict('Provision uniqueness conflict');
      }
      throw new ProvisionUnavailable('Customer persistence unavailable');
    }
  }
  provision(command:ProvisionCommand):Promise<ProvisionResult> { return this.mutate('ProvisionCustomer',command); }
  cancel(command:ProvisionCommand):Promise<ProvisionResult> { return this.mutate('CancelCustomerProvision',command); }
}
