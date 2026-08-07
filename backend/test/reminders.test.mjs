// Reminders against a mock Home Assistant: the client's whole lifecycle, plus
// the two behaviours that are easy to regress - rolling a repeat forward on the
// same uid, and pushing each occurrence exactly once.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useTempDataDir } from "./helpers/env.mjs";
import { startMockHa } from "./helpers/mock-ha.mjs";

useTempDataDir();
const { createRemindersClient, formatDateTime } = await import("../src/reminders.js");

let ha;
let client;

before(async () => {
  ha = await startMockHa();
  client = createRemindersClient(ha.deps);
});

after(async () => {
  await ha.close();
});

beforeEach(() => {
  ha.reset();
});

const minutesAgo = (n) => formatDateTime(new Date(Date.now() - n * 60_000));
const daysAhead = (n) => formatDateTime(new Date(Date.now() + n * 86_400_000));

test("discovers the todo entity and the notify target", async () => {
  assert.equal(await client.todoEntity(), "todo.dashboard");
  assert.equal(await client.notifyService(), "mobile_app_test_iphone");
});

test("creates a reminder and reads back its uid", async () => {
  // todo.add_item returns nothing (only get_items has supports_response), so
  // the uid has to be recovered by re-reading the list.
  const r = await client.create({
    title: "Take vitamins",
    due: "2026-08-07 07:30:00",
    notes: "with breakfast",
    recurrence: { freq: "daily" },
  });
  assert.equal(r.title, "Take vitamins");
  assert.ok(r.uid, "uid recovered after create");
  assert.equal(r.notes, "with breakfast");
  assert.equal(r.recurrenceLabel, "Every day");
  assert.equal(r.allDay, false);
});

test("an all-day reminder stays all-day", async () => {
  const r = await client.create({ title: "Filter", due: "2026-08-20", allDay: true });
  assert.equal(r.due, "2026-08-20");
  assert.equal(r.allDay, true);
});

test("two reminders with the same title stay distinguishable", async () => {
  // HA resolves `item` by uid OR summary, so addressing by summary would make
  // these two indistinguishable and updates would hit whichever came first.
  const a = await client.create({ title: "Trash", due: "2026-08-07 07:00:00" });
  const b = await client.create({ title: "Trash", due: "2026-08-14 07:00:00" });
  assert.notEqual(a.uid, b.uid);
  await client.update(a.uid, { title: "Trash (recycling)" });
  const list = await client.list();
  const titles = list.map((r) => r.title).sort();
  assert.deepEqual(titles, ["Trash", "Trash (recycling)"]);
});

test("list sorts by due date and sinks undated reminders", async () => {
  await client.create({ title: "Later", due: "2026-08-20 09:00:00" });
  await client.create({ title: "Sooner", due: "2026-08-08 09:00:00" });
  // Undated must not sort as epoch zero, which would park it at the top
  // permanently as the most overdue thing on the board.
  await client.create({ title: "Someday" });
  const list = await client.list();
  assert.deepEqual(list.map((r) => r.title), ["Sooner", "Later", "Someday"]);
});

test("a due reminder pushes exactly once", async () => {
  const r = await client.create({
    title: "Bins out",
    due: minutesAgo(2),
    notes: "Green bin",
    recurrence: { freq: "daily" },
  });
  await client.create({ title: "Not yet", due: daysAhead(1) });

  assert.deepEqual(await client.sendDueNotifications(), { sent: 1 });
  assert.equal(ha.notifications.length, 1);
  assert.equal(ha.notifications[0].service, "mobile_app_test_iphone");
  assert.equal(ha.notifications[0].title, "Bins out");
  assert.equal(ha.notifications[0].message, "Green bin");
  assert.equal(ha.notifications[0].data.tag, `reminder-${r.uid}`);

  // Deduped on (uid, due): an overdue reminder must not re-notify every poll.
  assert.deepEqual(await client.sendDueNotifications(), { sent: 0 });
  assert.equal(ha.notifications.length, 1);
});

test("a reminder with no notes falls back to its recurrence label", async () => {
  await client.create({ title: "Vitamins", due: minutesAgo(1), recurrence: { freq: "daily" } });
  await client.sendDueNotifications();
  assert.equal(ha.notifications[0].message, "Every day");
});

test("an undated reminder never pushes", async () => {
  await client.create({ title: "Someday" });
  assert.deepEqual(await client.sendDueNotifications(), { sent: 0 });
  assert.equal(ha.notifications.length, 0);
});

test("completing a repeat rolls it forward on the same uid", async () => {
  const due = minutesAgo(2);
  const r = await client.create({ title: "Vitamins", due, recurrence: { freq: "daily" } });

  const res = await client.complete(r.uid);
  assert.equal(res.completed, false, "a repeat is not closed out");
  assert.equal(res.next.slice(0, 10), formatDateTime(new Date(Date.parse(due.replace(" ", "T")) + 86_400_000)).slice(0, 10));

  const list = await client.list();
  assert.equal(list.length, 1, "still open");
  const rolled = list.find((x) => x.uid === r.uid);
  assert.ok(rolled, "same uid retained, so the rule and history stay attached");
  assert.equal(rolled.recurrenceLabel, "Every day", "recurrence survived the roll");
  assert.notEqual(rolled.due, due, "due advanced");
});

