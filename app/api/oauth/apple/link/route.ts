import { linkSupabaseOAuth, oauthOptions } from '../../../../../services/supabaseOAuthService';

export async function OPTIONS(req: Request) {
  return oauthOptions(req);
}

export async function POST(req: Request) {
  return linkSupabaseOAuth(req, 'apple');
}
