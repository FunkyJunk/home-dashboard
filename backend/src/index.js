import express from "express";
import "dotenv/config";
import { google } from "googleapis";
import WebSocket, { WebSocketServer } from "ws";
import { createReceiptsRouter } from "./receipts.js";
import { createThemeRouter } from "./theme.js";
import { getReminders, getReminderLists, completeReminder, createReminder, updateReminder, deleteReminder } from "./todoist.js";
import { getAllRokuStatuses, sendRokuKey, getRokuApps, launchRokuApp } from "./roku.js";
import { fetchPlexImage } from "./plex.js";
import { getNotes, createNote, updateNote, deleteNote } from "./notes.js";
import { analyzeShippingLabel } from "./shippingLabels.js";
import { analyzeReturnScreenshot } from "./amazonReturns.js";

const app = express();
// Default 100kb limit rejects any real pasted photo/screenshot once
// base64-encoded (a modest 5MB image becomes ~6.7MB as base64) - the
// shipping-label analyzer needs real headroom for that.
app.use(express.json({ limit: "20mb" }));
const PORT = process.env.PORT || 3000;
const HA_URL = process.env.HOME_ASSISTANT_URL || "http://homeassistant:8123";
const HA_TOKEN = process.env.HOME_ASSISTANT_TOKEN;
const HA_WS_URL = HA_URL.replace(/^http/, "ws") + "/api/websocket";

const NEST_PROJECT_ID = process.env.NEST_PROJECT_ID;
const NEST_CLIENT_ID = process.env.NEST_CLIENT_ID;
const NEST_CLIENT_SECRET = process.env.NEST_CLIENT_SECRET;
const NEST_REFRESH_TOKEN = process.env.NEST_REFRESH_TOKEN;
const NEST_API = "https://smartdevicemanagement.googleapis.com/v1";

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

app.use("/api/receipts", createReceiptsRouter({ oauth2Client }));
app.use("/api/theme", createThemeRouter());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/api/dashboard", async (_req, res) => {
  const [weather, cal, homeAssistant, nest, tasks, roku] = await Promise.allSettled([
    getWeather(),
    getCalendar(),
    getHomeAssistantStates(),
    getNestThermostats(),
    getReminders(),
    getAllRokuStatuses(),
  ]);

  const haStates = homeAssistant.status === "fulfilled" ? homeAssistant.value : null;
  const nestThermostats = nest.status === "fulfilled" ? nest.value : [];
  const rokuStatuses = roku.status === "fulfilled" ? roku.value : [];

  res.json({
    weather: weather.status === "fulfilled" ? weather.value : null,
    calendar: cal.status === "fulfilled" ? cal.value : null,
    homeAssistant: haStates,
    ring: haStates ? getRingCameras(haStates) : [],
    tasks: tasks.status === "fulfilled" ? tasks.value : [],
    roku: rokuStatuses,
    controls: [
      ...(haStates ? getControllableDevices(haStates, rokuStatuses) : []),
      ...nestThermostats,
    ],
    errors: [weather, cal, homeAssistant, nest, tasks, roku]
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason?.message || "unknown error"),
  });
});

// Marks a Todoist task complete via the REST API.
app.post("/api/tasks/:taskListId/:taskId/complete", async (req, res) => {
  try {
    await completeReminder(req.params.taskListId, req.params.taskId);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to complete task" });
  }
});

// Proxies a Plex poster/art image so the Plex token never reaches the
// browser - this dashboard has no login of its own.
app.get("/api/plex/image", async (req, res) => {
  try {
    const upstream = await fetchPlexImage(req.query.path);
    res.set("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "private, max-age=300");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to fetch image" });
  }
});

// Scratch Pad notes - local-only (see notes.js for why there's no Google
// Keep sync).
app.get("/api/notes", (_req, res) => {
  res.json(getNotes());
});
app.post("/api/notes", (req, res) => {
  const { text } = req.body || {};
  res.json(createNote({ text }));
});
app.put("/api/notes/:id", (req, res) => {
  try {
    res.json(updateNote(req.params.id, { text: req.body?.text }));
  } catch (e) {
    res.status(404).json({ error: e.message || "note not found" });
  }
});
app.delete("/api/notes/:id", (req, res) => {
  deleteNote(req.params.id);
  res.json({ ok: true });
});

// Analyzes a pasted/dragged shipping-label image: marketplace, recipient
// name, and a suggested crop box - see shippingLabels.js.
app.post("/api/shipping-label/analyze", async (req, res) => {
  const { image, mediaType } = req.body || {};
  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "image is required" });
  }
  try {
    const result = await analyzeShippingLabel(image, mediaType || "image/png");
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to analyze label" });
  }
});

