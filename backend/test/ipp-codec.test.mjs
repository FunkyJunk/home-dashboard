// IPP codec conformance.
//
// src/ipp.js is hand-rolled, so it is validated against the `ipp` npm package
// (a devDependency) in BOTH directions - my encoder decoded by theirs, their
// serializer decoded by mine. Testing an encoder against its own decoder would
// let a shared misunderstanding pass, which is exactly the failure mode that
// matters for a binary wire format.
//
// Where the oracle is itself wrong, the spec wins and the case is built by hand
// against RFC 8010. Two known oracle defects are handled that way below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ipp = require("ipp");

const { encodeRequest, decodeResponse, OPERATION, chooseFormat, httpUrlFor, statusName, PRODUCIBLE_FORMATS, _internals } =
  await import("../src/ipp.js");
const { attr, setOf, TAG } = _internals;

const PRINTER_URI = "ipp://192.168.1.50:631/ipp/print";

test("Get-Printer-Attributes is valid on the wire", () => {
  const { buffer } = encodeRequest({
    operation: OPERATION.getPrinterAttributes,
    printerUri: PRINTER_URI,
    operationAttrs: [
      attr(TAG.nameWithoutLanguage, "requesting-user-name", "home-dashboard"),
      setOf(TAG.keyword, "requested-attributes", ["printer-name", "document-format-supported", "printer-state"]),
    ],
  });
  const p = ipp.parse(buffer);
  assert.equal(p.operation, "Get-Printer-Attributes");
  assert.equal(p.version, "2.0");
  assert.equal(p["operation-attributes-tag"]["printer-uri"], PRINTER_URI);
  assert.equal(p["operation-attributes-tag"]["requesting-user-name"], "home-dashboard");
  assert.deepEqual(p["operation-attributes-tag"]["requested-attributes"], [
    "printer-name",
    "document-format-supported",
    "printer-state",
  ]);
});

test("the mandated attribute order is honoured", () => {
  // attributes-charset MUST be first and attributes-natural-language second.
  // Printers reject the whole request otherwise, surfacing only as a generic
  // HTTP 400 with nothing to go on.
  const { buffer } = encodeRequest({ operation: OPERATION.getPrinterAttributes, printerUri: PRINTER_URI });
  const opAttrs = ipp.parse(buffer)["operation-attributes-tag"];
  const order = Object.keys(opAttrs);
  assert.equal(order[0], "attributes-charset");
  assert.equal(order[1], "attributes-natural-language");
  assert.equal(opAttrs["attributes-charset"], "utf-8");
  assert.equal(opAttrs["attributes-natural-language"], "en-us");
});

test("Print-Job carries its operation and job attributes", () => {
  const { buffer } = encodeRequest({
    operation: OPERATION.printJob,
    printerUri: PRINTER_URI,
    operationAttrs: [
      attr(TAG.nameWithoutLanguage, "job-name", "label-4x6"),
      attr(TAG.mimeMediaType, "document-format", "application/pdf"),
    ],
    jobAttrs: [attr(TAG.integer, "copies", 2), attr(TAG.keyword, "media", "na_index-4x6_4x6in")],
    data: Buffer.from("%PDF-1.4 body"),
  });
  const p = ipp.parse(buffer);
  assert.equal(p.operation, "Print-Job");
  assert.equal(p["operation-attributes-tag"]["document-format"], "application/pdf");
  assert.equal(p["operation-attributes-tag"]["job-name"], "label-4x6");
  assert.equal(p["job-attributes-tag"]["copies"], 2, "integer, not a string");
  assert.equal(p["job-attributes-tag"]["media"], "na_index-4x6_4x6in");
});

test("document bytes survive encoding exactly", () => {
  // A PDF is binary and one altered byte can make a printer spit blank stock.
  // Asserted against the raw request buffer, NOT through the oracle: ipp.parse
  // decodes document data as UTF-8 and mangles high bytes (0xff 0x80 comes back
  // as 0xfd 0xfd), which would hide a real truncation here.
  const binary = Buffer.concat([
    Buffer.from("%PDF-1.3\n"),
    Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x0a, 0xc3, 0x28]),
    Buffer.from("\n%%EOF\n"),
  ]);
  const { buffer } = encodeRequest({
    operation: OPERATION.printJob,
    printerUri: PRINTER_URI,
    operationAttrs: [attr(TAG.mimeMediaType, "document-format", "application/pdf")],
    data: binary,
  });
  const onWire = buffer.subarray(buffer.length - binary.length);
  assert.ok(onWire.equals(binary), "document is byte-exact on the wire");
  assert.equal(
    buffer.readUInt8(buffer.length - binary.length - 1),
    0x03,
    "end-of-attributes tag immediately precedes the document"
  );
});

