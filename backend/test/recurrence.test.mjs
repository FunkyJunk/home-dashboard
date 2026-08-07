// Recurrence engine. Pure date arithmetic, no network.
//
// Every case here was either a bug found in review or a rule chosen
// deliberately over an alternative (clamp vs skip, fall back vs spill), so a
// failure means behaviour changed rather than a test being fussy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir } from "./helpers/env.mjs";

useTempDataDir();
const { nextOccurrence, parseDue, formatDate, formatDateTime, describeRecurrence, validateRecurrence } =
  await import("../src/reminders.js");

const at = (s) => parseDue(s).date;
const next = (spec, anchor, after) => {
  const d = nextOccurrence(spec, at(anchor), at(after));
  return d ? formatDateTime(d) : null;
};

test("parseDue treats a bare date as LOCAL midnight, not UTC", () => {
  // new Date('2026-08-07') is UTC midnight per spec, which is the previous
  // evening in any western zone - that would fire every all-day reminder a day
  // early, so the parse is done by hand.
  const p = parseDue("2026-08-07");
  assert.equal(p.allDay, true);
  assert.equal(formatDateTime(p.date), "2026-08-07 00:00:00");
  assert.equal(formatDate(p.date), "2026-08-07");
});

test("parseDue reads HA's timed format", () => {
  const p = parseDue("2026-08-07 13:30:00");
  assert.equal(p.allDay, false);
  assert.equal(formatDateTime(p.date), "2026-08-07 13:30:00");
});

test("parseDue rejects nonsense without throwing", () => {
  assert.equal(parseDue(null), null);
  assert.equal(parseDue(""), null);
  assert.equal(parseDue("not a date"), null);
});

test("daily", () => {
  assert.equal(next({ freq: "daily" }, "2026-08-07 09:00:00", "2026-08-07 10:00:00"), "2026-08-08 09:00:00");
  // Ticking early must not pull the next occurrence into today.
  assert.equal(next({ freq: "daily" }, "2026-08-07 09:00:00", "2026-08-07 07:00:00"), "2026-08-08 09:00:00");
  // Every N days keeps its original phase rather than re-basing on the tick.
  assert.equal(next({ freq: "daily", interval: 3 }, "2026-08-01 09:00:00", "2026-08-05 12:00:00"), "2026-08-07 09:00:00");
});

test("daily keeps wall-clock time across DST", () => {
  // Stepping 86_400_000ms across a 23- or 25-hour day drifts the reminder by an
  // hour: a 9am daily became 10am after spring-forward and 8am after fall-back.
  // America/New_York: 2026-03-08 springs forward, 2026-11-01 falls back.
  assert.equal(next({ freq: "daily" }, "2026-03-07 09:00:00", "2026-03-07 10:00:00"), "2026-03-08 09:00:00");
  assert.equal(next({ freq: "daily" }, "2026-10-31 09:00:00", "2026-10-31 10:00:00"), "2026-11-01 09:00:00");
  assert.equal(next({ freq: "daily", interval: 3 }, "2026-03-06 07:30:00", "2026-03-06 08:00:00"), "2026-03-09 07:30:00");
  // And when the jump is computed from a long-overdue anchor, not step by step.
  assert.equal(next({ freq: "daily" }, "2026-03-01 09:00:00", "2026-03-20 12:00:00"), "2026-03-21 09:00:00");
});

test("weekly and the weekday preset", () => {
  // Friday -> Monday for a Mon-Fri repeat.
  assert.equal(next({ freq: "weekly", byWeekday: [1, 2, 3, 4, 5] }, "2026-08-07 08:00:00", "2026-08-07 09:00:00"), "2026-08-10 08:00:00");
  // Multiple days in one week.
  assert.equal(next({ freq: "weekly", byWeekday: [2, 4] }, "2026-08-04 08:00:00", "2026-08-04 09:00:00"), "2026-08-06 08:00:00");
  // Biweekly must skip the intervening week, phase measured from the anchor.
  assert.equal(next({ freq: "weekly", interval: 2, byWeekday: [2] }, "2026-08-04 08:00:00", "2026-08-04 09:00:00"), "2026-08-18 08:00:00");
});

test("weekly keeps wall-clock time across DST", () => {
  assert.equal(next({ freq: "weekly", byWeekday: [1] }, "2026-03-02 06:00:00", "2026-03-02 07:00:00"), "2026-03-09 06:00:00");
});

test("monthly by day-of-month clamps rather than skipping", () => {
  // RRULE proper would skip February for a 31st repeat. A household reminder
  // that silently vanishes for a month is the worse failure, so it clamps.
  assert.equal(next({ freq: "monthly" }, "2026-01-31 09:00:00", "2026-01-31 10:00:00"), "2026-02-28 09:00:00");
  assert.equal(next({ freq: "monthly" }, "2026-08-15 09:00:00", "2026-08-15 10:00:00"), "2026-09-15 09:00:00");
  assert.equal(next({ freq: "monthly", interval: 3 }, "2026-08-15 09:00:00", "2026-08-16 00:00:00"), "2026-11-15 09:00:00");
  assert.equal(next({ freq: "monthly" }, "2026-02-15 09:00:00", "2026-02-15 10:00:00"), "2026-03-15 09:00:00");
});

