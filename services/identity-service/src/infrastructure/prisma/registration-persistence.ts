import type { PrismaClient } from './generated/client.js';

// Persistence boundary only. The caller must authenticate/verify the Customer
// response before invoking this method. Matching fields cannot prove its origin.
// After commit a repeated call conflicts; caller must query the durable outcome,
// never retry a mutation blindly or assume this helper is idempotent.
export async function persistConfirmedCompensation(
  client: PrismaClient,
  binding: {
    operationId: string; accountId: string; customerId: string; expectedVersion: bigint;
    cancelCommandId: string; safeErrorCode: string;
    confirmedCancellation: { operationId: string; accountId: string; customerId: string; state: 'PROVISION_CANCELLED' };
  },
): Promise<boolean> {
  if (binding.confirmedCancellation.state !== 'PROVISION_CANCELLED' ||
      binding.confirmedCancellation.operationId !== binding.operationId ||
      binding.confirmedCancellation.accountId !== binding.accountId ||
      binding.confirmedCancellation.customerId !== binding.customerId) {
    throw new Error('Customer cancellation evidence does not match registration');
  }
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(binding.safeErrorCode)) {
    throw new Error('Registration failure reason is not a safe code');
  }
  return client.$transaction(async tx => {
    const stepCount = await tx.$executeRaw`
      UPDATE registration_step SET step_state='CONFIRMED',updated_at=now()
      WHERE operation_id=${binding.operationId} AND step_kind='CANCEL_CUSTOMER_PROVISION'
        AND command_id=${binding.cancelCommandId}::uuid
        AND step_state IN ('READY','OUTCOME_UNKNOWN')`;
    if (stepCount !== 1) throw new Error('Customer cancellation step conflict');
    const changed = await tx.$queryRaw<{ account_id: string }[]>`
      UPDATE registration_operation SET
        public_status = 'FAILED', internal_phase = 'FAILED',
        customer_provision_state = 'PROVISION_CANCELLED',
        terminal_error_code = ${binding.safeErrorCode},
        terminal_at = now(), public_lookup_until = now() + interval '168 hours',
        updated_at = now(), version = version + 1
      WHERE operation_id = ${binding.operationId} AND account_id = ${binding.accountId}::uuid
        AND target_profile_id = ${binding.customerId}::uuid
        AND version = ${binding.expectedVersion} AND internal_phase = 'COMPENSATING'
        AND public_status = 'PROCESSING'
      RETURNING account_id`;
    if (changed.length !== 1) throw new Error('Registration compensation state conflict');
    await tx.$executeRaw`
      UPDATE session SET revoked_at = now(), version = version + 1
      WHERE account_id = ${binding.accountId}::uuid AND revoked_at IS NULL`;
    const accountCount = await tx.$executeRaw`
      UPDATE account SET registration_access_state = 'FAILED', updated_at = now(), version = version + 1
      WHERE account_id = ${binding.accountId}::uuid AND registration_access_state = 'BLOCKED'`;
    if (accountCount !== 1) throw new Error('Registration account state conflict');
    const claimCount = await tx.$executeRaw`
      UPDATE contact_claim SET released_at = now()
      WHERE operation_id = ${binding.operationId} AND account_id = ${binding.accountId}::uuid
        AND released_at IS NULL`;
    if (claimCount !== 2) throw new Error('Registration contact claim state conflict');
    return true;
  });
}

// First login lookup: find only the current owner of the unreleased claim.
// No account status is disclosed or treated as a public result before password proof.
export async function findCurrentClaimOwnerByContact(
  client: PrismaClient,
  kind: 'EMAIL' | 'PHONE',
  digest: Uint8Array,
): Promise<string | null> {
  const rows = await client.$queryRaw<{ account_id: string }[]>`
    SELECT account_id FROM contact_claim
    WHERE kind = ${kind} AND lookup_hmac = ${digest} AND released_at IS NULL
    LIMIT 1`;
  return rows[0]?.account_id ?? null;
}

// Eligibility query is only suitable after password verification and full
// Session/Account checks. It must not be the first login lookup: that would
// hide locked or in-progress current owners before authentication.
export async function findReadyAccountByContactAfterAuthentication(
  client: PrismaClient,
  kind: 'EMAIL' | 'PHONE',
  digest: Uint8Array,
): Promise<string | null> {
  const rows = await client.$queryRaw<{ account_id: string }[]>`
    SELECT a.account_id FROM contact_claim c
    JOIN account a ON a.account_id = c.account_id
    JOIN registration_operation ro ON ro.operation_id = c.operation_id
    WHERE c.kind = ${kind} AND c.lookup_hmac = ${digest}
      AND c.released_at IS NULL AND a.registration_access_state = 'READY'
      AND a.account_status = 'ACTIVE' AND ro.public_status = 'SUCCEEDED'
    LIMIT 1`;
  return rows[0]?.account_id ?? null;
}
