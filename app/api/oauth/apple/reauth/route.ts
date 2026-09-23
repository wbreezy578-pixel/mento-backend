import { oauthOptions, reauthenticateSupabaseOAuth } from '../../../../../services/supabaseOAuthService';

export function OPTIONS(req: Request) {
  return oauthOptions(req);
}

export function POST(req: Request) {
  return reauthenticateSupabaseOAuth(req, 'apple');
}
