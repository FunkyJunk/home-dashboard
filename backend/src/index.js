import express from "express";
import "dotenv/config";
import { google } from "googleapis";

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

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/api/dashboard", async (_req, res) => {
  const [weather, cal, homeAssistant] = await Promise.allSettled([
    getWeather(),
    getCalendar(),
    getHomeAssistantStates(),
  ]);

  res.json({
    weather: weather.status === "fulfilled" ? weather.value : null,
    calendar: cal.status === "fulfilled" ? cal.value : null,
    homeAssistant: homeAssistant.status === "fulfilled" ? homeAssistant.value : null,
    errors: [weather, cal, homeAssistant]
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

async function getHomeAssistantStates() {
  const r = await fetch(`${HA_URL}/api/states`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Home Assistant fetch failed: ${r.status}`);
  return r.json();
}

app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