// Analyzes an Amazon return QR screenshot's item table: description and
// quantity - see amazonReturns.js. The QR crop itself is deterministic and
// happens entirely on the frontend.
app.post("/api/amazon-return/analyze", async (req, res) => {
  const { image, mediaType } = req.body || {};
  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "image is required" });
  }
  try {
    const result = await analyzeReturnScreenshot(image, mediaType || "image/png");
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to analyze return screenshot" });
  }
});

// Direct Roku ECP remote control - these are the same 7 devices
// getAllRokuStatuses polls, not the HA-integrated media_player entities
// (those already go through /api/ha/control). See roku.js sendRokuKey.
app.post("/api/roku/:id/key/:key", async (req, res) => {
  try {
    await sendRokuKey(req.params.id, req.params.key);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to send Roku key" });
  }
});

app.get("/api/roku/:id/apps", async (req, res) => {
  try {
    res.json(await getRokuApps(req.params.id));
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to load Roku apps" });
  }
});

app.post("/api/roku/:id/launch/:appId", async (req, res) => {
  try {
    await launchRokuApp(req.params.id, req.params.appId);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to launch Roku app" });
  }
});

app.get("/api/tasks/lists", async (req, res) => {
  try {
    res.json(await getReminderLists());
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to load task lists" });
  }
});

// Manual task creation via Todoist REST API. Supports full due times,
// all-day dates, and recurrence (daily, weekly, monthly, yearly, etc. via
// a natural-language dueString - Todoist has no structured recurrence
// field, see todoist.js for why).
app.post("/api/tasks", async (req, res) => {
  const { taskListId, title, due, allDay, notes, dueString } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: "title is required" });
  }
  try {
    const task = await createReminder({
      listId: taskListId || undefined,
      title: String(title).trim(),
      due: due || null,
      allDay: !!allDay,
      notes: notes || undefined,
      dueString: dueString || null,
    });
    res.json(task);
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to create task" });
  }
});

// Updates an existing task's title/due/notes/recurrence.
app.patch("/api/tasks/:taskListId/:taskId", async (req, res) => {
  const { title, due, allDay, notes, dueString } = req.body || {};
  try {
    const task = await updateReminder(req.params.taskId, {
      title: title !== undefined ? String(title).trim() : undefined,
      due: due !== undefined ? due : undefined,
      allDay: !!allDay,
      notes: notes !== undefined ? notes : undefined,
      dueString: dueString || null,
    });
    res.json(task);
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to update task" });
  }
});

app.delete("/api/tasks/:taskListId/:taskId", async (req, res) => {
  try {
    await deleteReminder(req.params.taskId);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to delete task" });
  }
});

// Explicit allowlist - this dashboard has no login, so anyone on the LAN who
// can load the page can hit this route. Keeping it to specific entities
// (rather than a generic HA service passthrough) bounds what a stray
// request can actually actuate.
const CONTROLLABLE_DEVICES = {
  "light.shellyrgbw2_284dba": {
    type: "light",
    name: "Bambu X1 Carbon Light",
    // Plain on/off at full white - the Shelly's color/effect controls
    // (Meteor Shower etc.) aren't wanted for this fixture.
    simple: true,
    onData: { brightness: 255, rgbw_color: [0, 0, 0, 255] },
  },
  "light.office_bambu_p1s": {
    type: "light",
    name: "Bambu P1S Light",
    simple: true,
    onData: { brightness: 255, hs_color: [0, 0] },
  },
  "cover.office_office_blinds": { type: "cover", name: "Office Blinds" },
  // rokuId links this HA entity to its matching roku.js device (see
  // ROKU_DEVICES in roku.js) - both describe the same physical Roku, one
  // via the HA integration (quick tile controls: power, prev/play/next,
  // volume, source), the other via direct ECP (the detail popup + Plex
  // metadata + real remote, shared with the Home Status Roku list). A
  // deliberate hand-set link, not a runtime guess, same as this whole
  // allowlist already is.
  "media_player.office_roku_streambar_pro_office": { type: "media", name: "Office Roku", rokuId: "office" },
  // Thermostats are handled separately via the Nest SDM API directly - see
  // getNestThermostats()/setNestThermostat() below. The Homey-bridged HA
  // climate entities never showed correct names/data and couldn't actually
  // write a setpoint (Homey API permissions), so they're not listed here.
};

