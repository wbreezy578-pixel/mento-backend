import { getSupabaseServiceRoleKey, getSupabaseUrl } from '../lib/env';

export async function deleteSupabaseAuthUser(supabaseUserId: string) {
  const response = await fetch(`${getSupabaseUrl()}/auth/v1/admin/users/${encodeURIComponent(supabaseUserId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getSupabaseServiceRoleKey()}`, apikey: getSupabaseServiceRoleKey() },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok && response.status !== 404) throw new Error('Unable to remove the linked sign-in identity. Please try again.');
}
