export interface LiveTutorAvatarSessionLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  attach(element: HTMLVideoElement): void;
  speak?(payload: { text: string }): Promise<void>;
  sendAudio?(payload: { audioBase64: string; immediate?: boolean }): Promise<void>;
  interrupt?(): void;
}

export interface LiveTutorAvatarService {
  start(): Promise<void>;
  stop(): Promise<void>;
  attach(element: HTMLVideoElement): void;
  speak(text: string): Promise<void>;
  sendAudio(audioBase64: string, immediate?: boolean): Promise<void>;
  interrupt(): void;
}

export class SimliLiveTutorAvatarService implements LiveTutorAvatarService {
  private readonly session: LiveTutorAvatarSessionLike | null;

  constructor(session: LiveTutorAvatarSessionLike | null) {
    this.session = session;
  }

  async start(): Promise<void> {
    if (!this.session) return;
    await this.session.start();
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    await this.session.stop();
  }

  attach(element: HTMLVideoElement): void {
    if (!this.session) return;
    this.session.attach(element);
  }

  async speak(text: string): Promise<void> {
    if (!this.session) return;
    if (typeof this.session.speak === 'function') {
      await this.session.speak({ text });
    }
  }

  async sendAudio(audioBase64: string, immediate?: boolean): Promise<void> {
    if (!this.session) return;
    if (typeof this.session.sendAudio === 'function') {
      await this.session.sendAudio({ audioBase64, immediate });
    }
  }

  interrupt(): void {
    if (!this.session) return;
    if (typeof this.session.interrupt === 'function') {
      this.session.interrupt();
    }
  }
}
