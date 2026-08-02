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

async function fetchFromTodoist(path) {
  const res = await fetch(`${TODOIST_API_URL}${path}`, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Todoist API error: ${res.status} ${res.statusText}`);
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
    throw new Error(`Todoist API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Parse Todoist's due object into our shape: {due, allDay, recurring}
// Todoist due: { date: "2026-08-02", datetime: "2026-08-02T18:30:00", timezone, recurring: "FREQ=DAILY;..." }
function parseDueInfo(todoDue) {
  if (!todoDue) return { due: null, allDay: false, recurring: null };

  const recurring = todoDue.recurring || null;

  if (todoDue.datetime) {
    // Timed task - store the ISO string
    return { due: todoDue.datetime, allDay: false, recurring };
  }
  if (todoDue.date) {
    // All-day task - store the date string
    return { due: todoDue.date, allDay: true, recurring };
  }
  return { due: null, allDay: false, recurring };
}

export async function getReminders() {
  const [tasks, projects] = await Promise.all([
    fetchFromTodoist("/tasks"),
    fetchFromTodoist("/projects"),
  ]);

  const projectMap = new Map(projects.map((p) => [p.id, p.name]));

  const out = tasks
    .filter((t) => !t.is_completed)
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
        notes: t.description || null,
      };
    });

  // Sort by due date (same logic as before: overdue first, then by date)
  out.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    return a.due ? -1 : b.due ? 1 : 0;
  });

  return out;
}

export async function getReminderLists() {
  const projects = await fetchFromTodoist("/projects");
  return projects.map((p) => ({ id: p.id, title: p.name }));
}

export async function completeReminder(listId, reminderId) {
  await postToTodoist(`/tasks/${reminderId}/close`, {});
}

export async function createReminder({
  listId,
  title,
  due,
  allDay,
  notes,
  dailyRepeat,
}) {
  const body = {
    content: title,
    project_id: listId || undefined,
    description: notes || undefined,
  };

  if (due) {
    body.due_object = {};
    if (allDay) {
      body.due_object.date = due; // plain date string
    } else {
      body.due_object.datetime = due; // ISO datetime
    }
    if (dailyRepeat) {
      body.due_object.recurring = "FREQ=DAILY";
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

export async function debugSync() {
  const tasksRaw = await fetchFromTodoist("/tasks");
  const projectsRaw = await fetchFromTodoist("/projects");

  return {
    tasksRawType: typeof tasksRaw,
    tasksRawKeys: Array.isArray(tasksRaw) ? "array" : Object.keys(tasksRaw || {}),
    tasksRaw: tasksRaw,
    projectsRawType: typeof projectsRaw,
    projectsRawLength: Array.isArray(projectsRaw) ? projectsRaw.length : Object.keys(projectsRaw || {}).length,
  };
}
