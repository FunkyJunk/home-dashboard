import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

// ---------------------------------------------------------------------------
// Passkey (WebAuthn) authentication for the whole dashboard.
//
// This exists because every /api/* route was previously unauthenticated -
// including /api/ha/control/* which operates lights, blinds and media players,
// and /api/receipts/* which exposes everything derived from Gmail. That was
// tolerable on a LAN-only box and is not once the dashboard is reachable from
// the internet through a Cloudflare tunnel.
//
// WebAuthn rather than a password because the private key never leaves the
// device, there is no shared secret to phish or leak, and Face ID / Windows
// Hello satisfy it natively. userVerification is REQUIRED, so a touch alone is
// not enough - the device must actually verify the person.
//
// SELF-ENABLING, deliberately: with no credentials registered the middleware
// lets everything through exactly as before. Enforcement begins the moment the
// first passkey is registered. Without that property there is no way to
// bootstrap - you cannot register a passkey through a gate that already
// requires one - and a deploy would lock the user out of their own dashboard.
// It also gives a break-glass: deleting the credential rows on the NAS
// re-opens the dashboard for re-registration.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.RECEIPTS_DATA_DIR || "/app/data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "auth.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,              -- base64url credential ID
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    label TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,      -- sha256 of the cookie value, never the value itself
    credential_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