test("reads a realistic printer response", () => {
  const resp = ipp.serialize({
    version: "2.0",
    statusCode: "successful-ok",
    id: 42,
    "operation-attributes-tag": { "attributes-charset": "utf-8", "attributes-natural-language": "en-us" },
    "printer-attributes-tag": {
      "printer-name": "Brother-QL-1110NWB",
      "printer-state": "idle",
      "printer-is-accepting-jobs": true,
      "document-format-supported": ["application/octet-stream", "image/urf", "application/pdf"],
      "media-default": "na_index-4x6_4x6in",
    },
  });
  const d = decodeResponse(resp);
  assert.equal(d.ok, true);
  assert.equal(d.statusText, "successful-ok");
  assert.equal(d.requestId, 42);
  assert.equal(d.groups.printer["printer-name"], "Brother-QL-1110NWB");
  assert.equal(d.groups.printer["printer-state"], 3, "enum decoded as its integer");
  assert.equal(d.groups.printer["printer-is-accepting-jobs"], true, "boolean decoded");
  assert.deepEqual(d.groups.printer["document-format-supported"], [
    "application/octet-stream",
    "image/urf",
    "application/pdf",
  ], "1setOf promoted to an array");
});

test("reads a job response and an error response", () => {
  const jobResp = ipp.serialize({
    version: "2.0",
    statusCode: "successful-ok",
    id: 7,
    "operation-attributes-tag": { "attributes-charset": "utf-8", "attributes-natural-language": "en-us" },
    "job-attributes-tag": { "job-id": 314, "job-state": "pending", "job-uri": "ipp://p/jobs/314" },
  });
  const dj = decodeResponse(jobResp);
  assert.equal(dj.groups.job["job-id"], 314);
  assert.equal(dj.groups.job["job-uri"], "ipp://p/jobs/314");

  const errResp = ipp.serialize({
    version: "2.0",
    statusCode: "client-error-document-format-not-supported",
    id: 8,
    "operation-attributes-tag": { "attributes-charset": "utf-8", "attributes-natural-language": "en-us" },
  });
  const de = decodeResponse(errResp);
  assert.equal(de.ok, false);
  assert.equal(de.statusText, "client-error-document-format-not-supported");
});

test("decodes rangeOfInteger per RFC 8010", () => {
  // The oracle cannot serialize this type - it emits 8 zero bytes whatever you
  // pass and its own parser reads [0,0] back - so the bytes are built by hand:
  // tag 0x33, value is signed lower then signed upper.
  const name = Buffer.from("copies-supported");
  const value = Buffer.alloc(8);
  value.writeInt32BE(1, 0);
  value.writeInt32BE(99, 4);
  const attrBuf = Buffer.alloc(3 + name.length + 2);
  attrBuf.writeUInt8(0x33, 0);
  attrBuf.writeUInt16BE(name.length, 1);
  name.copy(attrBuf, 3);
  attrBuf.writeUInt16BE(value.length, 3 + name.length);

  const header = Buffer.alloc(8);
  header.writeUInt8(0x02, 0);
  header.writeUInt16BE(0x0000, 2);
  header.writeInt32BE(1, 4);

  const d = decodeResponse(Buffer.concat([header, Buffer.from([0x04]), attrBuf, value, Buffer.from([0x03])]));
  assert.deepEqual(d.groups.printer["copies-supported"], { lower: 1, upper: 99 });
});

test("a truncated response is rejected rather than mis-read", () => {
  assert.throws(() => decodeResponse(Buffer.from([0x02, 0x00, 0x00])), /truncated/);
});

test("unknown status codes are still named", () => {
  assert.equal(statusName(0x0000), "successful-ok");
  assert.equal(statusName(0x040a), "client-error-document-format-not-supported");
  assert.match(statusName(0x0fff), /^status-0x0fff$/);
});

test("format negotiation prefers PDF and refuses raster", () => {
  assert.deepEqual(chooseFormat(["image/urf", "application/pdf", "image/jpeg"], PRODUCIBLE_FORMATS), {
    format: "application/pdf",
    viaOctetStream: false,
  });
  assert.deepEqual(chooseFormat(["image/png", "image/urf"], PRODUCIBLE_FORMATS), {
    format: "image/png",
    viaOctetStream: false,
  });
  // octet-stream is a fallback, never a first choice.
  assert.deepEqual(chooseFormat(["application/octet-stream", "image/urf"], ["application/pdf"]), {
    format: "application/pdf",
    viaOctetStream: true,
  });
  // Nothing we can produce: must be refused, not sent hopefully.
  assert.equal(chooseFormat(["image/urf", "image/pwg-raster"], PRODUCIBLE_FORMATS), null);
  assert.equal(chooseFormat([], PRODUCIBLE_FORMATS), null);
});

test("ipp:// URIs map onto HTTP transport", () => {
  assert.equal(httpUrlFor("ipp://p.local/ipp/print"), "http://p.local:631/ipp/print");
  assert.equal(httpUrlFor("ipp://192.168.1.9:631/ipp/print"), "http://192.168.1.9:631/ipp/print");
  assert.equal(httpUrlFor("ipps://p.local:631/ipp/print"), "https://p.local:631/ipp/print");
  assert.equal(httpUrlFor("ipp://p.local:6310/ipp/print"), "http://p.local:6310/ipp/print");
});