function getControllableDevices(states, rokuStatuses = []) {
  return Object.entries(CONTROLLABLE_DEVICES)
    .map(([entityId, meta]) => {
      const s = states.find((e) => e.entity_id === entityId);
      if (!s) return null;
      const available = s.state !== "unavailable";

      if (meta.type === "light") {
        return {
          id: entityId,
          type: "light",
          name: meta.name,
          available,
          simple: !!meta.simple,
          on: s.state === "on",
          brightness: s.attributes?.brightness ?? null,
          effect: s.attributes?.effect ?? null,
          effectList: s.attributes?.effect_list ?? [],
        };
      }
      if (meta.type === "cover") {
        return {
          id: entityId,
          type: "cover",
          name: meta.name,
          available,
          position: s.attributes?.current_position ?? null,
          isClosed: s.attributes?.is_closed ?? s.state === "closed",
        };
      }
      if (meta.type === "media") {
        // HA's media_player state for this Roku doesn't reliably reflect
        // real power state (confirmed: showed "on" while the device was
        // actually off) - a rokuId-linked tile gets its power state from
        // roku.js's direct device-info query instead, which is accurate.
        const rokuDevice = meta.rokuId ? rokuStatuses.find((r) => r.id === meta.rokuId) : null;
        return {
          id: entityId,
          type: "media",
          name: meta.name,
          available,
          state: s.state,
          appName: s.attributes?.app_name ?? s.attributes?.source ?? null,
          sourceList: s.attributes?.source_list ?? [],
          rokuId: meta.rokuId ?? null,
          poweredOn: rokuDevice ? rokuDevice.poweredOn : null,
        };
      }
      return null;
    })
    .filter(Boolean);
}

// Wildcard rather than :entityId - Nest device resource names
// ("enterprises/.../devices/...") contain slashes.
app.post("/api/ha/control/*", async (req, res) => {
  const entityId = req.params[0];

  if (entityId.startsWith("enterprises/")) {
    try {
      await setNestThermostat(entityId, req.body || {});
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.message || "failed to update thermostat" });
    }
    return;
  }

  const meta = CONTROLLABLE_DEVICES[entityId];
  if (!meta) {
    return res.status(404).json({ error: "unknown device" });
  }
  try {
    if (meta.type === "light") {
      const { on, brightness, effect } = req.body || {};
      if (on === false) {
        await callHaService("light", "turn_off", { entity_id: entityId });
      } else if (meta.simple) {
        await callHaService("light", "turn_on", { entity_id: entityId, ...meta.onData });
      } else {
        const data = { entity_id: entityId };
        if (Number.isInteger(brightness) && brightness >= 0 && brightness <= 255) {
          data.brightness = brightness;
        }
        if (typeof effect === "string") {
          const current = await getHomeAssistantStates()
            .then((states) => states.find((s) => s.entity_id === entityId))
            .catch(() => null);
          if (current?.attributes?.effect_list?.includes(effect)) {
            data.effect = effect;
          }
        }
        await callHaService("light", "turn_on", data);
      }
    } else if (meta.type === "cover") {
      const { position } = req.body || {};
      if (!Number.isInteger(position) || position < 0 || position > 100) {
        return res.status(400).json({ error: "invalid position" });
      }
      await callHaService("cover", "set_cover_position", { entity_id: entityId, position });
    } else if (meta.type === "media") {
      const { action, source, key } = req.body || {};
      if (action === "select_source") {
        if (typeof source !== "string") {
          return res.status(400).json({ error: "invalid source" });
        }
        const current = await getHomeAssistantStates()
          .then((states) => states.find((s) => s.entity_id === entityId))
          .catch(() => null);
        if (!current?.attributes?.source_list?.includes(source)) {
          return res.status(400).json({ error: "invalid source" });
        }
        await callHaService("media_player", "select_source", { entity_id: entityId, source });
      } else if (action === "mute") {
        await callHaService("media_player", "volume_mute", { entity_id: entityId, is_volume_muted: true });
      } else if (action === "remote_key") {
        if (!ROKU_REMOTE_KEYS.includes(key)) {
          return res.status(400).json({ error: "invalid key" });
        }
        // Same device, different HA domain - the remote entity (full D-pad,
        // Home/Back/etc.) is separate from the media_player entity used for
        // everything else in this tile.
        const remoteEntity = entityId.replace(/^media_player\./, "remote.");
        await callHaService("remote", "send_command", { entity_id: remoteEntity, command: key });
      } else {
        const MEDIA_ACTIONS = {
          turn_on: "turn_on",
          turn_off: "turn_off",
          volume_up: "volume_up",
          volume_down: "volume_down",
          play_pause: "media_play_pause",
          previous: "media_previous_track",
          next: "media_next_track",
        };
        const service = MEDIA_ACTIONS[action];
        if (!service) {
          return res.status(400).json({ error: "invalid action" });
        }
        await callHaService("media_player", service, { entity_id: entityId });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to update device" });
  }
});

