// IPP printer stand-in. Requests are decoded and responses built with the `ipp`
// npm package (a devDependency) rather than with src/ipp.js, so the dashboard's
// hand-rolled codec is always measured against an independent implementation
// instead of against itself.
//
// Four profiles cover the cases that behave differently:
//   pdf     - advertises application/pdf: the happy path
//   raster  - image/urf + image/pwg-raster only: must be refused, never fed
//   sniffer - application/octet-stream only: PDF sent under that type
//   empty   - out of paper: printer-is-accepting-jobs false
//
// Only /ipp/print answers, so path probing is a real test rather than a
// formality. Note ipp.parse returns document data as a string, not a Buffer,
// and mangles high bytes - byte-exactness is asserted against the raw request
// buffer in ipp-codec.test.mjs instead of through this mock.
import http from "http";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ipp = require("ipp");

export const PROFILES = {
  pdf: {
    name: "Label-Printer-PDF",
    model: "Mock QL-1110NWB",
    formats: ["application/octet-stream", "application/pdf", "image/jpeg", "image/urf"],
    accepting: true,
  },
  raster: {
    name: "Label-Printer-Raster",
    model: "Mock AirPrint Raster",
    formats: ["image/urf", "image/pwg-raster"],
    accepting: true,
  },
  sniffer: {
    name: "Label-Printer-Sniffer",
    model: "Mock Octet Only",
    formats: ["application/octet-stream"],
    accepting: true,
  },
  empty: {
    name: "Label-Printer-Empty",
    model: "Mock Out Of Paper",
    formats: ["application/pdf"],
    accepting: false,
  },
};

function startOne(profile) {
  const jobs = [];
  let lastDocument = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url !== "/ipp/print") {
        res.writeHead(404);
        return res.end();
      }

      let parsed;
      try {
        parsed = ipp.parse(Buffer.concat(chunks));
      } catch {
        res.writeHead(400);
        return res.end();
      }

      const id = parsed.id;
      const opAttrs = parsed["operation-attributes-tag"] || {};
      const jobAttrs = parsed["job-attributes-tag"] || {};
      const base = {
        version: "2.0",
        id,
        "operation-attributes-tag": { "attributes-charset": "utf-8", "attributes-natural-language": "en-us" },
      };
      let out;

      if (parsed.operation === "Get-Printer-Attributes") {
        out = ipp.serialize({
          ...base,
          statusCode: "successful-ok",
          "printer-attributes-tag": {
            "printer-name": profile.name,
            "printer-make-and-model": profile.model,
            "printer-state": profile.accepting ? "idle" : "stopped",
            "printer-state-reasons": profile.accepting ? ["none"] : ["media-empty-error"],
            "printer-is-accepting-jobs": profile.accepting,
            "document-format-supported": profile.formats,
            "document-format-default": profile.formats[0],
            "media-supported": ["na_index-4x6_4x6in"],
            "media-default": "na_index-4x6_4x6in",
          },
        });
      } else if (parsed.operation === "Print-Job") {
        const fmt = opAttrs["document-format"];
        if (!profile.formats.includes(fmt)) {
          out = ipp.serialize({ ...base, statusCode: "client-error-document-format-not-supported" });
        } else {
          lastDocument = Buffer.isBuffer(parsed.data)
            ? parsed.data
            : Buffer.from(parsed.data || "", "latin1");
          const jobId = 100 + jobs.length;
          jobs.push({
            jobId,
            format: fmt,
            bytes: lastDocument.length,
            jobName: opAttrs["job-name"],
            user: opAttrs["requesting-user-name"],
            copies: jobAttrs["copies"],
            media: jobAttrs["media"],
          });
          out = ipp.serialize({
            ...base,
            statusCode: "successful-ok",
            "job-attributes-tag": { "job-id": jobId, "job-state": "pending", "job-uri": `ipp://mock/jobs/${jobId}` },
          });
        }
      } else {
        out = ipp.serialize({ ...base, statusCode: "server-error-operation-not-supported" });
      }

      res.writeHead(200, { "Content-Type": "application/ipp", "Content-Length": out.length });
      res.end(out);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        uri: `ipp://127.0.0.1:${port}/ipp/print`,
        host: `127.0.0.1:${port}`,
        jobs,
        documentHead: () => (lastDocument ? lastDocument.subarray(0, 8).toString("latin1") : null),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

export async function startMockPrinters() {
  const entries = await Promise.all(
    Object.entries(PROFILES).map(async ([key, profile]) => [key, await startOne(profile)])
  );
  const printers = Object.fromEntries(entries);
  return {
    ...printers,
    closeAll: () => Promise.all(Object.values(printers).map((p) => p.close())),
  };
}
