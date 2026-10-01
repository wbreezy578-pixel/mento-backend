import { NextResponse } from 'next/server';
import logger from '../../../../lib/logger';
import { getUserFromRequest, verifyPassword, getSensitiveActionRequirements, recordSecurityEvent } from '../../../lib/auth';
import { resolveDeletionCredential } from '../../../lib/accountDeletion';
import { AccountDeletionPendingError, beginAccountDeletion, processAccountDeletionJob } from '../../../../services/accountDeletionService';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';

const authJson = (body: unknown, init: ResponseInit = {}) => NextResponse.json(body, {
  ...init,
  headers: { 'Cache-Control': 'no-store', ...(init.headers ?? {}) },
});

function buildDeletionResponse(input: { deleted: boolean; pending?: boolean; status?: number }) {
  const response = authJson({ ok: true, success: true, deleted: input.deleted, deletionPending: Boolean(input.pending) }, { status: input.status ?? 200 });
  response.cookies.set('mento_access_token', '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  response.cookies.set('mento_refresh_token', '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  return response;
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return authJson({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { password, confirmPassword, confirmationText } = body as {
      password?: string;
      confirmPassword?: string;
      confirmationText?: string;
    };
    const normalizedConfirmationText = typeof confirmationText === 'string' ? confirmationText.trim().toLowerCase() : '';

    if (normalizedConfirmationText !== 'delete my account') {
      return authJson({ error: 'Type "delete my account" to confirm.' }, { status: 400 });
    }

    const credential = await resolveDeletionCredential(
      { password },
      { authProvider: user.authProvider, oauthProvider: user.oauthProvider, email: user.email, lastOAuthReauthAt: user.lastOAuthReauthAt }
    );

    if (credential.mode === 'password') {
      if (typeof confirmPassword !== 'string' || confirmPassword !== password) {
        return authJson({ error: 'Password confirmation must match.' }, { status: 400 });
      }
      const passwordMatches = await verifyPassword(password, user.password);
      if (!passwordMatches) {
        return authJson({ error: 'Incorrect password.' }, { status: 401 });
      }
    }

    const actionRequirements = getSensitiveActionRequirements(user);
    if (actionRequirements.requiresRecentOAuthReauth) {
      const providerName = user.oauthProvider === 'apple' ? 'Apple' : 'Google';
      return authJson({ error: `Please sign in with ${providerName} again before deleting your account.` }, { status: 403 });
    }
    const limit = await ensureSlidingWindow(`account-delete:${user.id}`, 3, 60 * 60);
    if (!limit.ok) return authJson({ error: 'Too many account deletion attempts. Please try again later.' }, { status: 429 });

    const job = await beginAccountDeletion(user.id);
    await recordSecurityEvent(user.id, 'account_deletion_requested', { deletionMode: credential.mode });
    try {
      await processAccountDeletionJob(job.id);
      await recordSecurityEvent(null, 'account_deleted', { deletionJobId: job.id, deletionMode: credential.mode });
      return buildDeletionResponse({ deleted: true });
    } catch (error) {
      if (error instanceof AccountDeletionPendingError) {
        return buildDeletionResponse({ deleted: false, pending: true, status: 202 });
      }
      throw error;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Account deletion failed.';
    logger.error('Account deletion request failed', { errorName: error instanceof Error ? error.name : 'unknown' });

    if (error instanceof Error) {
      if (/incorrect password/i.test(message)) {
        return authJson({ error: message }, { status: 401 });
      }
      if (/password confirmation|type "delete my account" to confirm|oauth-linked accounts require/i.test(message)) {
        return authJson({ error: message }, { status: 400 });
      }
      if (/please re-authenticate with google recently|google-linked accounts require a recent google re-authentication|please sign in with apple again/i.test(message)) {
        return authJson({ error: message }, { status: 403 });
      }
    }

    return authJson({ error: 'Unable to begin account deletion right now.' }, { status: 500 });
  }
}
