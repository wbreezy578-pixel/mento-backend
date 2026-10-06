import { createHash, createHmac, randomUUID } from 'node:crypto';
import { buildWebsiteStaticFiles } from './websiteStaticSite';

export class WebsiteDeploymentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebsiteDeploymentConfigurationError';
  }
}

export type UploadedWebsiteDeployment = {
  deploymentId: string;
  r2Prefix: string;
  manifestKey: string;
  artifactHash: string;
  artifactSize: number;
  manifest: Record<string, {
    key: string;
    contentType: string;
    cacheControl: string;
    sha256: string;
  }>;
};

type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function getR2Config(): R2Config {
  if (process.env.WEBSITE_DEPLOYMENTS_ENABLED !== 'true') {
    throw new WebsiteDeploymentConfigurationError('Website deployment publishing is disabled.');
  }
  const stage = process.env.WEBSITE_DEPLOYMENT_STAGE?.trim();
  if (stage !== 'staging' && stage !== 'production') {
    throw new WebsiteDeploymentConfigurationError('Website deployment stage must be staging or production.');
  }

  const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID?.trim() ?? '';
  const bucket = process.env.WEBSITE_DEPLOYMENTS_BUCKET?.trim() ?? '';
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID?.trim() ?? '';
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY?.trim() ?? '';
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new WebsiteDeploymentConfigurationError(`A valid ${stage} R2 account ID is required.`);
  }
  const validBucket = stage === 'staging'
    ? /^mento-websites-staging(?:-[a-z0-9-]+)?$/.test(bucket)
    : bucket === 'mento-websites-production';
  if (!validBucket) {
    const expectedBucket = stage === 'staging' ? 'mento-websites-staging' : 'mento-websites-production';
    throw new WebsiteDeploymentConfigurationError(`The deployment bucket must use the ${expectedBucket} name.`);
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new WebsiteDeploymentConfigurationError(`${stage} R2 credentials are not configured.`);
  }
  return { accountId, bucket, accessKeyId, secretAccessKey };
}

function hmac(key: Buffer | string, value: string, encoding?: 'hex'): Buffer | string {
  const result = createHmac('sha256', key).update(value, 'utf8');
  return encoding ? result.digest(encoding) : result.digest();
}

function encodeObjectKey(key: string): string {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function sendR2Object(
  config: R2Config,
  key: string,
  method: 'PUT' | 'DELETE',
  body: Buffer,
  contentType: string,
  cacheControl: string,
): Promise<void> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodeURIComponent(config.bucket)}/${encodeObjectKey(key)}`;
  const payloadHash = createHash('sha256').update(body).digest('hex');
  const canonicalHeaders = [
    `cache-control:${cacheControl.trim()}`,
    `content-type:${contentType.trim()}`,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
  ].join('\n') + '\n';
  const signedHeaders = 'cache-control;content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const dateKey = hmac(`AWS4${config.secretAccessKey}`, dateStamp) as Buffer;
  const regionKey = hmac(dateKey, 'auto') as Buffer;
  const serviceKey = hmac(regionKey, 's3') as Buffer;
  const signingKey = hmac(serviceKey, 'aws4_request') as Buffer;
  const signature = hmac(signingKey, stringToSign, 'hex') as string;
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${host}${canonicalUri}`, {
    method,
    headers: {
      Authorization: authorization,
      'Cache-Control': cacheControl,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    body: new Uint8Array(body),
    cache: 'no-store',
  });
  if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
    const responseBody = await response.text();
    const providerCode = responseBody.match(/<Code>([^<]{1,80})<\/Code>/)?.[1];
    const errorCode = providerCode ? ` (${providerCode})` : '';
    throw new Error(`R2 object ${method === 'PUT' ? 'upload' : 'deletion'} failed with status ${response.status}${errorCode}.`);
  }
}

