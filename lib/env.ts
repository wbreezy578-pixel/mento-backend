import fs from 'node:fs';
import path from 'node:path';

const ENV_FILE_CANDIDATES = ['.env.local', '.env'];
let environmentValidated = false;

function resolveEnvValue(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function loadEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};

  const values: Record<string, string> = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!key) continue;

    values[key] = value;
  }

  return values;
}

export function loadEnvironmentFromDotEnv(): void {
  const cwd = process.cwd();

  for (const candidate of ENV_FILE_CANDIDATES) {
    // Environment files are local-development inputs and must not be traced into server bundles.
    const candidatePath = path.resolve(/* turbopackIgnore: true */ cwd, candidate);
    const fileValues = loadEnvFile(candidatePath);

    for (const [key, value] of Object.entries(fileValues)) {
      const currentValue = process.env[key];
      const shouldOverride = currentValue === undefined || currentValue.trim() === '' || (key === 'DATABASE_URL' && !currentValue.trim().startsWith('postgresql://'));
      if (shouldOverride) {
        process.env[key] = value;
      }
    }
  }
}

function validateNonEmpty(key: string, value: string | undefined): void {
  if (!value) {
    throw new Error(`Environment variable "${key}" is required and must not be empty.`);
  }
}

function validateUrl(key: string, value: string | undefined, expectedPrefix: string): void {
  validateNonEmpty(key, value);
  if (!value!.startsWith(expectedPrefix)) {
    throw new Error(`Environment variable "${key}" must start with "${expectedPrefix}".`);
  }
}

function ensureEnvironmentLoaded(): void {
  if (!environmentValidated) {
    loadEnvironmentFromDotEnv();
  }
}

export function getRequiredEnv(key: string): string {
  ensureEnvironmentLoaded();
  const value = resolveEnvValue(key);
  if (!value) {
    throw new Error(`Environment variable "${key}" is required and must not be empty.`);
  }
  return value;
}

export function getRequiredUrl(key: string, expectedPrefix: string): string {
  const value = getRequiredEnv(key);
  if (!value.startsWith(expectedPrefix)) {
    throw new Error(`Environment variable "${key}" must start with "${expectedPrefix}".`);
  }
  return value;
}

export function getJwtSecret(): string | undefined {
  ensureEnvironmentLoaded();
  return resolveEnvValue('JWT_SECRET')
    || resolveEnvValue('AUTH_JWT_SECRET')
    || resolveEnvValue('NEXTAUTH_SECRET');
}

export function getGeminiApiKey(): string {
  return getRequiredEnv('GEMINI_API_KEY');
}

export function getSupabaseUrl(): string {
  return getRequiredUrl('SUPABASE_URL', 'https://');
}

export function getSupabaseApiKey(): string | undefined {
  ensureEnvironmentLoaded();
  return resolveEnvValue('SUPABASE_API_KEY');
}

export function getSupabaseAnonKey(): string {
  return getRequiredEnv('SUPABASE_ANON_KEY');
}

export function getSupabaseServiceRoleKey(): string {
  return getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
}

export function getSupabaseClientKey(): string {
  return getSupabaseApiKey() ?? getSupabaseAnonKey();
}

export function getPaymentWebhookSecret(): string {
  ensureEnvironmentLoaded();
  const value = resolveEnvValue('PAYMENT_WEBHOOK_AUTH_SECRET') ?? resolveEnvValue('PAYMENT_WEBHOOK_SECRET');
  if (!value) {
    throw new Error('Environment variable "PAYMENT_WEBHOOK_AUTH_SECRET" or "PAYMENT_WEBHOOK_SECRET" is required and must not be empty.');
  }
  return value;
}

export function getPaymentWebhookAuthSecret(): string {
  return getPaymentWebhookSecret();
}

export function getPaddleProPriceId(): string {
  ensureEnvironmentLoaded();
  const value = resolveEnvValue('PADDLE_PRO_PRICE_ID');
  if (!value) {
    throw new Error('Environment variable "PADDLE_PRO_PRICE_ID" is required and must not be empty.');
  }
  return value;
}

export function getPaddleTopUpPriceId(): string | null {
  ensureEnvironmentLoaded();
  return resolveEnvValue('PADDLE_TOP_UP_PRICE_ID') ?? null;
}

