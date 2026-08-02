// Plex Media Server "now playing" sessions - used to show rich metadata
// (poster, title, season/episode, watched/left/end time) for whatever's
// playing through the Plex app on a Roku. Roku's own device API never
// exposes more than a bare app name for anything else - confirmed against
// a real session (2026-08-xx): Roku's /query/media-player only ever
// returns format + playback position, nothing about title/poster/duration,
// and 403s entirely for devices not actively playing. See roku.js.
const PLEX_URL = process.env.PLEX_URL || "http://192.168.1.97:32400";

function getToken() {
  if (!process.env.PLEX_TOKEN) {
    throw new Error("Plex not configured - set PLEX_TOKEN");
  }
  return process.env.PLEX_TOKEN;
}

export async function getPlexSessions() {
  const res = await fetch(`${PLEX_URL}/status/sessions?X-Plex-Token=${getToken()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Plex API error: ${res.status}`);
  const data = await res.json();
  const items = data?.MediaContainer?.Metadata || [];

  return items.map((m) => {
    const durationMs = m.duration || 0;
    const viewOffsetMs = m.viewOffset || 0;
    const remainingMs = Math.max(0, durationMs - viewOffsetMs);
    return {
      playerAddress: m.Player?.address || null,
      playerState: m.Player?.state || null,
      type: m.type, // "movie" | "episode" | ...
      title: m.title,
      showTitle: m.grandparentTitle || null,
      seasonNumber: m.parentIndex ?? null,
      episodeNumber: m.index ?? null,
      year: m.year || null,
      summary: m.summary || null,
      contentRating: m.contentRating || null,
      thumbPath: m.thumb || null,
      durationMs,
      viewOffsetMs,
      remainingMs,
      endTime: new Date(Date.now() + remainingMs).toISOString(),
    };
  });
}

// Proxies a Plex image (poster/art) through the backend so the token never
// reaches the browser - the dashboard has no login of its own, so anything
// exposed directly to the frontend is exposed to anyone on the LAN.
// Restricted to the exact shape Plex itself returns in a session's
// thumb/art field, rather than passing an arbitrary path through.
const PLEX_IMAGE_PATH = /^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/;

export async function fetchPlexImage(path) {
  if (typeof path !== "string" || !PLEX_IMAGE_PATH.test(path)) {
    throw new Error("invalid image path");
  }
  const res = await fetch(`${PLEX_URL}${path}?X-Plex-Token=${getToken()}`);
  if (!res.ok) throw new Error(`Plex image fetch failed: ${res.status}`);
  return res;
}
