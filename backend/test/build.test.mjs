// Build provenance and the log buffer behind Settings > Build.
//
// The point of this feature is answering "is what I pushed actually running?",
// so the tests care most about the two ways it could lie: reporting build
// metadata that isn't really there, and a log buffer that grows without bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers/env.mjs";

test("reports no CI metadata when the image was not built by CI", async () => {
  // Deliberately fresh imports per case: build.js reads env at call time for
  // most fields, but builtByCi is the flag people will trust, so it is checked
  // in both states.
  for (const k of ["BUILD_COMMIT", "BUILD_REF", "BUILD_TIME", "BUILD_RUN_NUMBER", "BUILD_RUN_URL"]) {
    delete process.env[k];
  }
  const { buildInfo } = await import("../src/build.js");
  const info = buildInfo();
  assert.equal(info.builtByCi, false, "absent metadata must not read as a real build");
  assert.equal(info.commit, null);
  assert.equal(info.commitShort, null);
  assert.equal(info.builtAt, null);
});

test("reports CI metadata when the image was built by CI", async () => {
  process.env.BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";
  process.env.BUILD_REF = "main";
  process.env.BUILD_TIME = "2026-08-07T20:00:00Z";
  process.env.BUILD_RUN_NUMBER = "123";
  process.env.BUILD_RUN_URL = "https://github.com/x/y/actions/runs/456";
  const { buildInfo } = await import("../src/build.js");
  const info = buildInfo();
  assert.equal(info.builtByCi, true);
  assert.equal(info.commitShort, "0123456", "short sha is what the UI shows");
  assert.equal(info.ref, "main");
  assert.equal(info.builtAt, "2026-08-07T20:00:00Z");
  assert.equal(info.ciRunNumber, "123");
  assert.equal(info.ciRunUrl, "https://github.com/x/y/actions/runs/456");
});

test("runtime block reports the things that silently break behaviour", async () => {
  const { buildInfo } = await import("../src/build.js");
  const rt = buildInfo().runtime;
  assert.ok(rt.startedAt, "startedAt");
  assert.equal(typeof rt.uptimeSeconds, "number");
  assert.match(rt.node, /^v\d+\./);
  // Timezone is here because it decides when reminders fire and was wrong once.
  assert.equal(rt.timezone, "America/New_York", "pinned by test/helpers/env.mjs");
  assert.equal(rt.tzEnvSet, true);
  assert.equal(typeof rt.logCapacity, "number");
});

test("the log buffer captures console output without swallowing it", async () => {
  const { captureConsole, createBuildRouter } = await import("../src/build.js");

  // The spy goes on FIRST and is never removed. captureConsole wraps whatever
  // console.log is at the time it runs, so restoring the original afterwards
  // would strip the capture wrapper back off and silently disable the buffer
  // for every later test in this file.
  const seen = [];
  const realLog = console.log;
  console.log = (...a) => {
    seen.push(a.join(" "));
    realLog(...a);
  };
  captureConsole();

  console.log("captured-marker-1");
  console.warn("warn-marker");
  console.error("error-marker");

  assert.deepEqual(seen, ["captured-marker-1"], "the wrapped console still passes the line through");

  // Read it back through the router the UI actually calls.
  const router = createBuildRouter();
  const lines = await getJson(router, "/log", { limit: "50" });
  const texts = lines.lines.map((l) => l.text);
  assert.ok(texts.includes("captured-marker-1"), "log captured");
  assert.ok(texts.includes("warn-marker"));
  assert.ok(texts.includes("error-marker"));
  const levels = lines.lines.filter((l) => l.text.endsWith("-marker")).map((l) => l.level);
  assert.deepEqual(levels, ["warn", "error"], "level is recorded, not just the text");

  const warnOnly = await getJson(router, "/log", { limit: "50", level: "warn" });
  assert.ok(
    warnOnly.lines.every((l) => l.level === "warn" || l.level === "error"),
    "level=warn means warn-and-worse"
  );
  assert.ok(
    warnOnly.lines.some((l) => l.level === "error"),
    "errors are included in the warn filter"
  );

  const errorOnly = await getJson(router, "/log", { limit: "50", level: "error" });
  assert.ok(errorOnly.lines.every((l) => l.level === "error"));
});

test("the log buffer is bounded", async () => {
  const { buildInfo, createBuildRouter } = await import("../src/build.js");
  const cap = buildInfo().runtime.logCapacity;
  for (let i = 0; i < cap + 50; i++) console.log(`flood-${i}`);
  const after = buildInfo().runtime;
  assert.ok(after.logLinesBuffered <= cap, `buffered ${after.logLinesBuffered} must not exceed ${cap}`);

  // Oldest are evicted, newest kept - a buffer that dropped new lines instead
  // would be worse than useless when chasing something that just happened.
  const out = await getJson(createBuildRouter(), "/log", { limit: String(cap) });
  const texts = out.lines.map((l) => l.text);
  assert.ok(texts.includes(`flood-${cap + 49}`), "newest line retained");
  assert.ok(!texts.includes("flood-0"), "oldest line evicted");
});

test("a huge log line is truncated rather than eating the buffer", async () => {
  const { createBuildRouter } = await import("../src/build.js");
  console.log("X".repeat(9000));
  const out = await getJson(createBuildRouter(), "/log", { limit: "5" });
  const longest = Math.max(...out.lines.map((l) => l.text.length));
  assert.ok(longest <= 2000, `longest line ${longest} should be capped at 2000`);
});

// Minimal express-router driver: builds a request/response pair good enough for
// these handlers, so the tests don't need a listening server.
function getJson(router, path, query = {}) {
  return new Promise((resolve, reject) => {
    const req = { method: "GET", url: path, query, params: {}, headers: {} };
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(body) {
        resolve(body);
      },
    };
    router.handle(req, res, (err) => reject(err || new Error(`no route for ${path}`)));
  });
}
