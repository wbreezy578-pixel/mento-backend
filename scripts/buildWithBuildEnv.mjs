import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Next evaluates server modules while collecting routes. Those modules validate
// their configuration, so the build needs syntactically valid values even
// though it must never receive production secrets. Cloud Run injects the real
// values only when the runtime starts.
const buildDefaults = {
  DATABASE_URL: 'postgresql://build:build@localhost:5432/build',
  DIRECT_URL: 'postgresql://build:build@localhost:5432/build',
  JWT_SECRET: 'build-only-placeholder-not-a-runtime-secret',
  GEMINI_API_KEY: 'build-only-placeholder',
  SUPABASE_URL: 'https://build-only.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'build-only-placeholder',
  SUPABASE_ANON_KEY: 'build-only-placeholder',
  PAYMENT_WEBHOOK_AUTH_SECRET: 'build-only-placeholder',
  SIMLI_API_KEY: 'build-only-placeholder',
  SIMLI_AVATAR_ID: 'build-only-placeholder',
  REDIS_URL: 'redis://build-only-placeholder:6379',
  TRUSTED_PROXY_PROVIDER: 'cloud-run',
  AUTH_WEB_BASE_URL: 'https://auth.trymentoapp.com',
};

for (const [name, value] of Object.entries(buildDefaults)) {
  if (!process.env[name]?.trim()) process.env[name] = value;
}

// Tell optional infrastructure clients not to open network connections while
// Next is prerendering pages. This flag exists only in this child build
// process; Cloud Run never receives it at runtime.
process.env.MENTO_BUILD = '1';

function run(binary, args) {
  const result = spawnSync(process.execPath, [path.resolve('node_modules', binary), ...args], {
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('prisma/build/index.js', ['generate']);
run('next/dist/bin/next', ['build']);
