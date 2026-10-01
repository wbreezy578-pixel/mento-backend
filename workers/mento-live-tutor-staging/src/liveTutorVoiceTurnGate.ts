export class LiveTutorVoiceTurnGate {
  private isIdle = false;
  private readonly waiters = new Set<() => void>();

  update(isIdle: boolean): void {
    this.isIdle = isIdle;
    if (!isIdle) return;

    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.isIdle) return Promise.resolve(true);

    return new Promise((resolve) => {
      const finish = (idle: boolean) => {
        clearTimeout(timeout);
        this.waiters.delete(onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);

      this.waiters.add(onIdle);
      const timeout = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      if (this.isIdle) finish(true);
    });
  }
}