import Redis, { Cluster } from 'ioredis';

export type MentoRedisClient = Redis | Cluster;

export function createRedisClient(url: string): MentoRedisClient {
  if (process.env.REDIS_CLUSTER_MODE !== 'true') {
    // Upstash exposes a single TLS endpoint rather than Redis Cluster slot
    // discovery. Bound connection and command waits so a DNS/network outage
    // fails a caller safely instead of leaving lifecycle work queued forever.
    return new Redis(url, {
      maxRetriesPerRequest: 2,
      connectTimeout: 8_000,
      commandTimeout: 8_000,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
    });
  }

  const parsed = new URL(url);
  const tls = parsed.protocol === 'rediss:' ? { servername: parsed.hostname } : undefined;
  return new Cluster(
    [{ host: parsed.hostname, port: Number(parsed.port || (tls ? 6380 : 6379)) }],
    {
      clusterRetryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
      enableOfflineQueue: false,
      redisOptions: {
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        tls,
        maxRetriesPerRequest: 2,
        connectTimeout: 8_000,
        commandTimeout: 8_000,
      },
    },
  );
}
