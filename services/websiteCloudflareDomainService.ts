import { isWebsiteHostname } from './websiteDeploymentStorage';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const PRODUCTION_WORKER_NAME = 'mento-webs-router-production';
const PRODUCTION_ZONE_NAME = 'trymentoapp.com';

export class WebsiteHostnameProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebsiteHostnameProvisioningError';
  }
}

type CloudflareDomain = {
  id: string;
  hostname: string;
  service: string;
};

type CloudflareEnvelope<T> = {
  success?: boolean;
  result?: T;
};

function getAccountConfig(): { accountId: string; apiToken: string } {
  const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID?.trim() ?? '';
  const apiToken = process.env.CLOUDFLARE_WORKERS_API_TOKEN?.trim() ?? '';
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !apiToken) {
    throw new WebsiteHostnameProvisioningError('Production website hostname provisioning is not configured.');
  }
  return { accountId, apiToken };
}

async function cloudflareRequest<T>(
  url: URL,
  apiToken: string,
  method: 'GET' | 'PUT',
  body?: Record<string, string>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new WebsiteHostnameProvisioningError('Cloudflare website hostname provisioning could not be reached.');
  }
  if (!response.ok) {
    throw new WebsiteHostnameProvisioningError(`Cloudflare website hostname provisioning failed with status ${response.status}.`);
  }

  const envelope = await response.json() as CloudflareEnvelope<T>;
  if (envelope.success !== true || envelope.result === undefined) {
    throw new WebsiteHostnameProvisioningError('Cloudflare website hostname provisioning returned an invalid response.');
  }
  return envelope.result;
}

export async function ensureWebsiteWorkerDomain(hostname: string): Promise<void> {
  if (process.env.WEBSITE_DEPLOYMENT_STAGE !== 'production') return;
  if (process.env.WEBSITE_DEPLOYMENTS_ENABLED !== 'true') {
    throw new WebsiteHostnameProvisioningError('Production website hostname provisioning is disabled.');
  }
  if (!isWebsiteHostname(hostname)) {
    throw new WebsiteHostnameProvisioningError('Only reserved Mento Websites hostnames can be provisioned.');
  }

  const { accountId, apiToken } = getAccountConfig();
  const domainsUrl = new URL(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/domains`);
  domainsUrl.searchParams.set('hostname', hostname);
  const existing = await cloudflareRequest<CloudflareDomain[]>(domainsUrl, apiToken, 'GET');
  const exactMatch = existing.find((domain) => domain.hostname.toLowerCase() === hostname.toLowerCase());
  if (exactMatch) {
    if (exactMatch.service !== PRODUCTION_WORKER_NAME) {
      throw new WebsiteHostnameProvisioningError('The requested website hostname is already attached to another Worker.');
    }
    return;
  }

  const attached = await cloudflareRequest<CloudflareDomain>(
    domainsUrl,
    apiToken,
    'PUT',
    { hostname, service: PRODUCTION_WORKER_NAME, zone_name: PRODUCTION_ZONE_NAME },
  );
  if (
    attached.hostname.toLowerCase() !== hostname.toLowerCase()
    || attached.service !== PRODUCTION_WORKER_NAME
    || !attached.id
  ) {
    throw new WebsiteHostnameProvisioningError('Cloudflare did not attach the requested hostname to the Websites Worker.');
  }
}
