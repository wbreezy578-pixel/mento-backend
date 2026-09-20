import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('public authentication flow security contracts', () => {
  it('keeps signup enumeration-safe and rate-limited', () => {
    const signup = source('app/api/signup/route.ts');
    expect(signup).toContain('signup:ip:${clientIp}');
    expect(signup).toContain('signup:email:${authRateLimitSubject(normalizedEmail)}');
    expect(signup).toContain("If this address can be registered, check your email for the next step.");
    expect(signup).not.toMatch(/already exists|email already registered|account already exists/i);
  });

  it('uses the same public login failure message and dummy bcrypt path', () => {
    const login = source('app/api/login/route.ts');
    expect(login).toContain("const LOGIN_FAILURE_MESSAGE = 'Unable to sign in. Check your email and password.'");
    expect((login.match(/LOGIN_FAILURE_MESSAGE/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect((login.match(/verifyPassword\(String\(password\), DUMMY_BCRYPT_HASH\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(login).not.toMatch(/return .*user not found|return .*wrong password/i);
  });

  it('does not report a Redis outage as an account throttle', () => {
    const login = source('app/api/login/route.ts');
    const verifyMfa = source('app/api/login/verify-mfa/route.ts');

    expect(login).toContain("const unavailable = ipLimit.unavailable || accountLimit.unavailable;");
    expect(login).toContain('status: unavailable ? 503 : 429');
    expect(verifyMfa).toContain('const unavailable = rateLimit.unavailable === true;');
    expect(verifyMfa).toContain('status: unavailable ? 503 : 429');
  });

  it('claims reset and verification tokens conditionally so replay cannot succeed', () => {
    const reset = source('app/api/auth/reset-password/route.ts');
    const verify = source('app/api/auth/verify-email/route.ts');
    expect(reset).toContain('where: { id: resetRecord.id, usedAt: null, revokedAt: null');
    expect(reset).toContain('if (claimed.count !== 1) return null;');
    expect(verify).toContain('where: { id: record.id, usedAt: null, revokedAt: null');
    expect(verify).toContain('if (claimed.count !== 1) return null;');
  });

  it('keeps logout and OAuth callback responses generic on rejection', () => {
    const logout = source('app/api/auth/logout/route.ts');
    const googleOAuth = source('app/api/oauth/google/route.ts');
    const appleOAuth = source('app/api/oauth/apple/route.ts');
    expect(logout).toContain("{ error: 'Unable to sign out right now.' }");
    expect(googleOAuth).toContain("exchangeSupabaseOAuth(req, 'google')");
    expect(appleOAuth).toContain("exchangeSupabaseOAuth(req, 'apple')");
  });

  it('does not pass refresh tokens, MFA challenges, or codes to logs or security events', () => {
    for (const route of [
      'app/api/auth/refresh/route.ts',
      'app/api/login/route.ts',
      'app/api/login/verify-mfa/route.ts',
    ]) {
      const sensitiveLoggingLines = source(route)
        .split('\n')
        .filter((line) => /logger\.|recordSecurityEvent\(/i.test(line))
        .join('\n');

      expect(sensitiveLoggingLines).not.toMatch(/\b(refreshToken|challengeToken|code)\b/);
    }
  });
});
