// Reminders backed by a Home Assistant `todo` entity (Local To-do), with
// recurrence and iPhone push handled here.
//
// Why the split: HA's todo model has no recurrence field at all. TodoItem is
// (uid, summary, status, due, description, completed) and todo.add_item /
// todo.update_item accept only item/rename/status/due_date/due_datetime/
// description - verified against homeassistant/components/todo/services.yaml
// and local_todo's supported_features. So HA stores the *next* occurrence of
// each reminder and this module owns the repeat rule, in its own SQLite file.
//
// Items are addressed by uid, never by summary. HA resolves the `item` field
// with _find_by_uid_or_summary, so a summary works too - but two reminders
// called "Trash" would then be indistinguishable and updates would hit
// whichever came first. uid is the only safe key.
//
// todo.get_items is SupportsResponse.ONLY, so reading the list must go through
// POST /api/services/todo/get_items?return_response and unwrap
// service_response - a plain POST is rejected by HA with "Add ?return_response
// to query parameters".

import fs from "fs";
import path from "path";
import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";

const DATA_DIR = process.env.RECEIPTS_DATA_DIR || "/app/data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "reminders.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS recurrence (
    uid        TEXT PRIMARY KEY,
    spec       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  -- One row per occurrence actually pushed, so a 60s poll cycle cannot
  -- re-notify the same due moment over and over. Keyed by the occurrence's
  -- own due stamp: advancing a recurring reminder yields a new due, hence a
  -- new row, hence exactly one push per occurrence.
  CREATE TABLE IF NOT EXISTS notified (
    uid     TEXT NOT NULL,
    due     TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (uid, due)
  );
`);

const stmts = {
  getSpec: db.prepare("SELECT spec FROM recurrence WHERE uid = ?"),
  allSpecs: db.prepare("SELECT uid, spec FROM recurrence"),
  putSpec: db.prepare(
    "INSERT INTO recurrence (uid, spec, created_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(uid) DO UPDATE SET spec = excluded.spec"
  ),
  dropSpec: db.prepare("DELETE FROM recurrence WHERE uid = ?"),
  wasNotified: db.prepare("SELECT 1 FROM notified WHERE uid = ? AND due = ?"),
  markNotified: db.prepare(
    "INSERT OR IGNORE INTO notified (uid, due, sent_at) VALUES (?, ?, ?)"
  ),
  dropNotified: db.prepare("DELETE FROM notified WHERE uid = ?"),
};

// ---------------------------------------------------------------------------
// Due-value parsing
//
// HA hands back either "2026-08-07" (all-day) or "2026-08-07 13:30:00" (timed,
// naive local). Both are parsed as *local* time deliberately: a naive stamp
// means local wall time on both sides, and the browser writes these from what
// the user typed into a date/time input.
//
// That makes the container's TZ load-bearing, not cosmetic. It is set on the
// backend service in infra/docker-compose.yml; the image itself (node:20-alpine)
// has no timezone configured and would otherwise run in UTC, shifting every
// notification by the offset while the dashboard kept displaying the time that
// was typed. startup logs the effective zone so a missing TZ is visible rather
// than silent - see logEffectiveTimezone in index.js.
//
// Passing these through `new Date(str)` would be a separate trap: a bare
// "2026-08-07" is treated as UTC midnight by the spec, which lands on the
// previous evening in any western timezone and would fire every all-day
// reminder a day early.
// ---------------------------------------------------------------------------

export function parseDue(due) {
  if (!due) return null;
  const s = String(due).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return { allDay: true, date: new Date(Number(y), Number(m) - 1, Number(d)) };
  }
  const timed = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (timed) {
    const [, y, m, d, hh, mm, ss] = timed;
    return {
      allDay: false,
      date: new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss || 0)),
    };
  }
  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : { allDay: false, date: fallback };
}

const pad = (n) => String(n).padStart(2, "0");

export function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDateTime(d) {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Recurrence
//
// Spec shape (all fields optional except freq):
//   { freq: 'daily'|'weekly'|'monthly'|'yearly',
//     interval: 1,                        // every N periods
//     byWeekday: [1,2,3,4,5],             // weekly; 0=Sunday
//     monthlyMode: 'dayOfMonth'|'nthWeekday',
//     nth: 1..5 | -1,                     // nthWeekday; -1 = last
//     weekday: 0..6 }                     // nthWeekday
//
// The UI presets (daily, weekdays, weekly, biweekly, monthly, nth-weekday,
// yearly, every-N-of-each) all compress into this one object, so the engine
// stays a single code path instead of a preset switch that has to grow every
// time a new option is offered.
// ---------------------------------------------------------------------------

const FREQS = new Set(["daily", "weekly", "monthly", "yearly"]);

export function validateRecurrence(spec) {
  if (spec == null) return null;
  if (typeof spec !== "object") throw new Error("recurrence must be an object");
  if (!FREQS.has(spec.freq)) {
    throw new Error(`recurrence.freq must be one of ${[...FREQS].join(", ")}`);
  }
  const interval = Number(spec.interval ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    throw new Error("recurrence.interval must be an integer between 1 and 365");
  }
  const out = { freq: spec.freq, interval };

  if (spec.freq === "weekly") {
    const days = Array.isArray(spec.byWeekday) ? [...new Set(spec.byWeekday.map(Number))] : [];
    if (!days.length) throw new Error("weekly recurrence needs at least one weekday");
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error("recurrence.byWeekday entries must be 0-6");
    }
    out.byWeekday = days.sort((a, b) => a - b);
  }

  if (spec.freq === "monthly") {
    out.monthlyMode = spec.monthlyMode === "nthWeekday" ? "nthWeekday" : "dayOfMonth";
    if (out.monthlyMode === "nthWeekday") {
      const nth = Number(spec.nth);
      const weekday = Number(spec.weekday);
      if (![1, 2, 3, 4, 5, -1].includes(nth)) {
        throw new Error("recurrence.nth must be 1-5 or -1 for last");
      }
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        throw new Error("recurrence.weekday must be 0-6");
      }
      out.nth = nth;
      out.weekday = weekday;
    }
  }

  return out;
}

// Day-of-month arithmetic clamps rather than skips: a "31st of each month"
// reminder lands on Feb 28/29 instead of vanishing for the short months. RRULE
// proper would skip, but a reminder that silently disappears for a month is
// the worse failure for a household to-do list.
function addMonthsClamped(d, months) {
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1, d.getHours(), d.getMinutes(), d.getSeconds());
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return target;
}

function nthWeekdayOfMonth(year, month, weekday, nth) {
  if (nth === -1) {
    const last = new Date(year, month + 1, 0);
    const shift = (last.getDay() - weekday + 7) % 7;
    return new Date(year, month, last.getDate() - shift);
  }
  const first = new Date(year, month, 1);
  const shift = (weekday - first.getDay() + 7) % 7;
  const day = 1 + shift + (nth - 1) * 7;
  const lastDay = new Date(year, month + 1, 0).getDate();
  // A "5th Tuesday" does not exist every month - fall back to the last one
  // rather than rolling into the following month, which would silently move
  // the reminder off the month the user picked.
  return new Date(year, month, day > lastDay ? day - 7 : day);
}

const atTimeOf = (d, ref) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), ref.getHours(), ref.getMinutes(), ref.getSeconds());

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// Steps whole CALENDAR days, keeping ref's wall-clock time. Adding 86_400_000ms
// instead would drift by an hour across a DST boundary, because that day is 23
// or 25 hours long - a 9am daily reminder became 10am after spring-forward and
// 8am after fall-back.
const addDays = (d, n, ref) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, ref.getHours(), ref.getMinutes(), ref.getSeconds());

// Returns the first occurrence strictly after `after`, keeping the time-of-day
// of `anchor` (the reminder's original due moment).
export function nextOccurrence(spec, anchor, after) {
  const rule = validateRecurrence(spec);
  if (!rule) return null;
  const base = after > anchor ? after : anchor;

  if (rule.freq === "daily") {
    let next = atTimeOf(anchor, anchor);
    if (next <= base) {
      // Whole calendar days from anchor to base. Measured between local
      // midnights and rounded, so the one 23- or 25-hour day each year cannot
      // skew the count. Stepping is from the anchor so "every 3 days" keeps its
      // original cadence rather than re-basing on when it was ticked off.
      const elapsedDays = Math.round((startOfDay(base) - startOfDay(anchor)) / DAY_MS);
      let steps = Math.max(rule.interval, Math.ceil(elapsedDays / rule.interval) * rule.interval);
      next = addDays(anchor, steps, anchor);
      while (next <= base) {
        steps += rule.interval;
        next = addDays(anchor, steps, anchor);
      }
    }
    return next;
  }

  if (rule.freq === "weekly") {
    // Walk forward a day at a time and keep the first matching weekday that
    // also falls in an "every N weeks" week. Week index is measured from the
    // anchor's week so the phase is stable across completions.
    const anchorWeekStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay());
    for (let i = 1; i <= 366 * 2; i++) {
      const cand = atTimeOf(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i), anchor);
      if (!rule.byWeekday.includes(cand.getDay())) continue;
      const candWeekStart = new Date(cand.getFullYear(), cand.getMonth(), cand.getDate() - cand.getDay());
      const weeks = Math.round((candWeekStart - anchorWeekStart) / (7 * 24 * 60 * 60 * 1000));
      if (weeks % rule.interval !== 0) continue;
      if (cand > base) return cand;
    }
    return null;
  }

  if (rule.freq === "monthly") {
    if (rule.monthlyMode === "nthWeekday") {
      for (let i = 0; i <= 120; i++) {
        const probe = new Date(anchor.getFullYear(), anchor.getMonth() + i * rule.interval, 1);
        const cand = atTimeOf(
          nthWeekdayOfMonth(probe.getFullYear(), probe.getMonth(), rule.weekday, rule.nth),
          anchor
        );
        if (cand > base) return cand;
      }
      return null;
    }
    for (let i = 1; i <= 120; i++) {
      const cand = addMonthsClamped(anchor, i * rule.interval);
      if (cand > base) return cand;
    }
    return null;
  }

  // yearly
  for (let i = 1; i <= 50; i++) {
    const cand = addMonthsClamped(anchor, i * 12 * rule.interval);
    if (cand > base) return cand;
  }
  return null;
}

// Human label, used in the card and in the push body so a notification says
// what it is without opening the dashboard.
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NTH_LABELS = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", "-1": "last" };

export function describeRecurrence(spec) {
  if (!spec) return null;
  const n = spec.interval || 1;
  if (spec.freq === "daily") return n === 1 ? "Every day" : `Every ${n} days`;
  if (spec.freq === "weekly") {
    const days = (spec.byWeekday || []).map((d) => WEEKDAY_LABELS[d]);
    const isWeekdays = (spec.byWeekday || []).join() === "1,2,3,4,5";
    const which = isWeekdays ? "weekday" : days.join(", ");
    if (n === 1) return isWeekdays ? "Every weekday" : `Every ${which}`;
    return `Every ${n} weeks on ${which}`;
  }
  if (spec.freq === "monthly") {
    const every = n === 1 ? "Every month" : `Every ${n} months`;
    if (spec.monthlyMode === "nthWeekday") {
      return `${every} on the ${NTH_LABELS[String(spec.nth)]} ${WEEKDAY_LABELS[spec.weekday]}`;
    }
    // Same-date is the default reading of "every month", and spelling it out
    // pushed the badge onto a second line in the card's narrow column.
    return every;
  }
  return n === 1 ? "Every year" : `Every ${n} years`;
}

// ---------------------------------------------------------------------------
// Home Assistant todo client
// ---------------------------------------------------------------------------

export function createRemindersClient({ callHaService, callHaServiceForResponse, getStates, listServices }) {
  let cachedEntity = null;
  let cachedNotify = null;

  async function todoEntity() {
    if (process.env.HA_TODO_ENTITY) return process.env.HA_TODO_ENTITY;
    if (cachedEntity) return cachedEntity;
    const states = await getStates();
    const found = (states || []).find((s) => String(s.entity_id || "").startsWith("todo."));
    if (!found) {
      throw new Error(
        "no todo entity found in Home Assistant - add the Local To-do integration, or set HA_TODO_ENTITY"
      );
    }
    cachedEntity = found.entity_id;
    return cachedEntity;
  }

  // Resolved by discovery so a new phone doesn't need a code change, but
  // HA_NOTIFY_SERVICE wins when set - discovery picks the first mobile_app
  // target, which is wrong the moment a second device is paired.
  async function notifyService() {
    if (process.env.HA_NOTIFY_SERVICE) return process.env.HA_NOTIFY_SERVICE;
    if (cachedNotify) return cachedNotify;
    const domains = await listServices();
    const notify = (domains || []).find((d) => d.domain === "notify");
    const name = Object.keys(notify?.services || {}).find((s) => s.startsWith("mobile_app_"));
    if (!name) return null;
    cachedNotify = name;
    return cachedNotify;
  }

  // Which list am I actually writing to? Both targets are auto-discovered by
  // taking the FIRST match, so with a shopping list present the reminders can
  // silently land there and nothing in the UI would say so. Reportable over
  // HTTP specifically because Home Assistant's own UI is LAN-only - checking
  // this used to require being at home.
  async function describeSource() {
    const states = await getStates();
    const candidates = (states || [])
      .filter((s) => String(s.entity_id || "").startsWith("todo."))
      .map((s) => ({
        entity: s.entity_id,
        name: s.attributes?.friendly_name || null,
        openItems: Number(s.state) || 0,
      }));
    const entity = await todoEntity();
    return {
      usingTodoEntity: entity,
      pinnedByEnv: !!process.env.HA_TODO_ENTITY,
      todoCandidates: candidates,
      // Flagged rather than left for the reader to spot: more than one list and
      // no explicit pin means the choice is incidental.
      ambiguous: candidates.length > 1 && !process.env.HA_TODO_ENTITY,
      usingNotifyService: (await notifyService()) || null,
      notifyPinnedByEnv: !!process.env.HA_NOTIFY_SERVICE,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      localTime: new Date().toString(),
    };
  }

  async function rawItems(status) {
    const entity_id = await todoEntity();
    const body = { entity_id };
    if (status) body.status = Array.isArray(status) ? status : [status];
    const res = await callHaServiceForResponse("todo", "get_items", body);
    // service_response is keyed by entity id: { "todo.x": { items: [...] } }
    const perEntity = res?.service_response || {};
    return perEntity[entity_id]?.items || Object.values(perEntity)[0]?.items || [];
  }

  function decorate(item) {
    const spec = specFor(item.uid);
    const parsed = parseDue(item.due);
    return {
      uid: item.uid,
      title: item.summary,
      notes: item.description || null,
      status: item.status,
      due: item.due || null,
      allDay: parsed ? parsed.allDay : null,
      recurrence: spec,
      recurrenceLabel: describeRecurrence(spec),
    };
  }

  function specFor(uid) {
    const row = stmts.getSpec.get(uid);
    if (!row) return null;
    try {
      return JSON.parse(row.spec);
    } catch {
      return null;
    }
  }

  async function list() {
    const items = await rawItems(["needs_action"]);
    return items
      .map(decorate)
      .sort((a, b) => {
        // Undated reminders sink below dated ones rather than sorting as epoch
        // zero, which would park them permanently at the top as "overdue".
        const da = parseDue(a.due)?.date;
        const dbb = parseDue(b.due)?.date;
        if (!da && !dbb) return String(a.title).localeCompare(String(b.title));
        if (!da) return 1;
        if (!dbb) return -1;
        return da - dbb;
      });
  }

  function dueFields({ due, allDay }) {
    if (!due) return {};
    const parsed = parseDue(due);
    if (!parsed) throw new Error(`unparseable due value: ${due}`);
    return allDay ?? parsed.allDay
      ? { due_date: formatDate(parsed.date) }
      : { due_datetime: formatDateTime(parsed.date) };
  }

  async function create({ title, due, allDay, notes, recurrence }) {
    const summary = String(title || "").trim();
    if (!summary) throw new Error("title is required");
    const spec = validateRecurrence(recurrence);
    if (spec && !due) throw new Error("a recurring reminder needs a due date");

    const entity_id = await todoEntity();
    const fields = { entity_id, item: summary, ...dueFields({ due, allDay }) };
    if (notes) fields.description = String(notes);
    await callHaService("todo", "add_item", fields);

    // todo.add_item returns nothing (only get_items has supports_response), so
    // the uid has to be recovered by re-reading. Match on summary and prefer
    // the item whose due matches what was just written, which disambiguates
    // when a reminder of the same name already exists.
    const items = await rawItems(["needs_action"]);
    const matches = items.filter((i) => i.summary === summary);
    const wanted = fields.due_datetime || fields.due_date || null;
    const created =
      matches.find((i) => (i.due || null) === wanted) || matches[matches.length - 1] || null;
    if (!created) throw new Error("reminder was added but could not be read back from Home Assistant");

    if (spec) stmts.putSpec.run(created.uid, JSON.stringify(spec), new Date().toISOString());
    return decorate(created);
  }

  async function update(uid, { title, due, allDay, notes, recurrence }) {
    const entity_id = await todoEntity();
    const fields = { entity_id, item: uid };
    if (title !== undefined) fields.rename = String(title).trim();
    if (notes !== undefined) fields.description = String(notes || "");
    if (due !== undefined) {
      if (due === null) throw new Error("clearing a due date is not supported by Home Assistant");
      Object.assign(fields, dueFields({ due, allDay }));
    }
    // update_item rejects a call with nothing to change (has_at_least_one_key).
    const changing = Object.keys(fields).filter((k) => k !== "entity_id" && k !== "item");
    if (changing.length) await callHaService("todo", "update_item", fields);

    if (recurrence !== undefined) {
      const spec = validateRecurrence(recurrence);
      if (spec) stmts.putSpec.run(uid, JSON.stringify(spec), new Date().toISOString());
      else stmts.dropSpec.run(uid);
    }

    const items = await rawItems(["needs_action"]);
    const found = items.find((i) => i.uid === uid);
    return found ? decorate(found) : { uid };
  }

  // Completing a recurring reminder rolls it forward instead of closing it:
  // same uid, new due. That keeps the recurrence row and the item's history
  // attached, and means the notified table naturally allows one push per
  // occurrence. A non-recurring reminder is simply marked completed.
  async function complete(uid) {
    const entity_id = await todoEntity();
    const items = await rawItems(["needs_action"]);
    const item = items.find((i) => i.uid === uid);
    if (!item) throw new Error("reminder not found");

    const spec = specFor(uid);
    const parsed = parseDue(item.due);
    if (!spec || !parsed) {
      await callHaService("todo", "update_item", { entity_id, item: uid, status: "completed" });
      return { uid, completed: true, next: null };
    }

    const next = nextOccurrence(spec, parsed.date, new Date());
    if (!next) {
      await callHaService("todo", "update_item", { entity_id, item: uid, status: "completed" });
      return { uid, completed: true, next: null };
    }
    await callHaService("todo", "update_item", {
      entity_id,
      item: uid,
      ...(parsed.allDay ? { due_date: formatDate(next) } : { due_datetime: formatDateTime(next) }),
    });
    return {
      uid,
      completed: false,
      next: parsed.allDay ? formatDate(next) : formatDateTime(next),
    };
  }

  async function remove(uid) {
    const entity_id = await todoEntity();
    await callHaService("todo", "remove_item", { entity_id, item: uid });
    stmts.dropSpec.run(uid);
    stmts.dropNotified.run(uid);
  }

  // All-day reminders have no time to fire at, so they go out at a set hour
  // rather than at midnight, where they would land in a notification shade
  // nobody looks at until morning.
  const allDayHour = Number(process.env.REMINDER_ALLDAY_HOUR ?? 8);

  async function sendDueNotifications(now = new Date()) {
    const service = await notifyService();
    if (!service) {
      return { sent: 0, skipped: "no notify.mobile_app_* service found in Home Assistant" };
    }
    const items = await rawItems(["needs_action"]);
    let sent = 0;
    for (const item of items) {
      const parsed = parseDue(item.due);
      if (!parsed) continue;
      const fireAt = parsed.allDay
        ? new Date(parsed.date.getFullYear(), parsed.date.getMonth(), parsed.date.getDate(), allDayHour)
        : parsed.date;
      if (fireAt > now) continue;
      const dueKey = item.due;
      if (stmts.wasNotified.get(item.uid, dueKey)) continue;

      const spec = specFor(item.uid);
      const label = describeRecurrence(spec);
      await callHaService("notify", service, {
        title: item.summary,
        message: item.description || label || "Reminder due",
        data: {
          tag: `reminder-${item.uid}`,
          url: "/lovelace",
        },
      });
      stmts.markNotified.run(item.uid, dueKey, new Date().toISOString());
      sent++;
    }
    return { sent };
  }

  return {
    list, create, update, complete, remove,
    sendDueNotifications, todoEntity, notifyService, describeSource,
  };
}

export function createRemindersRouter(client) {
  const router = express.Router();

  // Registered ahead of the parameterised routes so "source" is never taken
  // for a reminder uid.
  router.get("/source", async (_req, res) => {
    try {
      res.json(await client.describeSource());
    } catch (e) {
      res.status(502).json({ error: e.message || "failed to describe reminder source" });
    }
  });

  router.get("/", async (_req, res) => {
    try {
      res.json(await client.list());
    } catch (e) {
      res.status(502).json({ error: e.message || "failed to load reminders" });
    }
  });

  router.post("/", async (req, res) => {
    try {
      res.json(await client.create(req.body || {}));
    } catch (e) {
      res.status(badRequest(e) ? 400 : 502).json({ error: e.message || "failed to create reminder" });
    }
  });

  router.patch("/:uid", async (req, res) => {
    try {
      res.json(await client.update(req.params.uid, req.body || {}));
    } catch (e) {
      res.status(badRequest(e) ? 400 : 502).json({ error: e.message || "failed to update reminder" });
    }
  });

  router.post("/:uid/complete", async (req, res) => {
    try {
      res.json(await client.complete(req.params.uid));
    } catch (e) {
      res.status(502).json({ error: e.message || "failed to complete reminder" });
    }
  });

  router.delete("/:uid", async (req, res) => {
    try {
      await client.remove(req.params.uid);
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.message || "failed to delete reminder" });
    }
  });

  return router;
}

const badRequest = (e) =>
  /required|must be|needs at least|needs a due|unparseable|not supported/i.test(e.message || "");

// Polls rather than scheduling a timer per reminder: reminders change from
// three directions (this dashboard, the HA to-do panel, an HA automation), so
// a timer table would drift out of sync with the list it is meant to track.
export function startReminderScheduler(client, { intervalSeconds } = {}) {
  const every = Number(process.env.REMINDER_POLL_SECONDS ?? intervalSeconds ?? 60) * 1000;
  let running = false;

  const tick = async () => {
    if (running) return; // a slow HA must not stack overlapping passes
    running = true;
    try {
      const out = await client.sendDueNotifications();
      if (out.sent) console.log(`[reminders] pushed ${out.sent} due reminder(s)`);
    } catch (e) {
      // Logged, never thrown: an unhandled rejection in here would take the
      // whole backend down and with it the rest of the dashboard.
      console.warn(`[reminders] notification pass failed: ${e.message}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, every);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
