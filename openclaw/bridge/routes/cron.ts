import { Router } from "express";
import type { BridgeGatewayClient } from "../gateway-client.js";
import { asyncHandler } from "../utils.js";

interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule_kind: string;
  schedule_display: string;
  schedule_expr: string | null;
  schedule_every_ms: number | null;
  message: string;
  deliver: boolean;
  channel: string | null;
  to: string | null;
  next_run_at_ms: number | null;
  last_run_at_ms: number | null;
  last_status: string | null;
  last_error: string | null;
  created_at_ms: number;
}

function serializeJob(job: Record<string, unknown>): CronJob {
  return {
    id: (job.id as string) || "",
    name: (job.name as string) || "",
    enabled: (job.enabled as boolean) ?? true,
    schedule_kind: (job.scheduleKind as string) || (job.schedule_kind as string) || "every",
    schedule_display: (job.scheduleDisplay as string) || (job.schedule_display as string) || "",
    schedule_expr: (job.scheduleExpr as string) || (job.schedule_expr as string) || null,
    schedule_every_ms: (job.scheduleEveryMs as number) || (job.schedule_every_ms as number) || null,
    message: (job.message as string) || "",
    deliver: (job.deliver as boolean) ?? false,
    channel: (job.channel as string) || null,
    to: (job.to as string) || null,
    next_run_at_ms: (job.nextRunAtMs as number) || (job.next_run_at_ms as number) || null,
    last_run_at_ms: (job.lastRunAtMs as number) || (job.last_run_at_ms as number) || null,
    last_status: (job.lastStatus as string) || (job.last_status as string) || null,
    last_error: (job.lastError as string) || (job.last_error as string) || null,
    created_at_ms: (job.createdAtMs as number) || (job.created_at_ms as number) || Date.now(),
  };
}

export function cronRoutes(client: BridgeGatewayClient): Router {
  const router = Router();

  // GET /api/cron/jobs
  router.get("/cron/jobs", asyncHandler(async (req, res) => {
    const includeDisabled = req.query.include_disabled === "true";

    try {
      const jobs = await client.request<Record<string, unknown>[]>("cron.list", {});
      let result = (jobs || []).map(serializeJob);

      if (!includeDisabled) {
        result = result.filter((j) => j.enabled);
      }

      // Sort by next_run_at_ms ascending
      result.sort((a, b) => (a.next_run_at_ms || Infinity) - (b.next_run_at_ms || Infinity));
      res.json(result);
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/cron/jobs
  router.post("/cron/jobs", asyncHandler(async (req, res) => {
    const { name, message, every_seconds, cron_expr, at_iso, deliver, channel, to } = req.body;

    if (!every_seconds && !cron_expr && !at_iso) {
      res.status(400).json({ detail: "Must specify every_seconds, cron_expr, or at_iso" });
      return;
    }

    try {
      const params: Record<string, unknown> = { name, message };
      if (every_seconds) params.everySeconds = every_seconds;
      if (cron_expr) params.cronExpr = cron_expr;
      if (at_iso) params.atIso = at_iso;
      if (deliver !== undefined) params.deliver = deliver;
      if (channel) params.channel = channel;
      if (to) params.to = to;

      const job = await client.request<Record<string, unknown>>("cron.create", params);
      res.json(serializeJob(job));
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // DELETE /api/cron/jobs/:job_id
  router.delete("/cron/jobs/:job_id", asyncHandler(async (req, res) => {
    try {
      await client.request("cron.delete", { id: req.params.job_id });
      res.json({ ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found")) {
        res.status(404).json({ detail: "Job not found" });
      } else {
        res.status(500).json({ detail: msg });
      }
    }
  }));

  // PUT /api/cron/jobs/:job_id/toggle
  router.put("/cron/jobs/:job_id/toggle", asyncHandler(async (req, res) => {
    const { enabled } = req.body;

    try {
      const job = await client.request<Record<string, unknown>>("cron.toggle", {
        id: req.params.job_id,
        enabled,
      });
      res.json(serializeJob(job));
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found")) {
        res.status(404).json({ detail: "Job not found" });
      } else {
        res.status(500).json({ detail: msg });
      }
    }
  }));

  // POST /api/cron/jobs/:job_id/run
  router.post("/cron/jobs/:job_id/run", asyncHandler(async (req, res) => {
    try {
      await client.request("cron.run", { id: req.params.job_id });
      res.json({ ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found")) {
        res.status(404).json({ detail: "Job not found" });
      } else {
        res.status(500).json({ detail: msg });
      }
    }
  }));

  return router;
}
