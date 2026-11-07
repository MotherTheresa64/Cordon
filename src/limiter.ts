import type { IncomingMessage, ServerResponse } from "node:http";

export interface Decision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms at which the caller has a full allowance again. */
  resetAt: number;
  /** How long to wait before retrying. Zero when the request was allowed. */
  retryAfterMs: number;
}

export interface Limiter {
  check(key: string, now: number, cost?: number): Decision;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, received ${value}`);
  }
}

/**
 * Token bucket: allows bursts up to `burst`, then refills continuously at
 * `limit` tokens per `windowMs`. Smooths traffic instead of letting a caller
 * spend a whole allowance at the top of every minute.
 */
export class TokenBucketLimiter implements Limiter {
  readonly limit: number;
  readonly windowMs: number;
  private capacity: number;
  private ratePerMs: number;
  private buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(opts: { limit: number; windowMs: number; burst?: number }) {
    assertPositiveInteger(opts.limit, "limit");
    assertPositiveInteger(opts.windowMs, "windowMs");
    const burst = opts.burst ?? opts.limit;
    assertPositiveInteger(burst, "burst");
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.capacity = burst;
    this.ratePerMs = opts.limit / opts.windowMs;
  }

  check(key: string, now: number, cost = 1): Decision {
    assertPositiveInteger(cost, "cost");
    const state = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsed = Math.max(0, now - state.updatedAt);
    const available = Math.min(this.capacity, state.tokens + elapsed * this.ratePerMs);
    const allowed = available >= cost;
    const tokens = allowed ? available - cost : available;

    this.buckets.set(key, { tokens, updatedAt: now });

    const retryAfterMs = allowed
      ? 0
      : Math.max(1, Math.ceil((cost - tokens) / this.ratePerMs));
    return {
      allowed,
      limit: this.limit,
      remaining: Math.floor(tokens),
      resetAt: now + Math.ceil((this.capacity - tokens) / this.ratePerMs),
      retryAfterMs,
    };
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }
}

/**
 * Sliding window: counts requests inside a trailing window. Cheaper to reason about
 * than a bucket when the requirement is literally "at most N per window", and it has
 * no burst allowance at all.
 */
export class SlidingWindowLimiter implements Limiter {
  readonly limit: number;
  readonly windowMs: number;
  private hits = new Map<string, number[]>();

  constructor(opts: { limit: number; windowMs: number }) {
    assertPositiveInteger(opts.limit, "limit");
    assertPositiveInteger(opts.windowMs, "windowMs");
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
  }

  check(key: string, now: number, cost = 1): Decision {
    assertPositiveInteger(cost, "cost");
    if (cost > this.limit) {
      throw new RangeError("cost cannot exceed the limit: the request could never succeed");
    }
    const hits = this.hits.get(key) ?? [];
    const cutoff = now - this.windowMs;
    while (hits.length > 0 && hits[0] <= cutoff) hits.shift();

    const allowed = hits.length + cost <= this.limit;
    if (allowed) for (let i = 0; i < cost; i++) hits.push(now);
    this.hits.set(key, hits);

    const oldest = hits[0];
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - hits.length),
      resetAt: oldest === undefined ? now : oldest + this.windowMs,
      retryAfterMs: allowed || oldest === undefined ? 0 : Math.max(1, oldest + this.windowMs - now),
    };
  }

  forget(key: string): void {
    this.hits.delete(key);
  }
}

export function rateLimitHeaders(d: Decision): Record<string, string> {
  return {
    "x-ratelimit-limit": String(d.limit),
    "x-ratelimit-remaining": String(d.remaining),
    "x-ratelimit-reset": String(Math.ceil(d.resetAt / 1000)),
  };
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/**
 * Wraps a handler so every response carries the rate limit headers, and an over-limit
 * request is answered with 429 + Retry-After instead of reaching the handler at all.
 */
export function withRateLimit(
  handler: Handler,
  limiter: Limiter,
  keyOf: (req: IncomingMessage) => string,
  now: () => number = Date.now,
): Handler {
  return async (req, res) => {
    const decision = limiter.check(keyOf(req), now());
    for (const [name, value] of Object.entries(rateLimitHeaders(decision))) res.setHeader(name, value);

    if (!decision.allowed) {
      const body = JSON.stringify({
        error: "rate_limited",
        retryAfterMs: decision.retryAfterMs,
      });
      res.writeHead(429, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "retry-after": String(Math.ceil(decision.retryAfterMs / 1000)),
      });
      res.end(body);
      return;
    }
    await handler(req, res);
  };
}
