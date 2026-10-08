import { getSensitiveActionRequirements } from './auth';

export type DeletionCredentialMode = 'password' | 'google' | 'apple';

export interface DeletionCredentialResolution {
  mode: DeletionCredentialMode;
  value: string;
}

export interface DeletionCredentialContext {
  authProvider?: string | null;
  oauthProvider?: string | null;
  lastOAuthReauthAt?: Date | string | null;
  email?: string | null;
}

export async function resolveDeletionCredential(
  input: { password?: string },
  context: DeletionCredentialContext = {}
): Promise<DeletionCredentialResolution> {
  const password = typeof input.password === 'string' ? input.password.trim() : '';

  const linkedOAuthProvider = context.oauthProvider || (context.authProvider === 'google' || context.authProvider === 'apple' ? context.authProvider : context.authProvider === 'mixed' ? 'google' : null);
  const isGoogleLinked = linkedOAuthProvider === 'google';
  const isAppleLinked = linkedOAuthProvider === 'apple';
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
