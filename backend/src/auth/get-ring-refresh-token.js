// Run this ONCE, locally, on your desktop - not on the NAS.
// Usage: node get-ring-refresh-token.js
// Prompts for your Ring account email/password, and a 2FA code if your
// account requires one (most do). This is the same RingRestClient auth
// flow that ring-client-api's bundled `ring-auth-cli` uses.

import { RingRestClient } from "ring-client-api";
import readline from "readline/promises";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const email = await rl.question("Ring account email: ");
const password = await rl.question("Ring account password (visible as typed): ");

const client = new RingRestClient({ email, password });

try {
  await client.getAuth();
} catch (e) {
  if (client.using2fa) {
    console.log(`\n${client.promptFor2fa}`);
    const code = await rl.question("2FA code: ");
    await client.getAuth(code);
  } else {
    rl.close();
    throw e;
  }
}

// client.refreshToken is a base64 blob (Ring token + hardware ID), not the raw
// Ring token - always store this exact string, and expect it to change: Ring
// rotates it roughly hourly, so the value below is only a starting point. If
// the backend runs long enough for the token to rotate out from under it, the
// Ring source in /api/dashboard starts failing until RING_REFRESH_TOKEN in
// .env is updated with a fresh one from this script.
console.log("\nAdd this to your .env file on the NAS:\n");
console.log(`RING_REFRESH_TOKEN=${client.refreshToken}\n`);

rl.close();