export async function uploadWebsiteDeployment(input: {
  websiteId: string;
  version: number;
  content: unknown;
  deploymentId?: string;
}): Promise<UploadedWebsiteDeployment> {
  const config = getR2Config();
  const deploymentId = input.deploymentId ?? randomUUID();
  const { files } = buildWebsiteStaticFiles(input.content, input.websiteId, deploymentId);
  const r2Prefix = `websites/${input.websiteId}/deployments/${deploymentId}`;
  const manifestKey = `${r2Prefix}/manifest.json`;
  const manifest: UploadedWebsiteDeployment['manifest'] = {};
  let artifactSize = 0;
  const uploadedKeys: string[] = [];

  try {
    for (const [relativePath, file] of files) {
      const body = Buffer.from(file.body, 'utf8');
      const key = `${r2Prefix}/${relativePath}`;
      const sha256 = createHash('sha256').update(body).digest('hex');
      await sendR2Object(config, key, 'PUT', body, file.contentType, file.cacheControl);
      uploadedKeys.push(key);
      manifest[relativePath] = { key, contentType: file.contentType, cacheControl: file.cacheControl, sha256 };
      artifactSize += body.byteLength;
      if (artifactSize > 10 * 1024 * 1024) {
        throw new Error('Generated website deployment exceeds the 10 MB publishing limit.');
      }
    }

    const manifestBody = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      websiteId: input.websiteId,
      deploymentId,
      version: input.version,
      entries: manifest,
    }), 'utf8');
    await sendR2Object(config, manifestKey, 'PUT', manifestBody, 'application/json; charset=utf-8', 'no-store');
    uploadedKeys.push(manifestKey);
    artifactSize += manifestBody.byteLength;
    if (artifactSize > 10 * 1024 * 1024) {
      throw new Error('Generated website deployment exceeds the 10 MB publishing limit.');
    }
    return {
      deploymentId,
      r2Prefix,
      manifestKey,
      artifactHash: createHash('sha256').update(manifestBody).digest('hex'),
      artifactSize,
      manifest,
    };
  } catch (error) {
    const cleanup = await Promise.allSettled(uploadedKeys.map((key) => (
      sendR2Object(config, key, 'DELETE', Buffer.alloc(0), 'application/octet-stream', 'no-store')
    )));
    const failedCleanup = cleanup.filter((result) => result.status === 'rejected');
    if (failedCleanup.length > 0) {
      throw new AggregateError(
        [error, ...failedCleanup.map((result) => result.status === 'rejected' ? result.reason : undefined)],
        'Website deployment upload failed and some staging R2 objects could not be removed.',
      );
    }
    throw error;
  }
}

export async function deleteWebsiteDeploymentArtifacts(deployment: UploadedWebsiteDeployment): Promise<void> {
  const config = getR2Config();
  const keys = [...Object.values(deployment.manifest).map((entry) => entry.key), deployment.manifestKey];
  const results = await Promise.allSettled(keys.map((key) => (
    sendR2Object(config, key, 'DELETE', Buffer.alloc(0), 'application/octet-stream', 'no-store')
  )));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.status === 'rejected' ? result.reason : undefined),
      'Some uncommitted website deployment objects could not be removed.',
    );
  }
}

export function createWebsiteHostname(slug: string, domain = 'trymentoapp.com'): string {
  const canonicalDomain = domain.trim().toLowerCase();
  const canonicalSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 59).replace(/-+$/g, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(canonicalSlug)) {
    throw new Error('Website slug cannot be used as a public hostname.');
  }
  if (!/^[a-z0-9.-]+$/.test(canonicalDomain) || canonicalDomain !== 'trymentoapp.com') {
    throw new Error('Only the reserved first-level Mento Websites domain is supported.');
  }
  return `web-${canonicalSlug}.${canonicalDomain}`;
}

export function isWebsiteHostname(hostname: string, domain = 'trymentoapp.com'): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  const suffix = `.${domain}`;
  if (!normalized.endsWith(suffix)) return false;
  const label = normalized.slice(0, -suffix.length);
  return label.startsWith('web-')
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
}
