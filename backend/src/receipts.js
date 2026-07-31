import express from "express";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { google } from "googleapis";

// SQLite lives on the mounted data volume, so scanned months and every
// candidate/decision survive container restarts. Scanning Gmail is a real
// cost (hundreds of message fetches) and something the user explicitly
// asked to only pay once per month unless they force a re-check, so the
// database is the source of truth for the UI - "candidates" is never a
// live Gmail call, only "/scan" is.
const DATA_DIR = process.env.RECEIPTS_DATA_DIR || "/app/data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "receipts.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS scanned_months (
    month TEXT PRIMARY KEY,
    scanned_at TEXT NOT NULL,
    message_count INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    month TEXT NOT NULL,
    from_addr TEXT,
    subject TEXT,
    date TEXT,
    snippet TEXT,
    total REAL,
    tax REAL,
    shipping REAL,
    line_items TEXT,
    attachment TEXT,
    images TEXT,
    body_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_candidates_month ON candidates(month);
  CREATE TABLE IF NOT EXISTS legacy_resolved (
    id TEXT PRIMARY KEY,
    decision TEXT,
    resolved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS ignore_keywords (
    keyword TEXT PRIMARY KEY,
    added_at TEXT NOT NULL
  );
`);

// One-time migration from the old flat-file state (pre-database version of
// this feature) so receipts already marked business/personal don't
// reappear once their month gets scanned under the new system.
const LEGACY_STATE_FILE = path.join(DATA_DIR, "receipts-state.json");
if (db.prepare("SELECT COUNT(*) AS c FROM legacy_resolved").get().c === 0 && fs.existsSync(LEGACY_STATE_FILE)) {
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, "utf8"));
    const insertLegacy = db.prepare("INSERT OR IGNORE INTO legacy_resolved (id, decision, resolved_at) VALUES (?, ?, ?)");
    const tx = db.transaction((entries) => {
      for (const [id, v] of entries) insertLegacy.run(id, v.decision || "dismissed", v.at || new Date().toISOString());
    });
    tx(Object.entries(legacy));
  } catch {
    // Corrupt or unreadable legacy file - nothing to migrate, not fatal.
  }
}

const RECEIPT_QUERY_TERMS = [
  "receipt", "invoice", '"order confirmation"', '"your order"',
  '"payment received"', "itinerary", '"booking confirmation"', '"tax invoice"',
  '"purchase receipt"', '"payment confirmation"',
];

// Cuts the most obvious marketing noise that otherwise matches on "receipt"/
// "order" in a promo subject line - not trying to be exhaustive here, the
// review UI is the real filter for whatever slips through.
const RECEIPT_QUERY_EXCLUSIONS = ['"% off"', "unsubscribe", "newsletter"];

function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  const after = `${y}/${m}/1`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const before = `${nextY}/${nextM}/1`;
  return { after, before };
}

function buildQuery(after, before, ignoreKeywords) {
  // ignoreKeywords is user-curated (via the "Ignore" button's keyword
  // picker) on top of the static exclusion list, so shipping/delivery
  // noise the user has already flagged stops coming back in future scans.
  const exclusions = [...RECEIPT_QUERY_EXCLUSIONS, ...ignoreKeywords.map((k) => `"${k}"`)].map((t) => `-${t}`).join(" ");
  return `after:${after} before:${before} (${RECEIPT_QUERY_TERMS.join(" OR ")}) ${exclusions}`;
}

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Gmail bodies are a MIME tree (plain/html/attachments as siblings or
// nested multipart/*), not a flat list - both helpers below have to walk it.
function findBodyText(payload) {
  let plain = null;
  let html = null;
  (function walk(part) {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) {
      plain = decodeBase64Url(part.body.data).toString("utf8");
    }
    if (part.mimeType === "text/html" && part.body?.data) {
      html = decodeBase64Url(part.body.data).toString("utf8");
    }
    (part.parts || []).forEach(walk);
  })(payload);

  if (plain) return plain;
  if (html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");
  }
  return "";
}

function findAttachments(payload) {
  const out = [];
  (function walk(part) {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      out.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId });
    }
    (part.parts || []).forEach(walk);
  })(payload);
  return out;
}

// Splits attachments into the one to treat as "the receipt document" (a
// PDF if there is one) and any images - a vendor email can carry both a
// PDF invoice AND product photos, and the UI wants to show every image as
// a clickable thumbnail, not just whichever attachment happened to sort
// first.
function extractAttachments(payload) {
  const all = findAttachments(payload).filter(
    (a) => a.mimeType === "application/pdf" || a.mimeType?.startsWith("image/")
  );
  const pdf = all.find((a) => a.mimeType === "application/pdf") || null;
  const images = all.filter((a) => a.mimeType?.startsWith("image/"));
  return { attachment: pdf || images[0] || null, images };
}

const MONEY = "\\$?\\s?([\\d,]{1,3}(?:,\\d{3})*\\.\\d{2})";

function findAmount(text, labels) {
  for (const label of labels) {
    const m = text.match(new RegExp(`${label}[^\\d\\n]{0,25}${MONEY}`, "i"));
    if (m) return parseFloat(m[1].replace(/,/g, ""));
  }
  return null;
}

// Best-effort only - arbitrary vendor email formats vary too much to parse
// reliably. The review UI lets the user add/edit/remove items by hand;
// this just saves typing when it happens to work.
function extractLineItems(text) {
  const skip = /(total|subtotal|tax|shipping|discount|balance|payment|card ending|confirmation|order number|thank you)/i;
  const items = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    const m = line.match(/^(.{3,80}?)\s+\$?([\d,]+\.\d{2})$/);
    if (m && !skip.test(m[1])) {
      items.push({ description: m[1].trim(), amount: parseFloat(m[2].replace(/,/g, "")) });
    }
    if (items.length >= 20) break; // sanity cap against runaway matches
  }
  return items;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (e) {
        results[i] = { status: "rejected", reason: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function rowToCandidate(row) {
  return {
    id: row.id,
    month: row.month,
    from: row.from_addr,
    subject: row.subject,
    date: row.date,
    snippet: row.snippet,
    total: row.total,
    tax: row.tax,
    shipping: row.shipping,
    lineItems: JSON.parse(row.line_items || "[]"),
    attachment: JSON.parse(row.attachment || "null"),
    images: JSON.parse(row.images || "[]"),
    bodyText: row.body_text,
    status: row.status,
  };
}

export function createReceiptsRouter({ oauth2Client }) {
  const router = express.Router();
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const selectPendingByMonth = db.prepare("SELECT * FROM candidates WHERE month = ? AND status = 'pending'");
  const selectPending = db.prepare("SELECT * FROM candidates WHERE status = 'pending'");
  const selectScannedMonth = db.prepare("SELECT * FROM scanned_months WHERE month = ?");
  const upsertCandidate = db.prepare(`
    INSERT INTO candidates (id, month, from_addr, subject, date, snippet, total, tax, shipping, line_items, attachment, images, body_text, status)
    VALUES (@id, @month, @from_addr, @subject, @date, @snippet, @total, @tax, @shipping, @line_items, @attachment, @images, @body_text, @status)
    ON CONFLICT(id) DO UPDATE SET
      from_addr = excluded.from_addr, subject = excluded.subject, date = excluded.date, snippet = excluded.snippet,
      total = excluded.total, tax = excluded.tax, shipping = excluded.shipping, line_items = excluded.line_items,
      attachment = excluded.attachment, images = excluded.images, body_text = excluded.body_text
    WHERE candidates.status = 'pending'
  `);
  const upsertScannedMonth = db.prepare(`
    INSERT INTO scanned_months (month, scanned_at, message_count) VALUES (?, ?, ?)
    ON CONFLICT(month) DO UPDATE SET scanned_at = excluded.scanned_at, message_count = excluded.message_count
  `);
  const getLegacyResolved = db.prepare("SELECT decision FROM legacy_resolved WHERE id = ?");

  // Month picker data: for each month of the requested year, whether it's
  // been scanned yet and how many pending candidates are sitting in it.
  router.get("/months", (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    const scannedRows = db.prepare("SELECT month, scanned_at, message_count FROM scanned_months WHERE month LIKE ?").all(`${year}-%`);
    const scannedMap = Object.fromEntries(scannedRows.map((r) => [r.month, r]));
    const pendingRows = db.prepare("SELECT month, COUNT(*) AS c FROM candidates WHERE status = 'pending' AND month LIKE ?").all(`${year}-%`);
    const pendingMap = Object.fromEntries(pendingRows.map((r) => [r.month, r.c]));

    const months = [];
    for (let m = 1; m <= 12; m++) {
      const month = `${year}-${String(m).padStart(2, "0")}`;
      months.push({
        month,
        scanned: !!scannedMap[month],
        scannedAt: scannedMap[month]?.scanned_at || null,
        messageCount: scannedMap[month]?.message_count || 0,
        pendingCount: pendingMap[month] || 0,
      });
    }
    res.json({ year, months });
  });

  // The ignore list is user-curated: picked from a subject's words via the
  // "Ignore" button's keyword popup. Used both to highlight matching
  // candidates client-side and to exclude future Gmail scans (see buildQuery).
  router.get("/ignore-keywords", (req, res) => {
    const keywords = db.prepare("SELECT keyword FROM ignore_keywords ORDER BY added_at DESC").all().map((r) => r.keyword);
    res.json({ keywords });
  });

  router.post("/ignore-keywords", (req, res) => {
    const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords : [];
    const insert = db.prepare("INSERT OR IGNORE INTO ignore_keywords (keyword, added_at) VALUES (?, ?)");
    const now = new Date().toISOString();
    const tx = db.transaction((words) => {
      for (const w of words) {
        const keyword = String(w || "").trim().toLowerCase();
        if (keyword) insert.run(keyword, now);
      }
    });
    tx(keywords);
    const all = db.prepare("SELECT keyword FROM ignore_keywords ORDER BY added_at DESC").all().map((r) => r.keyword);
    res.json({ keywords: all });
  });

  router.delete("/ignore-keywords/:keyword", (req, res) => {
    db.prepare("DELETE FROM ignore_keywords WHERE keyword = ?").run(req.params.keyword.toLowerCase());
    res.json({ ok: true });
  });

  // Pure DB read - never touches Gmail. This is what the grid loads from
  // on every month switch/page load so browsing is instant and doesn't
  // re-run a search.
  router.get("/candidates", (req, res) => {
    const { month } = req.query;
    const rows = month ? selectPendingByMonth.all(month) : selectPending.all();
    res.json({ candidates: rows.map(rowToCandidate) });
  });

  // The only route that calls Gmail. Skips the search entirely if the
  // month was already scanned, unless force=true.
  router.post("/scan", async (req, res) => {
    try {
      const { month, force } = req.body || {};
      if (!/^\d{4}-\d{2}$/.test(month || "")) {
        return res.status(400).json({ error: "month must be in YYYY-MM format" });
      }

      const already = selectScannedMonth.get(month);
      if (already && !force) {
        return res.json({
          candidates: selectPendingByMonth.all(month).map(rowToCandidate),
          scanned: already.message_count,
          alreadyScanned: true,
          errors: [],
        });
      }

      const ignoreKeywords = db.prepare("SELECT keyword FROM ignore_keywords").all().map((r) => r.keyword);
      const { after, before } = monthRange(month);
      const query = buildQuery(after, before, ignoreKeywords);

      let messages = [];
      let pageToken;
      do {
        const { data } = await gmail.users.messages.list({
          userId: "me",
          q: query,
          maxResults: 100,
          pageToken,
        });
        messages.push(...(data.messages || []));
        pageToken = data.nextPageToken;
      } while (pageToken && messages.length < 500); // sanity cap per month

      const results = await mapWithConcurrency(messages, 8, async (m) => {
        const { data: full } = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "full",
        });
        const headers = Object.fromEntries((full.payload.headers || []).map((h) => [h.name, h.value]));
        const bodyText = findBodyText(full.payload);
        const { attachment, images } = extractAttachments(full.payload);

        return {
          id: m.id,
          from: headers.From || "",
          subject: headers.Subject || "",
          date: headers.Date || "",
          snippet: full.snippet || "",
          total: findAmount(bodyText, ["total", "grand total", "order total", "amount charged", "amount due"]),
          tax: findAmount(bodyText, ["tax", "sales tax"]),
          shipping: findAmount(bodyText, ["shipping", "delivery"]),
          lineItems: extractLineItems(bodyText),
          attachment,
          images,
          bodyText: bodyText.slice(0, 4000),
        };
      });

      const fulfilled = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const tx = db.transaction((rows) => {
        for (const c of rows) {
          const legacy = getLegacyResolved.get(c.id);
          upsertCandidate.run({
            id: c.id,
            month,
            from_addr: c.from,
            subject: c.subject,
            date: c.date,
            snippet: c.snippet,
            total: c.total,
            tax: c.tax,
            shipping: c.shipping,
            line_items: JSON.stringify(c.lineItems),
            attachment: JSON.stringify(c.attachment),
            images: JSON.stringify(c.images),
            body_text: c.bodyText,
            status: legacy ? legacy.decision : "pending",
          });
        }
        upsertScannedMonth.run(month, new Date().toISOString(), messages.length);
      });
      tx(fulfilled);

      const candidates = selectPendingByMonth.all(month).map(rowToCandidate);
      // Highest-confidence candidates (an actual dollar figure was found)
      // first, so review starts with the most likely real receipts.
      candidates.sort((a, b) => (b.total != null) - (a.total != null));

      res.json({
        candidates,
        scanned: messages.length,
        alreadyScanned: false,
        errors: results.filter((r) => r.status === "rejected").map((r) => r.reason?.message || "unknown error"),
      });
    } catch (e) {
      res.status(502).json({ error: e.message || "gmail scan failed" });
    }
  });

  router.get("/attachment/:messageId/:attachmentId", async (req, res) => {
    try {
      const { messageId, attachmentId } = req.params;
      const { data } = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      });
      res.set("Content-Type", "application/octet-stream");
      res.send(decodeBase64Url(data.data));
    } catch (e) {
      res.status(502).json({ error: e.message || "attachment fetch failed" });
    }
  });

  router.post("/:messageId/resolve", (req, res) => {
    db.prepare("UPDATE candidates SET status = ?, resolved_at = ? WHERE id = ?").run(
      req.body?.decision || "dismissed",
      new Date().toISOString(),
      req.params.messageId
    );
    res.json({ ok: true });
  });

  // Undo, in case a receipt gets marked resolved by mistake.
  router.post("/:messageId/unresolve", (req, res) => {
    db.prepare("UPDATE candidates SET status = 'pending', resolved_at = NULL WHERE id = ?").run(req.params.messageId);
    res.json({ ok: true });
  });

  return router;
}