async function callHaService(domain, service, data) {
  const r = await fetch(`${HA_URL}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`Home Assistant service call failed: ${r.status}`);
}

const RING_CAMERA_ID = /^camera\.[a-z0-9_]+$/;

// Roku ECP key names - allowlisted rather than passed through raw, since this
// dashboard has no login.
const ROKU_REMOTE_KEYS = [
  "Up", "Down", "Left", "Right", "Select",
  "Back", "Home", "InstantReplay", "Info",
];

app.get("/api/ring/snapshot/:entityId", async (req, res) => {
  const { entityId } = req.params;
  if (!RING_CAMERA_ID.test(entityId)) {
    return res.status(400).json({ error: "invalid camera id" });
  }
  try {
    const r = await fetch(`${HA_URL}/api/camera_proxy/${entityId}`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
    });
    if (!r.ok) return res.status(r.status).end();
    res.set("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "no-store");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).json({ error: "snapshot fetch failed" });
  }
});

async function getWeather() {
  const lat = process.env.LAT;
  const lon = process.env.LON;
  // No forecast_days override - Open-Meteo's default (7) applies to both
  // daily and hourly, and the frontend only slices what it needs from each.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,relative_humidity_2m&hourly=temperature_2m,weather_code,relative_humidity_2m,precipitation_probability&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`weather fetch failed: ${r.status}`);
  return r.json();
}

async function getCalendar() {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    throw new Error("calendar integration not yet configured");
  }
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { data } = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: in7Days.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 10,
  });
  return (data.items || []).map((e) => ({
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
  }));
}

// Only ever shows incomplete tasks (showCompleted: false) - this is a
// glance-at-the-dashboard widget, not a full task manager. Pulls every
// list (most accounts just have the one default "My Tasks", but nothing
// stops someone from having more) and merges them, soonest due date first.
let nestAccessToken = null;
let nestTokenExpiresAt = 0;

async function getNestAccessToken() {
  if (nestAccessToken && Date.now() < nestTokenExpiresAt - 60_000) {
    return nestAccessToken;
  }
  const r = await fetch("https://www.googleapis.com/oauth2/v4/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: NEST_CLIENT_ID,
      client_secret: NEST_CLIENT_SECRET,
      refresh_token: NEST_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error(`Nest token refresh failed: ${r.status}`);
  const data = await r.json();
  nestAccessToken = data.access_token;
  nestTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return nestAccessToken;
}

const celsiusToF = (c) => (c * 9) / 5 + 32;
const fahrenheitToC = (f) => ((f - 32) * 5) / 9;

const HVAC_MODE_LABELS = { heatcool: "Auto" };

async function getNestThermostats() {
  if (!NEST_PROJECT_ID || !NEST_REFRESH_TOKEN) {
    throw new Error("Nest integration not configured");
  }
  const token = await getNestAccessToken();
  const r = await fetch(`${NEST_API}/enterprises/${NEST_PROJECT_ID}/devices`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Nest devices fetch failed: ${r.status}`);
  const data = await r.json();

  return (data.devices || [])
    .filter((d) => d.type === "sdm.devices.types.THERMOSTAT")
    .map((d) => {
      const t = d.traits || {};
      const roomName = d.parentRelations?.[0]?.displayName;
      const customName = t["sdm.devices.traits.Info"]?.customName;
      const mode = (t["sdm.devices.traits.ThermostatMode"]?.mode || "OFF").toLowerCase();
      const availableModes = (t["sdm.devices.traits.ThermostatMode"]?.availableModes || []).map((m) => m.toLowerCase());
      const setpoint = t["sdm.devices.traits.ThermostatTemperatureSetpoint"] || {};
      const ambientC = t["sdm.devices.traits.Temperature"]?.ambientTemperatureCelsius;
      const humidity = t["sdm.devices.traits.Humidity"]?.ambientHumidityPercent;
      const hvacStatus = (t["sdm.devices.traits.ThermostatHvac"]?.status || "").toLowerCase();
      const online = t["sdm.devices.traits.Connectivity"]?.status === "ONLINE";
      // heatcool (range) mode carries both setpoints - showing the cool side
      // keeps the single-stepper UI simple; none of these run in that mode.
      const setpointC = mode === "heat" ? setpoint.heatCelsius : (setpoint.coolCelsius ?? setpoint.heatCelsius);

      return {
        id: d.name,
        type: "nest",
        name: (customName || roomName || "Thermostat").trim() || "Thermostat",
        available: online,
        hvacMode: mode,
        hvacModes: availableModes,
        hvacModeLabels: HVAC_MODE_LABELS,
        hvacStatus,
        currentTemp: ambientC != null ? Math.round(celsiusToF(ambientC)) : null,
        currentHumidity: humidity ?? null,
        targetTemp: setpointC != null ? Math.round(celsiusToF(setpointC)) : null,
        minTemp: 50,
        maxTemp: 90,
        step: 1,
      };
    });
}

