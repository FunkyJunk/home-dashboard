// Minimal IPP/2.0 client - enough to ask a printer what it can do and to send
// it one document. Hand-rolled rather than pulling in an IPP library: the
// dashboard needs exactly three operations, the wire format is a fixed binary
// header plus tag/name/value triples, and owning the parser is what lets a
// failure report the printer's own document-format-supported list instead of a
// bare status code.
//
// Wire format (RFC 8010):
//   version-number  2 bytes   (0x02 0x00 = IPP 2.0)
//   operation-id    2 bytes
//   request-id      4 bytes
//   attribute-group*          each: delimiter-tag(1) then attributes
//   end-of-attributes-tag     0x03
//   document data             (raw, for Print-Job)
//
// attribute      = value-tag(1) name-len(2) name value-len(2) value
// extra value    = value-tag(1) 0x0000        value-len(2) value   (a 1setOf)
//
// attributes-charset MUST be the first operation attribute and
// attributes-natural-language MUST be the second; printers reject the request
// outright if that order is wrong, which is an easy thing to get subtly wrong
// and a miserable thing to debug from a printer's generic 400.

const DELIM = {
  operation: 0x01,
  job: 0x02,
  end: 0x03,
  printer: 0x04,
  unsupported: 0x05,
};

const TAG = {
  unsupported: 0x10,
  unknown: 0x12,
  noValue: 0x13,
  integer: 0x21,
  boolean: 0x22,
  enumeration: 0x23,
  octetString: 0x30,
  dateTime: 0x31,
  resolution: 0x32,
  rangeOfInteger: 0x33,
  begCollection: 0x34,
  textWithLanguage: 0x35,
  nameWithLanguage: 0x36,
  endCollection: 0x37,
  textWithoutLanguage: 0x41,
  nameWithoutLanguage: 0x42,
  keyword: 0x44,
  uri: 0x45,
  uriScheme: 0x46,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
  memberAttrName: 0x4a,
};

export const OPERATION = {
  printJob: 0x0002,
  validateJob: 0x0004,
  getJobAttributes: 0x0009,
  getPrinterAttributes: 0x000b,
};

const STRING_TAGS = new Set([
  TAG.octetString, TAG.textWithoutLanguage, TAG.nameWithoutLanguage, TAG.keyword,
  TAG.uri, TAG.uriScheme, TAG.charset, TAG.naturalLanguage, TAG.mimeMediaType,
  TAG.memberAttrName,
]);

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function attr(tag, name, value) {
  const nameBuf = Buffer.from(name, "utf8");
  let valBuf;
  if (tag === TAG.integer || tag === TAG.enumeration) {
    valBuf = Buffer.alloc(4);
    valBuf.writeInt32BE(value, 0);
  } else if (tag === TAG.boolean) {
    valBuf = Buffer.from([value ? 1 : 0]);
  } else {
    valBuf = Buffer.from(String(value), "utf8");
  }
  const head = Buffer.alloc(3 + nameBuf.length + 2);
  head.writeUInt8(tag, 0);
  head.writeUInt16BE(nameBuf.length, 1);
  nameBuf.copy(head, 3);
  head.writeUInt16BE(valBuf.length, 3 + nameBuf.length);
  return Buffer.concat([head, valBuf]);
}

// Second and later values of a 1setOf carry an empty name.
function additional(tag, value) {
  return attr(tag, "", value);
}

function setOf(tag, name, values) {
  const list = [].concat(values);
  if (!list.length) return Buffer.alloc(0);
  return Buffer.concat([attr(tag, name, list[0]), ...list.slice(1).map((v) => additional(tag, v))]);
}

let nextRequestId = 1;

