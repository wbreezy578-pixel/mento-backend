/** A denied operation must never appear as completed, even if its caller requested success. */
export function resolveUsageLogSuccess(allowed: boolean, pending: boolean, requestedSuccess?: boolean): boolean | null {
  if (!allowed) return false;
  if (pending) return null;
  return requestedSuccess ?? true;
}
