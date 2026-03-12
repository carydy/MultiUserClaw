import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, writeOpenclawConfig } from "./config.js";
import { BridgeGatewayClient } from "./gateway-client.js";
import { createServer } from "./server.js";

async function waitForGateway(url: string, maxWaitMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const client = new BridgeGatewayClient(url);
      await Promise.race([
        client.start(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      client.stop();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Gateway did not become ready within ${maxWaitMs}ms`);
}

function resolveGatewayCommand(openclawDir: string): { cmd: string; args: string[] } {
  // In production (Docker), dist/ exists → use node openclaw.mjs directly
  const distEntry = path.join(openclawDir, "dist", "entry.js");
  const openclawMjs = path.join(openclawDir, "openclaw.mjs");

  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [openclawMjs] };
  }

  // In dev mode, use scripts/run-node.mjs which auto-builds then runs
  const runNode = path.join(openclawDir, "scripts", "run-node.mjs");
  if (fs.existsSync(runNode)) {
    console.log("[bridge] Dev mode: using run-node.mjs (will auto-build if needed)");
    return { cmd: process.execPath, args: [runNode] };
  }

  // Fallback: try node openclaw.mjs anyway
  return { cmd: process.execPath, args: [openclawMjs] };
}

/**
 * Manages the gateway child process lifecycle, including restart support.
 */
class GatewayManager {
  private proc: ChildProcess | null = null;
  private restarting = false;
  private readonly openclawDir: string;
  private readonly gatewayCmd: string;
  private readonly gatewayArgs: string[];
  private readonly gatewayEnv: Record<string, string | undefined>;
  private readonly gatewayUrl: string;

  client: BridgeGatewayClient;

  constructor(
    openclawDir: string,
    cmd: string,
    args: string[],
    env: Record<string, string | undefined>,
    gatewayUrl: string,
  ) {
    this.openclawDir = openclawDir;
    this.gatewayCmd = cmd;
    this.gatewayArgs = args;
    this.gatewayEnv = env;
    this.gatewayUrl = gatewayUrl;
    this.client = new BridgeGatewayClient(gatewayUrl);
  }

  async start(): Promise<void> {
    this.spawnGateway();
    await waitForGateway(this.gatewayUrl);
    console.log("[bridge] Gateway is ready");
    await this.client.start();
    console.log("[bridge] Connected to gateway");
  }

  private spawnGateway(): void {
    console.log(`[bridge] Starting openclaw gateway: ${this.gatewayCmd} ${this.gatewayArgs.join(" ")}`);
    const proc = spawn(this.gatewayCmd, this.gatewayArgs, {
      cwd: this.openclawDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: this.gatewayEnv,
    });

    proc.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[gateway] ${data}`);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[gateway] ${data}`);
    });
    proc.on("exit", (code) => {
      console.error(`[bridge] Gateway process exited with code ${code}`);
      if (!this.restarting && code !== 0) process.exit(1);
    });

    this.proc = proc;
  }

  async restart(): Promise<void> {
    if (this.restarting) throw new Error("Already restarting");
    this.restarting = true;
    console.log("[bridge] Restarting gateway...");

    try {
      // Disconnect bridge client
      this.client.stop();

      // Kill old gateway process
      if (this.proc && !this.proc.killed) {
        this.proc.kill("SIGTERM");
        // Wait for exit (up to 10s)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
            resolve();
          }, 10_000);
          this.proc?.on("exit", () => { clearTimeout(timer); resolve(); });
        });
      }

      // Re-read and write config (may have changed via settings API)
      const config = loadConfig();
      writeOpenclawConfig(config);
      console.log("[bridge] Refreshed openclaw config");

      // Spawn new gateway
      this.spawnGateway();
      await waitForGateway(this.gatewayUrl);
      console.log("[bridge] Gateway restarted and ready");

      // Reconnect bridge client
      this.client = new BridgeGatewayClient(this.gatewayUrl);
      await this.client.start();
      console.log("[bridge] Reconnected to gateway");
    } finally {
      this.restarting = false;
    }
  }

  shutdown(): void {
    this.client.stop();
    if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
  }
}

// Export for use by settings route
export let gatewayManager: GatewayManager | null = null;

async function main(): Promise<void> {
  console.log("[bridge] Starting openclaw bridge...");

  const config = loadConfig();

  // Write openclaw config for platform proxy integration
  writeOpenclawConfig(config);
  console.log("[bridge] Wrote openclaw config");

  // Resolve openclaw project directory (bridge/ is inside openclaw/)
  const openclawDir = process.env.OPENCLAW_DIR || path.resolve(process.cwd());

  // Ensure openclaw node_modules exist
  const nodeModulesDir = path.join(openclawDir, "node_modules");
  if (!fs.existsSync(nodeModulesDir)) {
    console.log("[bridge] Installing openclaw dependencies (pnpm install)...");
    try {
      execSync("pnpm install", { cwd: openclawDir, stdio: "inherit" });
    } catch (err) {
      console.error("[bridge] Failed to install openclaw dependencies:", (err as Error).message);
      console.error("[bridge] Please run 'pnpm install' in the openclaw directory manually.");
      process.exit(1);
    }
  }

  // Start openclaw gateway as a child process
  const { cmd: gatewayCmd, args: gatewayBaseArgs } = resolveGatewayCommand(openclawDir);
  const gatewayArgs = [
    ...gatewayBaseArgs,
    "gateway", "run",
    "--port", String(config.gatewayPort),
    "--bind", "loopback",
    "--force",
  ];

  const gatewayUrl = `ws://127.0.0.1:${config.gatewayPort}`;
  const manager = new GatewayManager(
    openclawDir, gatewayCmd, gatewayArgs,
    {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(config.openclawHome, "openclaw.json"),
      OPENCLAW_STATE_DIR: config.openclawHome,
      // In Docker multi-tenant mode, skip channels (each user gets their own container).
      // In local dev mode (BRIDGE_ENABLE_CHANNELS=1), let channels start normally.
      ...(process.env.BRIDGE_ENABLE_CHANNELS === "1" ? {} : { OPENCLAW_SKIP_CHANNELS: "1" }),
    },
    gatewayUrl,
  );

  gatewayManager = manager;

  console.log(`[bridge] Waiting for gateway at ${gatewayUrl}...`);
  await manager.start();

  // Start bridge HTTP server
  const server = createServer(manager.client, config, manager);
  server.listen(config.bridgePort, "0.0.0.0", () => {
    console.log(`[bridge] Bridge server listening on port ${config.bridgePort}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("[bridge] Shutting down...");
    manager.shutdown();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[bridge] Fatal error:", err);
  process.exit(1);
});