async function setNestThermostat(deviceName, { temperature, hvacMode }) {
  const token = await getNestAccessToken();
  const url = `${NEST_API}/${deviceName}:executeCommand`;

  if (typeof temperature === "number") {
    const mode = (hvacMode || "cool").toUpperCase();
    const command = mode === "HEAT"
      ? "sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat"
      : "sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool";
    const paramKey = mode === "HEAT" ? "heatCelsius" : "coolCelsius";
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command, params: { [paramKey]: fahrenheitToC(temperature) } }),
    });
    if (!r.ok) throw new Error(`Nest set temperature failed: ${r.status}`);
    return;
  }

  if (typeof hvacMode === "string") {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sdm.devices.commands.ThermostatMode.SetMode", params: { mode: hvacMode.toUpperCase() } }),
    });
    if (!r.ok) throw new Error(`Nest set mode failed: ${r.status}`);
    return;
  }

  throw new Error("invalid request");
}

// Which integration owns an entity (Sonos vs Roku vs Alexa vs a plain
// Chromecast, etc.) isn't in /api/states at all - HA only exposes that in
// the entity registry, which itself is WebSocket-only (no REST endpoint).
// Rarely changes, so it's cached rather than opening a fresh HA WebSocket
// connection on every 60s dashboard refresh.
let entityPlatformCache = null;
let entityPlatformCacheAt = 0;
const ENTITY_PLATFORM_TTL_MS = 10 * 60 * 1000;

function fetchEntityRegistryPlatforms() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HA_WS_URL);
    const msgId = 1;
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("entity registry fetch timed out"));
    }, 8000);
    const finish = (fn) => { clearTimeout(timeout); try { ws.close(); } catch {} fn(); };
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
      } else if (msg.type === "auth_ok") {
        ws.send(JSON.stringify({ id: msgId, type: "config/entity_registry/list" }));
      } else if (msg.type === "auth_invalid") {
        finish(() => reject(new Error("Home Assistant WebSocket auth failed")));
      } else if (msg.id === msgId && msg.type === "result") {
        finish(() => {
          if (!msg.success) { reject(new Error("entity_registry/list failed")); return; }
          const map = {};
          for (const entry of msg.result) if (entry.platform) map[entry.entity_id] = entry.platform;
          resolve(map);
        });
      }
    });
    ws.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function getEntityPlatformMap() {
  if (entityPlatformCache && Date.now() - entityPlatformCacheAt < ENTITY_PLATFORM_TTL_MS) return entityPlatformCache;
  entityPlatformCache = await fetchEntityRegistryPlatforms();
  entityPlatformCacheAt = Date.now();
  return entityPlatformCache;
}

