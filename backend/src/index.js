import express from "express";
import "dotenv/config";
import { google } from "googleapis";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.json());
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
    lights: haStates ? getControllableLights(haStates) : [],
    errors: [weather, cal, homeAssistant]
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason?.message || "unknown error"),
  });
});

// Explicit allowlist - this dashboard has no login, so anyone on the LAN who
// can load the page can hit this route. Keeping it to specific light
// entities (rather than a generic HA service passthrough) bounds what a
// stray request can actually actuate.
const CONTROLLABLE_LIGHTS = {
  "light.shellyrgbw2_284dba": { name: "Bambu Lighting" },
};

function getControllableLights(states) {
  return Object.entries(CONTROLLABLE_LIGHTS)
    .map(([entityId, meta]) => {
      const s = states.find((e) => e.entity_id === entityId);
      if (!s) return null;
      return {
        id: entityId,
        name: meta.name,
        available: s.state !== "unavailable",
        on: s.state === "on",
        brightness: s.attributes?.brightness ?? null,
        effect: s.attributes?.effect ?? null,
        effectList: s.attributes?.effect_list ?? [],
      };
    })
    .filter(Boolean);
}

app.post("/api/ha/light/:entityId", async (req, res) => {
  const { entityId } = req.params;
  if (!CONTROLLABLE_LIGHTS[entityId]) {
    return res.status(404).json({ error: "unknown light" });
  }
  const { on, brightness, effect } = req.body || {};
  try {
    if (on === false) {
      await callHaService("light", "turn_off", { entity_id: entityId });
    } else {
      const data = { entity_id: entityId };
      if (Number.isInteger(brightness) && brightness >= 0 && brightness <= 255) {
        data.brightness = brightness;
      }
      if (typeof effect === "string") {
        const known = await getHomeAssistantStates()
          .then((states) => states.find((s) => s.entity_id === entityId))
          .catch(() => null);
        if (known?.attributes?.effect_list?.includes(effect)) {
          data.effect = effect;
        }
      }
      await callHaService("light", "turn_on", data);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || "failed to update light" });
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
