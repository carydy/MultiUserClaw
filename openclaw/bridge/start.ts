import { spawn, execSync } from "node:child_process";
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
  // Gateway always binds to loopback (no auth needed). External access goes
  // through the bridge WS relay on bridgePort instead.
  const gatewayArgs = [
    ...gatewayBaseArgs,
    "gateway", "run",
    "--port", String(config.gatewayPort),
    "--bind", "loopback",
    "--force",
  ];

  console.log(`[bridge] Starting openclaw gateway: ${gatewayCmd} ${gatewayArgs.join(" ")}`);
  const gatewayProc = spawn(gatewayCmd, gatewayArgs, {
    cwd: openclawDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(config.openclawHome, "openclaw.json"),
      OPENCLAW_STATE_DIR: config.openclawHome,
      OPENCLAW_SKIP_CHANNELS: "1",
    },
  });

  gatewayProc.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[gateway] ${data}`);
  });
  gatewayProc.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[gateway] ${data}`);
  });
  gatewayProc.on("exit", (code) => {
    console.error(`[bridge] Gateway process exited with code ${code}`);
    if (code !== 0) process.exit(1);
  });

  // Wait for gateway to be ready
  const gatewayUrl = `ws://127.0.0.1:${config.gatewayPort}`;
  console.log(`[bridge] Waiting for gateway at ${gatewayUrl}...`);
  await waitForGateway(gatewayUrl);
  console.log("[bridge] Gateway is ready");

  // Connect bridge client to gateway
  const client = new BridgeGatewayClient(gatewayUrl);
  await client.start();
  console.log("[bridge] Connected to gateway");

  // Start bridge HTTP server
  const server = createServer(client, config);
  server.listen(config.bridgePort, "0.0.0.0", () => {
    console.log(`[bridge] Bridge server listening on port ${config.bridgePort}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("[bridge] Shutting down...");
    client.stop();
    gatewayProc.kill("SIGTERM");
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
