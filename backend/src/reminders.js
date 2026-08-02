import { createDAVClient } from "tsdav";
import ical from "node-ical";
import crypto from "crypto";

// iCloud Reminders lives on the CalDAV protocol - reminder lists are just
// calendar collections whose supported-components is VTODO instead of
// VEVENT. Confirmed (2026-08-02) against the real Tasks API that Google
// Tasks cannot expose a due *time* or recurrence at all, even round-tripped
// through our own writes - CalDAV genuinely supports both, which is the
// whole reason this replaced the Google Tasks integration.
const ICLOUD_SERVER_URL = "https://caldav.icloud.com";

let clientPromise = null;
function getClient() {
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    throw new Error("Apple Reminders not configured - set APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD");
  }
  if (!clientPromise) {
    clientPromise = createDAVClient({
      serverUrl: ICLOUD_SERVER_URL,
      credentials: {
        username: process.env.APPLE_ID,
        password: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  }
  return clientPromise;
}

function calendarLabel(cal) {
  if (typeof cal.displayName === "string") return cal.displayName;
  return cal.displayName?._text || cal.displayName?._cdata || "Reminders";
}

async function getReminderCalendars() {
  const client = await getClient();
  const calendars = await client.fetchCalendars();
  return calendars.filter((c) => (c.components || []).includes("VTODO"));
}

// TEMPORARY diagnostic - dumps every calendar iCloud returns (so we can see
// the real shape of `components`/`displayName`) plus raw object counts and
// the first object's raw ICS text per VTODO-supporting calendar. Remove
// once the empty-results issue is understood.
export async function debugDump() {
  const client = await getClient();
  const allCalendars = await client.fetchCalendars();
  const summary = allCalendars.map((c) => ({
    url: c.url,
    displayName: c.displayName,
    components: c.components,
    resourcetype: c.resourcetype,
  }));
  const vtodoCalendars = allCalendars.filter((c) => (c.components || []).includes("VTODO"));
  const perCalendar = await Promise.all(
    vtodoCalendars.map(async (cal) => {
      const objects = await client.fetchCalendarObjects({ calendar: cal });
      return {
        url: cal.url,
        objectCount: objects.length,
        firstObjectRaw: objects[0]?.data || null,
      };
    })
  );
  return { allCalendars: summary, vtodoCalendars: perCalendar };
}

// RFC 5545 basic UTC date-time format, e.g. 20260802T183000Z.
function icsDateStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

// One .ics resource can contain more than one VTODO in principle, so this
// walks every component node-ical found rather than assuming one-per-object.
function parseTodos(calendar, objects) {
  const out = [];
  for (const obj of objects) {
    if (!obj.data) continue;
    let parsed;
    try {
      parsed = ical.sync.parseICS(obj.data);
    } catch {
      continue;
    }
    for (const uid in parsed) {
      const item = parsed[uid];
      if (item.type !== "VTODO") continue;
      if (item.status === "COMPLETED" || item.status === "CANCELLED") continue;
      let due = null;
      let allDay = false;
      if (item.due) {
        if (item.due.dateOnly) {
          // A DATE-only DUE has no real timezone - node-ical builds it as
          // local midnight on this process's own clock, so reading it back
          // with local getters (not toISOString, which would reintroduce a
          // UTC offset) reproduces the same calendar date the ICS meant,
          // regardless of what timezone this container happens to run in.
          const y = item.due.getFullYear();
          const m = String(item.due.getMonth() + 1).padStart(2, "0");
          const d = String(item.due.getDate()).padStart(2, "0");
          due = `${y}-${m}-${d}`;
          allDay = true;
        } else {
          due = item.due.toISOString();
        }
      }
      out.push({
        id: item.uid,
        taskListId: calendar.url,
        listTitle: calendarLabel(calendar),
        title: item.summary || "(untitled)",
        due,
        allDay,
        recurring: !!item.rrule,
        notes: item.description || null,
      });
    }
  }
  return out;
}

export async function getReminders() {
  const client = await getClient();
  const calendars = await getReminderCalendars();
  const perCalendar = await Promise.all(
    calendars.map((cal) => client.fetchCalendarObjects({ calendar: cal }))
  );
  const all = [];
  calendars.forEach((cal, i) => all.push(...parseTodos(cal, perCalendar[i])));
  all.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    return a.due ? -1 : b.due ? 1 : 0;
  });
  return all;
}

export async function getReminderLists() {
  const calendars = await getReminderCalendars();
  return calendars.map((c) => ({ id: c.url, title: calendarLabel(c) }));
}

export async function completeReminder(listId, reminderId) {
  const client = await getClient();
  const calendars = await getReminderCalendars();
  const calendar = calendars.find((c) => c.url === listId);
  if (!calendar) throw new Error("reminder list not found");

  const objects = await client.fetchCalendarObjects({ calendar });
  for (const obj of objects) {
    if (!obj.data) continue;
    let parsed;
    try {
      parsed = ical.sync.parseICS(obj.data);
    } catch {
      continue;
    }
    if (!parsed[reminderId] || parsed[reminderId].type !== "VTODO") continue;

    const nowStamp = icsDateStamp(new Date());
    let text = obj.data;
    text = /^STATUS:.*$/m.test(text)
      ? text.replace(/^STATUS:.*$/m, "STATUS:COMPLETED")
      : text.replace(/^END:VTODO$/m, "STATUS:COMPLETED\r\nEND:VTODO");
    text = /^COMPLETED:.*$/m.test(text)
      ? text.replace(/^COMPLETED:.*$/m, `COMPLETED:${nowStamp}`)
      : text.replace(/^END:VTODO$/m, `COMPLETED:${nowStamp}\r\nEND:VTODO`);

    await client.updateCalendarObject({
      calendarObject: { url: obj.url, etag: obj.etag, data: text },
    });
    return;
  }
  throw new Error("reminder not found");
}

export async function createReminder({ listId, title, due, allDay, notes, dailyRepeat }) {
  const calendars = await getReminderCalendars();
  const calendar = listId ? calendars.find((c) => c.url === listId) : calendars[0];
  if (!calendar) throw new Error("reminder list not found");
  const client = await getClient();

  const uid = crypto.randomUUID();
  const nowStamp = icsDateStamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//home-dashboard//EN",
    "BEGIN:VTODO",
    `UID:${uid}`,
    `DTSTAMP:${nowStamp}`,
    `SUMMARY:${escapeIcsText(title)}`,
    "STATUS:NEEDS-ACTION",
  ];
  if (due) {
    lines.push(allDay ? `DUE;VALUE=DATE:${due.replace(/-/g, "")}` : `DUE:${icsDateStamp(new Date(due))}`);
  }
  if (notes) lines.push(`DESCRIPTION:${escapeIcsText(notes)}`);
  if (dailyRepeat) lines.push("RRULE:FREQ=DAILY");
  lines.push("END:VTODO", "END:VCALENDAR");

  await client.createCalendarObject({
    calendar,
    iCalString: lines.join("\r\n") + "\r\n",
    filename: `${uid}.ics`,
  });

  return {
    id: uid,
    taskListId: calendar.url,
    listTitle: calendarLabel(calendar),
    title,
    due: due || null,
    allDay: !!allDay,
    recurring: !!dailyRepeat,
    notes: notes || null,
  };
}
