import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import { prisma } from '../../../lib/prisma';
import { getActiveSimliSessionCount } from '../../../services/simliService';
import { getCircuitBreaker } from '../../../lib/resilience';
import { isReadinessHealthy } from './healthStatus';
import { checkRealtimeRedisHealth } from '../../../lib/realtimeRedis';

const geminiBreaker = getCircuitBreaker('gemini', 5, 30000);
const simliBreaker = getCircuitBreaker('simli', 3, 30000);
const mpesaBreaker = getCircuitBreaker('payment:mpesa', 3, 60000);

function getDiskHealth() {
  try {
    const stats = fs.statfsSync(process.cwd());
    const availableBytes = stats.bavail * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    const usedPercent = Math.round((1 - availableBytes / totalBytes) * 100);
    return {
      status: usedPercent < 90 ? 'ok' : 'warn',
      totalBytes,
      availableBytes,
      usedPercent,
    };
  } catch {
    return { status: 'warn', totalBytes: 0, availableBytes: 0, usedPercent: 0 };
  }
}

function getMemoryHealth() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPercent = Math.round((1 - free / total) * 100);
  return {
    status: usedPercent < 90 ? 'ok' : 'warn',
    totalBytes: total,
    availableBytes: free,
    usedPercent,
  };
}

export async function GET(req: Request) {
  const startedAt = Date.now();
  const checks: Record<string, unknown> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'ok' };
  } catch {
    checks.database = { status: 'fail' };
  }

  checks.gemini = {
    status: geminiBreaker.isOpen() ? 'circuit_open' : 'not_probed',
    circuitState: geminiBreaker.getState(),
  };

  checks.simli = {
    status: simliBreaker.isOpen() ? 'circuit_open' : 'not_probed',
    circuitState: simliBreaker.getState(),
    activeSessions: getActiveSimliSessionCount(),
  };

  checks.redis = { status: await checkRealtimeRedisHealth() };
  checks.paymentProviders = {
    mpesa: { status: mpesaBreaker.isOpen() ? 'circuit_open' : 'not_probed', circuitState: mpesaBreaker.getState() },
  };
  checks.disk = getDiskHealth();
  checks.memory = getMemoryHealth();

  const allHealthy = isReadinessHealthy(checks as Record<string, unknown>);

  const configuredToken = process.env.METRICS_AUTH_TOKEN?.trim();
  const isOperator = process.env.NODE_ENV !== 'production'
    ? true
    : Boolean(configuredToken && req.headers.get('authorization') === `Bearer ${configuredToken}`);
  const response: Record<string, unknown> = {
    status: allHealthy ? 'ready' : 'degraded',
    timestamp: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
  };
  if (isOperator) response.checks = checks;

  return NextResponse.json(response, { status: allHealthy ? 200 : 503 });
}
