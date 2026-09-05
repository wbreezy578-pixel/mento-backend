import { Environment, LogLevel, Paddle } from '@paddle/paddle-node-sdk';
import { getPaddleApiKey, getPaddleEnv } from './env';

export function getPaddleInstance() {
  const apiKey = getPaddleApiKey();
  const environment = getPaddleEnv() === 'production' ? Environment.production : Environment.sandbox;

  return new Paddle(apiKey, {
    environment,
    logLevel: LogLevel.error,
  });
}
