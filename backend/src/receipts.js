import express from "express";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";

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

// SQLite has no "ADD COLUMN IF NOT EXISTS" - these three were added after
// the table already existed in production, so add them defensively.
{
  const existingColumns = db.prepare("PRAGMA table_info(candidates)").all().map((c) => c.name);
  for (const [name, type] of [["business_amount", "REAL"], ["is_split", "INTEGER"], ["pdf_filename", "TEXT"], ["remote_images", "TEXT"], ["body_html", "TEXT"]]) {
    if (!existingColumns.includes(name)) db.exec(`ALTER TABLE candidates ADD COLUMN ${name} ${type}`);
  }
}

// ignore_keywords grew a second kind of entry (sender domains, excluded
// via Gmail's `-from:` operator instead of a quoted-phrase match) - the
// original schema's PK was just the keyword text, which can't
// distinguish "amazon.com" the subject phrase from "amazon.com" the
// domain, so this rebuilds the table with a composite (value, type) key.
{
  const ikColumns = db.prepare("PRAGMA table_info(ignore_keywords)").all().map((c) => c.name);
  if (!ikColumns.includes("type")) {
    db.exec(`
      ALTER TABLE ignore_keywords RENAME TO ignore_keywords_old;
      CREATE TABLE ignore_keywords (
        value TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'keyword',
        added_at TEXT NOT NULL,
        PRIMARY KEY (value, type)
      );
      INSERT INTO ignore_keywords (value, type, added_at) SELECT keyword, 'keyword', added_at FROM ignore_keywords_old;
      DROP TABLE ignore_keywords_old;
    `);
  }
}

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

