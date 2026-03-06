import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface BridgeConfig {
  proxyUrl: string;
  proxyToken: string;
  model: string;
  gatewayPort: number;
  bridgePort: number;
  openclawHome: string;
  workspacePath: string;
  uploadsPath: string;
  sessionsPath: string;
}

export function loadConfig(): BridgeConfig {
  const proxyUrl = process.env.NANOBOT_PROXY__URL || "http://localhost:8080/llm/v1";
  const proxyToken = process.env.NANOBOT_PROXY__TOKEN || "dev-token";
  const model = process.env.NANOBOT_AGENTS__DEFAULTS__MODEL || "claude-sonnet-4-20250514";
  const gatewayPort = parseInt(process.env.OPENCLAW_GATEWAY_PORT || "18789", 10);
  const bridgePort = parseInt(process.env.BRIDGE_PORT || "18080", 10);
  const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(openclawHome, "workspace");
  const uploadsPath = path.join(openclawHome, "uploads");
  const sessionsPath = path.join(openclawHome, "sessions");

  return {
    proxyUrl,
    proxyToken,
    model,
    gatewayPort,
    bridgePort,
    openclawHome,
    workspacePath,
    uploadsPath,
    sessionsPath,
  };
}

/**
 * Write openclaw config file so the gateway uses our platform LLM proxy.
 */
export function writeOpenclawConfig(cfg: BridgeConfig): void {
  const configDir = cfg.openclawHome;
  fs.mkdirSync(configDir, { recursive: true });

  const openclawConfig = {
    models: {
      mode: "replace",
      providers: {
        "platform-proxy": {
          baseUrl: cfg.proxyUrl,
          api: "openai-completions",
          apiKey: cfg.proxyToken,
          models: [{
            id: cfg.model,
            name: cfg.model,
          }],
        },
      },
    },
    agents: {
      defaults: {
        model: `platform-proxy/${cfg.model}`,
      },
    },
    gateway: {
      mode: "local",
      port: cfg.gatewayPort,
      bind: "loopback",
      auth: { mode: "none" },
      controlUi: {
        allowedOrigins: [
          "http://localhost:3080",
          "http://127.0.0.1:3080",
          "http://localhost:8080",
          "http://127.0.0.1:8080",
          `http://localhost:${cfg.gatewayPort}`,
          `http://127.0.0.1:${cfg.gatewayPort}`,
        ],
      },
    },
  };

  const configPath = path.join(configDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(openclawConfig, null, 2), "utf-8");

  // Ensure workspace, uploads, sessions directories exist
  fs.mkdirSync(cfg.workspacePath, { recursive: true });
  fs.mkdirSync(cfg.uploadsPath, { recursive: true });
  fs.mkdirSync(cfg.sessionsPath, { recursive: true });
}
