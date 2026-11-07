# Cordon

Rate limiting for Node HTTP services: a token bucket for smooth traffic, a sliding window
for strict "N per window", and middleware that returns `429` with `Retry-After` and the
`X-RateLimit-*` headers clients expect.

Zero dependencies.

## Run it

```bash
node --test
```

```ts
import { createServer } from "node:http";
import { SlidingWindowLimiter, withRateLimit } from "./src/limiter.ts";

const limiter = new SlidingWindowLimiter({ limit: 60, windowMs: 60_000 });
const server = createServer(
  withRateLimit(
    (req, res) => res.end("hello"),
    limiter,
    (req) => req.socket.remoteAddress ?? "unknown",
  ),
);
server.listen(3000);
```

## Two strategies, because they answer different questions

**`SlidingWindowLimiter`** stores the timestamps of each key's requests and counts those
inside the trailing window. It is the honest implementation of "at most 60 per minute", and
it has no burst allowance — a client that sends 60 requests at 12:00:59 and 60 more at
12:01:00 is blocked, which a fixed window would let through as 120 in two seconds.

**`TokenBucketLimiter`** holds a balance that refills continuously and is capped at
`burst`. It is the right choice when short bursts are legitimate (a page load firing six
requests) but sustained volume is not. Because refill is continuous rather than
per-window, there is no thundering herd at the boundary.

The trade-off is memory: the sliding window keeps every timestamp inside the window, the
bucket keeps two numbers per key. At high cardinality that difference matters.

## API

| Member | Behaviour |
| --- | --- |
| `new TokenBucketLimiter({ limit, windowMs, burst? })` | Refills `limit` tokens per window, capped at `burst` (default `limit`). |
| `new SlidingWindowLimiter({ limit, windowMs })` | At most `limit` requests per trailing window. |
| `check(key, now, cost = 1)` | Returns `{ allowed, limit, remaining, resetAt, retryAfterMs }`. `cost` weights an expensive endpoint. |
| `forget(key)` | Drops a key's state, freeing memory when a client disconnects. |
| `withRateLimit(handler, limiter, keyOf, now?)` | Middleware: sets headers on every response, short-circuits with `429` when over limit. |

`now` is injected everywhere. A limiter that reads `Date.now()` internally cannot be tested
without sleeping, and sleeping tests are the ones people delete.

## Design decisions

**Denied requests do not consume allowance.** A rejected call leaves the bucket untouched, so
a client hammering the endpoint while blocked does not push its own recovery further out.

**`retryAfterMs` is computed, not guessed.** For the bucket it is the time to accrue `cost`
tokens; for the window it is when the oldest counted hit ages out. Either way the client gets
a number that is actually true.

**An impossible `cost` throws instead of returning `allowed: false`.** Asking a limiter with
`limit: 2` for `cost: 3` is a programming error, and silently refusing forever hides it.

**Headers use whole seconds.** `X-RateLimit-Reset` and `Retry-After` are declared in seconds
by convention, so both are rounded up — a client that rounds down retries early and gets
another 429.

## Tests

Burst-then-deny, continuous refill at sub-window granularity, capacity capping after long
idle periods, `burst` above the sustained limit, per-key isolation and `forget`, weighted
`cost`, exact sliding-window admission and expiry, impossible-cost rejection, constructor
validation, header contents, and a real HTTP round trip covering `200` → `429` → recovery.
