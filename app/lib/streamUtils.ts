export type SafeStreamWriter = {
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
  isStreamClosed: () => boolean;
};

export function createSafeStreamWriter(controller: ReadableStreamDefaultController<Uint8Array>, abortSignal: AbortSignal): SafeStreamWriter {
  let isClosed = false;

  const streamClosed = () => isClosed || abortSignal.aborted;

  const enqueue = (chunk: Uint8Array) => {
    if (streamClosed()) {
      return;
    }
    try {
      controller.enqueue(chunk);
    } catch {
      isClosed = true;
    }
  };

  const close = () => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    try {
      controller.close();
    } catch {
      // If the consumer already closed the stream silently, ignore.
    }
  };

  abortSignal.addEventListener('abort', () => {
    isClosed = true;
    try {
      controller.close();
    } catch {
      // Ignore close failures when the stream is already closed.
    }
  }, { once: true });

  return { enqueue, close, isStreamClosed: streamClosed };
}
