// Only known, credential-free messages may reach development process logs.
export function describeStartupFailure(error: unknown): string {
  const message=error instanceof Error?error.message:'';
  if (message==='Invalid service certificate validity')
    return 'workload certificate expired or not yet valid; run npm.cmd run dev:certs:renew';
  if (message==='Invalid service certificate EKU'||message==='Invalid service URI SAN'||
      message==='Ambiguous certificate SAN'||message==='Invalid service server identity')
    return 'workload certificate identity or usage is invalid';
  if (/^(Identity|Customer|Driver) persistence connection failed$/.test(message))
    return `${message}; run npm.cmd run dev:diagnose`;
  if (/^(Identity|Customer|Driver) runtime database configuration is invalid$/.test(message))
    return message;
  if (/^Missing (Driver )?gRPC bind configuration$/.test(message)) return message;
  return 'startup failed; run npm.cmd run dev:diagnose (details withheld to protect credentials)';
}
