// Run this ONCE, locally, on your desktop - not on the NAS.
// Usage: node get-nest-refresh-token.js <device-access-project-id>
//
// Prerequisites:
// 1. A Google Cloud project with the Smart Device Management API enabled.
// 2. An OAuth 2.0 "Web application" client in that project (Credentials ->
//    Create Credentials -> OAuth client ID), with
//    http://localhost:8092/oauth2callback added as an authorized redirect
//    URI. Download its JSON as nest-credentials.json in this folder.
// 3. A Device Access project created at
//    https://console.nest.google.com/device-access (one-time $5 fee),
//    linked to the OAuth client above. Its project ID is the argument to
//    this script.

import fs from "fs";
import http from "http";
import { URL, URLSearchParams } from "url";
import open from "open";

const SCOPE = "https://www.googleapis.com/auth/sdm.service";
const PORT = 8092;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const projectId = process.argv[2];
if (!projectId) {
  console.error("Usage: node get-nest-refresh-token.js <device-access-project-id>");
  process.exit(1);
}

const creds = JSON.parse(fs.readFileSync("./nest-credentials.json", "utf8"));
const { client_id, client_secret } = creds.web;

const authUrl = `https://nestservices.google.com/partnerconnections/${projectId}/auth?` +
  new URLSearchParams({
    redirect_uri: REDIRECT_URI,
    access_type: "offline",  // required to get a refresh token
    prompt: "consent",       // forces Google to re-issue a refresh token even on repeat runs
    client_id,
    response_type: "code",
    scope: SCOPE,
  });

const server = http
  .createServer(async (req, res) => {
    if (!req.url.startsWith("/oauth2callback")) return;

    const code = new URL(req.url, REDIRECT_URI).searchParams.get("code");
    res.end("Success! You can close this tab and return to the terminal.");
    server.close();

    const tokenRes = await fetch("https://www.googleapis.com/oauth2/v4/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id,
        client_secret,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      console.error("\nNo refresh token in response:", tokens);
      return;
    }

    console.log("\nAdd this to your .env file on the NAS:\n");
    console.log(`NEST_PROJECT_ID=${projectId}`);
    console.log(`NEST_CLIENT_ID=${client_id}`);
    console.log(`NEST_CLIENT_SECRET=${client_secret}`);
    console.log(`NEST_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  })
  .listen(PORT, () => {
    console.log("Opening browser for Google sign-in...");
    open(authUrl);
  });
