export function isWebsTestingMode(): boolean {
  const testMode = process.env.WEBS_TEST_MODE?.trim();
  const backendEnvironment = process.env.MENTO_BACKEND_ENV?.trim();
  if (testMode && testMode !== 'true' && testMode !== 'false') {
    throw new Error('WEBS_TEST_MODE must be either true or false.');
  }
  if (testMode === 'true' && backendEnvironment !== 'blue') {
    throw new Error('WEBS_TEST_MODE can only be enabled on the isolated Blue backend.');
  }
  return testMode === 'true' && backendEnvironment === 'blue';
}

export function isFreeWebsTestingUsage(feature: string, metadata: Record<string, unknown>): boolean {
  return isWebsTestingMode()
    && (feature === 'website' || feature === 'image')
    && metadata.source === 'websites';
}

export function shouldBypassWebsUserAllowance(feature: string, metadata: Record<string, unknown>): boolean {
  return isFreeWebsTestingUsage(feature, metadata);
}

export function resolveWebsUserCharge(
  feature: string,
  metadata: Record<string, unknown>,
  calculatedChargeUSD: number,
): number {
  return isFreeWebsTestingUsage(feature, metadata) ? 0 : calculatedChargeUSD;
}
