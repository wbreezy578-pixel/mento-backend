import { describe, expect, it } from 'vitest';
import { POST as directUpgrade } from '../billing/upgrade/route';
import { PUT as clientFinalize } from './route';
import { isPaddleCheckoutSku } from '../../../services/paddleService';
import { buildContentSecurityPolicy } from '../../../lib/securityHeaders';

describe('payment security boundaries', () => {
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
    expect(buildContentSecurityPolicy('/billing/checkout', 'production')).toContain('https://cdn.paddle.com');
    expect(buildContentSecurityPolicy('/other', 'production')).not.toContain('https://cdn.paddle.com');
  });
});
