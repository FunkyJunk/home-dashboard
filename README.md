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

## 5. Roku Devices card (direct ECP + Plex)

Talks directly to each Roku over its local, unauthenticated control API
(ECP, port 8060) rather than through Home Assistant - no token needed for
this part. Roku's own API only ever exposes the active app's *name* though;
it doesn't share poster art, title, or playback position for any app
except Plex (confirmed against a real device: every other app - Netflix,
Prime Video, etc. - reports nothing more than its name). For the richer
"now playing" metadata, this cross-references your Plex Media Server's own
session list by matching each Roku's IP address against Plex's reported
player address.

1. `backend/src/roku.js` hardcodes the LAN IPs of your Roku devices (found
   via a one-time subnet scan) - give each a DHCP reservation so its IP
   doesn't drift, and add/remove entries there directly if your devices
   change.
2. If you run Plex Media Server, add to `infra/.env` on the NAS:
   ```
   PLEX_URL=http://<nas-lan-ip>:32400
   PLEX_TOKEN=your-plex-token
   ```
   Get the token by signing into app.plex.tv, opening any item → **...** →
   **Get Info** → **View XML**, and copying `X-Plex-Token` from the
   resulting URL. `PLEX_URL` needs the NAS's actual LAN IP, not
   `localhost` - the backend runs in its own Docker network namespace, so
   `localhost` there means the container itself, not the NAS host Plex
   runs on.
3. `docker compose up -d` again to pick up the new `.env` values.

   Without `PLEX_TOKEN` set, the card still works - it just shows the
   active app name for every device, the same as any non-Plex app.

## 6. Synology NAS setup

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

## 7. Point the wall tablet

Browser → `http://<nas-ip>:8080` (or whatever port the frontend container
publishes) and set it full-screen/kiosk mode. Since this stays LAN-only,
there's no reverse proxy, no cert, no port forwarding to worry about.

## 8. Business receipts (needs HTTPS)

The Business Receipts card saves files straight to a folder on your PC via
the browser's File System Access API (`showDirectoryPicker`), which only
works in a "secure context" — plain `http://<nas-ip>` doesn't qualify, even
on a LAN. The frontend container also listens on 443 with a self-signed
cert for this reason; the wall tablet keeps using plain HTTP on 8080
unaffected.

One-time cert setup on the NAS (SAN must match whatever IP/hostname you'll
actually browse to):
```bash
mkdir -p infra/ssl && cd infra/ssl
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout home-dashboard.key -out home-dashboard.crt \
  -subj "/CN=<nas-ip>" \
  -addext "subjectAltName=IP:<nas-ip>"
```

Then browse to `https://<nas-ip>:8443` on the desktop where you want to use
the receipts feature. Chrome/Edge will show a "connection is not private"
warning for the self-signed cert — click **Advanced → Proceed** (a one-time
trust exception per browser/device). Use **Choose tax folder** on the card
to pick a local folder once; the app remembers it via IndexedDB after that.

### Optional: AI-based receipt extraction

