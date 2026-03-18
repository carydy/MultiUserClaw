import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";

type ClientMessage =
  | { type: "init"; session_key?: string; command?: string; cwd?: string; cols?: number; rows?: number }
  | { type: "start"; command?: string; cwd?: string }
  | { type: "input"; data: string }
  | { type: "resize"; cols?: number; rows?: number }
  | { type: "kill" }
  | { type: "ping" };

type TerminalSession = {
  key: string;
  proc: ChildProcessWithoutNullStreams;
  clients: Set<WebSocket>;
  buffer: string[];
  timeoutId: ReturnType<typeof setTimeout> | null;
};

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_BUFFER_CHUNKS = 2000;
const sessions = new Map<string, TerminalSession>();

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function parseMessage(raw: WebSocket.RawData): ClientMessage | null {
  try {
    const txt = typeof raw === "string" ? raw : raw.toString("utf-8");
    const obj = JSON.parse(txt) as ClientMessage;
    if (!obj || typeof obj !== "object" || !("type" in obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

export function createTerminalWs(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    let session: TerminalSession | null = null;

    const sessionKeyFrom = (raw?: string): string => {
      const key = (raw || "").trim();
      if (!key) return "default";
      return key.slice(0, 128);
    };

    const broadcast = (target: TerminalSession, payload: Record<string, unknown>) => {
      const data = JSON.stringify(payload);
      for (const client of target.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    };

    const appendBuffer = (target: TerminalSession, chunk: string) => {
      target.buffer.push(chunk);
      if (target.buffer.length > MAX_BUFFER_CHUNKS) {
        target.buffer.shift();
      }
    };

    const armSessionTimeout = (target: TerminalSession) => {
      if (target.timeoutId) clearTimeout(target.timeoutId);
      target.timeoutId = setTimeout(() => {
        try { target.proc.kill("SIGTERM"); } catch { /* ignore */ }
      }, SESSION_TTL_MS);
    };

    const attachClient = (target: TerminalSession) => {
      if (target.timeoutId) {
        clearTimeout(target.timeoutId);
        target.timeoutId = null;
      }
      target.clients.add(ws);
      session = target;
      send(ws, { type: "session", session_key: target.key, reused: target.clients.size > 1 });

      if (target.buffer.length > 0) {
        send(ws, { type: "output", data: target.buffer.join("") });
      }
    };

    const createSession = (key: string, command?: string, cwd?: string): TerminalSession => {
      const shellCmd = command?.trim() || "bash -il";
      const spawnOpts = {
        cwd: cwd && cwd.trim() ? cwd : process.cwd(),
        env: process.env,
      };

      let proc: ChildProcessWithoutNullStreams;
      // Keep a stable interactive shell by default; arbitrary commands run via bash -lc.
      if (shellCmd === "bash -il" || shellCmd === "bash -i" || shellCmd === "bash") {
        proc = spawn("bash", ["-il"], spawnOpts);
      } else {
        proc = spawn("bash", ["-lc", shellCmd], spawnOpts);
      }

      const next: TerminalSession = {
        key,
        proc,
        clients: new Set<WebSocket>(),
        buffer: [],
        timeoutId: null,
      };

      sessions.set(key, next);

      proc.stdout.on("data", (chunk: Buffer) => {
        const data = chunk.toString("utf-8");
        appendBuffer(next, data);
        broadcast(next, { type: "output", data });
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        const data = chunk.toString("utf-8");
        appendBuffer(next, data);
        broadcast(next, { type: "output", data });
      });
      proc.on("exit", (code, signal) => {
        broadcast(next, { type: "exit", code, signal: signal ?? null });
        if (next.timeoutId) clearTimeout(next.timeoutId);
        sessions.delete(key);
      });
      proc.on("error", (err: NodeJS.ErrnoException) => {
        broadcast(next, { type: "error", message: err.message });
      });

      broadcast(next, { type: "started", command: shellCmd });
      return next;
    };

    const startOrReuseSession = (rawKey?: string, command?: string, cwd?: string) => {
      const key = sessionKeyFrom(rawKey);
      const existing = sessions.get(key);
      if (existing) {
        attachClient(existing);
        return;
      }
      const created = createSession(key, command, cwd);
      attachClient(created);
    };

    ws.on("message", (raw) => {
      const msg = parseMessage(raw);
      if (!msg) return;

      switch (msg.type) {
        case "init":
          startOrReuseSession(msg.session_key, msg.command, msg.cwd);
          break;
        case "start":
          startOrReuseSession(undefined, msg.command, msg.cwd);
          break;
        case "input":
          if (session?.proc && session.proc.stdin.writable) {
            session.proc.stdin.write(msg.data);
          }
          break;
        case "resize":
          // Reserved for PTY implementation; kept for protocol compatibility.
          if (session) {
            send(ws, { type: "resized", cols: msg.cols ?? null, rows: msg.rows ?? null });
          }
          break;
        case "kill":
          if (session?.proc) {
            try { session.proc.kill("SIGTERM"); } catch { /* ignore */ }
          }
          break;
        case "ping":
          send(ws, { type: "pong" });
          break;
      }
    });

    ws.on("close", () => {
      if (session) {
        session.clients.delete(ws);
        if (session.clients.size === 0) {
          armSessionTimeout(session);
        }
      }
      session = null;
    });
  });
  return wss;
}
