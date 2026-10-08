import { PrismaClient } from '@prisma/client';
import { observeMonitoringLatency } from './monitoring';
import './metrics';
import { loadAndValidateEnvironment } from './env';

loadAndValidateEnvironment();

declare global {
  var prisma: PrismaClient | undefined;
}

export const prisma = global.prisma ?? new PrismaClient();
prisma.$use(async (params, next) => {
  const startedAt = Date.now();
  try {
    const result = await next(params);
    observeMonitoringLatency('database', Date.now() - startedAt, { operation: params.action });
    return result;
  } catch (error) {
    observeMonitoringLatency('database', Date.now() - startedAt, { operation: params.action, status: 'error' });
    throw error;
  }
});
if (process.env.NODE_ENV !== 'production') global.prisma = prisma;