async function getHomeAssistantStates() {
  const r = await fetch(`${HA_URL}/api/states`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Home Assistant fetch failed: ${r.status}`);
  const states = await r.json();

  // Best-effort only - a registry lookup failure (permissions, a slow HA
  // instance, whatever) should never take down the states the rest of the
  // dashboard actually depends on, just leave entities without a platform.
  try {
    const platforms = await getEntityPlatformMap();
    for (const s of states) {
      const platform = platforms[s.entity_id];
      if (platform) s.attributes = { ...s.attributes, platform };
    }
  } catch (e) {
    console.error("[home-assistant] entity registry platform lookup failed:", e.message);
  }

  return states;
}

// Ring entities carry this attribution regardless of local naming, so cameras
// are discovered rather than assumed from hardcoded entity IDs.
function getRingCameras(states) {
  const ringEntities = states.filter(
    (s) => s.attributes?.attribution === "Data provided by Ring.com"
  );
  const cameras = ringEntities.filter((s) => s.entity_id.startsWith("camera."));

  return cameras
    .map((cam) => {
      // Companion entities (motion/ding events, battery sensor) use the short
      // device name, not the camera's own "_live_view"-suffixed entity_id.
      const base = cam.entity_id.slice("camera.".length).replace(/_live_view$/, "");
      const motion = ringEntities.find((s) => s.entity_id === `event.${base}_motion`);
      const ding = ringEntities.find((s) => s.entity_id === `event.${base}_ding`);
      const battery = ringEntities.find((s) => s.entity_id === `sensor.${base}_battery`);
      const batteryLevel = battery ? Number(battery.state) : null;
      // HA leaves the camera's own state as "idle" even once a battery cam has
      // died - a 0% battery reading is what actually indicates it's offline.
      const offline = cam.state === "unavailable" || batteryLevel === 0;
      if (offline) return null; // auto-hide - reappears once healthy again

      return {
        id: cam.entity_id,
        name: cam.attributes?.friendly_name || base.replace(/_/g, " "),
        motionActive: isActiveOrRecent(motion),
        dingActive: isActiveOrRecent(ding),
        snapshotUrl: `/api/ring/snapshot/${cam.entity_id}`,
      };
    })
    .filter(Boolean);
}

function isActiveOrRecent(entity, withinMs = 5 * 60 * 1000) {
  if (!entity) return false;
  if (entity.state === "on") return true;
  const t = new Date(entity.state);
  return !isNaN(t) && Date.now() - t < withinMs;
}

const server = app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));

// Ring's "_live_view" entities stream over WebRTC rather than HLS/MJPEG - the
// only way to get an actual live frame (not a replay of the last motion
// event) is to negotiate a real session through HA's WebSocket API and relay
// SDP/ICE between the browser and HA for the life of that session.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/api\/ring\/webrtc\/(camera\.[a-z0-9_]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (browserWs) => {
    relayWebRtcSignaling(browserWs, match[1]);
  });
});

function relayWebRtcSignaling(browserWs, entityId) {
  const haWs = new WebSocket(HA_WS_URL);
  let nextId = 1;
  let sessionId = null;
  let haReady = false;
  let pendingOfferSdp = null;
  let pendingCandidates = [];
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { haWs.close(); } catch {}
    try { browserWs.close(); } catch {}
  };
  const sendError = (message) => {
    try { browserWs.send(JSON.stringify({ type: "error", message })); } catch {}
  };
  const sendOffer = (sdp) => {
    haWs.send(JSON.stringify({ id: nextId++, type: "camera/webrtc/offer", entity_id: entityId, offer: sdp }));
  };
  const sendCandidate = (candidate) => {
    haWs.send(JSON.stringify({
      id: nextId++,
      type: "camera/webrtc/candidate",
      entity_id: entityId,
      session_id: sessionId,
      candidate,
    }));
  };

  haWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "auth_required":
        haWs.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
        break;
      case "auth_invalid":
        sendError("Home Assistant auth rejected");
        cleanup();
        break;
      case "auth_ok":
        haReady = true;
        if (pendingOfferSdp) {
          sendOffer(pendingOfferSdp);
          pendingOfferSdp = null;
        }
        break;
      case "result":
        if (!msg.success) {
          sendError(msg.error?.message || "webrtc offer failed");
          cleanup();
        } else if (msg.result?.session_id) {
          sessionId = msg.result.session_id;
          for (const c of pendingCandidates) sendCandidate(c);
          pendingCandidates = [];
        }
        break;
      case "event":
        if (msg.event?.type === "answer") {
          browserWs.send(JSON.stringify({ type: "answer", sdp: msg.event.answer }));
        } else if (msg.event?.type === "candidate") {
          browserWs.send(JSON.stringify({ type: "candidate", candidate: msg.event.candidate }));
        } else if (msg.event?.type === "error") {
          sendError(msg.event.message || "webrtc stream error");
        }
        break;
    }
  });
  haWs.on("error", () => {
    sendError("Home Assistant connection error");
    cleanup();
  });
  haWs.on("close", cleanup);

  browserWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "offer") {
      if (haReady) sendOffer(msg.sdp);
      else pendingOfferSdp = msg.sdp;
    } else if (msg.type === "candidate") {
      if (sessionId) sendCandidate(msg.candidate);
      else pendingCandidates.push(msg.candidate);
    }
  });
  browserWs.on("close", cleanup);
  browserWs.on("error", cleanup);
}
