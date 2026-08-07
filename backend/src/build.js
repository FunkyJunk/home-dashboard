// Build and runtime provenance, so "is what I pushed actually running?" can be
// answered from the dashboard instead of by SSH-ing into the NAS.
//
// The build values are Docker build args set by CI (.github/workflows/
// build-and-push.yml) and baked into the image as env vars. All of them being
// null is itself informative: it means this image was not built by CI.
//
// Frontend and backend are separate images built by separate matrix jobs, so
// they can legitimately be at different commits - the Settings page compares
// them, because "I deployed but nothing changed" is usually one of the two
// lagging rather than the deploy failing.

import express from "express";
import util from "util";

const MAX_LOG_LINES = Math.min(Number(process.env.BUILD_LOG_LINES ?? 300), 2000);
const lines = [];
const startedAt = new Date();

function push(level, args) {
  let text;
  try {
    text = args
      .map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 2, breakLength: 120 })))
      .join(" ");
  } catch {
    text = "<unserialisable log line>";
  }
  // Capped per line as well as in total: one stack trace should not evict the
  // whole buffer.
  lines.push({ at: new Date().toISOString(), level, text: text.slice(0, 2000) });
  if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
}

// console is wrapped, not replaced, so `docker logs` still receives everything
// and stays the source of truth. This buffer is only a convenience copy for
// when there is no shell to hand.
//
// Nothing here redacts, so never console.log a token or a full .env value -
// this endpoint makes anything logged readable over HTTP.
export function captureConsole() {
  for (const level of ["log", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      push(level, args);
    };
  }
}

export function buildInfo() {
  const commit = process.env.BUILD_COMMIT || null;
  return {
    builtByCi: !!commit,
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    ref: process.env.BUILD_REF || null,
    builtAt: process.env.BUILD_TIME || null,
    ciRunNumber: process.env.BUILD_RUN_NUMBER || null,
    ciRunUrl: process.env.BUILD_RUN_URL || null,
    image: process.env.BUILD_IMAGE || null,
    runtime: {
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      // Included because it silently decides when reminders fire, and it was
      // wrong once - see logEffectiveTimezone in index.js.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      tzEnvSet: !!process.env.TZ,
      localTime: new Date().toString(),
      logLinesBuffered: lines.length,
      logCapacity: MAX_LOG_LINES,
    },
  };
}

export function createBuildRouter() {
  const router = express.Router();

  router.get("/", (_req, res) => res.json(buildInfo()));

  router.get("/log", (req, res) => {
    const requested = Number(req.query.limit);
    const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 200, MAX_LOG_LINES);
    const level = String(req.query.level || "").toLowerCase();
    let out = lines;
    if (level === "warn" || level === "error") {
      // "warn" means warn-and-worse, which is what you want when scanning for
      // trouble rather than reading everything.
      const wanted = level === "warn" ? ["warn", "error"] : ["error"];
      out = lines.filter((l) => wanted.includes(l.level));
    }
    res.json({
      capacity: MAX_LOG_LINES,
      buffered: lines.length,
      returned: Math.min(limit, out.length),
      lines: out.slice(-limit),
    });
  });

  return router;
}
