// src/metrics.ts

export type ContactMetrics = {
  contactId: string;
  inbound: number;
  outbound: number;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  lastSeenAt: number | null;
};

export type ProviderMetrics = {
  provider: string;
  requests: number;
  failures: number;
};

export type TimelineBucket = {
  start: number;
  inbound: number;
  outbound: number;
};

export type MetricsSnapshot = {
  running: boolean;
  startedAt: number | null;
  uptimeMs: number;
  totals: {
    inbound: number;
    outbound: number;
    uniqueContacts: number;
    llmRequests: number;
    llmFailures: number;
  };
  responseTime: {
    averageMs: number | null;
    samples: number;
  };
  timeline: TimelineBucket[];
  providers: ProviderMetrics[];
  contacts: ContactMetrics[];
};

const BUCKET_MS = 60 * 1000;
const MAX_BUCKETS = 60;
const RESPONSE_SAMPLE_LIMIT = 100;

type InternalContactMetrics = ContactMetrics;

type BucketState = {
  start: number;
  inbound: number;
  outbound: number;
};

type ProviderState = {
  provider: string;
  requests: number;
  failures: number;
};

type MetricsState = {
  running: boolean;
  sessionStart: number | null;
  totalUptimeMs: number;
  totalInbound: number;
  totalOutbound: number;
  contacts: Map<string, InternalContactMetrics>;
  buckets: Map<number, BucketState>;
  providers: Map<string, ProviderState>;
  responseSamples: number[];
  responseSum: number;
};

const state: MetricsState = {
  running: false,
  sessionStart: null,
  totalUptimeMs: 0,
  totalInbound: 0,
  totalOutbound: 0,
  contacts: new Map(),
  buckets: new Map(),
  providers: new Map(),
  responseSamples: [],
  responseSum: 0,
};

function now(): number {
  return Date.now();
}

function ensureContact(contactId: string): InternalContactMetrics {
  let entry = state.contacts.get(contactId);
  if (!entry) {
    entry = {
      contactId,
      inbound: 0,
      outbound: 0,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastSeenAt: null,
    };
    state.contacts.set(contactId, entry);
  }
  return entry;
}

function touchBucket(timestamp: number, kind: "inbound" | "outbound"): void {
  const bucketStart = Math.floor(timestamp / BUCKET_MS) * BUCKET_MS;
  let bucket = state.buckets.get(bucketStart);
  if (!bucket) {
    bucket = { start: bucketStart, inbound: 0, outbound: 0 };
    state.buckets.set(bucketStart, bucket);
  }
  bucket[kind] += 1;

  if (state.buckets.size > MAX_BUCKETS) {
    const keys = Array.from(state.buckets.keys()).sort((a, b) => a - b);
    while (keys.length > MAX_BUCKETS) {
      const removeKey = keys.shift();
      if (typeof removeKey === "number") {
        state.buckets.delete(removeKey);
      }
    }
  }
}

function addResponseSample(latencyMs: number): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  state.responseSamples.push(latencyMs);
  state.responseSum += latencyMs;
  if (state.responseSamples.length > RESPONSE_SAMPLE_LIMIT) {
    const removed = state.responseSamples.shift();
    if (typeof removed === "number") {
      state.responseSum -= removed;
    }
  }
}

export function botStarted(): void {
  if (state.running) {
    return;
  }
  state.running = true;
  state.sessionStart = now();
}

export function botStopped(): void {
  if (!state.running) {
    return;
  }
  const current = now();
  if (state.sessionStart !== null) {
    state.totalUptimeMs += current - state.sessionStart;
  }
  state.sessionStart = null;
  state.running = false;
}

export function recordInbound(contactId: string): void {
  const timestamp = now();
  state.totalInbound += 1;
  const entry = ensureContact(contactId);
  entry.inbound += 1;
  entry.lastInboundAt = timestamp;
  entry.lastSeenAt = timestamp;
  touchBucket(timestamp, "inbound");
}

export function recordOutbound(contactId: string, latencyMs: number): void {
  const timestamp = now();
  state.totalOutbound += 1;
  const entry = ensureContact(contactId);
  entry.outbound += 1;
  entry.lastOutboundAt = timestamp;
  entry.lastSeenAt = timestamp;
  touchBucket(timestamp, "outbound");
  addResponseSample(latencyMs);
}

export function recordLLMRequest(provider: string, ok: boolean): void {
  const key = provider || "unknown";
  let entry = state.providers.get(key);
  if (!entry) {
    entry = { provider: key, requests: 0, failures: 0 };
    state.providers.set(key, entry);
  }
  entry.requests += 1;
  if (!ok) {
    entry.failures += 1;
  }
}

function computeUptimeMs(): number {
  if (state.sessionStart !== null && state.running) {
    return state.totalUptimeMs + (now() - state.sessionStart);
  }
  return state.totalUptimeMs;
}

export function getSnapshot(): MetricsSnapshot {
  const uptimeMs = computeUptimeMs();
  const responseSamples = state.responseSamples.slice();
  const responseAvg = responseSamples.length > 0
    ? Math.round((state.responseSum / responseSamples.length) * 10) / 10
    : null;

  const contacts = Array.from(state.contacts.values()).map((c) => ({ ...c }));
  contacts.sort((a, b) => {
    const aScore = a.inbound + a.outbound;
    const bScore = b.inbound + b.outbound;
    if (bScore !== aScore) {
      return bScore - aScore;
    }
    const aLast = a.lastSeenAt || 0;
    const bLast = b.lastSeenAt || 0;
    return bLast - aLast;
  });

  const timeline = Array.from(state.buckets.values())
    .map((bucket) => ({ ...bucket }))
    .sort((a, b) => a.start - b.start);

  const providers = Array.from(state.providers.values())
    .map((p) => ({ ...p }))
    .sort((a, b) => b.requests - a.requests);

  const totalProviderRequests = providers.reduce((sum, p) => sum + p.requests, 0);
  const totalProviderFailures = providers.reduce((sum, p) => sum + p.failures, 0);

  return {
    running: state.running,
    startedAt: state.sessionStart,
    uptimeMs,
    totals: {
      inbound: state.totalInbound,
      outbound: state.totalOutbound,
      uniqueContacts: state.contacts.size,
      llmRequests: totalProviderRequests,
      llmFailures: totalProviderFailures,
    },
    responseTime: {
      averageMs: responseAvg,
      samples: responseSamples.length,
    },
    timeline,
    providers,
    contacts,
  };
}

export function resetMetrics(): void {
  state.running = false;
  state.sessionStart = null;
  state.totalUptimeMs = 0;
  state.totalInbound = 0;
  state.totalOutbound = 0;
  state.contacts.clear();
  state.buckets.clear();
  state.providers.clear();
  state.responseSamples = [];
  state.responseSum = 0;
}
