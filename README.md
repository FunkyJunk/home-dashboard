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
               Gmail, and weather into one JSON payload for the frontend
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

## 3. Synology NAS setup

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

## 4. Point the wall tablet

Browser → `http://<nas-ip>:8080` (or whatever port the frontend container
publishes) and set it full-screen/kiosk mode. Since this stays LAN-only,
there's no reverse proxy, no cert, no port forwarding to worry about.
