import Redis, { Cluster } from 'ioredis';
import { isIP } from 'node:net';

export type MentoRedisClient = Redis | Cluster;

export function createRedisClient(url: string): MentoRedisClient {
  if (process.env.REDIS_CLUSTER_MODE !== 'true') {
    return new Redis(url, { maxRetriesPerRequest: 2 });
  }

  const parsed = new URL(url);
  // Azure Redis Enterprise advertises cluster nodes by IP. Keep the original
  // hostname as TLS SNI so certificates remain valid after slot discovery.
  const tls = parsed.protocol === 'rediss:' ? { servername: parsed.hostname } : undefined;
  return new Cluster(
    [{ host: parsed.hostname, port: Number(parsed.port || (tls ? 6380 : 6379)) }],
    {
      // Azure Managed Redis OSS clusters advertise shard IPs on 85xx ports.
      // Route those ports through the public cache hostname so DNS/TLS and
      // Container Apps networking remain valid.
      natMap: (address) => {
        const separator = address.lastIndexOf(':');
        const advertisedHost = separator >= 0 ? address.slice(0, separator) : address;
        const advertisedPort = separator >= 0 ? Number(address.slice(separator + 1)) : Number(parsed.port);
        return isIP(advertisedHost)
          ? { host: parsed.hostname, port: advertisedPort }
          : null;
      },
      redisOptions: {
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        tls,
        maxRetriesPerRequest: 2,
      },
    },
  );
}
