import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGatewayEnv,
  connectClientWithRetry,
  formatStartupDuration,
  formatStartupStartedAt,
} from "./startup.ts";

test("connectClientWithRetry retries the same client until it connects", async () => {
  let attempts = 0;
  let stopCalls = 0;
  const client = {
    async start() {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`attempt ${attempts} failed`);
      }
    },
    stop() {
      stopCalls += 1;
    },
  };

  await connectClientWithRetry(client, { maxWaitMs: 50, retryIntervalMs: 0 });

  assert.equal(attempts, 3);
  assert.equal(stopCalls, 2);
});

test("buildGatewayEnv only injects config and state paths", () => {
  const env = buildGatewayEnv(
    {
      PATH: "/usr/bin",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_DISABLE_BONJOUR: "1",
    },
    {
      openclawHome: "/tmp/openclaw-home",
    },
  );

  assert.equal(env.OPENCLAW_CONFIG_PATH, "/tmp/openclaw-home/openclaw.json");
  assert.equal(env.OPENCLAW_STATE_DIR, "/tmp/openclaw-home");
  assert.equal(env.OPENCLAW_SKIP_CHANNELS, "1");
  assert.equal(env.OPENCLAW_SKIP_GMAIL_WATCHER, "1");
  assert.equal(env.OPENCLAW_SKIP_CANVAS_HOST, "1");
  assert.equal(env.OPENCLAW_DISABLE_BONJOUR, "1");
});

test("buildGatewayEnv does not invent bridge skip defaults when caller did not provide them", () => {
  const env = buildGatewayEnv(
    {
      PATH: "/usr/bin",
    },
    {
      openclawHome: "/tmp/openclaw-home",
    },
  );

  assert.equal(env.OPENCLAW_SKIP_CHANNELS, undefined);
  assert.equal(env.OPENCLAW_SKIP_GMAIL_WATCHER, undefined);
  assert.equal(env.OPENCLAW_SKIP_CANVAS_HOST, undefined);
  assert.equal(env.OPENCLAW_DISABLE_BONJOUR, undefined);
});

test("startup time helpers produce readable logs", () => {
  const startedAt = new Date("2026-04-11T13:05:06.789Z");

  assert.equal(formatStartupStartedAt(startedAt), "2026-04-11T13:05:06.789Z");
  assert.equal(formatStartupDuration(12), "12ms");
  assert.equal(formatStartupDuration(1234), "1234ms (1.23s)");
});
