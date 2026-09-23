export class BillingTransactionQueueTimeoutError extends Error {
  readonly code = 'billing_transaction_queue_timeout';

  constructor() {
    super('Billing coordination timed out. Please retry.');
    this.name = 'BillingTransactionQueueTimeoutError';
  }
}

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createKeyedTransactionQueue(timeoutMs: number) {
  const activeKeys = new Set<string>();
  const queues = new Map<string, Waiter[]>();

  function release(key: string) {
    const queue = queues.get(key);
    const next = queue?.shift();
    if (queue?.length === 0) queues.delete(key);
    if (next) {
      clearTimeout(next.timer);
      next.resolve(() => release(key));
      return;
    }
    activeKeys.delete(key);
  }

  async function acquire(key: string): Promise<() => void> {
    if (!activeKeys.has(key)) {
      activeKeys.add(key);
      return () => release(key);
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const queue = queues.get(key);
          if (queue) {
            const index = queue.indexOf(waiter);
            if (index >= 0) queue.splice(index, 1);
            if (queue.length === 0) queues.delete(key);
          }
          reject(new BillingTransactionQueueTimeoutError());
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      const queue = queues.get(key) ?? [];
      queue.push(waiter);
      queues.set(key, queue);
    });
  }

  return { acquire };
}
