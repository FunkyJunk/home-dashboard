// Direct Roku ECP (External Control Protocol) integration - no Home
// Assistant involved. Roku devices expose an unauthenticated HTTP API on
// port 8060 to anything on the same LAN. Confirmed live against all 7 real
// devices (2026-08-xx): every non-Plex app (Netflix, Prime Video, etc.)
// only ever reports a bare app name via ECP - no title, poster, or
// duration is exposed for any app but Plex, whose Roku channel is the one
// exception that shares full metadata, but through Plex's own API
// (plex.js), not Roku's - so any Roku running Plex gets cross-referenced
// with a live Plex session by matching IP addresses.
import { getPlexSessions } from "./plex.js";

// Hardcoded rather than discovered fresh on every request - a full-subnet
// SSDP/port scan is too slow to repeat on every dashboard poll. These are
// the 7 devices found via a one-time LAN scan; give each a DHCP
// reservation so its IP doesn't drift, and add new ones here.
const ROKU_DEVICES = [
  { id: "theater", ip: "192.168.1.66" },
  { id: "playroom-soundbar", ip: "192.168.1.131" },
  { id: "bar", ip: "192.168.1.133" },
  { id: "office", ip: "192.168.1.151" },
  { id: "bedroom", ip: "192.168.1.160" },
  { id: "living-room", ip: "192.168.1.181" },
  { id: "third-floor", ip: "192.168.1.200" },
];

const ECP_TIMEOUT_MS = 2500;

async function ecpFetch(ip, path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ECP_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${ip}:8060${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`ECP ${path} returned ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

async function getDeviceStatus(device) {
  try {
    const [infoXml, appXml] = await Promise.all([
      ecpFetch(device.ip, "/query/device-info"),
      ecpFetch(device.ip, "/query/active-app"),
    ]);
    const name = xmlTag(infoXml, "friendly-device-name") || xmlTag(infoXml, "user-device-name") || device.id;
    const model = xmlTag(infoXml, "model-name") || "Roku";
    const appMatch = appXml.match(/<app[^>]*>([^<]*)<\/app>/);
    const appName = appMatch ? appMatch[1].trim() : null;
    const isHome = !appName || appName === "Roku" || appName === "Roku Dynamic Menu";
    const screensaver = xmlTag(appXml, "screensaver");

    return {
      id: device.id,
      ip: device.ip,
      name,
      model,
      online: true,
      idle: isHome,
      appName: isHome ? null : appName,
      screensaver: isHome ? screensaver : null,
      plex: null,
    };
  } catch {
    return {
      id: device.id,
      ip: device.ip,
      name: device.id,
      model: null,
      online: false,
      idle: true,
      appName: null,
      screensaver: null,
      plex: null,
    };
  }
}

export async function getAllRokuStatuses() {
  const [sessions, statuses] = await Promise.all([
    getPlexSessions().catch(() => []),
    Promise.all(ROKU_DEVICES.map(getDeviceStatus)),
  ]);

  return statuses.map((status) => {
    if (!status.appName || !status.appName.toLowerCase().includes("plex")) return status;
    const session = sessions.find((s) => s.playerAddress === status.ip);
    return session ? { ...status, plex: session } : status;
  });
}