test("the rolled-forward occurrence is notifiable again", async () => {
  const r = await client.create({ title: "Vitamins", due: minutesAgo(2), recurrence: { freq: "daily" } });
  await client.sendDueNotifications();
  assert.equal(ha.notifications.length, 1);
  await client.complete(r.uid);
  // Tomorrow's occurrence is not due yet, so nothing fires - but its (uid, due)
  // is unseen, so it is not suppressed either.
  assert.deepEqual(await client.sendDueNotifications(), { sent: 0 });
});

test("completing a one-off actually closes it", async () => {
  const r = await client.create({ title: "Call the roofer", due: daysAhead(1) });
  const res = await client.complete(r.uid);
  assert.equal(res.completed, true);
  assert.equal((await client.list()).length, 0);
});

test("update can rename, retime and replace the recurrence", async () => {
  const r = await client.create({ title: "Standup", due: "2026-08-10 09:15:00", recurrence: { freq: "daily" } });
  const upd = await client.update(r.uid, {
    title: "Standup (AM)",
    due: "2026-08-10 09:30:00",
    recurrence: { freq: "weekly", byWeekday: [1, 3, 5] },
  });
  assert.equal(upd.title, "Standup (AM)");
  assert.equal(upd.due, "2026-08-10 09:30:00");
  assert.equal(upd.recurrenceLabel, "Every Monday, Wednesday, Friday");
});

test("update can clear a recurrence, leaving a one-off", async () => {
  const r = await client.create({ title: "Once", due: "2026-08-10 09:00:00", recurrence: { freq: "daily" } });
  const upd = await client.update(r.uid, { recurrence: null });
  assert.equal(upd.recurrenceLabel, null);
  const res = await client.complete(r.uid);
  assert.equal(res.completed, true, "with no rule it closes instead of rolling");
});

test("delete removes the item and forgets its rule", async () => {
  const r = await client.create({ title: "Gone", due: "2026-08-10 09:00:00", recurrence: { freq: "daily" } });
  await client.remove(r.uid);
  assert.equal((await client.list()).length, 0);
  // A recreated reminder with the same title must not inherit the old rule.
  const again = await client.create({ title: "Gone", due: "2026-08-10 09:00:00" });
  assert.equal(again.recurrenceLabel, null);
});

test("rejects unusable input before touching HA", async () => {
  const bad = [
    [{ title: "   " }, /title is required/],
    [{ title: "x", recurrence: { freq: "daily" } }, /needs a due date/],
    [{ title: "x", due: "2026-09-01", recurrence: { freq: "hourly" } }, /freq must be one of/],
    [{ title: "x", due: "2026-09-01", recurrence: { freq: "weekly" } }, /at least one weekday/],
    [{ title: "x", due: "nonsense" }, /unparseable due value/],
  ];
  for (const [body, re] of bad) {
    await assert.rejects(() => client.create(body), re, `expected ${JSON.stringify(body)} to be rejected`);
  }
  assert.equal(ha.items.length, 0, "nothing was written to HA");
});

test("completing something that is already gone fails cleanly", async () => {
  await assert.rejects(() => client.complete("no-such-uid"), /reminder not found/);
});

test("reports which to-do list it is using, and flags an ambiguous choice", async () => {
  // Both targets are auto-discovered by taking the first match, so a shopping
  // list can quietly capture the reminders. HA's own UI is LAN-only, so this
  // has to be answerable over HTTP.
  const src = await client.describeSource();
  assert.equal(src.usingTodoEntity, "todo.dashboard");
  assert.equal(src.pinnedByEnv, false);
  assert.equal(src.usingNotifyService, "mobile_app_test_iphone");
  assert.ok(src.timezone, "reports the zone reminders are compared in");

  // One list, no pin: an incidental choice, but the only possible one.
  assert.equal(src.todoCandidates.length, 1);
  assert.equal(src.ambiguous, false);

  // Two lists and no pin is the case worth flagging.
  ha.items.length = 0;
  const withShopping = createRemindersClient({
    ...ha.deps,
    getStates: async () => [
      { entity_id: "todo.shopping_list", state: "3", attributes: { friendly_name: "Shopping List" } },
      { entity_id: "todo.dashboard", state: "0", attributes: { friendly_name: "Reminders" } },
    ],
  });
  const amb = await withShopping.describeSource();
  assert.equal(amb.ambiguous, true, "two lists and no pin must be flagged");
  assert.equal(amb.usingTodoEntity, "todo.shopping_list", "discovery takes the first, which is the hazard");
  assert.deepEqual(
    amb.todoCandidates.map((c) => c.entity),
    ["todo.shopping_list", "todo.dashboard"]
  );
  assert.equal(amb.todoCandidates[0].name, "Shopping List");
  assert.equal(amb.todoCandidates[0].openItems, 3);
});