// RP ID must be a DOMAIN - an IP address is not a valid Relying Party ID, which
// is why this cannot run on http://192.168.1.97. Set both from the environment
// so the hostname is never hardcoded.
const RP_ID = process.env.WEBAUTHN_RP_ID || "";
const RP_NAME = process.env.WEBAUTHN_RP_NAME || "Home Dashboard";
const ORIGIN = process.env.WEBAUTHN_ORIGIN || (RP_ID ? `https://${RP_ID}` : "");
const SESSION_COOKIE = "dash_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days; re-auth is one Face ID prompt
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const stmts = {
  allCreds: db.prepare("SELECT * FROM credentials"),
  credById: db.prepare("SELECT * FROM credentials WHERE id = ?"),
  insertCred: db.prepare(
    "INSERT INTO credentials (id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ),
  bumpCounter: db.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?"),
  deleteCred: db.prepare("DELETE FROM credentials WHERE id = ?"),
  countCreds: db.prepare("SELECT COUNT(*) AS n FROM credentials"),
  insertSession: db.prepare(
    "INSERT INTO sessions (token_hash, credential_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ),
  sessionByHash: db.prepare("SELECT * FROM sessions WHERE token_hash = ?"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  pruneSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
  deleteSessionsForCred: db.prepare("DELETE FROM sessions WHERE credential_id = ?"),
};

export function credentialCount() {
  return stmts.countCreds.get().n;
}
export function authIsEnforced() {
  return credentialCount() > 0;
}

// Sessions are stored as a hash, so a database copy yields no usable cookies.
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Challenges are held in memory rather than the database: they are single-use
// and short-lived, and losing them on restart is harmless (the ceremony just
// restarts). Keyed by a random id handed to the client.
const pendingChallenges = new Map();
function putChallenge(kind, challenge) {
  const id = crypto.randomBytes(16).toString("base64url");
  pendingChallenges.set(id, { kind, challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  for (const [k, v] of pendingChallenges) if (v.expiresAt < Date.now()) pendingChallenges.delete(k);
  return id;
}
function takeChallenge(id, kind) {
  const entry = pendingChallenges.get(id);
  if (!entry) return null;
  pendingChallenges.delete(id); // single use, always
  if (entry.kind !== kind || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

function createSession(credentialId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  stmts.pruneSessions.run(now.toISOString());
  stmts.insertSession.run(
    sha256(token),
    credentialId,
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString()
  );
  return token;
}

export function sessionIsValid(token) {
  if (!token) return false;
  const row = stmts.sessionByHash.get(sha256(token));
  if (!row) return false;
  if (new Date(row.expires_at) < new Date()) {
    stmts.deleteSession.run(row.token_hash);
    return false;
  }
  return true;
}

function cookieFrom(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token) {
  // Secure + HttpOnly + SameSite=Strict: not readable from JS, never sent over
  // plaintext, and not attached to cross-site requests, which is what stops a
  // malicious page from driving the API with the user's own session.
  res.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`
  );
}
function clearSessionCookie(res) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}

// Simple fixed-window limiter on the auth endpoints only. Enough to make
// online guessing pointless without pulling in a dependency; WebAuthn is not
// guessable anyway, so this is really about not letting someone burn CPU.
const attempts = new Map();
function rateLimited(req, limit = 20, windowMs = 60 * 1000) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || rec.resetAt < now) {
    attempts.set(key, { n: 1, resetAt: now + windowMs });
    return false;
  }
  rec.n++;
  return rec.n > limit;
}

// Paths that must stay reachable without a session, or login is impossible.
const OPEN_PATHS = new Set([
  "/api/auth/status",
  "/api/auth/login/options",
  "/api/auth/login/verify",
  "/api/auth/register/options",
  "/api/auth/register/verify",
]);

export function requireAuth(req, res, next) {
  if (!authIsEnforced()) return next();          // no passkeys yet: behave as before
  if (OPEN_PATHS.has(req.path)) return next();
  if (sessionIsValid(cookieFrom(req, SESSION_COOKIE))) return next();
  res.status(401).json({ error: "authentication required" });
}

export function createAuthRouter() {
  const router = express.Router();

  // Lets the frontend decide what to show without leaking anything useful.
  router.get("/status", (req, res) => {
    res.json({
      enforced: authIsEnforced(),
      authenticated: !authIsEnforced() || sessionIsValid(cookieFrom(req, SESSION_COOKIE)),
      configured: !!(RP_ID && ORIGIN),
      rpId: RP_ID || null,
      credentialCount: credentialCount(),
    });
  });

  function configGuard(res) {
    if (RP_ID && ORIGIN) return false;
    res.status(503).json({
      error: "WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN are not set - passkeys need a real hostname, not an IP",
    });
    return true;
  }

  // --- registration -------------------------------------------------------
  // Registering a NEW passkey once one already exists requires a valid
  // session, so an attacker who reaches the API cannot simply enrol their own
  // device. The very first registration is necessarily open - that is the
  // bootstrap, and it is why this should be done before the tunnel is public.
  router.post("/register/options", async (req, res) => {
    if (configGuard(res)) return;
    if (authIsEnforced() && !sessionIsValid(cookieFrom(req, SESSION_COOKIE))) {
      return res.status(401).json({ error: "sign in before adding another passkey" });
    }
    const existing = stmts.allCreds.all();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: process.env.WEBAUTHN_USER_NAME || "dashboard",
      userDisplayName: process.env.WEBAUTHN_USER_NAME || "Dashboard",
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      authenticatorSelection: {
        residentKey: "required",       // discoverable, so login needs no username
        userVerification: "required",  // forces Face ID / Hello, not just presence
        // Left unset by default so the browser offers everything it can (phone
        // via hybrid, security key, built-in). When the caller asks for
        // "platform", pin it to the device's own authenticator instead: on
        // Windows, Edge otherwise offered only phone and security key and
        // silently omitted Hello, with no way to tell why. Asking explicitly
        // means Hello is either used or reports a real error.
        ...(req.body?.platform ? { authenticatorAttachment: "platform" } : {}),
      },
    });
    const challengeId = putChallenge("register", options.challenge);
    res.json({ challengeId, options });
  });

  router.post("/register/verify", async (req, res) => {
    if (configGuard(res)) return;
    if (rateLimited(req)) return res.status(429).json({ error: "too many attempts" });
    if (authIsEnforced() && !sessionIsValid(cookieFrom(req, SESSION_COOKIE))) {
      return res.status(401).json({ error: "sign in before adding another passkey" });
    }
    const expectedChallenge = takeChallenge(String(req.body?.challengeId || ""), "register");
    if (!expectedChallenge) return res.status(400).json({ error: "challenge expired - start again" });
    try {
      const verification = await verifyRegistrationResponse({
        response: req.body?.response,
        expectedChallenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: "registration could not be verified" });
      }
      const { credential } = verification.registrationInfo;
      stmts.insertCred.run(
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter ?? 0,
        JSON.stringify(credential.transports || []),
        String(req.body?.label || "").slice(0, 60) || "Passkey",
        new Date().toISOString()
      );
      // Registering signs you in, so the first device is never left locked out.
      setSessionCookie(res, createSession(credential.id));
      res.json({ ok: true, credentialCount: credentialCount() });
    } catch (e) {
      res.status(400).json({ error: e.message || "registration failed" });
    }
  });

  // --- authentication -----------------------------------------------------
  router.post("/login/options", async (req, res) => {
    if (configGuard(res)) return;
    if (rateLimited(req)) return res.status(429).json({ error: "too many attempts" });
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "required",
      // Empty allowCredentials + discoverable keys = the device offers whatever
      // passkey it holds for this origin, so no username is ever typed.
      allowCredentials: [],
    });
    res.json({ challengeId: putChallenge("login", options.challenge), options });
  });

  router.post("/login/verify", async (req, res) => {
    if (configGuard(res)) return;
    if (rateLimited(req)) return res.status(429).json({ error: "too many attempts" });
    const expectedChallenge = takeChallenge(String(req.body?.challengeId || ""), "login");
    if (!expectedChallenge) return res.status(400).json({ error: "challenge expired - start again" });
    const response = req.body?.response;
    const cred = response?.id ? stmts.credById.get(response.id) : null;
    if (!cred) return res.status(401).json({ error: "unknown passkey" });
    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(cred.public_key),
          counter: cred.counter,
          transports: cred.transports ? JSON.parse(cred.transports) : undefined,
        },
      });
      if (!verification.verified) return res.status(401).json({ error: "verification failed" });
      // A counter that fails to advance can indicate a cloned authenticator.
      // Devices that always report 0 are legitimate and common (most platform
      // authenticators), so only a real regression is rejected.
      const newCounter = verification.authenticationInfo.newCounter;
      if (cred.counter > 0 && newCounter > 0 && newCounter <= cred.counter) {
        return res.status(401).json({ error: "credential counter regressed - possible cloned key" });
      }
      stmts.bumpCounter.run(newCounter, new Date().toISOString(), cred.id);
      setSessionCookie(res, createSession(cred.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(401).json({ error: e.message || "authentication failed" });
    }
  });

  router.post("/logout", (req, res) => {
    const token = cookieFrom(req, SESSION_COOKIE);
    if (token) stmts.deleteSession.run(sha256(token));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // --- credential management (session required once enforcing) -------------
  router.get("/credentials", (req, res) => {
    res.json({
      credentials: stmts.allCreds.all().map((c) => ({
        id: c.id, label: c.label, createdAt: c.created_at, lastUsedAt: c.last_used_at,
      })),
    });
  });

  router.delete("/credentials/:id", (req, res) => {
    // Removing the last passkey would silently re-open the whole API, so it is
    // refused: delete the row over SSH if that is genuinely what you want.
    if (credentialCount() <= 1) {
      return res.status(400).json({ error: "cannot remove the only passkey - that would disable authentication entirely" });
    }
    stmts.deleteSessionsForCred.run(req.params.id);
    stmts.deleteCred.run(req.params.id);
    res.json({ ok: true, credentialCount: credentialCount() });
  });

  return router;
}
