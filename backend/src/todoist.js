// Todoist API v1 integration for the Tasks widget.
// Uses Bearer token auth (Personal Token) to read/write tasks.
// Task structure returned: {id, taskListId, listTitle, title, due, allDay, recurring, notes}

const TODOIST_API_URL = "https://api.todoist.com/api/v1";

function getAuthHeaders() {
  if (!process.env.TODOIST_TOKEN) {
    throw new Error("Todoist not configured - set TODOIST_TOKEN");
  }
  return { Authorization: `Bearer ${process.env.TODOIST_TOKEN}` };
}

// Carries Todoist's own explanation alongside the status code. A bare 401
// cannot tell a revoked/regenerated token apart from one mangled in .env -
// docker compose passes surrounding quotes and trailing whitespace through
// literally, and either yields exactly the same 401. This message is the only
// place the failure is visible (it renders in the dashboard footer), so the
// reason has to travel with it. The body holds the reason, never the token.
async function todoistError(res) {
  let detail = "";
  try {
    const text = (await res.text()).trim();
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error || parsed.error_message || parsed.message || text;
    } catch {
      detail = text;
    }
  } catch {
    // Body unreadable - the status code alone still reports something useful.
  }
  detail = String(detail).replace(/\s+/g, " ").slice(0, 160);
  return new Error(
    `Todoist API error: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`
  );
}

async function fetchFromTodoist(path) {
  const res = await fetch(`${TODOIST_API_URL}${path}`, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) {
    throw await todoistError(res);
  }
  return res.json();
}

async function postToTodoist(path, body) {
  const res = await fetch(`${TODOIST_API_URL}${path}`, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await todoistError(res);
  }
  // close/complete-style endpoints return 204 No Content - res.json() throws
  // on an empty body, so only parse when there's actually something there.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function deleteFromTodoist(path) {
  const res = await fetch(`${TODOIST_API_URL}${path}`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });
  if (!res.ok) {
    throw await todoistError(res);
  }
}

// Parse Todoist's due object into our shape: {due, allDay, recurring, recurrenceLabel}
// Todoist v1 due: { date: "2026-08-02" or "2026-08-02T18:00:00", is_recurring: true, string: "every wednesday at 6:00 pm", ... }
function parseDueInfo(todoDue) {
  if (!todoDue) return { due: null, allDay: false, recurring: null, recurrenceLabel: null };

  const dateStr = todoDue.date;
  if (!dateStr) return { due: null, allDay: false, recurring: null, recurrenceLabel: null };

  const recurring = todoDue.is_recurring || null;
  // The exact phrase Todoist parsed the recurrence from (e.g. "every 1st
  // monday") - kept so the frontend can offer "keep existing" on edit
  // without having to reverse-engineer a new due_string from scratch.
  const recurrenceLabel = recurring ? todoDue.string || null : null;

  // Check if it's a timed task (contains T) or all-day (just date)
  if (dateStr.includes("T")) {
    // Timed task - store the date string as-is (it's already ISO-like)
    return { due: dateStr, allDay: false, recurring, recurrenceLabel };
  } else {
    // All-day task - store the date string
    return { due: dateStr, allDay: true, recurring, recurrenceLabel };
  }
}

export async function getReminders() {
  const tasksResponse = await fetchFromTodoist("/tasks");
  const projectsResponse = await fetchFromTodoist("/projects");

  const tasks = tasksResponse.results || [];
  const projects = Array.isArray(projectsResponse) ? projectsResponse : (projectsResponse.results || []);

  const projectMap = new Map(projects.map((p) => [p.id, p.name]));

  const out = tasks
    .filter((t) => !t.checked)
    .map((t) => {
      const dueInfo = parseDueInfo(t.due);
      return {
        id: t.id,
        taskListId: t.project_id,
        listTitle: projectMap.get(t.project_id) || "Inbox",
        title: t.content,
        due: dueInfo.due,
        allDay: dueInfo.allDay,
        recurring: !!dueInfo.recurring,
        recurrenceLabel: dueInfo.recurrenceLabel,
        notes: t.description || null,
      };
    });

  // Sort by due date (overdue first, then by date)
  out.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    return a.due ? -1 : b.due ? 1 : 0;
  });

  return out;
}

export async function getReminderLists() {
  const projectsResponse = await fetchFromTodoist("/projects");
  const projects = Array.isArray(projectsResponse) ? projectsResponse : (projectsResponse.results || []);
  return projects.map((p) => ({ id: p.id, title: p.name }));
}

export async function deleteReminder(reminderId) {
  await deleteFromTodoist(`/tasks/${reminderId}`);
}

export async function completeReminder(listId, reminderId) {
  await postToTodoist(`/tasks/${reminderId}/close`, {});
}

// Todoist has no structured recurrence field (no RRULE-equivalent) - the
// only way to set a repeating due date is a natural-language due_string
// that its own NLP parser interprets (confirmed against the live API,
// 2026-08-02: a nested due_object.recurring key like "FREQ=DAILY" is not a
// real field at all, so it was silently dropped and every created task
// came back with no due date whatsoever - the actual bug being fixed here).
export async function createReminder({
  listId,
  title,
  due,
  allDay,
  notes,
  dueString,
}) {
  const body = {
    content: title,
    project_id: listId || undefined,
    description: notes || undefined,
  };

  if (dueString) {
    body.due_string = dueString;
    body.due_lang = "en";
  } else if (due) {
    if (allDay) {
      body.due_date = due; // plain YYYY-MM-DD
    } else {
      body.due_datetime = due; // full ISO 8601
    }
  }

  const task = await postToTodoist("/tasks", body);

  const dueInfo = parseDueInfo(task.due);
  return {
    id: task.id,
    taskListId: task.project_id,
    listTitle: "Created",
    title: task.content,
    due: dueInfo.due,
    allDay: dueInfo.allDay,
    recurring: !!dueInfo.recurring,
    notes: task.description || null,
  };
}

export async function updateReminder(reminderId, { title, due, allDay, notes, dueString }) {
  const body = {};
  if (title !== undefined) body.content = title;
  if (notes !== undefined) body.description = notes;

  if (dueString) {
    body.due_string = dueString;
    body.due_lang = "en";
  } else if (due) {
    if (allDay) {
      body.due_date = due;
    } else {
      body.due_datetime = due;
    }
  } else if (due === null) {
    body.due_string = "no date";
  }

  const task = await postToTodoist(`/tasks/${reminderId}`, body);

  const dueInfo = parseDueInfo(task.due);
  return {
    id: task.id,
    taskListId: task.project_id,
    listTitle: "Updated",
    title: task.content,
    due: dueInfo.due,
    allDay: dueInfo.allDay,
    recurring: !!dueInfo.recurring,
    notes: task.description || null,
  };
}

