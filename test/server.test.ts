import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.ts";

async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const hit = (url: string, key: string) =>
  fetch(`${url}/hit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });

test("the page is served and health reports the limit", async () => {
  await withServer(async (url) => {
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Cordon/);

    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.limit, 5);
    assert.equal(health.windowMs, 1000);
  });
});

test("the sixth request in a window is refused with headers", async () => {
  await withServer(async (url) => {
    const decisions = [];
    for (let i = 0; i < 6; i++) {
      decisions.push((await (await hit(url, "burst")).json()).decision);
    }
    assert.deepEqual(decisions.slice(0, 5).map((d: { allowed: boolean }) => d.allowed), [true, true, true, true, true]);
    assert.equal(decisions[5].allowed, false);
    assert.ok(decisions[5].retryAfterMs > 0);

    const last = await (await hit(url, "burst")).json();
    assert.equal(last.headers["x-ratelimit-limit"], "5");
    assert.equal(last.headers["x-ratelimit-remaining"], "0");
  });
});

test("separate keys have separate buckets", async () => {
  await withServer(async (url) => {
    for (let i = 0; i < 6; i++) await hit(url, "busy");
    const other = await (await hit(url, "quiet")).json();
    assert.equal(other.decision.allowed, true);
  });
});

test("reset restores the full burst", async () => {
  await withServer(async (url) => {
    for (let i = 0; i < 6; i++) await hit(url, "key");
    await fetch(`${url}/reset`, { method: "POST" });
    const after = await (await hit(url, "key")).json();
    assert.equal(after.decision.allowed, true);
    assert.equal(after.decision.remaining, 4);
  });
});
