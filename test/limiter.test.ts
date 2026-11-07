import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SlidingWindowLimiter,
  TokenBucketLimiter,
  rateLimitHeaders,
  withRateLimit,
} from "../src/limiter.ts";

const T0 = 1_700_000_000_000;

test("a token bucket allows a burst and then refuses", () => {
  const limiter = new TokenBucketLimiter({ limit: 10, windowMs: 1_000 });
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.check("ip-1", T0).allowed, true, `request ${i + 1} should pass`);
  }
  const denied = limiter.check("ip-1", T0);
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterMs > 0);
});

test("tokens refill continuously, not in a lump at the boundary", () => {
  const limiter = new TokenBucketLimiter({ limit: 10, windowMs: 1_000 });
  for (let i = 0; i < 10; i++) limiter.check("k", T0);
  assert.equal(limiter.check("k", T0).allowed, false);

  // 100ms of a 1s window restores exactly one token.
  assert.equal(limiter.check("k", T0 + 100).allowed, true);
  assert.equal(limiter.check("k", T0 + 100).allowed, false);
  assert.equal(limiter.check("k", T0 + 200).allowed, true);
});

test("the bucket never exceeds its capacity, however long it idles", () => {
  const limiter = new TokenBucketLimiter({ limit: 5, windowMs: 1_000 });
  const far = T0 + 60 * 60 * 1_000;
  const first = limiter.check("k", far);
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 4, "an hour of idle time is still capped at the limit");
});

test("burst can exceed the sustained limit", () => {
  const limiter = new TokenBucketLimiter({ limit: 10, windowMs: 1_000, burst: 25 });
  let allowed = 0;
  for (let i = 0; i < 30; i++) if (limiter.check("k", T0).allowed) allowed++;
  assert.equal(allowed, 25);
});

test("keys are isolated from each other", () => {
  const limiter = new TokenBucketLimiter({ limit: 2, windowMs: 1_000 });
  assert.equal(limiter.check("a", T0).allowed, true);
  assert.equal(limiter.check("a", T0).allowed, true);
  assert.equal(limiter.check("a", T0).allowed, false);
  assert.equal(limiter.check("b", T0).allowed, true, "one noisy client must not lock out another");
  limiter.forget("a");
  assert.equal(limiter.check("a", T0).allowed, true, "forget resets a key");
});

test("cost allows weighting an expensive request", () => {
  const limiter = new TokenBucketLimiter({ limit: 10, windowMs: 1_000 });
  assert.equal(limiter.check("k", T0, 7).allowed, true);
  const partial = limiter.check("k", T0, 7);
  assert.equal(partial.allowed, false, "3 tokens left cannot cover a cost of 7");
  assert.equal(partial.remaining, 3);
});

test("a sliding window admits exactly the limit and then blocks", () => {
  const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 10_000 });
  assert.equal(limiter.check("k", T0).allowed, true);
  assert.equal(limiter.check("k", T0 + 1).allowed, true);
  const third = limiter.check("k", T0 + 2);
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);

  const denied = limiter.check("k", T0 + 3);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 10_000 - 3, "retry once the oldest hit ages out");
});

test("sliding window forgets only hits that left the window", () => {
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1_000 });
  limiter.check("k", T0);
  limiter.check("k", T0 + 400);
  assert.equal(limiter.check("k", T0 + 500).allowed, false);

  assert.equal(limiter.check("k", T0 + 1_001).allowed, true, "the first hit expired");
  assert.equal(limiter.check("k", T0 + 1_002).allowed, false, "the second is still inside");
});

test("a cost larger than the limit is rejected as impossible", () => {
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1_000 });
  assert.throws(() => limiter.check("k", T0, 3), RangeError);
});

test("constructor arguments are validated", () => {
  assert.throws(() => new TokenBucketLimiter({ limit: 0, windowMs: 1_000 }), RangeError);
  assert.throws(() => new TokenBucketLimiter({ limit: 1, windowMs: -5 }), RangeError);
  assert.throws(() => new SlidingWindowLimiter({ limit: 1.5, windowMs: 1_000 }), RangeError);
});

test("headers describe the decision", () => {
  const limiter = new SlidingWindowLimiter({ limit: 5, windowMs: 1_000 });
  const headers = rateLimitHeaders(limiter.check("k", T0));
  assert.deepEqual(headers, {
    "x-ratelimit-limit": "5",
    "x-ratelimit-remaining": "4",
    "x-ratelimit-reset": String(Math.ceil((T0 + 1_000) / 1000)),
  });
});

test("middleware admits requests, then answers 429 with Retry-After", async () => {
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000 });
  let clock = T0;
  const handler = withRateLimit(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    limiter,
    () => "127.0.0.1",
    () => clock,
  );

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/`;

  try {
    const first = await fetch(url);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-ratelimit-remaining"), "1");

    assert.equal((await fetch(url)).status, 200);

    const third = await fetch(url);
    assert.equal(third.status, 429);
    assert.equal(third.headers.get("x-ratelimit-remaining"), "0");
    assert.ok(Number(third.headers.get("retry-after")) > 0);
    assert.equal((await third.json()).error, "rate_limited");

    clock += 60_001;
    assert.equal((await fetch(url)).status, 200, "the window rolls over");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
