import express from "express";
import type { BridgeGatewayClient, GatewayEvent } from "../gateway-client.js";

/**
 * SSE endpoint that streams gateway chat events to the frontend.
 * This avoids the need for the frontend to do the Ed25519 device
 * authentication required by the gateway's WebSocket protocol.
 */
export function eventsRoutes(client: BridgeGatewayClient) {
  const router = express.Router();

  router.get("/events/stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial keepalive
    res.write(": connected\n\n");

    const listener = (evt: GatewayEvent) => {
      // Only forward chat events (delta, final, started, error, aborted)
      if (evt.event === "chat") {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
    };

    client.onEvent(listener);

    // Keepalive every 25s to prevent proxy timeouts
    const keepalive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 25000);

    _req.on("close", () => {
      clearInterval(keepalive);
      client.offEvent(listener);
    });
  });

  return router;
}
