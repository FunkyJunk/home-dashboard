import express from "express";
import "dotenv/config";
import { google } from "googleapis";
import { RingApi } from "ring-client-api";

const app = express();
const PORT = process.env.PORT || 3000;
const HA_URL = process.env.HOME_ASSISTANT_URL || "http://homeassistant:8123";
const HA_TOKEN = process.env.HOME_ASSISTANT_TOKEN;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

const RING_CAMERA_IDS = (process.env.RING_CAMERA_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

// avoidSnapshotBatteryDrain makes the library cache snapshots from
// battery-powered cameras for ~10min instead of ~10s (wired cams still refresh
// every ~10s) - without it, polling this endpoint every 60s would wake a
// battery cam far more often than its snapshot actually changes and drain it
// noticeably faster than a plugged-in cam.
const ringApi = process.env.RING_REFRESH_TOKEN
  ? new RingApi({ refreshToken: process.env.RING_REFRESH_TOKEN, avoidSnapshotBatteryDrain: true })
  : null;

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/api/dashboard", async (_req, res) => {
  const [weather, cal, homeAssistant, ring] = await Promise.allSettled([
    getWeather(),
    getCalendar(),
    getHomeAssistantStates(),
    getRingSnapshots(),
  ]);

  res.json({
    weather: weather.status === "fulfilled" ? weather.value : null,
    calendar: cal.status === "fulfilled" ? cal.value : null,
    homeAssistant: homeAssistant.status === "fulfilled" ? homeAssistant.value : null,
    ring: ring.status === "fulfilled" ? ring.value : null,
    errors: [weather, cal, homeAssistant, ring]
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason?.message || "unknown error"),
  });
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

async function getRingSnapshots() {
  if (!ringApi) {
    throw new Error("Ring integration not yet configured");
  }
  const cameras = await ringApi.getCameras();
  const selected = RING_CAMERA_IDS.length
    ? cameras.filter((c) => RING_CAMERA_IDS.includes(String(c.id)))
    : cameras;

  const results = await Promise.allSettled(
    selected.map(async (camera) => {
      const image = await camera.getSnapshot();
      return {
        id: camera.id,
        name: camera.name,
        snapshot: `data:image/jpeg;base64,${image.toString("base64")}`,
        timestamp: new Date().toISOString(),
      };
    })
  );

  return selected.map((camera, i) => {
    const result = results[i];
    if (result.status === "fulfilled") return result.value;
    return {
      id: camera.id,
      name: camera.name,
      snapshot: null,
      timestamp: null,
      error: result.reason?.message || "snapshot failed",
    };
  });
}

async function getHomeAssistantStates() {
  const r = await fetch(`${HA_URL}/api/states`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Home Assistant fetch failed: ${r.status}`);
  return r.json();
}

app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