function buildQuery(after, before, ignoreItems) {
  // ignoreItems is user-curated (via the "Ignore" button's picker) on top
  // of the static exclusion list, so shipping/delivery noise or entire
  // senders the user has already flagged stop coming back in future
  // scans. Domains use Gmail's -from: operator (excludes by sender)
  // rather than a quoted-phrase match (which would exclude any email
  // merely mentioning that domain, e.g. a tracking link).
  const wordExclusions = ignoreItems.filter((i) => i.type !== "domain").map((i) => `-"${i.value}"`);
  const domainExclusions = ignoreItems.filter((i) => i.type === "domain").map((i) => `-from:${i.value}`);
  const exclusions = [...RECEIPT_QUERY_EXCLUSIONS.map((t) => `-${t}`), ...wordExclusions, ...domainExclusions].join(" ");
  return `after:${after} before:${before} (${RECEIPT_QUERY_TERMS.join(" OR ")}) ${exclusions}`;
}

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Gmail bodies are a MIME tree (plain/html/attachments as siblings or
// nested multipart/*), not a flat list - this walks it once and returns
// both the plain and html parts, since callers need each for different
// things (line-item text parsing wants plain text with real line breaks
// preserved; remote image extraction needs the raw HTML).
function findParts(payload) {
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
  return { plain, html };
}

function bodyTextFromParts({ plain, html }) {
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

// Most retail emails (Amazon, etc.) embed product photos as remote
// <img src="https://...cdn.../photo.jpg"> tags, not real Gmail
// attachments - there is no attachment data to fetch for these at all,
// so the only way to show them is to load the URL directly from the
// vendor. That does mean the vendor learns the email was opened (same
// mechanism as a tracking pixel) - accepted trade-off, opted into
// explicitly.
//
// Rather than handing back a flat pool of images (which mixes in header
// logos, social icons, and footer badges alongside actual product
// photos), this replaces each candidate <img> with an inline
// "[[IMAGE n: alt text]]" marker at its original position in the HTML
// flow, then flattens to text. The AI extractor sees these markers in
// context and can tell "this image sits right next to this line item" -
// and skip anything that clearly reads as decorative/branding rather
// than a product photo.
const LOGO_HINTS = /(logo|icon|sprite|badge|social|footer|header|banner|pixel|spacer|transparent|divider)/i;

function htmlWithImageMarkers(html) {
  if (!html) return { text: "", images: [] };
  const images = [];
  const tagRe = /<img\b[^>]*>/gi;
  const withMarkers = html.replace(tagRe, (tag) => {
    if (images.length >= 12) return "";
    const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) return "";
    const url = srcMatch[1];
    if (!/^https?:\/\//i.test(url)) return "";
    if (!/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) return "";
    const altMatch = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
    const alt = altMatch ? altMatch[1] : "";
    const w = tag.match(/\bwidth\s*=\s*["']?(\d+)/i);
    const h = tag.match(/\bheight\s*=\s*["']?(\d+)/i);
    if ((w && Number(w[1]) <= 40) || (h && Number(h[1]) <= 40)) return ""; // tracking pixels & tiny icons
    if (LOGO_HINTS.test(url) || LOGO_HINTS.test(alt)) return ""; // obvious branding/decoration
    images.push({ url, alt });
    return ` [[IMAGE ${images.length - 1}${alt ? ": " + alt : ""}]] `;
  });
  const text = withMarkers
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  return { text, images };
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
//
// Two shapes are handled: "description  $12.34" on one line (simple
// receipts like Staples), and Amazon-style multi-line blocks where a long
// product title is followed by a "Quantity: N" line and then the price
// alone on its own line, often as "12.34 USD" with no $ sign at all.
function extractLineItems(text) {
  const skip = /(total|subtotal|tax|shipping|discount|balance|payment|card ending|confirmation|order number|thank you)/i;
  const priceOnlyLine = /^\$?([\d,]+\.\d{2})\s*(?:USD)?$/i;
  const fillerLine = /^(quantity|qty)\b/i;
  const items = [];

  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length && items.length < 20; i++) {
    const line = lines[i];
    if (skip.test(line)) continue;

    const sameLine = line.match(/^(.{3,300}?)\s+\$?([\d,]+\.\d{2})(?:\s*USD)?$/i);
    if (sameLine && !skip.test(sameLine[1])) {
      items.push({ description: sameLine[1].replace(/^\*\s*/, "").trim(), amount: parseFloat(sameLine[2].replace(/,/g, "")) });
      continue;
    }

    if (line.length < 15 || priceOnlyLine.test(line)) continue;
    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      const priceMatch = lines[j].match(priceOnlyLine);
      if (priceMatch) {
        items.push({ description: line.replace(/^\*\s*/, "").trim(), amount: parseFloat(priceMatch[1].replace(/,/g, "")) });
        i = j;
        break;
      }
      if (!fillerLine.test(lines[j])) break; // only skip recognized "in-between" lines like Quantity: N
    }
  }
  return items;
}

// Regex-based extraction above is genuinely best-effort - every vendor
// formats receipts differently, and pattern-matching only ever covers the
// formats it was written against. When an API key is configured, an LLM
// reads the actual email instead, which generalizes across formats far
// better than more regex. Falls back to the regex heuristics above if no
// key is set, or if the call fails for any reason (rate limit, etc.) -
// scanning must never hard-fail just because extraction had a bad day.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const EXTRACTION_TOOL = {
  name: "extract_receipt",
  description: "Extract structured purchase details from a receipt or order-confirmation email.",
  input_schema: {
    type: "object",
    properties: {
      isReceipt: {
        type: "boolean",
        description: "True if this email documents an actual purchase with financial data (receipt, order/payment confirmation). False for pure shipping/tracking status updates, marketing, or anything with no dollar amounts.",
      },
      total: { type: ["number", "null"], description: "Grand total charged, in dollars. Null if not stated." },
      tax: { type: ["number", "null"], description: "Sales tax amount, in dollars. Null if not stated." },
      shipping: { type: ["number", "null"], description: "Shipping/delivery fee, in dollars. Null if not stated." },
      lineItems: {
        type: "array",
        description: "Every distinct item/product purchased, with its price if shown. Do not include tax, shipping, discounts, or the total itself as a line item.",
        items: {
          type: "object",
          properties: {
            description: { type: "string", description: "The product/item name or description, as written in the email." },
            amount: { type: ["number", "null"], description: "That item's price in dollars, or null if not shown separately." },
            imageIndex: {
              type: ["integer", "null"],
              description: "The number from an [[IMAGE n: ...]] marker in the body that is a genuine photo of THIS specific item (usually appears right next to its description/price). Null if none is clearly associated with this item - do not guess, and never use a marker that reads as a logo, banner, icon, or generic branding image rather than an actual product photo.",
            },
          },
          required: ["description"],
        },
      },
    },
    required: ["isReceipt", "lineItems"],
  },
};

async function extractWithAI(subject, bodyText) {
  if (!anthropic) return null;
  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1536,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: "tool", name: "extract_receipt" },
      messages: [{
        role: "user",
        content: `Extract the purchase details from this email. [[IMAGE n: ...]] markers stand in for images that appeared inline in the original email at that position.\n\nSubject: ${subject}\n\nBody:\n${bodyText.slice(0, 8000)}`,
      }],
    });
    const toolUse = msg.content.find((b) => b.type === "tool_use");
    return toolUse ? toolUse.input : null;
  } catch (e) {
    console.error("AI extraction failed, falling back to regex:", e.message);
    return null;
  }
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
    remoteImageUrls: JSON.parse(row.remote_images || "[]"),
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    status: row.status,
    businessAmount: row.business_amount,
    isSplit: !!row.is_split,
    pdfFilename: row.pdf_filename,
  };
}

