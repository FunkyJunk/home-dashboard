# Home Dashboard

One page, one glance: calendars, email, weather, and home automation (Homey, Alexa, MyQ via Home Assistant). Runs entirely on the local network on a Synology NAS.

## Architecture

```
Desktop (Claude Code)  --push-->  GitHub  --CI builds image-->  ghcr.io
                                                                    |
                                                                    v
                                Synology NAS (Container Manager / Docker)
                    +--------------------+   +----------------+   +------------------+
                    |  Home Assistant    |-->|  Backend API   |-->|  Dashboard (web) |
                    |  Homey/Alexa/MyQ   |   |  + Cal/Email/  |   |  static frontend |
                    +--------------------+   |    Weather     |   +------------------+
                                              +----------------+
                                                                    |
                                                                    v
                                                          Wall tablet (LAN only)
```

## Repo layout

```
home-dashboard/
  backend/     Node.js/Express API that aggregates HA state, Google Calendar,
               Gmail, weather, and Ring camera snapshots into one JSON
               payload for the frontend
  frontend/    static HTML/JS dashboard, served by nginx
  infra/       docker-compose.yml + env template for the NAS
  .github/     CI workflow that builds and pushes images to GHCR
```

## 1. Desktop setup

Install Claude Code (native installer, no Node required):

```bash
# macOS / Linux
curl -fsSL https://claude.ai/install.sh | bash
```
```powershell
# Windows PowerShell
irm https://claude.ai/install.ps1 | iex
```
Verify with `claude --version` and `claude doctor`. Full docs: https://docs.claude.com/en/docs/claude-code/overview

Then:
```bash
git clone <your-new-empty-github-repo-url> home-dashboard
cd home-dashboard
# copy this scaffold in, then:
git add . && git commit -m "Initial scaffold" && git push
```
From here on, run `claude` inside this folder and it has full repo context.

## 2. Google Calendar + Gmail access

Since this is a personal Gmail account (not Google Workspace), use an OAuth 2.0
"Desktop app" client — service accounts can't read personal Gmail/Calendar
without a Workspace admin.

1. https://console.cloud.google.com → new project → enable **Google Calendar
   API** and **Gmail API**.
2. Credentials → Create Credentials → OAuth client ID → Application type:
   **Desktop app**. Download the JSON.
3. Run the one-time consent flow *locally on your desktop* (loopback
   redirect, nothing needs to be exposed to the internet) to mint a refresh
   token. A small script for this goes in `backend/src/auth/get-refresh-token.js`
   — run it once, then copy the resulting refresh token into `infra/.env` on
   the NAS. Never commit that file.

## 3. Ring camera access

Ring has no OAuth app registration flow like Google - auth is your account
email/password plus 2FA, exchanged once for a long-lived refresh token.

1. Run `node backend/src/auth/get-ring-refresh-token.js` *locally on your
   desktop*, not on the NAS. It prompts for your Ring email/password and, if
   your account has 2FA (most do), a verification code, then prints a
   refresh token to paste into `infra/.env` as `RING_REFRESH_TOKEN`.
2. Optionally set `RING_CAMERA_IDS` in `.env` to a comma-separated list of
   camera IDs if you only want specific cameras on the board; leave it blank
   to show every camera on the account.

   Honest heads-up: Ring rotates this refresh token roughly every hour under
   the hood. The backend keeps using the one you set until it stops working,
   at which point you'll see a Ring error on the dashboard and need to
   re-run the script for a fresh token. Also, snapshot requests wake a
   battery-powered camera - the backend caches those longer than wired
   cameras to limit the drain, but a camera add-on that hammers this more
   than the existing 60s poll cycle will burn through battery faster.

## 4. Nest thermostat access (direct, bypassing Homey)

The thermostats are also reachable through Home Assistant via the Homey
bridge, but that integration has never surfaced correct names or reliable
data for them and (as of writing) can't actually write a new setpoint -
Homey's API is rejecting the write with a permissions error. This talks to
Nest's own Smart Device Management (SDM) API directly instead.

Google discontinued the old free Nest API - this is the current paid
successor, the **Device Access** program:

1. https://console.cloud.google.com → new project (or reuse an existing
   one) → enable the **Smart Device Management API**.
2. Credentials → Create Credentials → OAuth client ID → Application type:
   **Web application**. Add `http://localhost:8092/oauth2callback` as an
   authorized redirect URI. Download the JSON as
   `backend/src/auth/nest-credentials.json`.
3. https://console.nest.google.com/device-access → pay the **one-time $5
   registration fee** → create a Device Access project, linking it to the
   OAuth client from step 2. Note its **project ID**.
4. Run `node backend/src/auth/get-nest-refresh-token.js <device-access-project-id>`
   *locally on your desktop*. It opens a browser for Google sign-in against
   whichever account owns the Nest structure, then prints
   `NEST_PROJECT_ID` / `NEST_CLIENT_ID` / `NEST_CLIENT_SECRET` /
   `NEST_REFRESH_TOKEN` to paste into `infra/.env` on the NAS.

   Honest heads-up: SDM's refresh tokens can get silently revoked if the
   linked Google Cloud project's OAuth consent screen is still in "Testing"
   mode (those tokens expire after 7 days) - move it to "Production" in the
   Cloud Console's OAuth consent screen settings to avoid that.

## 5. Synology NAS setup

1. **Control Panel → Terminal & SNMP** → enable SSH.
2. **Package Center** → install **Container Manager** (DSM 7.x's Docker
   package; on older DSM it's listed as "Docker").
3. Create a shared folder, e.g. `/volume1/docker/home-dashboard`, for
   persistent volumes (Home Assistant config, backend cache).
4. SSH in and clone the repo:
   ```bash
   ssh admin@<nas-ip>
   cd /volume1/docker
   git clone <your-repo-url> home-dashboard
   cd home-dashboard/infra
   cp .env.example .env   # fill in real values, never commit this
   ```
5. Authenticate Docker to GitHub Container Registry (only needed if pulling
   pre-built images rather than building on the NAS, which is recommended —
   Synology CPUs are slow at compiling):
   ```bash
   echo <github_PAT_with_read:packages> | docker login ghcr.io -u <github-username> --password-stdin
   ```
6. Bring the stack up:
   ```bash
   docker compose up -d
   ```
7. Home Assistant first-run wizard: `http://<nas-ip>:8123`. Add the Homey,
   Alexa Media Player (via HACS — you'll need to install HACS separately,
   it's not in HA core), MyQ, and Ring integrations from there.

   Ring is core to HA (no HACS needed) — add it via **Settings → Devices &
   Services → Add Integration → Ring** and log in with your Ring account.
   Once its camera/motion/ding entities show up in HA, the dashboard backend
   picks them up automatically over the existing `HOME_ASSISTANT_TOKEN` —
   no separate Ring credentials needed.

   Honest heads-up: MyQ's parent company actively fights third-party API
   access, so the MyQ integration in HA breaks periodically when they change
   something. Not a you-problem — just expect the occasional patch.

## 6. Point the wall tablet

Browser → `http://<nas-ip>:8080` (or whatever port the frontend container
publishes) and set it full-screen/kiosk mode. Since this stays LAN-only,
there's no reverse proxy, no cert, no port forwarding to worry about.