export function encodeRequest({ operation, printerUri, operationAttrs = [], jobAttrs = [], data }) {
  const header = Buffer.alloc(8);
  header.writeUInt8(0x02, 0); // IPP 2.0
  header.writeUInt8(0x00, 1);
  header.writeUInt16BE(operation, 2);
  const requestId = nextRequestId++;
  header.writeInt32BE(requestId, 4);

  const parts = [header, Buffer.from([DELIM.operation])];
  // Order is mandated: charset, then natural-language, then the rest.
  parts.push(attr(TAG.charset, "attributes-charset", "utf-8"));
  parts.push(attr(TAG.naturalLanguage, "attributes-natural-language", "en-us"));
  parts.push(attr(TAG.uri, "printer-uri", printerUri));
  for (const a of operationAttrs) parts.push(a);

  if (jobAttrs.length) {
    parts.push(Buffer.from([DELIM.job]));
    for (const a of jobAttrs) parts.push(a);
  }

  parts.push(Buffer.from([DELIM.end]));
  if (data) parts.push(data);
  return { buffer: Buffer.concat(parts), requestId };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function readValue(tag, buf) {
  if (tag === TAG.integer || tag === TAG.enumeration) return buf.readInt32BE(0);
  if (tag === TAG.boolean) return buf.readUInt8(0) === 1;
  if (tag === TAG.rangeOfInteger) return { lower: buf.readInt32BE(0), upper: buf.readInt32BE(4) };
  if (tag === TAG.resolution) {
    return { x: buf.readInt32BE(0), y: buf.readInt32BE(4), units: buf.readUInt8(8) === 3 ? "dpi" : "dpcm" };
  }
  if (tag === TAG.textWithLanguage || tag === TAG.nameWithLanguage) {
    // [lang-len][lang][text-len][text] - only the text is interesting here.
    const langLen = buf.readUInt16BE(0);
    const textLen = buf.readUInt16BE(2 + langLen);
    return buf.subarray(4 + langLen, 4 + langLen + textLen).toString("utf8");
  }
  if (tag === TAG.noValue || tag === TAG.unknown || tag === TAG.unsupported) return null;
  if (STRING_TAGS.has(tag)) return buf.toString("utf8");
  return buf.toString("utf8");
}

export function decodeResponse(buf) {
  if (buf.length < 8) throw new Error("IPP response truncated");
  const statusCode = buf.readUInt16BE(2);
  const requestId = buf.readInt32BE(4);
  const groups = { operation: {}, job: {}, printer: {}, unsupported: {} };
  const nameFor = { [DELIM.operation]: "operation", [DELIM.job]: "job", [DELIM.printer]: "printer", [DELIM.unsupported]: "unsupported" };

  let i = 8;
  let current = null;
  let lastName = null;
  // Collections are read but flattened to their member names; nothing this
  // dashboard requests returns one, and a printer that volunteers one must not
  // derail the parse.
  let collectionDepth = 0;

  while (i < buf.length) {
    const tag = buf.readUInt8(i);
    if (tag === DELIM.end) break;
    if (tag in nameFor) {
      current = groups[nameFor[tag]];
      lastName = null;
      i += 1;
      continue;
    }
    if (i + 3 > buf.length) break;
    const nameLen = buf.readUInt16BE(i + 1);
    const name = buf.subarray(i + 3, i + 3 + nameLen).toString("utf8");
    const valLenAt = i + 3 + nameLen;
    if (valLenAt + 2 > buf.length) break;
    const valLen = buf.readUInt16BE(valLenAt);
    const valBuf = buf.subarray(valLenAt + 2, valLenAt + 2 + valLen);
    i = valLenAt + 2 + valLen;

    if (tag === TAG.begCollection) { collectionDepth++; continue; }
    if (tag === TAG.endCollection) { collectionDepth = Math.max(0, collectionDepth - 1); continue; }
    if (collectionDepth > 0 || !current) continue;

    const value = readValue(tag, valBuf);
    const key = nameLen ? name : lastName;
    if (!key) continue;
    if (nameLen) {
      lastName = name;
      current[key] = value;
    } else {
      // Additional value of a 1setOf: promote to an array.
      current[key] = [].concat(current[key], value);
    }
  }

  return { statusCode, statusText: statusName(statusCode), requestId, groups, ok: statusCode < 0x0100 };
}

export function statusName(code) {
  const known = {
    0x0000: "successful-ok",
    0x0001: "successful-ok-ignored-or-substituted-attributes",
    0x0002: "successful-ok-conflicting-attributes",
    0x0400: "client-error-bad-request",
    0x0401: "client-error-forbidden",
    0x0402: "client-error-not-authenticated",
    0x0403: "client-error-not-authorized",
    0x0405: "client-error-not-found",
    0x0406: "client-error-gone",
    0x040a: "client-error-document-format-not-supported",
    0x040b: "client-error-attributes-or-values-not-supported",
    0x0500: "server-error-internal-error",
    0x0501: "server-error-operation-not-supported",
    0x0502: "server-error-service-unavailable",
    0x0503: "server-error-version-not-supported",
    0x0508: "server-error-not-accepting-jobs",
    0x0509: "server-error-busy",
  };
  return known[code] || `status-0x${code.toString(16).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Transport
//
// IPP rides on plain HTTP POST with Content-Type application/ipp. An ipp:// URI
// means HTTP on port 631 (ipps:// means HTTPS on 631), so the scheme is
// rewritten rather than handed to fetch, which has no idea what ipp:// is.
// ---------------------------------------------------------------------------

export function httpUrlFor(printerUri) {
  const u = new URL(printerUri);
  const secure = u.protocol === "ipps:" || u.protocol === "https:";
  const port = u.port || "631";
  return `${secure ? "https" : "http"}://${u.hostname}:${port}${u.pathname}${u.search}`;
}

async function send(printerUri, requestBuffer, { timeoutMs = 20000 } = {}) {
  const url = httpUrlFor(printerUri);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/ipp", "Content-Length": String(requestBuffer.length) },
      body: requestBuffer,
      signal: ac.signal,
    });
    const body = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      throw new Error(`printer returned HTTP ${res.status} for ${url}`);
    }
    return decodeResponse(body);
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`printer at ${url} did not respond within ${timeoutMs}ms`);
    // Node's fetch reports every connection-level problem as a bare "fetch
    // failed" with the real reason buried in .cause. Unwrapped, a typo'd
    // LABEL_PRINTER_URI is indistinguishable from a printer that is asleep.
    const cause = e.cause?.code || e.cause?.message;
    if (/fetch failed/i.test(e.message || "")) {
      throw new Error(`could not reach printer at ${url}${cause ? ` (${cause})` : ""}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const REQUESTED = [
  "printer-name",
  "printer-make-and-model",
  "printer-state",
  "printer-state-reasons",
  "printer-is-accepting-jobs",
  "document-format-supported",
  "document-format-default",
  "media-supported",
  "media-default",
  "printer-resolution-supported",
  "printer-resolution-default",
  "copies-supported",
  "ipp-versions-supported",
  "operations-supported",
];

const PRINTER_STATES = { 3: "idle", 4: "processing", 5: "stopped" };

export async function getPrinterAttributes(printerUri, opts) {
  const { buffer } = encodeRequest({
    operation: OPERATION.getPrinterAttributes,
    printerUri,
    operationAttrs: [
      attr(TAG.nameWithoutLanguage, "requesting-user-name", process.env.IPP_USER || "home-dashboard"),
      setOf(TAG.keyword, "requested-attributes", REQUESTED),
    ],
  });
  const res = await send(printerUri, buffer, opts);
  if (!res.ok) throw new Error(`Get-Printer-Attributes failed: ${res.statusText}`);
  const p = res.groups.printer;
  const asArray = (v) => (v === undefined || v === null ? [] : [].concat(v));
  return {
    uri: printerUri,
    name: p["printer-name"] || null,
    makeAndModel: p["printer-make-and-model"] || null,
    state: PRINTER_STATES[p["printer-state"]] || p["printer-state"] || null,
    stateReasons: asArray(p["printer-state-reasons"]),
    acceptingJobs: p["printer-is-accepting-jobs"] ?? null,
    formats: asArray(p["document-format-supported"]),
    defaultFormat: p["document-format-default"] || null,
    media: asArray(p["media-supported"]),
    defaultMedia: p["media-default"] || null,
    resolutions: asArray(p["printer-resolution-supported"]),
    copiesSupported: p["copies-supported"] || null,
    ippVersions: asArray(p["ipp-versions-supported"]),
    raw: p,
  };
}

// Formats this dashboard can actually produce, best first. The label pipeline
// already emits a 4x6 PDF (jsPDF, client-side) and the PNG it was built from,
// so there is nothing to gain from claiming raster support we cannot encode -
// a printer that only speaks PWG Raster or Apple URF is reported as such
// instead of being sent a document it will reject or, worse, print as garbage.
export const PRODUCIBLE_FORMATS = ["application/pdf", "image/png", "image/jpeg"];

export function chooseFormat(printerFormats, available) {
  const supported = new Set((printerFormats || []).map((f) => String(f).toLowerCase()));
  // application/octet-stream means "sniff it yourself", which every AirPrint
  // printer advertises; it is a usable fallback but never a first choice.
  for (const fmt of PRODUCIBLE_FORMATS) {
    if (available.includes(fmt) && supported.has(fmt)) return { format: fmt, viaOctetStream: false };
  }
  if (supported.has("application/octet-stream")) {
    const fmt = PRODUCIBLE_FORMATS.find((f) => available.includes(f));
    if (fmt) return { format: fmt, viaOctetStream: true };
  }
  return null;
}

export async function printJob(printerUri, { data, format, jobName = "label", copies = 1, media }, opts) {
  const jobAttrs = [];
  if (copies && copies > 1) jobAttrs.push(attr(TAG.integer, "copies", copies));
  if (media) jobAttrs.push(attr(TAG.keyword, "media", media));

  const { buffer } = encodeRequest({
    operation: OPERATION.printJob,
    printerUri,
    operationAttrs: [
      attr(TAG.nameWithoutLanguage, "requesting-user-name", process.env.IPP_USER || "home-dashboard"),
      attr(TAG.nameWithoutLanguage, "job-name", jobName),
      attr(TAG.mimeMediaType, "document-format", format),
    ],
    jobAttrs,
    data,
  });
  const res = await send(printerUri, buffer, opts);
  if (!res.ok) {
    throw new Error(`Print-Job rejected by printer: ${res.statusText}`);
  }
  return {
    jobId: res.groups.job["job-id"] ?? null,
    jobState: res.groups.job["job-state"] ?? null,
    jobUri: res.groups.job["job-uri"] ?? null,
    statusText: res.statusText,
  };
}

// Common IPP paths, tried in order when only a hostname is known. There is no
// standard path - /ipp/print is the IPP Everywhere convention, the rest cover
// CUPS queues and older vendor firmware.
export const COMMON_PATHS = ["/ipp/print", "/ipp/printer", "/ipp", "/printers/label", "/"];

// `host` may carry an explicit port ("printer.local:6310"). Printers almost
// always sit on 631, but a port-forwarded or containerised one does not, and
// hardcoding 631 made the probe untestable as well as less useful.
export async function probeHost(host, { timeoutMs = 4000 } = {}) {
  const [hostname, port] = String(host).split(":");
  const results = [];
  for (const p of COMMON_PATHS) {
    const uri = `ipp://${hostname}:${port || 631}${p}`;
    try {
      const info = await getPrinterAttributes(uri, { timeoutMs });
      results.push({ uri, ok: true, name: info.name, makeAndModel: info.makeAndModel, formats: info.formats, state: info.state });
    } catch (e) {
      results.push({ uri, ok: false, error: e.message });
    }
  }
  return results;
}

export const _internals = { attr, setOf, TAG, DELIM };
