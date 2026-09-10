import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

describe('allowance exhaustion error contract', () => {
  it('includes upgrade and reset metadata at the gateway boundary', () => {
    const source = read('lib/aiSecurityGateway.ts');
    expect(source).toContain("code: 'product_allowance_exhausted'");
    expect(source).toContain('upgradeAvailable: billingDecision.upgradeAvailable');
    expect(source).toContain('remainingUsage: billingDecision.remainingUsage');
    expect(source).toContain('resetTime: billingDecision.resetTime');
  });

  it('keeps structured allowance metadata in both streaming routes', () => {
    const chatStream = read('app/api/chat/stream/route.ts');
    const regenerate = read('app/api/chat/message/regenerate/route.ts');
    expect(chatStream).toContain('upgradeAvailable: appError.upgradeAvailable');
    expect(chatStream).toContain('resetTime: appError.resetTime');
    expect(regenerate).toContain('upgradeAvailable: gatewayBody?.upgradeAvailable === true');
    expect(regenerate).toContain('resetTime: typeof gatewayBody?.resetTime === \'string\' ? gatewayBody.resetTime : null');
  });
});
