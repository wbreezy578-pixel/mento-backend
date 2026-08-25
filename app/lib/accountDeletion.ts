import { getSensitiveActionRequirements } from './auth';

export type DeletionCredentialMode = 'password' | 'google' | 'apple';

export interface DeletionCredentialResolution {
  mode: DeletionCredentialMode;
  value: string;
}

export interface DeletionCredentialContext {
  authProvider?: string | null;
  lastOAuthReauthAt?: Date | string | null;
  email?: string | null;
}

export interface GoogleTokenVerifier {
  verifyGoogleAccessToken?: (token: string, context: DeletionCredentialContext) => Promise<{ email?: string | null } | null>;
}

export async function verifyGoogleAccessToken(token: string, _context: DeletionCredentialContext = {}) {
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    return null;
  }

  try {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(trimmedToken)}`);
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { email?: string | null; expires_in?: number | null; aud?: string | null };
    if (!payload.email) {
      return null;
    }

    return { email: payload.email };
  } catch {
    return null;
  }
}

export async function resolveDeletionCredential(
  input: { password?: string; googleAccessToken?: string },
  context: DeletionCredentialContext = {},
  verifier: GoogleTokenVerifier = {}
): Promise<DeletionCredentialResolution> {
  const password = typeof input.password === 'string' ? input.password.trim() : '';
  const googleAccessToken = typeof input.googleAccessToken === 'string' ? input.googleAccessToken.trim() : '';

  const isGoogleLinked = context.authProvider === 'google' || context.authProvider === 'mixed';
  const isAppleLinked = context.authProvider === 'apple';
  const actionRequirements = getSensitiveActionRequirements({
    authProvider: context.authProvider,
    lastOAuthReauthAt: context.lastOAuthReauthAt,
  });

  if (password) {
    if (isGoogleLinked || isAppleLinked) {
      throw new Error('OAuth-linked accounts require a recent provider re-authentication before deletion.');
    }
    return { mode: 'password' as const, value: password };
  }

  if (isAppleLinked) {
    if (actionRequirements.requiresRecentOAuthReauth) {
      throw new Error('Please sign in with Apple again before deleting your account.');
    }
    return { mode: 'apple', value: '' };
  }

  if (googleAccessToken) {
    if (!isGoogleLinked) {
      throw new Error('Google re-authentication is only supported for Google-linked accounts.');
    }

    const verified = verifier.verifyGoogleAccessToken
      ? await verifier.verifyGoogleAccessToken(googleAccessToken, context)
      : await verifyGoogleAccessToken(googleAccessToken, context);

    if (!verified) {
      throw new Error('Google re-authentication failed. Please sign in with Google again and try deleting your account.');
    }

    const normalizedEmail = typeof context.email === 'string' ? context.email.trim().toLowerCase() : '';
    const verifiedEmail = typeof verified.email === 'string' ? verified.email.trim().toLowerCase() : '';
    if (normalizedEmail && verifiedEmail && normalizedEmail !== verifiedEmail) {
      throw new Error('Google re-authentication token does not match your signed-in account.');
    }

    if (actionRequirements.requiresRecentOAuthReauth) {
      throw new Error('Please re-authenticate with Google recently before deleting your account.');
    }

    return { mode: 'google' as const, value: googleAccessToken };
  }

  if (isGoogleLinked) {
    if (actionRequirements.requiresRecentOAuthReauth) {
      throw new Error('Please re-authenticate with Google recently before deleting your account.');
    }
    // The Mento session was freshly issued only after the shared Supabase OAuth
    // exchange verified Google ownership and updated lastOAuthReauthAt. Requiring
    // a second provider token here made deletion impossible for the mobile app.
    return { mode: 'google', value: '' };
  }

  throw new Error('Password confirmation is required to delete your account.');
}
