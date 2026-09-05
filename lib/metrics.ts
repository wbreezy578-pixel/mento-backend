import client from 'prom-client';
import { setMonitoringProvider, type MonitoringAttributes, type MonitoringFailureMetric, type MonitoringLatencyMetric } from './monitoring';

const GLOBAL_METRIC_STATE = '__mentoPromClientMetrics__';

type MetricRegisters = client.Counter<string> | client.Gauge<string> | client.Histogram<string>;

type MetricsState = {
  register: client.Registry;
  rateLimitHits: client.Counter<'type'>;
  rateLimitAllowed: client.Counter<'type'>;
  rateLimitDenied: client.Counter<'type'>;
  providerRequests: client.Counter<'provider' | 'outcome'>;
  providerRetries: client.Counter<'provider'>;
  providerLatency: client.Histogram<'provider'>;
  requestLatency: client.Histogram<'route'>;
  providerCircuitState: client.Gauge<'provider' | 'state'>;
  providerFailures: client.Counter<'provider'>;
  providerSuccesses: client.Counter<'provider'>;
  monitoringLatency: client.Histogram<'metric' | 'provider' | 'route' | 'operation' | 'feature'>;
  monitoringFailures: client.Counter<'metric' | 'provider' | 'route' | 'operation' | 'feature' | 'status' | 'source' | 'reason'>;
  liveTutorVoiceLatency: client.Histogram<'stage'>;
};

declare global {
  var __mentoPromClientMetrics__: MetricsState | undefined;
}

function createRegistry(): client.Registry {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  return registry;
}

function createMetric<T extends MetricRegisters>(
  register: client.Registry,
  name: string,
  create: () => T,
): T {
  const existing = register.getSingleMetric(name) as T | undefined;
  if (existing) {
    return existing;
  }
  return create();
}

function initializeMetrics(): MetricsState {
  const existing = (globalThis as typeof globalThis & { __mentoPromClientMetrics__?: MetricsState })[GLOBAL_METRIC_STATE];
  if (existing) {
    return existing;
  }

  const register = createRegistry();

  const rateLimitHits = createMetric(register, 'rate_limit_hits_total', () => new client.Counter({
    name: 'rate_limit_hits_total',
    help: 'Total number of rate limit hits',
    labelNames: ['type'] as const,
    registers: [register],
  }));

  const rateLimitAllowed = createMetric(register, 'rate_limit_allowed_total', () => new client.Counter({
    name: 'rate_limit_allowed_total',
    help: 'Total number of allowed requests through rate limiter',
    labelNames: ['type'] as const,
    registers: [register],
  }));

  const rateLimitDenied = createMetric(register, 'rate_limit_denied_total', () => new client.Counter({
    name: 'rate_limit_denied_total',
    help: 'Total number of denied requests by rate limiter',
    labelNames: ['type'] as const,
    registers: [register],
  }));

  const providerRequests = createMetric(register, 'provider_requests_total', () => new client.Counter({
    name: 'provider_requests_total',
    help: 'Total provider requests by provider and outcome',
    labelNames: ['provider', 'outcome'] as const,
    registers: [register],
  }));

  const providerRetries = createMetric(register, 'provider_retries_total', () => new client.Counter({
    name: 'provider_retries_total',
    help: 'Total provider retries',
    labelNames: ['provider'] as const,
    registers: [register],
  }));

  const providerLatency = createMetric(register, 'provider_latency_ms', () => new client.Histogram({
    name: 'provider_latency_ms',
    help: 'Latency of provider requests in milliseconds',
    labelNames: ['provider'] as const,
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    registers: [register],
  }));

  const requestLatency = createMetric(register, 'http_request_duration_ms', () => new client.Histogram({
    name: 'http_request_duration_ms',
    help: 'Incoming request latency in milliseconds',
    labelNames: ['route'] as const,
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    registers: [register],
  }));

  const providerCircuitState = createMetric(register, 'provider_circuit_state', () => new client.Gauge({
    name: 'provider_circuit_state',
    help: 'Current circuit breaker state for each provider',
    labelNames: ['provider', 'state'] as const,
    registers: [register],
  }));

  const providerFailures = createMetric(register, 'provider_failures_total', () => new client.Counter({
    name: 'provider_failures_total',
    help: 'Total provider failures',
    labelNames: ['provider'] as const,
    registers: [register],
  }));

  const providerSuccesses = createMetric(register, 'provider_successes_total', () => new client.Counter({
    name: 'provider_successes_total',
    help: 'Total successful provider calls',
    labelNames: ['provider'] as const,
    registers: [register],
  }));

  const monitoringLatency = createMetric(register, 'monitoring_latency_ms', () => new client.Histogram({
    name: 'monitoring_latency_ms',
    help: 'Application and provider latency in milliseconds',
    labelNames: ['metric', 'provider', 'route', 'operation', 'feature'] as const,
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    registers: [register],
  }));

  const monitoringFailures = createMetric(register, 'monitoring_failures_total', () => new client.Counter({
    name: 'monitoring_failures_total',
    help: 'Application failures by monitored category',
    labelNames: ['metric', 'provider', 'route', 'operation', 'feature', 'status', 'source', 'reason'] as const,
    registers: [register],
  }));

  const liveTutorVoiceLatency = createMetric(register, 'live_tutor_voice_latency_ms', () => new client.Histogram({
    name: 'live_tutor_voice_latency_ms',
    help: 'Live Tutor latency by privacy-safe voice pipeline stage in milliseconds',
    labelNames: ['stage'] as const,
    buckets: [25, 50, 100, 200, 350, 500, 750, 1000, 1500, 2500, 4000, 7000, 10000],
    registers: [register],
  }));

  const state: MetricsState = {
    register,
    rateLimitHits,
    rateLimitAllowed,
    rateLimitDenied,
    providerRequests,
    providerRetries,
    providerLatency,
    requestLatency,
    providerCircuitState,
    providerFailures,
    providerSuccesses,
    monitoringLatency,
    monitoringFailures,
    liveTutorVoiceLatency,
  };

  (globalThis as typeof globalThis & { __mentoPromClientMetrics__?: MetricsState })[GLOBAL_METRIC_STATE] = state;
  return state;
}

