import { createServer } from 'node:http';
import next from 'next';
import { registerShutdownTask } from './lib/crashRecovery';
import { attachLiveTutorVoiceGateway } from './services/liveTutorVoiceGateway';
import { shutdownRealtimeRedis } from './lib/realtimeRedis';

const dev = process.argv.includes('--dev') || process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function startBackgroundLifecycleTasks(): Promise<void> {
  const [{ shutdownActiveSimliSessions, recoverDurableLiveTutorSessions }, { recoverActivePaymentTransactions }, { reconcilePendingPaddleTransactions }] = await Promise.all([
    import('./services/simliService'),
    import('./services/paymentService'),
    import('./services/paddleService'),
  ]);

  registerShutdownTask(shutdownActiveSimliSessions);
  registerShutdownTask(recoverActivePaymentTransactions);
  registerShutdownTask(shutdownRealtimeRedis);
  void recoverDurableLiveTutorSessions().catch((error) => {
    console.warn('[startup] Durable live-tutor recovery failed after server started.', error);
  });
  void reconcilePendingPaddleTransactions().catch((error) => {
    console.warn('[startup] Pending Paddle transaction reconciliation failed.', error);
  });
}

app.prepare().then(() => {
  const server = createServer((request, response) => handle(request, response));
  const shutdownVoiceGateway = attachLiveTutorVoiceGateway(server);
  registerShutdownTask(shutdownVoiceGateway);
  registerShutdownTask(async () => {
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  server.listen(port, hostname, () => {
    console.log(`[Server] listening on http://${hostname}:${port}`);
    void startBackgroundLifecycleTasks().catch((error) => {
      console.warn('[startup] Background lifecycle tasks failed to initialize.', error);
    });
  });
}).catch((error) => {
  console.error('Unable to start Mento server', error);
  process.exitCode = 1;
});
