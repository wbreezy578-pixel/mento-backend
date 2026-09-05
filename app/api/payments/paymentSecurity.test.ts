import { describe, expect, it } from 'vitest';
import { POST as directUpgrade } from '../billing/upgrade/route';
import { PUT as clientFinalize } from './route';
import { isPaddleCheckoutSku } from '../../../services/paddleService';
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

  it('accepts only server-configured checkout SKUs', () => {
    expect(isPaddleCheckoutSku('pro')).toBe(true);
    expect(isPaddleCheckoutSku('topup_50')).toBe(true);
    expect(isPaddleCheckoutSku('pri_attacker_supplied')).toBe(false);
  });

  it('allows Paddle resources only on the dedicated checkout page', () => {
    expect(buildContentSecurityPolicy('/billing/checkout', 'production', nonce)).toContain('https://cdn.paddle.com');
    expect(buildContentSecurityPolicy('/other', 'production', nonce)).not.toContain('https://cdn.paddle.com');
  });
});