export function createReceiptsRouter({ oauth2Client }) {
  const router = express.Router();
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const selectPendingByMonth = db.prepare("SELECT * FROM candidates WHERE month = ? AND status = 'pending'");
  const selectPending = db.prepare("SELECT * FROM candidates WHERE status = 'pending'");
  const selectScannedMonth = db.prepare("SELECT * FROM scanned_months WHERE month = ?");
  const upsertCandidate = db.prepare(`
    INSERT INTO candidates (id, month, from_addr, subject, date, snippet, total, tax, shipping, line_items, attachment, images, remote_images, body_text, body_html, status)
    VALUES (@id, @month, @from_addr, @subject, @date, @snippet, @total, @tax, @shipping, @line_items, @attachment, @images, @remote_images, @body_text, @body_html, @status)
    ON CONFLICT(id) DO UPDATE SET
      from_addr = excluded.from_addr, subject = excluded.subject, date = excluded.date, snippet = excluded.snippet,
      total = excluded.total, tax = excluded.tax, shipping = excluded.shipping, line_items = excluded.line_items,
      attachment = excluded.attachment, images = excluded.images, remote_images = excluded.remote_images,
      body_text = excluded.body_text, body_html = excluded.body_html
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
    const pendingRows = db.prepare("SELECT month, COUNT(*) AS c FROM candidates WHERE status = 'pending' AND month LIKE ? GROUP BY month").all(`${year}-%`);
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

  // The ignore list is user-curated: picked from a subject's words (or a
  // sender's domain) via the "Ignore" button's popup. Used both to
  // highlight matching candidates client-side and to exclude future
  // Gmail scans (see buildQuery).
  const selectIgnoreItems = db.prepare("SELECT value, type FROM ignore_keywords ORDER BY added_at DESC");
  function currentIgnoreLists() {
    const rows = selectIgnoreItems.all();
    return {
      keywords: rows.filter((r) => r.type !== "domain").map((r) => r.value),
      domains: rows.filter((r) => r.type === "domain").map((r) => r.value),
    };
  }

  router.get("/ignore-keywords", (req, res) => {
    res.json(currentIgnoreLists());
  });

  router.post("/ignore-keywords", (req, res) => {
    const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords : [];
    const domains = Array.isArray(req.body?.domains) ? req.body.domains : [];
    const insert = db.prepare("INSERT OR IGNORE INTO ignore_keywords (value, type, added_at) VALUES (?, ?, ?)");
    const now = new Date().toISOString();
    const tx = db.transaction((words, doms) => {
      for (const w of words) {
        const value = String(w || "").trim().toLowerCase();
        if (value) insert.run(value, "keyword", now);
      }
      for (const d of doms) {
        const value = String(d || "").trim().toLowerCase();
        if (value) insert.run(value, "domain", now);
      }
    });
    tx(keywords, domains);
    res.json(currentIgnoreLists());
  });

  router.delete("/ignore-keywords/:value", (req, res) => {
    const type = req.query.type === "domain" ? "domain" : "keyword";
    db.prepare("DELETE FROM ignore_keywords WHERE value = ? AND type = ?").run(req.params.value.toLowerCase(), type);
    res.json({ ok: true });
  });

  // Pure DB read - never touches Gmail. This is what the grid loads from
  // on every month/tab switch, so browsing is instant and doesn't re-run
  // a search. status is comma-separated ("business,split" for the
  // Business tab, since a partial split-save is still a business receipt).
  router.get("/candidates", (req, res) => {
    const { month, status } = req.query;
    const statuses = (status || "pending").split(",").map((s) => s.trim()).filter(Boolean);
    const placeholders = statuses.map(() => "?").join(",");
    const rows = month
      ? db.prepare(`SELECT * FROM candidates WHERE month = ? AND status IN (${placeholders})`).all(month, ...statuses)
      : db.prepare(`SELECT * FROM candidates WHERE status IN (${placeholders})`).all(...statuses);
    res.json({ candidates: rows.map(rowToCandidate) });
  });

  // Per-tab counts for the currently selected month, so tab labels can
  // show "Business (3)" without a separate round trip per tab.
  router.get("/status-counts", (req, res) => {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: "month is required" });
    const rows = db.prepare("SELECT status, COUNT(*) AS c FROM candidates WHERE month = ? GROUP BY status").all(month);
    const counts = { pending: 0, business: 0, personal: 0, ignore: 0 };
    for (const r of rows) {
      if (r.status === "business" || r.status === "split") counts.business += r.c;
      else if (Object.prototype.hasOwnProperty.call(counts, r.status)) counts[r.status] = r.c;
    }
    res.json({ counts });
  });

  // Everything marked business/split for the year, in final (possibly
  // hand-edited) form - the source the "Download spreadsheet" button
  // generates from. Nothing is written incrementally to a spreadsheet on
  // each save anymore, so reclassifying a receipt later never leaves a
  // stale row behind.
  router.get("/export", (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    const rows = db.prepare(
      "SELECT * FROM candidates WHERE month LIKE ? AND status IN ('business', 'split') ORDER BY date ASC"
    ).all(`${year}-%`);
    res.json({ year, receipts: rows.map(rowToCandidate) });
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

      const ignoreItems = selectIgnoreItems.all();
      const { after, before } = monthRange(month);
      const query = buildQuery(after, before, ignoreItems);

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

      // Lower concurrency when calling out to the Anthropic API per message
      // - the regex path is free and instant, but an LLM call per email
      // benefits from being gentler on rate limits.
      const results = await mapWithConcurrency(messages, anthropic ? 4 : 8, async (m) => {
        const { data: full } = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "full",
        });
        const headers = Object.fromEntries((full.payload.headers || []).map((h) => [h.name, h.value]));
        const parts = findParts(full.payload);
        const bodyText = bodyTextFromParts(parts);
        const { attachment, images } = extractAttachments(full.payload);
        const { text: markedText, images: imageMarkers } = htmlWithImageMarkers(parts.html);

        const ai = await extractWithAI(headers.Subject || "", markedText || bodyText);
        // A confident "this isn't even a receipt" from the model (customer
        // service threads, insurance paperwork, marketplace notifications)
        // is worth trusting over the Gmail search terms alone - drop it
        // rather than cluttering review with something nobody would ever
        // call a receipt. Still counts toward the "scanned N emails" tally.
        if (ai && ai.isReceipt === false) return null;

        const total = ai ? ai.total ?? null : findAmount(bodyText, ["total", "grand total", "order total", "amount charged", "amount due"]);
        const tax = ai ? ai.tax ?? null : findAmount(bodyText, ["tax", "sales tax"]);
        const shipping = ai ? ai.shipping ?? null : findAmount(bodyText, ["shipping", "delivery"]);
        const usedImageIndexes = new Set();
        const lineItems = ai
          ? (ai.lineItems || []).map((it) => {
              const marker = it.imageIndex != null ? imageMarkers[it.imageIndex] : null;
              if (marker) usedImageIndexes.add(it.imageIndex);
              return { description: it.description, amount: it.amount ?? null, imageUrl: marker ? marker.url : null };
            })
          : extractLineItems(bodyText);
        // Anything left over (a photo the model saw but didn't tie to a
        // specific item, or all of them when AI extraction isn't
        // configured) still shows up as a general receipt image rather
        // than being thrown away.
        const remoteImageUrls = imageMarkers.filter((_, i) => !usedImageIndexes.has(i)).map((img) => img.url);

        return {
          id: m.id,
          from: headers.From || "",
          subject: headers.Subject || "",
          date: headers.Date || "",
          snippet: full.snippet || "",
          total,
          tax,
          shipping,
          lineItems,
          attachment,
          images,
          remoteImageUrls,
          bodyText: bodyText.slice(0, 4000),
          // Kept separately from bodyText (which is flattened for
          // parsing) so the detail view can render something closer to
          // what the email actually looked like, instead of stripped text.
          bodyHtml: parts.html ? parts.html.slice(0, 300000) : null,
        };
      });

      const fulfilled = results.filter((r) => r.status === "fulfilled" && r.value !== null).map((r) => r.value);
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
            remote_images: JSON.stringify(c.remoteImageUrls),
            body_text: c.bodyText,
            body_html: c.bodyHtml,
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

  // total/tax/shipping/businessAmount/isSplit/pdfFilename are only
  // meaningful for business/split decisions (the frontend sends them then);
  // COALESCE keeps whatever was already stored when they're omitted, e.g.
  // for a personal/ignore decision, or a later reclassification that
  // doesn't touch the dollar figures.
  router.post("/:messageId/resolve", (req, res) => {
    const { decision, total, tax, shipping, businessAmount, isSplit, pdfFilename } = req.body || {};
    db.prepare(`
      UPDATE candidates SET
        status = ?, resolved_at = ?,
        total = COALESCE(?, total), tax = COALESCE(?, tax), shipping = COALESCE(?, shipping),
        business_amount = ?, is_split = ?, pdf_filename = COALESCE(?, pdf_filename)
      WHERE id = ?
    `).run(
      decision || "dismissed",
      new Date().toISOString(),
      total ?? null, tax ?? null, shipping ?? null,
      businessAmount ?? null, isSplit ? 1 : 0, pdfFilename ?? null,
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
