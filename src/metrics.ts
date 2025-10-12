type BucketStats = {
  inbound: number;
  outbound: number;
};

type ContactMetrics = {
  contactId: string;
  inbound: number;
  outbound: number;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  lastSeenAt: number | null;
  latencyCount: number;
  latencyTotalMs: number;
  recentLatencies: number[];
};

type ProviderStats = {
  total: number;
  ok: number;
  fail: number;
};

const BUCKET_MS = 60_000; // 1 minute buckets
const BUCKET_COUNT = 60; // keep last 60 minutes
const MAX_BUCKET_AGE = BUCKET_MS * BUCKET_COUNT;
const MAX_RESPONSE_SAMPLES = 200;
const MAX_CONTACT_LATENCY_SAMPLES = 25;

const state = {
  runningSince: null as number | null,
  lastStartAt: null as number | null,
  totals: {
    inbound: 0,
    outbound: 0,
  },
  contacts: new Map<string, ContactMetrics>(),
  uniqueContacts: new Set<string>(),
  throughputBuckets: new Map<number, BucketStats>(),
  providerStats: new Map<string, ProviderStats>(),
  responseTotals: {
    count: 0,
    totalLatencyMs: 0,
    samples: [] as number[],
  },
};

function getOrCreateContact(contactId: string): ContactMetrics {
  const existing = state.contacts.get(contactId);
  if (existing) {
    return existing;
  }
  const created: ContactMetrics = {
    contactId,
    inbound: 0,
    outbound: 0,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastSeenAt: null,
    latencyCount: 0,
    latencyTotalMs: 0,
    recentLatencies: [],
  };
  state.contacts.set(contactId, created);
  return created;
}

function getOrCreateBucket(bucketStart: number): BucketStats {
  const existing = state.throughputBuckets.get(bucketStart);
  if (existing) {
    return existing;
  }
  const created: BucketStats = { inbound: 0, outbound: 0 };
  state.throughputBuckets.set(bucketStart, created);
  return created;
}

function pruneOldBuckets(now: number): void {
  for (const [bucketStart] of state.throughputBuckets) {
    if (now - bucketStart > MAX_BUCKET_AGE) {
      state.throughputBuckets.delete(bucketStart);
    }
  }
}

function bucketKeyFor(timestamp: number): number {
  return Math.floor(timestamp / BUCKET_MS) * BUCKET_MS;
}

function addResponseSample(latencyMs: number, contact: ContactMetrics): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    return;
  }
  state.responseTotals.count += 1;
  state.responseTotals.totalLatencyMs += latencyMs;
  state.responseTotals.samples.push(latencyMs);
  if (state.responseTotals.samples.length > MAX_RESPONSE_SAMPLES) {
    state.responseTotals.samples.shift();
  }

  contact.latencyCount += 1;
  contact.latencyTotalMs += latencyMs;
  contact.recentLatencies.push(latencyMs);
  if (contact.recentLatencies.length > MAX_CONTACT_LATENCY_SAMPLES) {
    contact.recentLatencies.shift();
  }
}

function getProviderStats(provider: string): ProviderStats {
  const existing = state.providerStats.get(provider);
  if (existing) {
    return existing;
  }
  const created: ProviderStats = { total: 0, ok: 0, fail: 0 };
  state.providerStats.set(provider, created);
  return created;
}

export function botStarted(): void {
  const now = Date.now();
  state.runningSince = now;
  state.lastStartAt = now;
}

export function botStopped(): void {
  state.runningSince = null;
}

export function recordInbound(contactId: string): void {
  const now = Date.now();
  state.totals.inbound += 1;
  state.uniqueContacts.add(contactId);

  const contact = getOrCreateContact(contactId);
  contact.inbound += 1;
  contact.lastInboundAt = now;
  contact.lastSeenAt = now;

  pruneOldBuckets(now);
  const bucket = getOrCreateBucket(bucketKeyFor(now));
  bucket.inbound += 1;
}

export function recordOutbound(contactId: string, latencyMs: number): void {
  const now = Date.now();
  state.totals.outbound += 1;
  state.uniqueContacts.add(contactId);

  const contact = getOrCreateContact(contactId);
  contact.outbound += 1;
  contact.lastOutboundAt = now;
  contact.lastSeenAt = now;
  addResponseSample(latencyMs, contact);

  pruneOldBuckets(now);
  const bucket = getOrCreateBucket(bucketKeyFor(now));
  bucket.outbound += 1;
}

export function recordLLMRequest(provider: string, ok: boolean): void {
  const stats = getProviderStats(provider);
  stats.total += 1;
  if (ok) {
    stats.ok += 1;
  } else {
    stats.fail += 1;
  }
}

export interface MetricsSnapshot {
  running: boolean;
  startedAt: number | null;
  uptimeMs: number;
  totals: {
    inbound: number;
    outbound: number;
    uniqueContacts: number;
  };
  response: {
    averageMs: number | null;
    sampleCount: number;
  };
  contacts: Array<{
    contactId: string;
    inbound: number;
    outbound: number;
    lastSeenAt: number | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
    averageLatencyMs: number | null;
  }>;
  throughput: Array<{
    bucketStart: number;
    inbound: number;
    outbound: number;
  }>;
  providers: Record<string, ProviderStats>;
}

export function getSnapshot(): MetricsSnapshot {
  const now = Date.now();
  const running = state.runningSince != null;
  const uptimeMs = running && state.runningSince ? now - state.runningSince : 0;

  const contacts = Array.from(state.contacts.values()).map((contact) => {
    const avgLatency = contact.latencyCount > 0
      ? contact.latencyTotalMs / contact.latencyCount
      : null;
    return {
      contactId: contact.contactId,
      inbound: contact.inbound,
      outbound: contact.outbound,
      lastSeenAt: contact.lastSeenAt,
      lastInboundAt: contact.lastInboundAt,
      lastOutboundAt: contact.lastOutboundAt,
      averageLatencyMs: avgLatency,
    };
  });

  contacts.sort((a, b) => {
    const aTime = a.lastSeenAt ?? 0;
    const bTime = b.lastSeenAt ?? 0;
    return bTime - aTime;
  });

  const throughput = Array.from(state.throughputBuckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucketStart, stats]) => ({
      bucketStart,
      inbound: stats.inbound,
      outbound: stats.outbound,
    }));

  const providers: Record<string, ProviderStats> = {};
  for (const [provider, stats] of state.providerStats.entries()) {
    providers[provider] = { ...stats };
  }

  const averageMs = state.responseTotals.count > 0
    ? state.responseTotals.totalLatencyMs / state.responseTotals.count
    : null;

  return {
    running,
    startedAt: state.runningSince ?? state.lastStartAt,
    uptimeMs,
    totals: {
      inbound: state.totals.inbound,
      outbound: state.totals.outbound,
      uniqueContacts: state.uniqueContacts.size,
    },
    response: {
      averageMs,
      sampleCount: state.responseTotals.count,
    },
    contacts: contacts.slice(0, 20),
    throughput,
    providers,
  };
}