const metrics = initializeMetrics();

const monitoringLabels = (attributes: MonitoringAttributes) => ({
  provider: attributes.provider ? String(attributes.provider) : '',
  route: attributes.route ? String(attributes.route) : '',
  operation: attributes.operation ? String(attributes.operation) : '',
  feature: attributes.feature ? String(attributes.feature) : '',
});

setMonitoringProvider({
  observeLatency(metric: MonitoringLatencyMetric, durationMs: number, attributes = {}) {
    metrics.monitoringLatency.labels(metric, ...Object.values(monitoringLabels(attributes))).observe(durationMs);
  },
  incrementFailure(metric: MonitoringFailureMetric, attributes = {}) {
    metrics.monitoringFailures.labels(
      metric,
      ...Object.values(monitoringLabels(attributes)),
      attributes.status ? String(attributes.status) : '',
      attributes.source ? String(attributes.source) : '',
      attributes.reason ? String(attributes.reason) : '',
    ).inc();
  },
});

export async function metricsText() {
  return await metrics.register.metrics();
}

export const rateLimitHits = metrics.rateLimitHits;
export const rateLimitAllowed = metrics.rateLimitAllowed;
export const rateLimitDenied = metrics.rateLimitDenied;
export const providerRequests = metrics.providerRequests;
export const providerRetries = metrics.providerRetries;
export const providerLatency = metrics.providerLatency;
export const requestLatency = metrics.requestLatency;
export const providerCircuitState = metrics.providerCircuitState;
export const providerFailures = metrics.providerFailures;
export const providerSuccesses = metrics.providerSuccesses;
export const monitoringLatency = metrics.monitoringLatency;
export const monitoringFailures = metrics.monitoringFailures;
export const liveTutorVoiceLatency = metrics.liveTutorVoiceLatency;

export function observeLiveTutorVoiceLatency(stage: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  metrics.liveTutorVoiceLatency.labels(stage).observe(durationMs);
}

export function observeRequestLatency(route: string, durationMs: number) {
  metrics.requestLatency.labels(route).observe(durationMs);
}

export function observeProviderLatency(provider: string, durationMs: number) {
  metrics.providerLatency.labels(provider).observe(durationMs);
}

export function incrementProviderRetry(provider: string) {
  metrics.providerRetries.labels(provider).inc();
}

export function recordProviderRequest(provider: string, outcome: 'success' | 'failed') {
  metrics.providerRequests.labels(provider, outcome).inc();
}

export function recordProviderFailure(provider: string) {
  metrics.providerFailures.labels(provider).inc();
}

export function recordProviderSuccess(provider: string) {
  metrics.providerSuccesses.labels(provider).inc();
}

export function recordProviderCircuitState(provider: string, state: string) {
  metrics.providerCircuitState.labels(provider, state).set(1);
}

type MetricsSink = {
  incrementProviderRetry(provider: string): void;
  observeProviderLatency(provider: string, durationMs: number): void;
  recordProviderCircuitState(provider: string, state: string): void;
  recordProviderFailure(provider: string): void;
  recordProviderRequest(provider: string, outcome: 'success' | 'failed'): void;
  recordProviderSuccess(provider: string): void;
};

(globalThis as typeof globalThis & { __mentoMetrics?: MetricsSink }).__mentoMetrics = {
  incrementProviderRetry,
  observeProviderLatency,
  recordProviderCircuitState,
  recordProviderFailure,
  recordProviderRequest,
  recordProviderSuccess,
};

export default metrics.register;
