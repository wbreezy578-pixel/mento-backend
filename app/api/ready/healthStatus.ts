type HealthRecord = Record<string, unknown>;

function isSuccessfulCheck(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as HealthRecord;
  const status = typeof record.status === 'string' ? record.status : undefined;
  if (status === 'ok' || status === 'not_configured') {
    return true;
  }

  if (typeof record.success === 'boolean') {
    return record.success;
  }

  return Object.values(record).every((nestedValue) => isSuccessfulCheck(nestedValue));
}

export function isReadinessHealthy(checks: Record<string, unknown>): boolean {
  return [checks.database, checks.redis, checks.gemini, checks.simli, checks.paymentProviders].every((value) => isSuccessfulCheck(value));
}
