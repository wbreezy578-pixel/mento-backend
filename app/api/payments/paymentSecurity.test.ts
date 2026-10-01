import { describe, expect, it } from 'vitest';
import { POST as directUpgrade } from '../billing/upgrade/route';
import { PUT as clientFinalize } from './route';
import { buildContentSecurityPolicy } from '../../../lib/securityHeaders';

describe('payment security boundaries', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  it('does not allow the legacy direct upgrade endpoint to grant Pro', async () => {
    const response = await directUpgrade();
    expect(response.status).toBe(410);
  });

  it('does not allow clients to finalize payment transactions', async () => {
    const response = await clientFinalize();
    expect(response.status).toBe(405);
  });

  it('keeps the CSP locked down and strips legacy checkout provider origins', () => {
    expect(buildContentSecurityPolicy('/billing/checkout', 'production', nonce)).toContain("frame-src 'none'");
    expect(buildContentSecurityPolicy('/other', 'production', nonce)).not.toContain('paddle.com');
    expect(buildContentSecurityPolicy('/other', 'production', nonce)).not.toContain('cdn.paddle.com');
  });
});
