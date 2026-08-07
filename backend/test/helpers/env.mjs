// Shared test setup.
//
// TZ is pinned rather than inherited: the recurrence engine works in local wall
// time, so its DST cases are only meaningful against a zone that has DST. This
// matches infra/docker-compose.yml, and CI runners default to UTC, where a
// spring-forward test would pass for the wrong reason. Set at import time,
// before any Date is constructed - Node honours a runtime TZ change.
process.env.TZ = process.env.TZ_OVERRIDE || "America/New_York";

import fs from "fs";
import os from "os";
import path from "path";

// Each suite gets its own SQLite directory. reminders.js opens its database at
// import time from RECEIPTS_DATA_DIR, defaulting to /app/data, which does not
// exist outside the container - so this must be set before importing it.
export function useTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "home-dashboard-test-"));
  process.env.RECEIPTS_DATA_DIR = dir;
  return dir;
}

// Waits for a condition instead of sleeping a guessed interval, so the suite
// neither flakes on a slow runner nor pads every run with dead time.
export async function waitFor(fn, { timeoutMs = 5000, everyMs = 25, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