export function getPaddleTopUp50PriceId(): string {
  ensureEnvironmentLoaded();
  const value = resolveEnvValue('PADDLE_TOP_UP_50_PRICE_ID');
  if (!value) {
    throw new Error('Environment variable "PADDLE_TOP_UP_50_PRICE_ID" is required and must not be empty.');
  }
  return value;
}

export function getPaddleTopUp100PriceId(): string {
  ensureEnvironmentLoaded();
  const value = resolveEnvValue('PADDLE_TOP_UP_100_PRICE_ID');
  if (!value) {
    throw new Error('Environment variable "PADDLE_TOP_UP_100_PRICE_ID" is required and must not be empty.');
  }
  return value;
}

export function getPaddleClientToken(): string | null {
  ensureEnvironmentLoaded();
  // This is a client-facing token that is safe to expose to the browser when configured.
  return resolveEnvValue('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN') ?? null;
}

export function getPaddleCheckoutUrl(): string {
  ensureEnvironmentLoaded();
  const value = resolveEnvValue('PADDLE_CHECKOUT_URL');
  if (!value || !/^https:\/\//i.test(value)) {
    throw new Error('Environment variable "PADDLE_CHECKOUT_URL" is required and must be an HTTPS URL.');
  }
  return value;
}
export type PaddleEnvironment = 'sandbox' | 'production';

function normalizePaddleEnvironment(value: string | undefined): PaddleEnvironment {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'production' || normalized === 'prod') {
    return 'production';
  }
  return 'sandbox';
}

export function getPaddleApiKey(): string {
  return getRequiredEnv('PADDLE_API_KEY');
}

export function getPaddleEnv(): PaddleEnvironment {
  ensureEnvironmentLoaded();
  const value = resolveEnvValue('PADDLE_ENV') ?? resolveEnvValue('NEXT_PUBLIC_PADDLE_ENV');
  return normalizePaddleEnvironment(value);
}

export function getPaddleNotificationWebhookSecret(): string | null {
  ensureEnvironmentLoaded();
  return resolveEnvValue('PADDLE_NOTIFICATION_WEBHOOK_SECRET') ?? null;
}

export function getSimliApiKey(): string {
  return getRequiredEnv('SIMLI_API_KEY');
}

export function getSimliAvatarId(): string {
  return getRequiredEnv('SIMLI_AVATAR_ID') || getRequiredEnv('SIMLI_FACE_ID');
}

export function getSimliVoiceId(): string {
  return resolveEnvValue('SIMLI_VOICE_ID') ?? '';
}

export function getSimliApiBaseUrl(): string {
  ensureEnvironmentLoaded();
  return resolveEnvValue('SIMLI_API_BASE_URL') ?? resolveEnvValue('SIMLI_API_URL') ?? 'https://api.simli.ai';
}

export function getSimliApiUrl(): string {
  return getSimliApiBaseUrl();
}

export function getRedisUrl(): string | null {
  ensureEnvironmentLoaded();
  return resolveEnvValue('REDIS_URL') ?? resolveEnvValue('REDIS_HOST') ?? null;
}

export function loadAndValidateEnvironment(): void {
  if (environmentValidated) return;
  loadEnvironmentFromDotEnv();

  validateUrl('DATABASE_URL', resolveEnvValue('DATABASE_URL'), 'postgresql://');
  validateNonEmpty('JWT_SECRET', getJwtSecret());
  if ((getJwtSecret()?.length ?? 0) < 32) throw new Error('Environment variable "JWT_SECRET" must be at least 32 characters long.');
  validateNonEmpty('GEMINI_API_KEY', resolveEnvValue('GEMINI_API_KEY'));
  validateUrl('SUPABASE_URL', resolveEnvValue('SUPABASE_URL'), 'https://');
  validateNonEmpty('SUPABASE_SERVICE_ROLE_KEY', resolveEnvValue('SUPABASE_SERVICE_ROLE_KEY'));
  validateNonEmpty('SUPABASE_ANON_KEY', resolveEnvValue('SUPABASE_ANON_KEY'));
  validateNonEmpty('PAYMENT_WEBHOOK_AUTH_SECRET', resolveEnvValue('PAYMENT_WEBHOOK_AUTH_SECRET') ?? resolveEnvValue('PAYMENT_WEBHOOK_SECRET'));

  environmentValidated = true;
}
