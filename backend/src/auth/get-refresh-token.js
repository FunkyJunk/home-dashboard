// Run this ONCE, locally, on your desktop - not on the NAS.
// Usage: node get-refresh-token.js
// Requires credentials.json (downloaded from Google Cloud Console) in this same folder.

import { google } from "googleapis";
import fs from "fs";
import http from "http";
import { URL } from "url";
import open from "open";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  // No tasks scope - the Tasks widget moved to Apple Reminders (CalDAV) in
  // reminders.js, since Google's Tasks API can't expose a due time or
  // recurrence at all. Leaving this scope out of future re-auths is just
  // cleanup; it doesn't require touching the refresh token already on the
  // NAS, which keeps working for calendar/gmail regardless.
];

const PORT = 8091;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const creds = JSON.parse(fs.readFileSync("./credentials.json", "utf8"));
const { client_id, client_secret } = creds.installed || creds.web;

const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline", // required to get a refresh token
  prompt: "consent",      // forces Google to re-issue a refresh token even on repeat runs
  scope: SCOPES,
});

const server = http
  .createServer(async (req, res) => {
    if (!req.url.startsWith("/oauth2callback")) return;

    const code = new URL(req.url, REDIRECT_URI).searchParams.get("code");
    res.end("Success! You can close this tab and return to the terminal.");
    server.close();

    const { tokens } = await oauth2Client.getToken(code);
    console.log("\nAdd this to your .env file on the NAS:\n");
    console.log(`GOOGLE_CLIENT_ID=${client_id}`);
    console.log(`GOOGLE_CLIENT_SECRET=${client_secret}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  })
  .listen(PORT, () => {
    console.log("Opening browser for Google sign-in...");
    open(authUrl);
  });
