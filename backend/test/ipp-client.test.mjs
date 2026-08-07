// IPP client against mock printers, covering the four profiles that behave
// differently. The refusal cases matter most: sending a PDF to a raster-only
// printer wastes label stock silently, so "no job was sent" is asserted rather
// than assumed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "./helpers/env.mjs";
import { startMockPrinters } from "./helpers/mock-printer.mjs";

const { getPrinterAttributes, printJob, chooseFormat, probeHost, PRODUCIBLE_FORMATS } = await import("../src/ipp.js");

// A small but genuinely-structured PDF, so what crosses the wire looks real.
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

let printers;
before(async () => {
  printers = await startMockPrinters();
});
after(async () => {
  await printers.closeAll();
});

test("reads a PDF-capable printer's attributes", async () => {
  const info = await getPrinterAttributes(printers.pdf.uri);
  assert.equal(info.name, "Label-Printer-PDF");
  assert.equal(info.makeAndModel, "Mock QL-1110NWB");
  assert.equal(info.state, "idle");
  assert.equal(info.acceptingJobs, true);
  assert.deepEqual(info.formats, ["application/octet-stream", "application/pdf", "image/jpeg", "image/urf"]);
  assert.equal(info.defaultMedia, "na_index-4x6_4x6in");
});

test("sends a PDF and the printer receives it intact", async () => {
  const info = await getPrinterAttributes(printers.pdf.uri);
  const choice = chooseFormat(info.formats, PRODUCIBLE_FORMATS);
  assert.deepEqual(choice, { format: "application/pdf", viaOctetStream: false });

  const job = await printJob(printers.pdf.uri, {
    data: PDF,
    format: choice.format,
    jobName: "label-Smith",
    media: "na_index-4x6_4x6in",
  });
  assert.equal(typeof job.jobId, "number");
  assert.equal(job.statusText, "successful-ok");

  const received = printers.pdf.jobs.at(-1);
  assert.equal(received.format, "application/pdf");
  assert.equal(received.bytes, PDF.length);
  assert.equal(received.jobName, "label-Smith");
  assert.equal(received.media, "na_index-4x6_4x6in");
  assert.equal(received.user, "home-dashboard");
  assert.equal(printers.pdf.documentHead(), "%PDF-1.4", "a real PDF arrived, not a mangled one");
});

test("copies travels as an integer", async () => {
  await printJob(printers.pdf.uri, { data: PDF, format: "application/pdf", jobName: "three-up", copies: 3 });
  assert.equal(printers.pdf.jobs.at(-1).copies, 3);
});

test("a raster-only printer is refused, never fed a PDF", async () => {
  const info = await getPrinterAttributes(printers.raster.uri);
  assert.deepEqual(info.formats, ["image/urf", "image/pwg-raster"]);
  assert.equal(chooseFormat(info.formats, PRODUCIBLE_FORMATS), null, "negotiation refuses up front");

  // And if a PDF were forced through anyway, the printer's own rejection has to
  // surface as a readable error rather than a silent success.
  await assert.rejects(
    () => printJob(printers.raster.uri, { data: PDF, format: "application/pdf" }),
    /document-format-not-supported/
  );
  assert.equal(printers.raster.jobs.length, 0, "no label stock was wasted");
});

test("an octet-stream-only printer gets the PDF under that type", async () => {
  const info = await getPrinterAttributes(printers.sniffer.uri);
  assert.deepEqual(chooseFormat(info.formats, PRODUCIBLE_FORMATS), {
    format: "application/pdf",
    viaOctetStream: true,
  });
  await printJob(printers.sniffer.uri, { data: PDF, format: "application/octet-stream", jobName: "sniffed" });
  assert.equal(printers.sniffer.jobs.at(-1).format, "application/octet-stream");
  assert.equal(printers.sniffer.documentHead(), "%PDF-1.4", "still a real PDF underneath");
});

test("an out-of-paper printer says why", async () => {
  const info = await getPrinterAttributes(printers.empty.uri);
  assert.equal(info.acceptingJobs, false);
  assert.equal(info.state, "stopped");
  assert.deepEqual(info.stateReasons, ["media-empty-error"]);
});

test("an unreachable printer names the reason, not just 'fetch failed'", async () => {
  // Node's fetch reports every connection problem as a bare "fetch failed" with
  // the cause buried, which makes a typo'd URI indistinguishable from a printer
  // that is asleep.
  //
  // The port is obtained by binding and releasing one, so it is genuinely
  // closed. A hardcoded low port is not equivalent: Node rejects port 1 as
  // "bad port" before it ever connects, so that would assert a different path.
  const net = await import("node:net");
  const closedPort = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

  await assert.rejects(
    () => getPrinterAttributes(`ipp://127.0.0.1:${closedPort}/ipp/print`, { timeoutMs: 2000 }),
    (e) => {
      assert.match(e.message, new RegExp(`could not reach printer at http://127\\.0\\.0\\.1:${closedPort}/ipp/print`));
      assert.match(e.message, /ECONNREFUSED/);
      return true;
    }
  );
});

test("a printer that accepts the connection but never answers times out", async () => {
  // A thermal printer waking from sleep can hold a socket open, so the timeout
  // has to be the client's own rather than waiting on the OS.
  const net = await import("node:net");
  const sockets = [];
  const silent = net.createServer((s) => sockets.push(s)); // accepts, says nothing
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  const { port } = silent.address();
  try {
    await assert.rejects(
      () => getPrinterAttributes(`ipp://127.0.0.1:${port}/ipp/print`, { timeoutMs: 300 }),
      /did not respond within 300ms/
    );
  } finally {
    // server.close() waits for open connections to end, and the aborted fetch
    // leaves one behind - without destroying it here the whole run hangs.
    for (const s of sockets) s.destroy();
    await new Promise((r) => silent.close(r));
  }
});

test("probing finds the one path that answers", async () => {
  const results = await probeHost(printers.pdf.host, { timeoutMs: 2000 });
  const answered = results.filter((r) => r.ok);
  assert.equal(answered.length, 1, "only the conventional path responds");
  assert.equal(answered[0].uri, `ipp://${printers.pdf.host}/ipp/print`);
  assert.equal(answered[0].makeAndModel, "Mock QL-1110NWB");
  assert.ok(results.length > 1, "the other candidate paths are reported as failures, not dropped");
  assert.ok(results.filter((r) => !r.ok).every((r) => r.error), "each failure carries a reason");
});

test("probing accepts an explicit port", async () => {
  // Printers almost always sit on 631, but hardcoding it made the probe both
  // untestable and useless against a forwarded or containerised printer.
  const results = await probeHost(printers.sniffer.host, { timeoutMs: 2000 });
  assert.ok(results.some((r) => r.ok && r.uri.includes(`:${printers.sniffer.port}/`)));
});
