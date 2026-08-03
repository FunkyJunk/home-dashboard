import express from "express";

// Pulls candidate accent colors out of a pasted URL's page (and its first
// linked stylesheet) so the frontend can build a theme from them. Best
// effort only - this is a text scan for hex colors, not real rendering,
// so a site that expresses its palette entirely through images or
// computed JS styles won't yield much. <meta name="theme-color"> is
// checked first since it's a purpose-built, explicit signal many sites
// already provide for exactly this ("what color represents this site").
const HEX_RE = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;

function normalizeHex(raw) {
  let hex = raw.trim().toLowerCase();
  if (!hex.startsWith("#")) hex = "#" + hex;
  if (hex.length === 4) {
    hex = "#" + [...hex.slice(1)].map((c) => c + c).join("");
  }
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}

// Filters out near-grayscale colors (low saturation) - these are almost
// always neutral UI chrome (borders, text, backgrounds) rather than a
// site's actual brand/accent colors.
function isNearGray(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

function extractColors(html) {
  const counts = new Map();
  const themeColorMatch = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);
  const themeColor = themeColorMatch ? normalizeHex(themeColorMatch[1]) : null;

  let m;
  while ((m = HEX_RE.exec(html))) {
    const hex = normalizeHex(m[0]);
    if (!hex || isNearGray(hex)) continue;
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
  const ordered = themeColor ? [themeColor, ...ranked.filter((c) => c !== themeColor)] : ranked;
  return ordered.slice(0, 8);
}

export function createThemeRouter() {
  const router = express.Router();

  // Same extraction as /from-url, just given text directly instead of
  // fetching it - lets the frontend hand over an uploaded brand/style
  // guide (markdown, plain text, whatever) without needing a URL at all.
  // No fetch, no network call, so there's no timeout/CORS handling here.
  router.post("/from-text", (req, res) => {
    const text = String(req.body?.text || "").slice(0, 500_000);
    if (!text.trim()) return res.status(400).json({ error: "text is required" });
    const colors = extractColors(text);
    res.json({ colors });
  });

  router.post("/from-url", async (req, res) => {
    const targetUrl = String(req.body?.url || "").trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      return res.status(400).json({ error: "URL must start with http:// or https://" });
    }

    try {
      const pageRes = await fetch(targetUrl, { signal: AbortSignal.timeout(8000) });
      if (!pageRes.ok) return res.status(502).json({ error: `Fetch failed: ${pageRes.status}` });
      let html = (await pageRes.text()).slice(0, 500_000);

      // A lot of real-world sites keep their palette in an external
      // stylesheet rather than inline - grab the first linked one as a
      // bonus source, but don't let its failure break the main result.
      const cssLinkMatch = html.match(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/i);
      if (cssLinkMatch) {
        try {
          const cssUrl = new URL(cssLinkMatch[1], targetUrl).toString();
          const cssRes = await fetch(cssUrl, { signal: AbortSignal.timeout(5000) });
          if (cssRes.ok) html += (await cssRes.text()).slice(0, 300_000);
        } catch {
          // Ignore - the main page's colors are still useful on their own.
        }
      }

      const colors = extractColors(html);
      res.json({ colors });
    } catch (e) {
      res.status(502).json({ error: e.message || "failed to analyze that URL" });
    }
  });

  return router;
}