test("monthly by nth weekday", () => {
  const nth = (n, wd) => ({ freq: "monthly", monthlyMode: "nthWeekday", nth: n, weekday: wd });
  // 2026-08-11 is the 2nd Tuesday of August; the next is 2026-09-08.
  assert.equal(next(nth(2, 2), "2026-08-11 09:00:00", "2026-08-11 10:00:00"), "2026-09-08 09:00:00");
  // Last Friday of August 2026 is the 28th; next is 2026-09-25.
  assert.equal(next(nth(-1, 5), "2026-08-28 09:00:00", "2026-08-28 10:00:00"), "2026-09-25 09:00:00");
  // August 2026 has five Mondays (3,10,17,24,31); September has four. A "5th
  // Monday" must fall back to the last one, not spill into October.
  assert.equal(next(nth(5, 1), "2026-08-31 09:00:00", "2026-08-31 10:00:00"), "2026-09-28 09:00:00");
});

test("yearly clamps Feb 29", () => {
  assert.equal(next({ freq: "yearly" }, "2026-08-07 09:00:00", "2026-08-07 10:00:00"), "2027-08-07 09:00:00");
  assert.equal(next({ freq: "yearly" }, "2024-02-29 09:00:00", "2024-03-01 00:00:00"), "2025-02-28 09:00:00");
});

test("completing an overdue reminder schedules into the future, never the past", () => {
  // The whole point of not auto-advancing a missed reminder: when it is finally
  // ticked, the next occurrence has to be ahead of now.
  const cases = [
    [{ freq: "daily" }, "2026-08-01 09:00:00", "2026-08-06 12:00:00"],
    [{ freq: "weekly", byWeekday: [1, 3] }, "2026-07-01 09:00:00", "2026-08-06 12:00:00"],
    [{ freq: "monthly" }, "2026-02-15 09:00:00", "2026-08-06 12:00:00"],
    [{ freq: "yearly" }, "2020-08-07 09:00:00", "2026-08-06 12:00:00"],
  ];
  for (const [spec, anchor, after] of cases) {
    const got = nextOccurrence(spec, at(anchor), at(after));
    assert.ok(got > at(after), `${JSON.stringify(spec)} produced ${formatDateTime(got)}, not after ${after}`);
  }
});

test("labels read as English", () => {
  assert.equal(describeRecurrence(null), null);
  assert.equal(describeRecurrence({ freq: "daily" }), "Every day");
  assert.equal(describeRecurrence({ freq: "daily", interval: 3 }), "Every 3 days");
  assert.equal(describeRecurrence({ freq: "weekly", byWeekday: [1, 2, 3, 4, 5] }), "Every weekday");
  assert.equal(describeRecurrence({ freq: "weekly", byWeekday: [1, 3] }), "Every Monday, Wednesday");
  assert.equal(describeRecurrence({ freq: "monthly", interval: 3 }), "Every 3 months");
  assert.equal(
    describeRecurrence({ freq: "monthly", monthlyMode: "nthWeekday", nth: -1, weekday: 5 }),
    "Every month on the last Friday"
  );
  assert.equal(describeRecurrence({ freq: "yearly" }), "Every year");
});

test("validation rejects unusable specs", () => {
  assert.equal(validateRecurrence(null), null);
  const bad = [
    [{ freq: "hourly" }, /freq must be one of/],
    [{ freq: "daily", interval: 0 }, /interval must be/],
    [{ freq: "daily", interval: 1.5 }, /interval must be/],
    [{ freq: "weekly" }, /at least one weekday/],
    [{ freq: "weekly", byWeekday: [9] }, /entries must be 0-6/],
    [{ freq: "monthly", monthlyMode: "nthWeekday", nth: 9, weekday: 1 }, /nth must be/],
    [{ freq: "monthly", monthlyMode: "nthWeekday", nth: 1, weekday: 12 }, /weekday must be 0-6/],
  ];
  for (const [spec, re] of bad) {
    assert.throws(() => validateRecurrence(spec), re, `expected ${JSON.stringify(spec)} to be rejected`);
  }
});

test("the backend service is given a TZ in docker-compose", async () => {
  // Not a unit test of anything in src/, deliberately. The backend shipped
  // once with no TZ, so it ran in UTC while reminders are stored and fired as
  // local wall time - every notification off by the offset, and invisible
  // because the browser rendered the time correctly. Nothing in the code could
  // have caught that; only the deployment file says when a reminder fires.
  const fs = await import("node:fs");
  const url = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const compose = fs.readFileSync(path.join(here, "../../infra/docker-compose.yml"), "utf8");

  // Isolate the backend service block: from its key to the next service at the
  // same indent, so a TZ belonging to another service cannot satisfy this.
  const match = /\n {2}backend:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_-]*:\n|$)/.exec(compose);
  assert.ok(match, "no backend service found in infra/docker-compose.yml");
  assert.match(
    match[1],
    /^\s*-\s*TZ=\S+/m,
    "infra/docker-compose.yml must set TZ on the backend service - without it " +
      "node:alpine runs in UTC and reminders fire at the wrong time"
  );
});

test("validation normalises rather than trusting input", () => {
  const spec = validateRecurrence({ freq: "weekly", byWeekday: [5, 1, 1, 3] });
  assert.deepEqual(spec.byWeekday, [1, 3, 5], "duplicates dropped and sorted");
  assert.equal(spec.interval, 1, "interval defaults to 1");
  assert.equal(validateRecurrence({ freq: "monthly" }).monthlyMode, "dayOfMonth");
});
