import express from "express";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

// Which devices appear on the dashboard is user configuration, so it lives in
// SQLite on the mounted data volume rather than in code. The previous scheme
// was a hardcoded CONTROLLABLE_DEVICES allowlist in index.js, which meant
// adding a device required a code change and a redeploy.
//
// Its own file rather than receipts.db: nothing here relates to receipts, and a
// separate handle keeps a schema mistake in one feature from touching the
// other's data.
const DATA_DIR = process.env.RECEIPTS_DATA_DIR || "/app/data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "devices.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS dashboard_devices (
    entity_id TEXT PRIMARY KEY,
    name TEXT,
    added_at TEXT NOT NULL
  );
`);

// Domains this dashboard knows how to present, mapped to the tile type the
// frontend renders. Anything not listed is not offered for adding at all -
// Home Assistant exposes hundreds of diagnostic entities (update.*,
// device_tracker.*, sun.*, every per-device signal-strength sensor) and
// listing them all would bury the handful a person actually wants.
//
// "status" means READ-ONLY: shown on the dashboard, never controllable. lock is
// deliberately in that group. This dashboard has no authentication of its own
// (see the Plex image-proxy comment in index.js for the same constraint), so an
// unlock endpoint would be an unauthenticated door opener on the LAN. Showing
// whether a door is locked is useful and carries no such risk. climate is
// read-only here too: Nest thermostats come straight from the SDM API instead
// (getNestThermostats), and the Homey-bridged climate entities never accepted a
// setpoint write.
export const DOMAIN_TILE_TYPES = {
  light: "light",
  switch: "toggle",
  input_boolean: "toggle",
  fan: "fan",
  cover: "cover",
  media_player: "media",
  lock: "status",
  climate: "status",
  binary_sensor: "status",
  sensor: "status",
};

export function domainOf(entityId) {
  return String(entityId || "").split(".")[0];
}
export function tileTypeFor(entityId) {
  return DOMAIN_TILE_TYPES[domainOf(entityId)] || null;
}
export function isControllableType(type) {
  return type === "light" || type === "toggle" || type === "fan" || type === "cover" || type === "media";
}

const selectAll = db.prepare("SELECT entity_id, name, added_at FROM dashboard_devices ORDER BY added_at");
const insertOne = db.prepare(
  "INSERT INTO dashboard_devices (entity_id, name, added_at) VALUES (?, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET name = excluded.name"
);
const deleteOne = db.prepare("DELETE FROM dashboard_devices WHERE entity_id = ?");

export function listDashboardDevices() {
  return selectAll.all();
}
export function isDashboardDevice(entityId) {
  return listDashboardDevices().some((d) => d.entity_id === entityId);
}

// A light with only an "onoff" colour mode has no brightness to offer, so it
// gets the compact toggle-only tile instead of a dead slider.
function lightSupportsBrightness(attrs) {
  const modes = attrs?.supported_color_modes;
  if (!Array.isArray(modes)) return attrs?.brightness != null;
  return modes.some((m) => m !== "onoff");
}

// Builds the dashboard tile payload for one user-added entity. Shape matches
// what renderControls() in index.html expects per type.
export function buildDeviceTile(entityId, name, state) {
  const type = tileTypeFor(entityId);
  if (!type || !state) return null;
  const attrs = state.attributes || {};
  const label = name || attrs.friendly_name || entityId;
  const available = state.state !== "unavailable" && state.state !== "unknown";
  const base = { id: entityId, name: label, available, platform: attrs.platform || null, userAdded: true };

  if (type === "light") {
    return {
      ...base,
      type: "light",
      simple: !lightSupportsBrightness(attrs),
      on: state.state === "on",
      brightness: attrs.brightness ?? null,
      effect: attrs.effect ?? null,
      effectList: attrs.effect_list ?? [],
    };
  }
  if (type === "toggle") {
    return { ...base, type: "toggle", on: state.state === "on" };
  }
  if (type === "fan") {
    return { ...base, type: "fan", on: state.state === "on", percentage: attrs.percentage ?? null };
  }
  if (type === "cover") {
    return {
      ...base,
      type: "cover",
      position: attrs.current_position ?? null,
      isClosed: attrs.is_closed ?? state.state === "closed",
    };
  }
  if (type === "media") {
    return {
      ...base,
      type: "media",
      state: state.state,
      appName: attrs.app_name ?? attrs.source ?? null,
      sourceList: attrs.source_list ?? [],
      rokuId: null,
      poweredOn: null,
    };
  }
  return {
    ...base,
    type: "status",
    state: state.state,
    unit: attrs.unit_of_measurement ?? null,
    deviceClass: attrs.device_class ?? null,
  };
}

// Every user-added device as a dashboard tile, skipping any whose entity has
// vanished from Home Assistant (renamed, integration removed) - the row stays
// in the table so it reappears if the entity comes back, rather than being
// silently deleted out from under the user.
export function buildUserDeviceTiles(states) {
  return listDashboardDevices()
    .map((d) => buildDeviceTile(d.entity_id, d.name, states.find((s) => s.entity_id === d.entity_id)))
    .filter(Boolean);
}

export function createDevicesRouter({ getStates }) {
  const router = express.Router();

  // Everything on the network this dashboard could show, as Home Assistant
  // sees it - which covers Homey- and Alexa-bridged devices too, since those
  // reach HA through their own integrations and appear here with `platform`
  // naming the integration they came from.
  router.get("/discovered", async (req, res) => {
    try {
      const states = await getStates();
      const chosen = new Set(listDashboardDevices().map((d) => d.entity_id));
      const devices = states
        .filter((s) => DOMAIN_TILE_TYPES[domainOf(s.entity_id)])
        .map((s) => {
          const type = tileTypeFor(s.entity_id);
          return {
            entityId: s.entity_id,
            name: s.attributes?.friendly_name || s.entity_id,
            domain: domainOf(s.entity_id),
            type,
            controllable: isControllableType(type),
            platform: s.attributes?.platform || null,
            area: s.attributes?.area || null,
            state: s.state,
            unit: s.attributes?.unit_of_measurement || null,
            onDashboard: chosen.has(s.entity_id),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ devices, platforms: [...new Set(devices.map((d) => d.platform).filter(Boolean))].sort() });
    } catch (e) {
      res.status(502).json({ error: e.message || "failed to list devices" });
    }
  });

  router.get("/dashboard", (_req, res) => {
    res.json({ devices: listDashboardDevices() });
  });

  router.post("/dashboard", async (req, res) => {
    const entityId = String(req.body?.entityId || "").trim();
    const name = req.body?.name ? String(req.body.name).trim().slice(0, 80) : null;
    if (!entityId) return res.status(400).json({ error: "entityId is required" });
    if (!tileTypeFor(entityId)) {
      return res.status(400).json({ error: `unsupported device type: ${domainOf(entityId)}` });
    }
    // Confirm the entity actually exists before storing it, so a typo becomes an
    // error here rather than a tile that silently never renders.
    try {
      const states = await getStates();
      if (!states.some((s) => s.entity_id === entityId)) {
        return res.status(404).json({ error: "no such entity in Home Assistant" });
      }
    } catch (e) {
      return res.status(502).json({ error: e.message || "could not reach Home Assistant" });
    }
    insertOne.run(entityId, name, new Date().toISOString());
    res.json({ ok: true });
  });

  router.delete("/dashboard/:entityId", (req, res) => {
    deleteOne.run(req.params.entityId);
    res.json({ ok: true });
  });

  return router;
}
