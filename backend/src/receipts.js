import express from "express";
import fs from "fs";
import path from "path";
import { google } from "googleapis";

// Persisted here (mounted as a Docker volume) so "resolved" receipts stay
// hidden across container restarts, not just within one running process.
const DATA_DIR = process.env.RECEIPTS_DATA_DIR || "/app/data";
const STATE_FILE = path.join(DATA_DIR, "receipts-state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const RECEIPT_QUERY_TERMS = [
  "receipt", "invoice", '"order confirmation"', '"your order"',
  '"payment received"', "itinerary", '"booking confirmation"', '"tax invoice"',
  '"purchase receipt"', '"payment confirmation"',
];

function buildQuery(after) {
  return `after:${after} (${RECEIPT_QUERY_TERMS.join(" OR ")})`;
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

export function createReceiptsRouter({ oauth2Client }) {
  const router = express.Router();
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  router.get("/candidates", async (req, res) => {
    try {
      const state = loadState();
      const after = req.query.after || `${new Date().getFullYear()}/1/1`;
      const query = buildQuery(after);

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
      } while (pageToken && messages.length < 300); // sanity cap per scan

      const pending = messages.filter((m) => !state[m.id]);

      const results = await mapWithConcurrency(pending, 8, async (m) => {
        const { data: full } = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "full",
        });
        const headers = Object.fromEntries((full.payload.headers || []).map((h) => [h.name, h.value]));
        const bodyText = findBodyText(full.payload);
        const attachments = findAttachments(full.payload).filter(
          (a) => a.mimeType === "application/pdf" || a.mimeType?.startsWith("image/")
        );

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
          attachment: attachments[0] || null,
          bodyText: bodyText.slice(0, 4000),
        };
      });

      res.json({
        candidates: results.filter((r) => r.status === "fulfilled").map((r) => r.value),
        scanned: messages.length,
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
    const state = loadState();
    state[req.params.messageId] = { decision: req.body?.decision || "dismissed", at: new Date().toISOString() };
    saveState(state);
    res.json({ ok: true });
  });

  // Undo, in case a receipt gets marked resolved by mistake.
  router.post("/:messageId/unresolve", (req, res) => {
    const state = loadState();
    delete state[req.params.messageId];
    saveState(state);
    res.json({ ok: true });
  });

  return router;
}
