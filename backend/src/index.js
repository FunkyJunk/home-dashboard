import express from "express";
import "dotenv/config";
import { google } from "googleapis";
import WebSocket from "ws";

const app = express();
const PORT = process.env.PORT || 3000;
const HA_URL = process.env.HOME_ASSISTANT_URL || "http://homeassistant:8123";
const HA_TOKEN = process.env.HOME_ASSISTANT_TOKEN;
const HA_WS_URL = HA_URL.replace(/^http/, "ws") + "/api/websocket";

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/api/dashboard", async (_req, res) => {
  const [weather, cal, homeAssistant] = await Promise.allSettled([
    getWeather(),
    getCalendar(),
    getHomeAssistantStates(),
  ]);

  const haStates = homeAssistant.status === "fulfilled" ? homeAssistant.value : null;

  res.json({
    weather: weather.status === "fulfilled" ? weather.value : null,
    calendar: cal.status === "fulfilled" ? cal.value : null,
    homeAssistant: haStates,
    ring: haStates ? getRingCameras(haStates) : [],
    errors: [weather, cal, homeAssistant]
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason?.message || "unknown error"),
  });
});

const RING_CAMERA_ID = /^camera\.[a-z0-9_]+$/;

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

// The plain snapshot/MJPEG-repeat endpoints just replay the entity's last
// motion-event frame for Ring's "_live_view" cameras - not an actual live
// capture. A genuine live look requires HA's real stream negotiation (over
// its WebSocket API), which hands back an HLS playlist URL.
app.get("/api/ring/live/:entityId", async (req, res) => {
  const { entityId } = req.params;
  if (!RING_CAMERA_ID.test(entityId)) {
    return res.status(400).json({ error: "invalid camera id" });
  }
  try {
    const url = await requestRingLiveUrl(entityId);
    res.json({ url });
  } catch (e) {
    res.status(502).json({ error: e.message || "live stream request failed" });
  }
});

function requestRingLiveUrl(entityId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HA_WS_URL);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Home Assistant stream request timed out"));
    }, 10000);
    const finish = (fn, arg) => {
      clearTimeout(timeout);
      ws.terminate();
      fn(arg);
    };

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
      } else if (msg.type === "auth_invalid") {
        finish(reject, new Error("Home Assistant auth rejected"));
      } else if (msg.type === "auth_ok") {
        ws.send(JSON.stringify({ id: 1, type: "camera/stream", entity_id: entityId }));
      } else if (msg.id === 1 && msg.type === "result") {
        if (msg.success && msg.result?.url) {
          finish(resolve, msg.result.url);
        } else {
          finish(reject, new Error(msg.error?.message || "stream request failed"));
        }
      }
    });
    ws.on("error", (err) => finish(reject, err));
  });
}

// Mirrors HA's own /api/hls/ path so both relative and absolute references
// inside the returned HLS playlist resolve back through this same proxy.
app.get("/api/hls/*", async (req, res) => {
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  try {
    const r = await fetch(`${HA_URL}/api/hls/${req.params[0]}`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
      signal: controller.signal,
    });
    if (!r.ok || !r.body) return res.status(r.status || 502).end();
    res.set("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.set("Cache-Control", "no-store");
    for await (const chunk of r.body) {
      if (res.destroyed) break;
      res.write(chunk);
    }
    res.end();
  } catch {
    res.end();
  }
});

async function getWeather() {
  const lat = process.env.LAT;
  const lon = process.env.LON;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit`;
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

async function getHomeAssistantStates() {
  const r = await fetch(`${HA_URL}/api/states`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Home Assistant fetch failed: ${r.status}`);
  return r.json();
}

// Ring entities carry this attribution regardless of local naming, so cameras
// are discovered rather than assumed from hardcoded entity IDs.
function getRingCameras(states) {
  const ringEntities = states.filter(
    (s) => s.attributes?.attribution === "Data provided by Ring.com"
  );
  const cameras = ringEntities.filter((s) => s.entity_id.startsWith("camera."));

  return cameras.map((cam) => {
    const base = cam.entity_id.slice("camera.".length);
    const related = ringEntities.filter(
      (s) => s !== cam && s.entity_id.includes(base)
    );
    const motion = related.find((s) => s.entity_id.includes("motion"));
    const ding = related.find((s) => s.entity_id.includes("ding"));

    return {
      id: cam.entity_id,
      name: cam.attributes?.friendly_name || base.replace(/_/g, " "),
      available: cam.state !== "unavailable",
      motionActive: isActiveOrRecent(motion),
      dingActive: isActiveOrRecent(ding),
      snapshotUrl: `/api/ring/snapshot/${cam.entity_id}`,
    };
  });
}

function isActiveOrRecent(entity, withinMs = 5 * 60 * 1000) {
  if (!entity) return false;
  if (entity.state === "on") return true;
  const t = new Date(entity.state);
  return !isNaN(t) && Date.now() - t < withinMs;
}

app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
