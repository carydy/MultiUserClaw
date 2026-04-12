import path from "node:path";

export interface GatewayClientLike {
  start(): Promise<void>;
  stop(): void;
}

export interface BridgeStartupConfigLike {
  openclawHome: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectClientWithRetry(
  client: GatewayClientLike,
  options: {
    maxWaitMs?: number;
    retryIntervalMs?: number;
  } = {},
): Promise<void> {
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const retryIntervalMs = options.retryIntervalMs ?? 200;
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < maxWaitMs) {
    try {
      await client.start();
      return;
    } catch (error) {
      lastError = error;
      client.stop();
      await sleep(retryIntervalMs);
    }
  }

  throw new Error(
    `Gateway did not become ready within ${maxWaitMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

export function buildGatewayEnv(
  env: Record<string, string | undefined>,
  config: BridgeStartupConfigLike,
): Record<string, string | undefined> {
  return {
    ...env,
    OPENCLAW_CONFIG_PATH: path.join(config.openclawHome, "openclaw.json"),
    OPENCLAW_STATE_DIR: config.openclawHome,
  };
}

export function formatStartupStartedAt(startedAt: Date): string {
  return startedAt.toISOString();
}

export function formatStartupDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${durationMs}ms (${(durationMs / 1000).toFixed(2)}s)`;
}