By default, totals/tax/shipping/line-items are pulled out of each email
with regex heuristics, which only cover the specific formats they were
written against — most vendors format receipts differently, so a lot of
real emails come back with no line items detected even when a total was
found. Setting `ANTHROPIC_API_KEY` in `infra/.env` (get one at
[console.anthropic.com](https://console.anthropic.com)) switches scanning
over to having an LLM (Haiku) read each email directly, which generalizes
across vendor formats far better. It's a small per-email cost on a cheap
model, and falls back to the regex heuristics automatically if the key
isn't set or a call fails.

## 9. Scratch Pad (notes + shipping labels)

Notes are local-only - there's no way to sync with Google Keep from here.
Keep's API (`keep.googleapis.com`) only works for Google Workspace accounts
with domain-wide delegation; it has no OAuth flow for a personal Google
account at all, confirmed against Google's own docs.

Pasting an image (or dragging in a PDF) opens a crop tool: paste/drop a
label, Claude vision (same `ANTHROPIC_API_KEY` as receipt scanning above)
reads it to identify the marketplace/carrier and recipient name and
suggests roughly where the label sits in the image, then you drag/resize
an aspect-ratio-locked crop box to fit it exactly before confirming. The
"Action" dropdown holds crop presets (name + physical width/height in
inches) - "Print shipping label" (4"x6") is the only built-in one; **Edit
list…** adds more, all sharing the same crop/classify/save/print mechanic
just at a different size.

Confirming crops the image, builds a PDF sized to the exact preset
dimensions, saves it to `{picked folder}/{marketplace}/` (creating the
marketplace subfolder the first time a new one shows up) as
`{marketplace}_{recipient}_{date}_{time}.pdf`, and opens the browser print
dialog sized to match. Like Business Receipts, saving requires
`showDirectoryPicker` (HTTPS - see the cert setup above) and remembers the
picked root folder via IndexedDB after the first pick.

Renders dragged-in PDFs with a self-hosted `pdf.js` (`frontend/pdf.min.js`
+ `frontend/pdf.worker.min.js`, same no-CDN convention as `xlsx.full.min.js`/
`jspdf.umd.min.js`) so a PDF label goes through the identical crop step as
a pasted image.

## 10. Reminders + iPhone notifications

Reminders live in their own **Reminders** card (`+` button in its header) and
are stored in a Home Assistant **to-do list**, so the same list is editable
from HA's own To-do panel and from the dashboard. Due reminders push to the
iPhone through the Home Assistant Companion app.

Why the storage is split: HA's to-do model has no recurrence field. `TodoItem`
is `(uid, summary, status, due, description, completed)`, and
`todo.add_item`/`todo.update_item` accept only
`item`/`rename`/`status`/`due_date`/`due_datetime`/`description` (checked
against `homeassistant/components/todo/services.yaml`). So HA holds the *next*
occurrence of each reminder and `backend/src/reminders.js` owns the repeat
rule, in its own `reminders.db`.

1. In Home Assistant, add the **Local To-do** integration (Settings → Devices
   & services → Add integration → Local To-do) and create a list. Any `todo.*`
   entity works - a CalDAV or Google Tasks to-do list is fine too.
2. Install the **Home Assistant Companion** app on the iPhone and sign it into
   your HA, granting notification permission during setup.
3. Confirm the push target exists: HA → Developer tools → Actions → search
   `notify.` and look for `notify.mobile_app_<your-phone>`. If it isn't there,
   notifications can't be delivered yet and the dashboard will still work as a
   plain reminder list.
4. Optionally pin the targets in `infra/.env` (both are auto-discovered when
   blank, which picks the *first* match - set them once you have more than one
   to-do list or phone):
   ```
   HA_TODO_ENTITY=todo.reminders
   HA_NOTIFY_SERVICE=mobile_app_my_iphone
   REMINDER_ALLDAY_HOUR=8
   ```

Behaviour worth knowing:

- **Ticking a repeating reminder rolls it forward** to its next occurrence
  instead of closing it - same item, new due date. A one-off is marked
  completed as usual. This matches how Todoist behaved and keeps the recurrence
  rule attached to a stable `uid`.
- **A missed reminder is not auto-advanced.** It stays overdue (red badge)
  until ticked, so a skipped bin night is visible rather than silently rolled
  to next week. Completing it late schedules the next occurrence from *now*,
  not from the date it was missed, so it never lands in the past.
- **Each occurrence pushes exactly once.** The backend polls every
  `REMINDER_POLL_SECONDS` and records `(uid, due)` in `reminders.db`, so a
  reminder that stays overdue for days doesn't re-notify every minute.
- **Notifications don't need the tablet.** The old Todoist widget only popped a
  browser dialog, so anything due while the dashboard was closed was missed
  entirely. This runs in the backend.
- **Day-of-month recurrence clamps rather than skips**: "the 31st of each
  month" fires on Feb 28/29. A "fifth Monday" falls back to the last Monday in
  months that don't have one. Both choices favour firing on a nearby day over
  silently skipping a month.
- **All-day reminders** push at `REMINDER_ALLDAY_HOUR` (default 08:00) rather
  than midnight.

Available repeats: daily / every N days, every weekday (Mon-Fri), weekly on any
combination of days / every N weeks, monthly on the same date or on the nth
(or last) weekday / every N months, and yearly / every N years.

## 11. Printing labels from the NAS over IPP

By default a 4x6 label opens the browser's print dialog, so the printer has to
be visible to whatever device has the dashboard open. Set `LABEL_PRINTER_URI`
and the NAS sends the job itself over IPP - no dialog, no client-side printer
setup.

The document sent is the *same* 4x6 PDF the label pipeline already builds with
jsPDF for the saved copy, so there is no second rendering path that could drift
from the canvas pipeline in `frontend/index.html`.

### Finding the printer's URI

The backend container runs on Docker's bridge network, not host, so mDNS
(Bonjour) multicast never reaches it and the printer cannot be auto-discovered.
Given an IP or hostname, the probe endpoint tries the conventional IPP paths and
reports which answers:

```bash
curl -X POST http://<nas>:3000/api/printer/probe \
  -H 'Content-Type: application/json' \
  -d '{"host":"192.168.1.60"}'
```

To find the IP in the first place, from the NAS shell (HA's container is
host-networked, so it can see the LAN):

```bash
avahi-browse -rt _ipp._tcp
```

Then set it in `infra/.env` and `docker compose up -d`:

```
LABEL_PRINTER_URI=ipp://192.168.1.60:631/ipp/print
LABEL_PRINTER_MEDIA=na_index-4x6_4x6in
```

`GET /api/printer` reports what the printer says about itself - name, model,
state, `media-supported`, and the formats it accepts - plus which format the
dashboard picked.

### Document format is negotiated, not assumed

The dashboard can produce `application/pdf`, `image/png`, and `image/jpeg`. It
reads the printer's `document-format-supported` and picks the best match,
preferring PDF. A printer advertising only `application/octet-stream` (common on
AirPrint firmware) is sent the PDF bytes under that type and left to sniff them.

**A printer that speaks only raster (`image/urf`, `image/pwg-raster`) cannot be
used this way.** Encoding PWG Raster or Apple URF is a real amount of work that
isn't here. Rather than send a document such a printer will reject, the
dashboard reports it: `GET /api/printer` returns `printable: false`, and a print
attempt returns HTTP 415 naming both what the printer accepts and what the
dashboard can send. Label printing falls back to the browser dialog in that
case, so nothing is lost.

### Failure behaviour

A printer problem never costs you the label. If the NAS can't print - offline,
out of paper, wrong format - the error is shown in the label modal and the
browser print dialog opens as it did before. Specifically:

- unreachable printer: `could not reach printer at http://... (ECONNREFUSED)`
- out of paper: `printer is not accepting jobs (media-empty-error)`
- format mismatch: HTTP 415 with `printerAccepts` and `dashboardCanSend`

The IPP client is `backend/src/ipp.js`, hand-rolled for the three operations
needed (Get-Printer-Attributes, Print-Job, and path probing) rather than adding
a dependency. Note that IPP's attribute order is mandated - `attributes-charset`
first, `attributes-natural-language` second - and printers reject the request
outright when it's wrong, which is a miserable thing to debug from a generic
HTTP 400.

## 12. Tests, and the deploy gate

```bash
cd backend
npm install
npm test
```

51 test cases, no network and no real Home Assistant or printer required — mocks
stand in for both. Runs in about a second.

| File | Covers |
|---|---|
| `test/recurrence.test.mjs` | the repeat engine: every frequency, DST, clamping, validation |
| `test/reminders.test.mjs` | the HA to-do lifecycle, rollover, one-push-per-occurrence |
| `test/ipp-codec.test.mjs` | IPP wire format conformance and byte-exactness |
| `test/ipp-client.test.mjs` | the four printer profiles, including the refusal cases |

### The gate

`.github/workflows/build-and-push.yml` runs the suite as a separate `test` job,
and the image build declares `needs: test`. A red suite means **no image is
published**, which matters here specifically because Watchtower deploys
`:latest` unattended within five minutes — without the gate, a broken commit
reaches the wall tablet before anyone reads the CI email. Tests also run on pull
requests, so a branch gets a verdict before merge.

### Choices worth knowing before you add tests

- **TZ is pinned to `America/New_York` by `test/helpers/env.mjs`**, matching
  `infra/docker-compose.yml`. The recurrence engine works in local wall time, so
  its DST cases are only meaningful in a zone that *has* DST — on a CI runner,
  which defaults to UTC, a spring-forward test would pass for the wrong reason.
  Set `TZ_OVERRIDE` to check behaviour elsewhere.
- **The `ipp` package is a devDependency used only as a test oracle.**
  `src/ipp.js` is hand-rolled, so it is validated against an independent
  implementation in both directions — my encoder decoded by theirs, their
  serializer decoded by mine. Testing an encoder against its own decoder lets a
  shared misunderstanding pass, which is the failure mode that actually matters
  for a binary protocol. It never ships: the Dockerfile installs with
  `--omit=dev` and copies only `package.json` and `src`.
- **The oracle is wrong in two places, and the spec wins.** It cannot serialize
  `rangeOfInteger` (it emits eight zero bytes whatever you pass), and it decodes
  document data as UTF-8, mangling high bytes — `0xff 0x80` returns as
  `0xfd 0xfd`. Both cases are therefore asserted against bytes built by hand to
  RFC 8010. Document byte-exactness in particular is checked on the raw request
  buffer, since one altered byte in a PDF means blank label stock.
- **The committed lockfile pins CI, not the image.** `package-lock.json` exists
  so a transitive dependency update cannot change what the gate tested, and CI
  installs with `npm ci`. The published image is still unpinned:
  `backend/Dockerfile` copies only `package.json` and runs
  `npm install --omit=dev`, so it resolves fresh on every build. Closing that
  gap means pointing the Dockerfile at the lockfile and switching it to
  `npm ci` — a deliberate change to the deploy path, not done here.
- **Test files are listed explicitly in the `test` script** rather than globbed.
  Glob support in `node --test` arrived in Node 21, and CI pins Node 20 to match
  `node:20-alpine`. A new test file needs adding to that list.
