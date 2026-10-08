import { exchangeSupabaseOAuth, oauthOptions } from '../../../../services/supabaseOAuthService';

export const OPTIONS = oauthOptions;
export async function POST(req: Request) {
  return exchangeSupabaseOAuth(req, 'google');
}
