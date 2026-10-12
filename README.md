# PotatOS

**A whole Linux desktop in a browser tab, meant for "potato" PCs.**

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/DeroXP/PotatOS)

PotatOS is a small, real Linux desktop (Alpine Linux + XFCE) that runs in a
container on a server: [Railway](https://railway.com),
[GitHub Codespaces](https://github.com/features/codespaces), or any machine
with Docker. You use it from a web browser. The server runs the apps and
encodes the screen to video. Your own computer only decodes a video stream and
sends back keyboard and mouse input, which nearly any device from the last ten
years can do.

- Real Linux with real apps: Chromium, terminal, file manager, text editor,
  task manager, image viewer, media player and archive manager, plus `apk` for
  thousands more.
- Internet access from inside the desktop (it uses the server's connection).
- Microphone and webcam from your browser. Your browser asks for permission
  only when an app inside the desktop actually uses them.
- Up to 120 fps and up to 2K (2560x1440), given enough server CPU. See
  [Performance](#performance-the-honest-part).
- Works through plain HTTPS proxies (WebSockets). No UDP, TURN server or extra
  ports are needed.

Built on [linuxserver/webtop](https://github.com/linuxserver/docker-webtop)
(XFCE, s6-overlay, nginx) and [Selkies](https://github.com/selkies-project/selkies)
(streaming). PotatOS adds profiles, safe defaults for public hosting, PaaS
port handling, branding and a few apps.

---

## Architecture

```
  your browser (any PC / laptop / tablet)
  - shows the desktop as video (H.264 via WebCodecs, hardware decoded)
  - sends keyboard, mouse, clipboard, and mic/webcam when asked
        |
        |  HTTPS + WebSocket (wss://)   <- Railway / Codespaces terminate TLS,
        |                                  or use :3001 (self-signed) on a LAN
        v
 +---------------------------- PotatOS container ----------------------------+
 |  nginx :3000 (HTTP) / :3001 (HTTPS)   basic auth (PASSWORD), GET /healthz |
 |     |-- /     -> Selkies web client (static HTML/JS)                      |
 |     '-- /api  -> WebSocket -> Selkies server (127.0.0.1:8082)             |
 |                     same-origin check (no foreign web pages)              |
 |                     |-- grabs the Xvfb screen :1 -> x264 / VP8 / JPEG     |
 |                     |-- PulseAudio -> Opus audio                          |
 |                     |-- keyboard/mouse -> X server (XTest)                |
 |                     '-- mic -> virtual PulseAudio source,                 |
 |                         webcam -> virtual /dev/video0                     |
 |  Xvfb :1  ->  XFCE desktop  ->  Chromium, Terminal, Thunar, ...           |
 |  s6-overlay supervises all of it. PotatOS boot scripts live in            |
 |  /custom-cont-init.d (packages, port, profile, password, desktop).        |
 |  /config = home directory of user "abc"  (mount a volume here)            |
 +---------------------------------------------------------------------------+
```

## Quick start

### 1. Docker on your own machine

```bash
git clone <this repo> potatos && cd potatos
docker compose up -d --build      # first build pulls ~1 GB, takes a few minutes
```

Open <http://localhost:3000>. Your files and settings are kept in `./data`.
The Compose file publishes the desktop on **this machine only**
(`127.0.0.1:3000`) and without a password.

- **From another PC on your network:** LAN access is opt-in, because the
  desktop user has passwordless `sudo` and Docker-published ports bypass host
  firewalls such as ufw. Set a password first
  (`PASSWORD=choose-one docker compose up -d`, user `abc`), uncomment the
  `3001:3001` line in `docker-compose.yml`, then open `https://<server-ip>:3001`
  and accept the self-signed certificate warning. Use 3001 rather than 3000:
  browsers only allow the microphone and webcam on HTTPS or `localhost`.
- **To require a login**, run `PASSWORD=choose-one docker compose up -d`, or
  `POTATOS_REQUIRE_PASSWORD=true docker compose up -d` to have one generated
  (shown in `docker compose logs`). The user name is `abc`. Inside a running
  desktop, `potatos set-password` does the same without a restart.

If you prefer plain `docker run`:

```bash
docker build -t potatos .
docker run -d --name potatos -p 3000:3000 -p 3001:3001 --shm-size=1g \
  -v "$PWD/data:/config" -e PASSWORD=choose-one potatos
```

(This publishes on all interfaces, which is why it sets a `PASSWORD`.)

### 2. Railway

You need the **Hobby plan or higher**. The Free (0.5 GB RAM, 1 vCPU) and
Trial (1 GB RAM) plans are too small for a desktop with Chromium, and their
0.5 GB volumes fill up quickly with a browser profile and cache. Railway
resources are per-plan limits, not something you assign per service; Hobby
allows enough for every profile.

1. Push this repository to GitHub. In Railway, choose **New Project → Deploy
   from GitHub repo**. Railway finds the `Dockerfile` and builds it.
2. **Settings → Deploy:** set **Healthcheck Path** to `/healthz`. The first
   boot can be slow, so also add the variable
   `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300`.
   (`railway.json` in this repo sets the same values, but Railway's
   Config-as-Code files are deprecated: new services ignore them, and
   existing ones stop reading them on 2026-12-01. Set them in the dashboard.)
3. **Variables:**
   - `PASSWORD` (strongly recommended). If you do not set one, PotatOS
     generates one on Railway and prints it in the deploy logs, in a box that
     starts with `PotatOS login`. The user name is `abc`. Public desktops are
     never left open by accident.
   - `RAILWAY_SHM_SIZE_BYTES=1073741824` (1 GiB of `/dev/shm`; Railway's
     default is 64 MB, which Chromium and the video pipeline find tight).
   - optionally `POTATOS_PROFILE` (`potato`, `balanced` or `ultra`).
4. **Volume:** add a volume mounted at **`/config`**. Without it, your files,
   settings, browser profile and generated password are lost on every
   redeploy.
5. **Networking:** generate a public domain. Railway injects `PORT`, and
   PotatOS moves its web server to that port automatically (and keeps its
   self-signed HTTPS port 3001 internal, so Railway only sees one port). If
   Railway asks you to pick a port, choose the `PORT` value (usually 8080),
   **never 3001**. Open the `https://...up.railway.app` URL. It is HTTPS, so
   the mic and webcam work.
6. **CPU:** video encoding uses the CPU (Railway has no GPUs). `balanced`
   wants 2-4 vCPU and 2 GB RAM, `ultra` 6-8+ vCPU. See the profile table
   below.

> **Shared memory:** if `/dev/shm` is under 512 MB (for example when
> `RAILWAY_SHM_SIZE_BYTES` is not set), PotatOS starts Chromium with
> `--disable-dev-shm-usage`, so tabs don't crash. Other memory-hungry apps may
> still want the bigger `/dev/shm`.

### 3. GitHub Codespaces

1. On GitHub, open **Code → Codespaces → ⋯ → New with options** and choose a
   **4-core** machine (recommended). A 2-core machine works with
   `POTATOS_PROFILE=potato` and uses half the free core-hours.
2. Wait for the first build, which takes several minutes. The Codespace
   container *is* the desktop. Port **3000 ("PotatOS Desktop")** is forwarded
   and opens in a new tab. If it does not open, use the **PORTS** tab.
3. Forwarded ports are private by default: only your GitHub account can open
   them, and they are HTTPS, so the mic and webcam work.
4. **Before making the port public, set a login.** Add a Codespaces secret
   named **`POTATOS_PASSWORD`** (GitHub **Settings → Codespaces → Secrets**,
   and give this repository access), then restart the codespace. Secrets never
   reach the container's own startup scripts, so the `postStartCommand`
   (`potatos codespaces-setup`) applies it once the desktop is up; check that
   the page asks for a login (user `abc`) before you share the URL. You can
   also run `potatos set-password` in the VS Code terminal. Do **not** put
   `PASSWORD` in `containerEnv` in `devcontainer.json`: that file is committed,
   and your repository may be public.
5. **Keep your files in `/workspaces`** (there is a `workspaces` shortcut on the
   desktop). `/config` survives stopping and starting the codespace but **not a
   container rebuild**, which Codespaces offers whenever `devcontainer.json`
   changes.

In the VS Code terminal, `potatos info` shows the active profile and the
resources the Codespace has.

## Profiles

Set the profile with `POTATOS_PROFILE`. A profile only sets defaults. Any
`SELKIES_*` variable you set yourself always wins (setting any
`SELKIES_MANUAL_*` also turns off the profile's fixed resolution), and you can
still change the framerate and quality live from the Selkies sidebar inside
the allowed range.

> **Switching profiles:** the web client remembers the framerate and quality
> you last used on that site and keeps them if they are inside the new
> profile's range. `potato` uses narrow ranges so old values are discarded,
> but after other switches set the framerate and quality in the Selkies
> sidebar, or clear the site's data in your browser to start from the
> profile's values.

| Profile | Start / max fps | Desktop resolution | Quality (CRF, lower = better) | CBR bitrate | Codecs offered | Good for |
|---|---|---|---|---|---|---|
| `potato` | 30 / 30 | fixed **1280x720**, scaled to your window | 30 (26-50) | 3 Mbps (max 6) | H.264, VP8, JPEG | very old PCs, Chromebooks, phones, slow Wi-Fi, 1-2 vCPU servers |
| `balanced` (default) | 60 / 120 | follows the browser window (CSS pixels, so HiDPI screens don't secretly request 4K) | 25 | 8 Mbps | all | most people, 1080p60 on 2-4 vCPU |
| `ultra` | 120 / 120 | follows the browser window (CSS pixels), e.g. **2560x1440** for a full window on a 1440p monitor at 100% scaling | 20 | 20 Mbps | all | strong servers (6-8+ vCPU), fast networks, high-refresh monitors |
| `custom` | Selkies defaults | follows the window | Selkies defaults | Selkies defaults | all | you set `SELKIES_*` yourself |

Extra knobs:

- `POTATOS_RESOLUTION=1920x1080` locks the desktop to that size. `auto`
  follows the browser window. For `ultra` at exactly 2K regardless of window
  size or display scaling, set `POTATOS_RESOLUTION=2560x1440`.
- `SELKIES_USE_CSS_SCALING=false` renders at device pixels (sharper on HiDPI
  screens). Opt-in only: a Retina laptop or a 4K screen at 150-200% then asks
  for 2880x1800 or 3840x2160, well above 2K and the CPU estimates below.
- Any [Selkies setting](https://github.com/selkies-project/selkies) works as
  `SELKIES_<NAME>`. Examples: `SELKIES_FRAMERATE="90,8-120"` (start at 90,
  allow 8-120), `SELKIES_ENCODER="jpeg"`, `SELKIES_VIDEO_CRF="23"`.
- H.264 is the default codec for every profile, because nearly every client
  device decodes it in hardware. If a browser cannot decode a codec, Selkies
  falls back to the next one it can.

## Microphone, webcam and HTTPS

- The mic and webcam are **enabled with an "on demand" policy**
  (`SELKIES_MICROPHONE_ON_START=demand`, `SELKIES_WEBCAM_ON_START=demand`). Your
  browser asks for permission only when an app in the desktop opens the
  microphone or camera, such as a video call in Chromium, and releases the
  device shortly after the app stops. You can also toggle them by hand in the
  Selkies sidebar.
- Browsers expose the mic and camera **only in a secure context**:
  - Railway and Codespaces URLs are HTTPS: ✅
  - `http://localhost:3000` on the same machine: ✅
  - `https://<lan-ip>:3001` (self-signed; accept the warning once): ✅
  - `http://<lan-ip>:3000`: ❌ the mic and camera are not available
- Inside the desktop, the webcam is `/dev/video0` and the microphone is the
  default PulseAudio input (`pavucontrol` shows it).
- To disable them: `SELKIES_MICROPHONE_ENABLED=false` and `NO_WEBCAM=1`
  (or `SELKIES_WEBCAM_ENABLED=false`). PotatOS turns these into a **locked**
  off (`false|locked`). A plain unlocked `false` in Selkies only sets the
  default position of the sidebar toggle and leaves on-demand capture active.

## Performance (the honest part)

- **The server does the heavy lifting.** There is no GPU on Railway or
  Codespaces, so every frame is encoded in software (x264 for H.264, which is
  what Chrome, Edge, Safari and Firefox get). Encoding cost grows with
  resolution × framerate × how much of the screen changes.
- **Idle is cheap.** Selkies only encodes when the screen changes. An idle
  desktop measured about 1% CPU and ~260 MB RAM.
- **Rough guide** (estimates, not guarantees; video and games cost far more
  than a terminal):

  | Target | Server vCPU (encoding + apps) | Typical bandwidth |
  |---|---|---|
  | 720p30 (`potato`) | 1-2 | 1-4 Mbps |
  | 1080p60 (`balanced`) | 2-4 | 5-15 Mbps |
  | 1440p120 (`ultra`) | 6-8+ | 20-50 Mbps |

  One measurement, on a 4-vCPU test box: H.264 (x264, CRF 25, 60 fps target)
  to a Chromium client, 1920x992 desktop with a maximized terminal scrolling
  full-speed. The Selkies process (capture + encode) used ~0.5 of a core, the
  X server ~0.4, and the whole container ~2 cores including the app itself.
- **"Up to 120 fps / 2K" means the pipeline allows it.** Reaching it depends
  on server CPU, network and your display. If the server can't keep up, frames
  are dropped rather than queued, so input stays responsive. Use `potatos info`
  and `htop` to see what the server is doing.
- **Client side:** any current Chrome, Edge, Firefox or Safari. The client
  decodes H.264 (usually in hardware) and draws it, which is far lighter than
  running the apps. For very weak clients, use `potato` and a smaller browser
  window.
- **Latency:** mostly network round-trip time. Pick a server region near you.

## Security

- **Set `PASSWORD` for anything reachable from the internet.** nginx then
  requires HTTP basic auth for every page and the streaming WebSocket. The
  user is `CUSTOM_USER`, default `abc`. Only `/healthz` stays open, and it
  returns the text `ok`.
- **Basic auth alone does not stop other websites.** Once you have logged in,
  your browser re-sends the cached credentials even on a WebSocket opened by
  a page on a *different* site, which could then watch and control your
  desktop (cross-site WebSocket hijacking). PotatOS therefore keeps Selkies'
  same-origin check on: `SELKIES_ALLOWED_ORIGINS` is empty, so only pages
  whose host name matches the desktop's may open the stream (the base image
  ships `*`, which turns the check off). Selkies compares host names only, not
  ports or schemes, so another app served on the *same* host name (e.g. a
  different port on `localhost`) is trusted too. Railway, Codespaces, `localhost` and LAN IPs
  work as is. Behind a reverse proxy that rewrites the `Host` header, allow
  your public URL with `SELKIES_ALLOWED_ORIGINS=https://desktop.example.com`
  (comma-separated list) or `potatos allow-origin <url>` (saved in
  `/config/.potatos/allowed-origins`, so it survives restarts). Never set it to `*`
  on a reachable desktop.
- On **Railway**, a password is generated automatically if you set none. It is
  stored in `/config/.potatos/generated-password` (root-only, mode 600) so it
  survives restarts. Delete that file to rotate it. Opt out with
  `POTATOS_REQUIRE_PASSWORD=false` (only behind your own auth proxy). Set
  `POTATOS_REQUIRE_PASSWORD=true` to get the same protection on any host.
- `potatos set-password [<password>]` turns on a login at runtime (it keeps a
  hash in `/config/.potatos/htpasswd` and re-applies it on every boot);
  `potatos set-password --off` removes it.
- Basic auth is only safe over HTTPS. Railway, Codespaces and `:3001` provide
  that. Don't put a password-protected desktop on plain `http://` over the
  internet.
- Whoever logs in can use `sudo` inside the container (the `abc` user has
  passwordless sudo), so treat the login like a root password for the
  container. That also means the "root-only" password files above are
  readable from the desktop. The base image's `HARDEN_DESKTOP=true` disables
  sudo, terminals and file transfer for kiosk-style use.
- Docker's default seccomp profile is kept. Chromium runs with `--no-sandbox`
  inside the container, which is normal for containerised desktops.

## Persistence

Everything you do lives in **`/config`**, the home directory of user `abc`:
files, desktop and XFCE settings, the Chromium profile, the TLS certificate
and the generated password. Mount a volume there (`./data` in Compose, a
Railway volume). In Codespaces, `/config` survives stopping and starting but
is wiped by a **container rebuild**; only `/workspaces` is kept, so store
important files there (the desktop has a `workspaces` shortcut).

- First-boot setup (desktop launchers, wallpaper, Chromium as the default
  browser) runs once per volume. Anything you change or delete afterwards
  stays that way.
- Packages installed with `apk` / `potatos install` live in the container, not
  in `/config`, so they are gone after a redeploy. Put packages you always
  want in `POTATOS_EXTRA_PACKAGES="firefox gimp"`, which installs them at
  every start, or add them to the Dockerfile.

## Configuration reference

| Variable | Default | What it does |
|---|---|---|
| `POTATOS_PROFILE` | `balanced` | `potato`, `balanced`, `ultra`, `custom` (see [Profiles](#profiles)) |
| `POTATOS_RESOLUTION` | profile (`1280x720` for potato, else `auto`) | `auto` or `WIDTHxHEIGHT` |
| `PASSWORD` | empty | enables login (basic auth) |
| `CUSTOM_USER` | `abc` | login user name |
| `POTATOS_REQUIRE_PASSWORD` | `true` on Railway, else `false` | generate a password when `PASSWORD` is empty |
| `POTATOS_PASSWORD` | empty | Codespaces secret applied by `potatos codespaces-setup` |
| `SELKIES_ALLOWED_ORIGINS` | empty (same-origin only) | extra web origins allowed to open the stream |
| `POTATOS_EXTRA_PACKAGES` | empty | Alpine packages to `apk add` at each start |
| `PORT` | set by Railway | HTTP port, used when `CUSTOM_PORT` is not set |
| `CUSTOM_PORT` / `CUSTOM_HTTPS_PORT` | `3000` / `3001` | HTTP / HTTPS ports |
| `PUID` / `PGID` | `911` / `911` | owner of files in `/config` (set to your `id -u` / `id -g`) |
| `TZ` | `Etc/UTC` | time zone |
| `TITLE` | `PotatOS` | browser tab title |
| `SELKIES_*` | from profile | any Selkies streaming setting |
| `NO_WEBCAM`, `HARDEN_DESKTOP`, `SUBFOLDER`, `DISABLE_IPV6`, ... | | see [linuxserver/webtop](https://github.com/linuxserver/docker-webtop) |

Build argument: `POTATOS_APK_PACKAGES` (default `"htop mpv galculator"`).
Leave it empty for offline builds or when the Alpine mirror is unreachable:
`docker compose build --build-arg POTATOS_APK_PACKAGES= && docker compose up -d`.

Inside the desktop, run `potatos help`:

```
potatos info               show profile, streaming settings and resources
potatos install <pkg>...   install Alpine packages (apk), e.g. potatos install firefox
potatos search <term>      search Alpine packages
potatos set-password [pw]  require a login (user abc); --off removes it
potatos allow-origin <url> allow a web origin to open the stream (behind Host-rewriting proxies;
                           saved in /config/.potatos/allowed-origins)
potatos codespaces-setup   used by .devcontainer (origin + password from secrets)
potatos help               this help
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Railway asks for a login you never set | The password is in the deploy logs (`PotatOS login`). User `abc`. Or set `PASSWORD`. |
| Railway deploy fails its health check | Check the logs for `[potatos]` lines. Don't set `CUSTOM_PORT` on Railway; let `PORT` work. Set `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300` so the first boot has time. |
| Railway URL answers `400 Bad Request` | The domain targets port 3001. Edit the domain and pick the `PORT` value (usually 8080). |
| Page loads but stays grey, logs show `403` for `/api/websockets` | A proxy in front rewrites the `Host` header. Set `SELKIES_ALLOWED_ORIGINS=https://<your-public-host>` or run `potatos allow-origin https://<your-public-host>`. |
| Black or grey screen | Wait 10-20 s on first boot. Reload the page. Check `docker logs potatos` for errors. |
| Chromium tabs crash ("Aw, Snap!") | Give the container more shared memory (`--shm-size=1g`, `shm_size` in Compose, `RAILWAY_SHM_SIZE_BYTES=1073741824` on Railway). Below 512 MB PotatOS already falls back to `/tmp`. |
| Mic or webcam never asks for permission | You need HTTPS or localhost (see [above](#microphone-webcam-and-https)). Check the browser's site permissions. The prompt only appears when an app actually uses the device. |
| Laggy or stuttering | Use `POTATOS_PROFILE=potato`, lower the fps in the sidebar, shrink the browser window, or add vCPUs. `htop` in the desktop shows whether the server is maxed out. If a profile change seems ignored, the browser remembered old settings: set fps/quality in the sidebar or clear the site's data. |
| Mic or webcam still asked for after disabling | Use `SELKIES_MICROPHONE_ENABLED=false` / `NO_WEBCAM=1` (PotatOS locks them off); check `potatos info`. |
| Blurry text | The `potato` profile locks 720p. Set `POTATOS_RESOLUTION=auto`, or use `balanced`. |
| `nginx: socket() [::]:3000 failed` | Host without IPv6. PotatOS detects this and drops the IPv6 listeners automatically. You can also set `DISABLE_IPV6=true`. |
| Want a fresh desktop | Stop the container, delete the `/config` volume (`sudo rm -rf ./data`: `.potatos/` inside it is root-owned because it holds password files), start again. |

## Tests

```bash
# Build the image, boot 5 containers (default, PORT remap, PASSWORD, Railway
# mode, overrides) and check health, HTTP/HTTPS, auth, the WebSocket origin
# guard, profiles, overrides, and an H.264 stream to the image's own Chromium.
scripts/smoke-test.sh                     # BUILD_ARGS='--build-arg POTATOS_APK_PACKAGES=' offline

# Drive the real desktop in headless Chromium: wait for non-blank video frames,
# right-click (mouse), double-click the Text Editor launcher (no "untrusted
# launcher" dialog), Ctrl+Alt+T + type `echo hello ...` (keyboard).
# Screenshots land in tests/e2e/screenshots/.
cd tests/e2e && npm install
POTATOS_URL=http://localhost:3000 POTATOS_CONTAINER=potatos node desktop.test.mjs
```

The e2e test uses `playwright-core` with an already installed Chromium
(`CHROMIUM_PATH`, or `PLAYWRIGHT_BROWSERS_PATH`). It never downloads browsers.
Set `POTATOS_PASSWORD` if the desktop has a password. It logs the negotiated
codec; Playwright's Chromium cannot decode H.264, so it streams AV1 or VP8
(the smoke test covers H.264). `EXPECT_CODEC=H264` with an H.264-capable
`CHROMIUM_PATH` asserts the real-user path.

## Project layout

```
Dockerfile                    FROM linuxserver/webtop + apps + rootfs/ + HEALTHCHECK
rootfs/custom-cont-init.d/    boot scripts (run as root before services start)
  05-potatos-packages           POTATOS_EXTRA_PACKAGES
  10-potatos-port               PORT -> nginx, /healthz, IPv6 auto-detect
  20-potatos-profile            POTATOS_PROFILE -> SELKIES_* defaults, mic/cam policy
  30-potatos-security           WebSocket origin guard, auto/saved password
  40-potatos-desktop            first-boot launchers + default browser
rootfs/defaults/xfce/         first-boot XFCE desktop settings (wallpaper)
rootfs/usr/share/potatos/     wallpaper.svg, desktop launchers
rootfs/usr/local/bin/         potatos CLI, healthcheck, chromium shm wrapper, session helper
rootfs/etc/xdg/autostart/     runs potatos-session at login (marks the stock launchers trusted)
railway.json                  legacy Railway Config-as-Code (ignored by new services, and by all after 2026-12-01)
.devcontainer/                GitHub Codespaces
docker-compose.yml            local use
scripts/smoke-test.sh         container-level tests
tests/e2e/                    browser-level test (Playwright)
```

## License

MIT, see [LICENSE](LICENSE). Base images and bundled software keep their own
licenses (linuxserver/webtop: GPL-3.0; Selkies: MPL-2.0; Alpine packages:
various).
