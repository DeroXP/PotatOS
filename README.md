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

- Real Linux with real apps: Chromium and Firefox, terminal, file manager,
  text editor, task manager, image viewer, media player and archive manager,
  plus `apk` for thousands more.
- Internet access from inside the desktop (it uses the server's connection).
- Microphone and webcam from your browser. Your browser asks for permission
  only when an app inside the desktop actually uses them.
- Cheap when nobody is looking: after 10 minutes without a viewer the desktop
  is frozen (CPU ~0, no network packets), so Railway's Serverless mode can put
  the service to sleep, and it resumes instantly when you come back. Open apps
  and browser tabs survive a restart. See [Idle & sleep](#idle--sleep).
- Up to 120 fps and up to 2K (2560x1440) are *allowed*; what you get depends
  on server CPU. Read [Performance](#performance-the-honest-part) first.
- Works through plain HTTPS proxies (WebSockets). No UDP, TURN server or extra
  ports are needed.
- Have a PC with an NVIDIA GPU? The Debian variant (`Dockerfile.gpu`) can
  encode on the GPU (NVENC), which is what 2K at 120 fps needs; untested here
  (no GPU on the build machine), see [docs/gpu-host.md](docs/gpu-host.md) for
  the checks. A tiny portal on Railway sends you to the PC when it is on and
  to the cloud desktop when it is not. See [GPU host](#your-own-gpu-pc-and-the-portal).

Built on [linuxserver/webtop](https://github.com/linuxserver/docker-webtop)
(XFCE, s6-overlay, nginx) and [Selkies](https://github.com/selkies-project/selkies)
(streaming). PotatOS adds profiles, safe defaults for public hosting, PaaS
port handling, the idle/sleep machinery, a stats HUD, eco mode, a privacy
shade, browser choice, branding and a few apps.

**Contents:** [Architecture](#architecture) · [Quick start](#quick-start)
(Docker, Railway, Codespaces) · [GPU PC + portal](#your-own-gpu-pc-and-the-portal) ·
[Profiles](#profiles) · [Idle & sleep](#idle--sleep) ·
[The browser tab](#the-browser-tab-hud-eco-mode-privacy-shade-pausing) ·
[Browser choice](#browser-choice-chromium-or-firefox) ·
[Mic, webcam, HTTPS](#microphone-webcam-and-https) ·
[Performance](#performance-the-honest-part) · [Security](#security) ·
[Persistence](#persistence) · [Configuration reference](#configuration-reference) ·
[Troubleshooting](#troubleshooting) · [Tests & benchmark](#tests-and-benchmark) ·
[Project layout](#project-layout)

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
 |     |-- /     -> Selkies web client + PotatOS add-ons (potatos.js: HUD,   |
 |     |            eco mode, privacy shade, pause pages; waking page on 5xx)|
 |     '-- /api  -> WebSocket -> Selkies server (127.0.0.1:8082)             |
 |                     same-origin check (no foreign web pages)              |
 |                     |-- grabs the Xvfb screen :1 -> x264 / VP8 / JPEG     |
 |                     |-- PulseAudio -> Opus audio                          |
 |                     |-- keyboard/mouse -> X server (XTest)                |
 |                     '-- mic -> virtual PulseAudio source,                 |
 |                         webcam -> virtual /dev/video0                     |
 |  Xvfb :1  ->  XFCE desktop  ->  Chromium / Firefox, Terminal, Thunar ...  |
 |  potatos-idle: no viewer for 10 min -> checkpoint the session, SIGSTOP    |
 |  the desktop apps, close the browser's sockets (0 packets out); a page    |
 |  load thaws everything (~0.2 s)                                           |
 |  s6-overlay supervises all of it. PotatOS boot scripts live in            |
 |  /custom-cont-init.d (packages, port, profile, password, desktop, web).   |
 |  /config = home directory of user "abc"  (mount a volume here)            |
 +---------------------------------------------------------------------------+
```

## Quick start

### 1. Docker on your own machine

```bash
git clone https://github.com/DeroXP/PotatOS.git potatos && cd potatos
docker compose up -d --build      # first build downloads ~1 GB (3.8 GB on disk), takes a few minutes
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
   - optionally `POTATOS_PROFILE` (`auto` picks by vCPU count; `potato`,
     `balanced` or `ultra` to force one).
4. **Volume:** add a volume mounted at **`/config`**. Without it, your files,
   settings, browser profile and generated password are lost on every
   redeploy, and the desktop cannot restore your session after a sleep.
5. **Networking:** generate a public domain. Railway injects `PORT`, and
   PotatOS moves its web server to that port automatically (and keeps its
   self-signed HTTPS port 3001 internal, so Railway only sees one port). If
   Railway asks you to pick a port, choose the `PORT` value (usually 8080),
   **never 3001**. Open the `https://...up.railway.app` URL. It is HTTPS, so
   the mic and webcam work.
6. **CPU:** video encoding uses the CPU (Railway has no GPUs). 1080p at 30 fps
   wants 2-4 vCPU and 2 GB RAM; 60 fps about twice that. See
   [Performance](#performance-the-honest-part). Pro plans burst to 24 vCPU per
   replica automatically; there is no instance size to pick.
7. **Sleep when idle (recommended):** **Settings → Deploy → Serverless →
   Enable**, then **Redeploy** (the setting only applies to new containers).
   PotatOS freezes the desktop after 10 idle minutes and stops sending
   packets, which is exactly what Serverless watches for; see
   [Idle & sleep](#idle--sleep) for what to expect.
8. **Region:** Service settings → Region. Pick the Metal region closest to
   you (`us-west2` California, `us-east4-eqdc4a` Virginia,
   `europe-west4-drams3a` Amsterdam, `asia-southeast1-eqsg3a` Singapore).
   Latency is mostly round-trip time; nothing else matters as much.

> **Shared memory:** if `/dev/shm` is under 512 MB (for example when
> `RAILWAY_SHM_SIZE_BYTES` is not set), PotatOS starts Chromium with
> `--disable-dev-shm-usage`, so tabs don't crash. Other memory-hungry apps may
> still want the bigger `/dev/shm`.

### 3. GitHub Codespaces

1. On GitHub, open **Code → Codespaces → ⋯ → New with options** and choose a
   **4-core** machine (recommended, 1080p30-60). A 2-core machine works too:
   the `auto` profile then streams 720p at 30 fps, and it uses half the free
   core-hours ($0.18/h vs $0.36/h when paid).
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
6. **Idle timeout.** GitHub stops a codespace after 30 minutes without
   "activity", and **traffic on a forwarded port does not count**: only typing
   in VS Code or terminal output does. So a desktop session can be cut off
   mid-use. Raise **GitHub Settings → Codespaces → Default idle timeout** (up
   to 240 min), or create the codespace with `gh codespace create
   --idle-timeout 120m`. There is also a hard 12-hour cap per codespace.
   The other direction, stopping the codespace when *you* are idle, is
   handled by PotatOS if you add a Codespaces secret **`POTATOS_GH_TOKEN`**
   (a classic PAT with the `codespace` scope, or a fine-grained one with
   "Codespaces lifecycle admin" write access): after 10 minutes without a
   viewer the desktop is frozen and the codespace is stopped through the
   GitHub API, so you stop paying for the cores. Without the token it only
   freezes (CPU ~0) and GitHub's own timeout does the rest.

In the VS Code terminal, `potatos info` shows the active profile and the
resources the Codespace has.

## Your own GPU PC, and the portal

Software encoding tops out around 1440p at 35 fps on 4 vCPU (see
[Performance](#performance-the-honest-part)); Railway and Codespaces have no
GPUs. A PC at home with an NVIDIA card does have a hardware encoder (NVENC),
and NVIDIA's libraries need glibc, so PotatOS has a second image for it:
**`Dockerfile.gpu`**, built `FROM linuxserver/webtop:debian-xfce` with the
same `rootfs/` overlay (the scripts detect apt vs apk, the nginx config path
and the browser names at runtime). Everything in this README applies to it;
plus `potatos install-browser chrome|brave` and `POTATOS_BROWSER=chrome|brave`.

- **[docs/gpu-host.md](docs/gpu-host.md)**: Windows 11 + Docker Desktop
  (WSL2) step by step, with `docker-compose.gpu.yml` (the desktop container
  with the GPU, plus a Caddy sidecar that gets a Let's Encrypt certificate
  for your domain and proxies HTTPS/WebSockets), `.env.gpu.example`, the
  router port-forward, four commands that tell you whether NVENC really
  loaded, and what to expect: on WSL2 the GPU *encodes* but the apps still
  *render* on the CPU. Honest caveat: no GPU was available while this was
  written, so the Debian image is tested without one (x264 path, full test
  suite) and the NVENC steps are marked "check this".
- **[portal/](portal/README.md)**: a 10 MB Caddy you deploy as a second
  Railway service from the same repository (Root Directory `portal/`,
  variables `GPU_HOST` and `CPU_HOST`). It probes your PC's `/healthz` and
  redirects you there when it answers, otherwise to the Railway desktop. It
  redirects, never proxies (no video egress through Railway) and never
  contacts the Railway desktop (so Serverless can keep it asleep).

```
 https://portal...  ->  PC up?  yes -> https://desktop.example.com  (NVENC if it loads, ultra)
                                no  -> https://potatos...railway.app (x264, wakes from sleep)
```

## Profiles

Set the profile with `POTATOS_PROFILE` (default `auto`). A profile only sets
defaults. Any `SELKIES_*` variable you set yourself always wins (setting any
`SELKIES_MANUAL_*` also turns off the profile's fixed resolution), and you can
still change the framerate and quality live from the Selkies sidebar inside
the allowed range.

**`auto`** looks at the CPU count at boot (software x264 cost = pixels × fps,
and it never uses more than 4 threads; see the measurements below). The
count is the smaller of `nproc` and the container's cgroup CPU quota, because
`docker run --cpus 2`, Kubernetes limits and PaaS plans on big hosts limit
with a quota that `nproc` does not see (`potatos info` shows the same number;
the boot log says `Profile 'auto' on N vCPU`). On Railway, run `nproc; cat
/sys/fs/cgroup/cpu.max` in a shell to see what your plan gives you.

| vCPU | What `auto` does |
|---|---|
| 1-2 (a 2-core Codespace, `--cpus 2`, small plans) | 30 fps to start, up to 60; fixed **1280x720** scaled to your window |
| 3-4 | 30 fps to start, up to 60; follows the browser window (1080p-friendly) |
| 5 or more | `balanced`: 60 fps to start, up to 120 |

> **720p on a weak client:** the 720p stream is scaled to the browser window
> on *your* side. A browser with hardware compositing does that for free; one
> without it (blocklisted GPU, VMs, remote sessions) scales in software on
> every frame: measured 108 % of a core for 720p in a 1920x1080 window vs
> 43 % in a 1280x720 window (the image's own Chromium, `--disable-gpu`). On
> such a client keep the window near 1280x720 or use browser zoom, or set
> `POTATOS_RESOLUTION=auto` to stream the window's own size at 30 fps.

All profiles share the measured speed defaults: Turbo mode locked off (it
re-encodes identical frames, 5x the CPU on a still desktop), CRF 28 (about
-27 % bandwidth and -8 % encoder CPU vs CRF 25 at the same fps; CRF 30 would
be -42 %), the window compositor off, Opus at 64 / 96 / 128 kbps for potato
/ balanced / ultra.

> **Switching profiles:** the web client remembers the framerate and quality
> you last used on that site and keeps them if they are inside the new
> profile's range. `potato` uses narrow ranges so old values are discarded,
> but after other switches set the framerate and quality in the Selkies
> sidebar, or clear the site's data in your browser to start from the
> profile's values.

| Profile | Start / max fps | Desktop resolution | Quality (CRF, lower = better) | CBR bitrate | Codecs offered | Good for |
|---|---|---|---|---|---|---|
| `auto` (default) | by vCPU, see above | by vCPU | 28 | 8 Mbps | all | everyone who has not measured their server |
| `potato` | 30 / 30 | fixed **1280x720**, scaled to your window | 30 (26-50) | 3 Mbps (max 6) | H.264, VP8, JPEG | very old PCs, Chromebooks, phones, slow Wi-Fi, 1-2 vCPU servers |
| `balanced` | 60 / 120 | follows the browser window (CSS pixels, so HiDPI screens don't secretly request 4K) | 28 | 8 Mbps | all | 4+ vCPU, 1080p60 |
| `ultra` | 120 / 120 | follows the browser window (CSS pixels), e.g. **2560x1440** for a full window on a 1440p monitor at 100% scaling | 20 | 20 Mbps | all | a [GPU host](#your-own-gpu-pc-and-the-portal), or many dedicated cores; see the numbers below |
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
- Opt-ins, not defaults (measured, see [bench/](bench/)): `SELKIES_ENCODER=jpeg`
  costs 3-10x the bandwidth and 160-180 % CPU on the client;
  `SELKIES_ENCODER=h264enc-striped` saves ~28 % server CPU when only part of
  the screen moves but a software-decoding client drops to ~35 fps on
  full-screen scrolling. `SELKIES_RATE_CONTROL_MODE=cbr` caps the bitrate
  (19 → 5 Mbit/s under heavy motion, +14 % fps on a CPU-starved server) at
  the price of a bit more bandwidth on light motion.

## Idle & sleep

A desktop nobody is looking at should cost nothing. Selkies already stops
capturing and encoding when the last viewer leaves (about 1 % CPU), but the
apps you left open keep running: a browser with a few tabs burns 10-15 % of a
core and phones home every 45 s (keepalives, update checks, DNS). The
`potatos-idle` service handles that:

1. **After `POTATOS_IDLE_MINUTES` (default 10) without a connected viewer** it
   asks XFCE to save the session (which windows are open), then sends
   `SIGSTOP` to every desktop process except the streaming core (X server,
   Selkies, PulseAudio, D-Bus) and kills the browser's network-service
   process so its sockets close (Chromium respawns it in ~1 s when it
   continues). Measured: **0.6-0.9 % CPU and 0 outbound packets** while
   frozen, versus 9-13 % and ~4 packets/s with the same apps running.
2. **A page load or a new connection thaws everything** (`SIGCONT`), about
   0.2 s before the first frame, so you never see a stale picture. Only
   requests nginx answered with 2xx, 101 or 304 count: an internet scanner hitting a
   password-protected URL (401) or a wrong path (404) does not wake the
   desktop. `docker stop` thaws first too, so apps shut down cleanly.
3. **Memory is not freed by freezing** (there is no swap). Only the platform
   putting the service to sleep stops the RAM bill.

`potatos idle status` shows the state, `potatos idle pause` / `resume` freeze
and thaw by hand. `POTATOS_IDLE_MINUTES=0` turns the watcher off.
`POTATOS_IDLE_ACTION=log` only logs what it would do (nothing is frozen or
stopped, not even a Codespace). `POTATOS_IDLE_ACTION=halt`
stops the whole container instead (exit code 0); that only makes sense with
a restart policy that does *not* restart a clean exit (`restart: on-failure`),
and nothing inside the container can wake it again, so prefer freeze plus
the platform's own sleep.

### Railway Serverless

Railway's Serverless mode (Settings → Deploy → Serverless, then Redeploy)
sleeps a service that has sent **no outbound packets for 5-10 minutes**; an
inbound request wakes it. Inbound traffic itself is not measured, but
anything the service sends back is, so an open desktop tab keeps it awake,
and so does a browser inside the desktop checking for updates. PotatOS makes
the container go quiet: once frozen it sends nothing, and 5-10 minutes later
Railway sleeps the service. Expect, in order:

- 0-10 min after you leave: desktop running, ~1 % CPU with nothing open,
  9-13 % with a browser open (and it keeps sending packets, so Railway will
  not sleep yet), RAM billed.
- 10 min: frozen. CPU ~0, still RAM billed.
- 15-20 min: asleep. No compute charges; volume storage ($0.15/GB-month) still
  billed.
- You come back: the **first request may return a 502** from Railway's edge
  while the container boots (10-30 s). Refresh. Once nginx is up you get a
  branded "PotatOS is waking up" page that reloads itself until the streaming
  server answers. The previous session is restored: XFCE reopens its apps
  (terminal, file manager, editor), and the browser that was open comes back
  with its tabs (Chromium `--restore-last-session`; Firefox
  `browser.startup.page=3`). The new container has a new host name, so the
  Chromium wrapper first removes the profile lock the old one left behind
  (otherwise Chromium would refuse to start: "profile in use on another
  computer"); tested with a fresh container on the same volume.

Cost model: CPU is billed on actual use ($20/vCPU-month), RAM on what the
processes hold ($10/GB-month), egress at $0.05/GB. A frozen desktop stops the
CPU charge immediately; sleep stops the RAM charge (an idle desktop holds
~250 MB, ~500 MB with a browser open). Keep `restartPolicyType` at
`ON_FAILURE` or `ALWAYS`; never use "exit 0" as a sleep mechanism, a
Completed deployment does not wake on HTTP.

A tab you forgot in the background would keep the WebSocket open and the
service awake, so the web client lets go after 10 minutes hidden, also when
the tab was opened in the background to begin with (see
[pausing](#pausing-hidden-and-idle-tabs)).

### Codespaces

See [Quick start → Codespaces](#3-github-codespaces): forwarded-port traffic
does not count as activity for GitHub's idle timeout (raise it), and a
`POTATOS_GH_TOKEN` secret lets PotatOS stop the codespace after its own idle
timeout. `potatos codespaces-setup` (run by `.devcontainer`) stores the token
root-only in `/config/.potatos/gh-token` together with the codespace's name
(the watcher service does not see `CODESPACE_NAME` itself), and the watcher
logs at start whether the stop is armed. Only the idle timeout stops the
codespace: `potatos idle pause`, quiet-hours input-idle freezes and
`POTATOS_IDLE_ACTION=log` do not. Failures are logged, nothing else.

### Quiet hours

`POTATOS_QUIET_HOURS="01-07"` (off by default; hours in the container's `TZ`,
wrapping past midnight allowed, e.g. `23-06`). Inside the window the idle
timeout drops to 1 minute, and a viewer who is connected but has not touched
the mouse or keyboard for 5 minutes (`POTATOS_QUIET_INPUT_MINUTES`) is
treated as idle too (counted from the moment they connected): the server
freezes the desktop (input thaws it, also once the window is over) and the
browser tab goes to the paused page. Unset = nothing happens; `07-07` or
`00-24` is rejected rather than read as "always".

### Session restore

Three pieces make "open apps come back after a sleep" work; all are seeded on
the first boot of a `/config` volume and can be changed inside the desktop:

- `xfce4-session` saves the session on logout (`SaveOnExit`), and the idle
  watcher asks it to checkpoint before every freeze, when the viewer leaves,
  every 5 minutes while one is connected (`POTATOS_IDLE_CHECKPOINT_SECONDS`)
  and at shutdown: the watcher is an s6 service that depends on the desktop
  service and the system bus, so `docker stop`, a redeploy or a Codespace
  stop ends the watcher (checkpoint) *before* the desktop is torn down. A `SIGKILL` loses at most
  the last 5 minutes. XFCE names the saved session after the host name,
  which changes with every Railway deploy; PotatOS copies the newest one to
  the current name at boot. Apps that speak XSMP come back (xfce4-terminal,
  Thunar windows...); Mousepad does not.
- Browsers are not session clients, so the watcher notes which ones were
  running and `potatos-session` starts them again at login with their own
  restore: Chromium with `--restore-last-session` (the wrapper also clears
  the "didn't shut down correctly" state and a stale profile lock from a
  previous container; `potatos-session` does the same for Firefox's
  `.parentlock`), Firefox through `/etc/firefox/policies/policies.json`.
- Tested here (`tests/e2e`): two Chromium tabs → freeze → `docker kill` →
  a **new container on the same volume** → both tabs reopened; then
  `docker stop` while the desktop was in use → `docker start` → tabs back.

## The browser tab: HUD, eco mode, privacy shade, pausing

Everything in this section runs in your browser (`potatos.js`, injected into
the Selkies page). Settings come from environment variables and are
generated into `/potatos-config.js` at boot, no rebuild needed.

### HUD

A small overlay, bottom-right by default (the XFCE clock is top-right), shows
`1920x1080  58/60 fps  h264  6.5 Mbit/s  4 ms [ECO] [HW]` once a second:
stream resolution, frames received / target, codec, bandwidth, round-trip
time, eco mode active, hardware encoder in use. It ignores the mouse. The
small orange square next to it toggles the HUD (remembered per browser).
`POTATOS_HUD=off` removes it entirely; `POTATOS_HUD_CORNER=top-left|top-right|bottom-left|bottom-right`
moves it.

### Eco mode

Only matters when the target framerate is **above 60**. After 30 seconds
(`POTATOS_ECO_SECONDS`) without mouse or keyboard input the client lowers the
target to 60; the first input puts the original target back. It never goes
below 60 and does nothing at 60 or less, so video playback stays smooth. It
uses the same `settings` message the sidebar's slider sends, so the server
applies it live (`Applying video settings ... live (no restart)` in the log)
and the HUD shows `[ECO]`. What it saves is capture work, not frames: at a
120 fps target the screen is grabbed 120 times a second even when the page
only changes 60 times (the encoder, with Turbo off, only emits changed
frames). Measured with a 60 Hz CSS animation, H.264 1080p, 4 vCPU: eco
halves the grabs, Selkies CPU -21 %, Xvfb -37 %, encoded fps unchanged at
60. `POTATOS_ECO=off` disables it. The marker that remembers the original
target is per tab; leaving the page (pause, close) restores the target so
the next client does not start at 60.

### Privacy shade

On by default: when the tab goes to the background the stream is blurred
(CSS) and a "click or press a key to show the desktop" overlay appears. It
stays blurred until you click or press a key, so someone glancing at your
screen while you switch tabs sees nothing. `POTATOS_PRIVACY_SHADE=focus`
also blurs when the browser window loses focus; `off` disables it.

### Pausing: hidden and idle tabs

- A PotatOS tab **hidden for 10 minutes** (`POTATOS_HIDDEN_TAB_MINUTES`)
  navigates to a static "PotatOS is paused, click to resume" page. That
  closes the WebSocket: the server sees 0 viewers, freezes after its own
  timeout, and a forgotten tab can no longer keep a Railway service awake or
  spam a sleeping one with reconnects. A tab opened in the background
  (middle-click) counts as hidden from the start. Switching back to the tab
  resumes automatically.
- A **visible tab with no input and a static screen** for 30 minutes
  (`POTATOS_TAB_IDLE_MINUTES`) first shows a 60-second countdown banner
  ("No activity: pausing the desktop in 42 s. Move the mouse to stay."), then
  goes to the paused page. "Static" means fewer than 5 frames/s arrive; the
  screen counts as moving only when 5 fps or more keep arriving for 5
  seconds in a row, because the panel clock's redraw once a minute causes a
  1-2 s burst of frames that must not restart a 30-minute timer. A video
  playing, or anything else that keeps the screen changing, cancels it.
- The paused page makes no requests. Resume probes `api/health` first; if the
  service is asleep it shows "Waking the desktop up…" and retries every 3 s
  until the server answers, then reloads the desktop. The page is served
  without a login, so it only ever navigates back to a path on its own origin.
- `0` disables either timer.

## Browser choice: Chromium or Firefox

Both are installed (Firefox is in the default `POTATOS_APK_PACKAGES`).
`POTATOS_BROWSER=chromium` (default) or `firefox` picks the one the
**Browser** desktop launcher opens and the default browser for links
(`mimeapps.list`, XFCE's `helpers.rc`). The default is written when it is
unset or when `POTATOS_BROWSER` changes between boots, so a choice you make
inside the desktop (Settings → Default Applications) stays. If the chosen
browser is not installed, the launcher falls back to whichever one is.
Firefox gets a system policy (`/etc/firefox/policies/policies.json`): restore
the previous session on every start, no update checks, no first-run page.
`potatos info` shows the current choice.

On the Debian/GPU image (`Dockerfile.gpu`) Firefox is Debian's `firefox-esr`
(linked to `firefox`, same policy), and two more browsers are available:
`potatos install-browser chrome` or `brave` adds the vendor's apt repository,
installs it and registers a container-friendly launcher; then
`POTATOS_BROWSER=chrome|brave` works like the others (session restore via
`--restore-last-session` at login). Packages live in the container layer, so
re-run it after a rebuild. On the Alpine image these two values fall back to
Chromium with a warning.

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
  what Chrome, Edge, Safari and Firefox get). Cost = pixels × frames per
  second × how much of the screen changes. x264 runs `ultrafast`/`zerolatency`
  and uses at most **4 threads**, so more than 4 vCPU does not make one
  stream faster.
- **Measured** with the harness in [bench/](bench/) (H.264 to a real Chromium
  client, a 4-vCPU box shared with other work, so treat ±10 % as noise):

  | Workload | vCPU | Container CPU (% of one core) | Selkies / Xvfb / app | fps got / target | Mbit/s |
  |---|---|---|---|---|---|
  | Idle, no viewer | 2 | 1 | 0.6 / 0 / - | - | 0 |
  | Idle, viewer connected, 1080p, static screen | 2 | 17-21 | 8 / 8 / - | 0 | 0 |
  | Idle, tab hidden | 2 | 4 | 1.5 / 0 / - | - | 0 |
  | Idle, desktop frozen (apps open) | 4 | 0.9 | 0.6 / 0 / 0 | - | 0 |
  | Terminal scroll + CSS animation, 720p, 30 fps target (potato) | 2 | 174 | 20 / 20 / 50 | 31 / 30 | 8.6 |
  | Same, 720p60 | 2 | 185 | 34 / 21 / 49 | 60 / 60 | 17.5 |
  | Same, 1080p60 | 2 | 182-196 (limit hit) | 44 / 35 / 58 | **40-45** / 60 | 20 |
  | Same, 1080p60 | 4 | 230 | 58 / 41 / 67 | 57 / 60 | 25 |
  | Same, **1440p, 120 fps target (ultra)** | 4 | 240 | 63 / 52 / 75 | **35** / 120 | 28 |
  | Terminal scroll only, 1080p60 | 2 | 188 | 60 / 45 / - | 60 / 60 | **29** |
  | Same motion, **`auto` default** (720p30) | 2 | 161 | 20 / 17 / - | 31 / 30 | 9.9 |
  | Same motion, **`auto` default** (1080p30) | 4 | 224 | 36 / 37 / - | 31 / 30 | 17.7 |
  | Idle, viewer connected, static screen, `auto` | 2 / 4 | 8 / 12 | - | 0 | 0 |

  What moves the needle: 1080p → 720p cuts streaming CPU ~45-54 % (and the
  apps' own rendering ~44 %); 60 → 30 fps cuts Selkies CPU ~38-42 % (the
  cost per frame is roughly constant on light motion; under constant motion
  each 30-fps frame carries more change, 10 → 11.6 ms); CRF 25 → 28 cuts
  bandwidth ~27 % (30: ~42 %) with no fps change. Codec/encoder switches
  move things by about ±10 %. That is why `auto` starts at 30 fps on small
  hosts: against the old 1080p60 default it is -53 % Selkies CPU and half
  the bandwidth on 2 vCPU (the `bench/` harness reproduces every row;
  `--cpuset` for the 2-vCPU ones).
- **2K at 120 fps is not reachable in software.** On 4 vCPU, 1440p costs
  ~18 ms of CPU per frame and managed 35 fps; x264 cannot use more than 4
  threads. "1440p at 30-60 fps on 6-8 dedicated vCPU" is realistic; 2K/120
  needs a host with a GPU encoder (NVENC/VA-API), which Railway and
  Codespaces do not have. The `ultra` profile allows it; it does not promise it.
  For a PC with an NVIDIA card, see [the GPU variant](#your-own-gpu-pc-and-the-portal).
- **A visible tab with nobody touching it is the real waste** (17-21 % of a
  core at 1080p60 for a still screen: capture copies the screen every tick).
  That is what the hidden-tab pause, the idle countdown and the idle freeze
  are for.
- **Bandwidth and Railway egress.** CRF mode ignores the bitrate cap on busy
  screens: a 1080p60 terminal scroll measured 29 Mbit/s. Rule of thumb:
  **GB per hour ≈ Mbit/s × 0.45**, so that scroll is ~13 GB/h, about $0.65/h
  at Railway's $0.05/GB; a typical desktop session (2-6 Mbit/s) is 1-3 GB/h.
  To bound it, raise the CRF (`SELKIES_VIDEO_CRF=32,5-50`) or switch to
  constant bitrate (`SELKIES_RATE_CONTROL_MODE=cbr SELKIES_VIDEO_BITRATE=4000,500-8000`),
  which measured 5 Mbit/s instead of 19 under heavy motion. The HUD shows the
  live Mbit/s.
- **If the server can't keep up,** frames are dropped rather than queued, so
  input stays responsive; over a TCP proxy Selkies tolerates up to ~2 s of
  backlog before dropping, so keep the bitrate under what the path carries.
  Use the HUD, `potatos info` and `htop` to see what is going on.
- **Client side:** any current Chrome, Edge, Firefox or Safari. The client
  decodes H.264 (usually in hardware) and draws it, which is far lighter than
  running the apps. For very weak clients, use `potato` and a smaller browser
  window.
- **Latency:** mostly network round-trip time (the HUD shows it). Pick a
  server region near you; on Codespaces set the region by hand (`gh codespace
  create --location`), on Railway in the service settings. Neither platform
  offers UDP, so WebRTC would not be faster than the WebSocket transport.

## Security

- **Set `PASSWORD` for anything reachable from the internet.** nginx then
  requires HTTP basic auth for every page and the streaming WebSocket. The
  user is `CUSTOM_USER`, default `abc`. Only `/healthz` (returns `ok`) and
  the two static PotatOS pages `/potatos-paused.html` and
  `/potatos-waking.html` stay open; everything else, including the
  WebSocket, requires the login. The pages contain nothing but text and only
  navigate back to their own origin.
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

- First-boot setup (desktop launchers, wallpaper, session saving, the default
  browser) runs once per volume. Anything you change or delete afterwards
  stays that way (`POTATOS_BROWSER` is re-applied only when its value changes).
- Open apps and browser tabs are restored after a restart or a platform
  sleep; see [Session restore](#session-restore).
- Packages installed with `apk` / `potatos install` live in the container, not
  in `/config`, so they are gone after a redeploy. Put packages you always
  want in `POTATOS_EXTRA_PACKAGES="firefox gimp"`, which installs them at
  every start, or add them to the Dockerfile.

## Configuration reference

| Variable | Default | What it does |
|---|---|---|
| `POTATOS_PROFILE` | `auto` | `auto`, `potato`, `balanced`, `ultra`, `custom` (see [Profiles](#profiles)) |
| `POTATOS_RESOLUTION` | profile (`1280x720` for potato / small `auto`, else `auto`) | `auto` or `WIDTHxHEIGHT` |
| `POTATOS_IDLE_MINUTES` | `10` | freeze the desktop after N minutes without a viewer; `0` = off |
| `POTATOS_IDLE_ACTION` | `freeze` | `freeze`, `halt` (stop the container; needs `restart: on-failure`), `log` |
| `POTATOS_IDLE_CHECKPOINT_SECONDS` | `300` | how often the session is checkpointed while a viewer is connected |
| `POTATOS_QUIET_HOURS` | empty (off) | `HH-HH` in `TZ`, e.g. `01-07` (start ≠ end): 1-min idle timeout, input-idle viewers frozen |
| `POTATOS_QUIET_INPUT_MINUTES` | `5` | minutes without input that count as idle during quiet hours |
| `POTATOS_HIDDEN_TAB_MINUTES` | `10` | hidden tab → paused page; `0` = never |
| `POTATOS_TAB_IDLE_MINUTES` | `30` | visible tab, no input, static screen → countdown + paused page; `0` = never |
| `POTATOS_ECO` / `POTATOS_ECO_SECONDS` | `on` / `30` | above 60 fps: drop to 60 after N s without input |
| `POTATOS_HUD` / `POTATOS_HUD_CORNER` | `on` / `bottom-right` | stats overlay |
| `POTATOS_PRIVACY_SHADE` | `hidden` | `off`, `hidden` (blur when the tab is hidden), `focus` (also on window blur) |
| `POTATOS_BROWSER` | `chromium` | `chromium` or `firefox` (Debian image also `chrome`, `brave` after `potatos install-browser`): default browser + Browser launcher |
| `POTATOS_GH_TOKEN` | empty | Codespaces secret: stop the codespace after the idle timeout |
| `PASSWORD` | empty | enables login (basic auth) |
| `CUSTOM_USER` | `abc` | login user name |
| `POTATOS_REQUIRE_PASSWORD` | `true` on Railway, else `false` | generate a password when `PASSWORD` is empty |
| `POTATOS_PASSWORD` | empty | Codespaces secret applied by `potatos codespaces-setup` |
| `SELKIES_ALLOWED_ORIGINS` | empty (same-origin only) | extra web origins allowed to open the stream |
| `POTATOS_EXTRA_PACKAGES` | empty | packages to install at each start (`apk` on the Alpine image, `apt` on the Debian one) |
| `PORT` | set by Railway | HTTP port, used when `CUSTOM_PORT` is not set |
| `CUSTOM_PORT` / `CUSTOM_HTTPS_PORT` | `3000` / `3001` | HTTP / HTTPS ports |
| `PUID` / `PGID` | `911` / `911` | owner of files in `/config` (set to your `id -u` / `id -g`) |
| `TZ` | `Etc/UTC` | time zone |
| `TITLE` | `PotatOS` | browser tab title |
| `SELKIES_VIDEO_STREAMING_MODE` | `false\|locked` | Turbo (encode every frame) locked off; `true` to allow it |
| `SELKIES_*` | from profile | any Selkies streaming setting |
| `START_DOCKER` | `false` | the base image would start a Docker daemon in privileged containers |
| `NO_WEBCAM`, `HARDEN_DESKTOP`, `SUBFOLDER`, `DISABLE_IPV6`, ... | | see [linuxserver/webtop](https://github.com/linuxserver/docker-webtop) |

Build arguments: `POTATOS_APK_PACKAGES` (default `"htop mpv galculator firefox"`)
for `Dockerfile`, `POTATOS_APT_PACKAGES` (default `"htop mpv galculator firefox-esr"`)
for `Dockerfile.gpu`. Leave them empty for offline builds or when the mirror
is unreachable: `docker compose build --build-arg POTATOS_APK_PACKAGES= && docker compose up -d`.

Inside the desktop, run `potatos help`:

```
potatos info               show profile, streaming settings and resources
potatos install <pkg>...   install packages (apk), e.g. potatos install gimp
potatos search <term>      search packages
potatos install-browser chrome|brave   (Debian/GPU image) add the vendor repo and install it
potatos set-password [pw]  require a login (user abc); --off removes it
potatos allow-origin <url> allow a web origin to open the stream (behind Host-rewriting proxies;
                           saved in /config/.potatos/allowed-origins)
potatos idle [status]      is the desktop frozen? (potatos-idle service)
potatos idle pause|resume  freeze / thaw the desktop now
potatos codespaces-setup   used by .devcontainer (origin, password and GitHub token from secrets)
potatos help               this help
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Railway asks for a login you never set | The password is in the deploy logs (`PotatOS login`). User `abc`. Or set `PASSWORD`. |
| Railway deploy fails its health check | Check the logs for `[potatos]` lines. Don't set `CUSTOM_PORT` on Railway; let `PORT` work. Set `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300` so the first boot has time. |
| Railway URL answers `400 Bad Request` | The domain targets port 3001. Edit the domain and pick the `PORT` value (usually 8080). |
| "PotatOS: still waiting for the stream" after 20 s, logs show `403` for `/api/websockets` | A proxy in front rewrites the `Host` header. Set `SELKIES_ALLOWED_ORIGINS=https://<your-public-host>` or run `potatos allow-origin https://<your-public-host>`. |
| Black or grey screen | Wait 10-20 s on first boot. Reload the page. Check `docker logs potatos` for errors. |
| Chromium tabs crash ("Aw, Snap!") | Give the container more shared memory (`--shm-size=1g`, `shm_size` in Compose, `RAILWAY_SHM_SIZE_BYTES=1073741824` on Railway). Below 512 MB PotatOS already falls back to `/tmp`. |
| Mic or webcam never asks for permission | You need HTTPS or localhost (see [above](#microphone-webcam-and-https)). Check the browser's site permissions. The prompt only appears when an app actually uses the device. |
| Laggy or stuttering | Look at the HUD: fps far below the target means the server is maxed out (`htop`); a high rtt means the network. Use `POTATOS_PROFILE=potato`, lower the fps in the sidebar, shrink the browser window, or add vCPUs. If a profile change seems ignored, the browser remembered old settings: set fps/quality in the sidebar or clear the site's data. |
| First visit after a while shows a 502, or "PotatOS is waking up" | The service was asleep (Railway Serverless) or is booting. Refresh after a few seconds; the waking page reloads by itself. |
| Tab says "PotatOS is paused" | It was in the background for 10 min, or idle with a still screen for 30 min. Click Resume. Tune with `POTATOS_HIDDEN_TAB_MINUTES` / `POTATOS_TAB_IDLE_MINUTES` (`0` = never). |
| Screen is blurred with "click or press a key" | The privacy shade (tab was hidden). Click it, or set `POTATOS_PRIVACY_SHADE=off`. |
| Framerate drops to 60 by itself | Eco mode, after 30 s without input above 60 fps; any input restores it. `POTATOS_ECO=off` to disable. |
| Desktop seems frozen after coming back | It should thaw on the page load. `potatos idle status` tells; `potatos idle resume` forces it. If a download was running when it froze, it was cut (the browser's network service is closed on freeze). |
| Apps did not come back after a restart | Only apps open at the last checkpoint (freeze, viewer leaving, every 5 min while connected, clean stop) are saved, and only XSMP-aware ones plus the browser. A `/config` volume is required. |
| Chromium does not start, log says "profile appears to be in use ... on another computer" | A stale profile lock from a previous container. The wrapper removes it by itself; if you started Chromium another way: `rm ~/.config/chromium/Singleton*`. |
| Codespace stopped while I was using the desktop | GitHub's idle timeout ignores forwarded-port traffic. Raise Settings → Codespaces → Default idle timeout. |
| Mic or webcam still asked for after disabling | Use `SELKIES_MICROPHONE_ENABLED=false` / `NO_WEBCAM=1` (PotatOS locks them off); check `potatos info`. |
| Blurry text | The `potato` profile locks 720p. Set `POTATOS_RESOLUTION=auto`, or use `balanced`. |
| GPU host: HUD shows no `[HW]`, log says `Encoder: CPU (x264)` | NVENC did not load. Run the four checks in [docs/gpu-host.md](docs/gpu-host.md#check-the-gpu-four-commands); the usual causes are a driver older than 570, missing WSL libraries, or the EGL-symbol blocker. |
| `nginx: socket() [::]:3000 failed` | Host without IPv6. PotatOS detects this and drops the IPv6 listeners automatically. You can also set `DISABLE_IPV6=true`. |
| Want a fresh desktop | Stop the container, delete the `/config` volume (`sudo rm -rf ./data`: `.potatos/` inside it is root-owned because it holds password files), start again. |

## Tests and benchmark

```bash
# Build the image, boot 6 containers (default, PORT remap + Firefox, PASSWORD,
# Railway mode, overrides, idle) and check health, HTTP/HTTPS, auth, the
# WebSocket origin guard, profiles, overrides, the generated client config, the
# waking/paused pages, an H.264 stream to the image's own Chromium, and the idle
# watcher: freeze after 20 s, processes in state T, 0 outbound packets in 30 s,
# thaw on a page request, `potatos idle pause|resume`, quiet-hours parsing.
scripts/smoke-test.sh                     # BUILD_ARGS='--build-arg POTATOS_APK_PACKAGES=' offline
# The same suite against the Debian/GPU image (no GPU needed: x264 path):
DOCKERFILE=Dockerfile.gpu IMAGE=potatos:gpu BUILD_ARGS='--build-arg POTATOS_APT_PACKAGES=' scripts/smoke-test.sh

# Drive the real desktop in headless Chromium: non-blank frames, right-click,
# the Text Editor launcher, Ctrl+Alt+T + typing, then the HUD, privacy shade,
# eco mode (120 -> 60 -> 120), the idle countdown after 90 s of a static desktop,
# the hidden-tab pause (server sees 0 sessions; also for a tab hidden from the
# start) and session restore: into a NEW container on the same /config volume
# after `docker kill`, then after a plain `docker stop` while in use.
# Screenshots land in tests/e2e/screenshots/. The eco step needs a profile whose
# range reaches 120 fps, so start the container with POTATOS_PROFILE=balanced,
# and the new-container step needs a volume at /config.
docker run -d --name potatos -p 3000:3000 --shm-size=1g -v potatos-e2e:/config -e POTATOS_PROFILE=balanced potatos
cd tests/e2e && npm install
POTATOS_URL=http://localhost:3000 POTATOS_CONTAINER=potatos node desktop.test.mjs

# Reproduce the performance numbers (one fresh container + real H.264 client per run):
cd bench && npm install && ./run-matrix.sh matrix-example.txt 2 results.jsonl && node summarize.mjs results.jsonl --base anim-base
```

The e2e test uses `playwright-core` with an already installed Chromium
(`CHROMIUM_PATH`, or `PLAYWRIGHT_BROWSERS_PATH`). It never downloads browsers.
Set `POTATOS_PASSWORD` if the desktop has a password. It logs the negotiated
codec; Playwright's Chromium cannot decode H.264, so it streams AV1 or VP8
(the smoke test covers H.264). `EXPECT_CODEC=H264` with an H.264-capable
`CHROMIUM_PATH` asserts the real-user path.

## Project layout

```
Dockerfile                    FROM linuxserver/webtop (Alpine) + apps + rootfs/ + HEALTHCHECK, injects potatos.js
Dockerfile.gpu                FROM linuxserver/webtop:debian-xfce (glibc: NVENC-capable), same rootfs/
docker-compose.gpu.yml        GPU desktop + Caddy (HTTPS) for a Windows/Linux PC; .env.gpu.example; caddy/Caddyfile
portal/                       Railway redirector (Caddy): PC up -> GPU desktop, else -> Railway desktop
docs/gpu-host.md              Windows 11 + NVIDIA setup, GPU checks, router, uptime
rootfs/usr/share/potatos/lib.sh  Alpine/Debian differences (apk/apt, nginx path, browser names)
rootfs/custom-cont-init.d/    boot scripts (run as root before services start)
  05-potatos-packages           POTATOS_EXTRA_PACKAGES
  10-potatos-port               PORT -> nginx, /healthz, IPv6 auto-detect, waking page on 5xx
  20-potatos-profile            POTATOS_PROFILE (auto by vCPU) -> SELKIES_* defaults, mic/cam policy
  30-potatos-security           WebSocket origin guard, auto/saved password
  40-potatos-desktop            first-boot launchers, default browser, session-file host name
  50-potatos-web                env -> /potatos-config.js for the web client
rootfs/etc/s6-overlay/s6-rc.d/svc-potatos-idle/
                              the idle watcher (s6-rc longrun, root; depends on svc-de so it checkpoints before the desktop stops)
rootfs/usr/share/selkies/selkies-dashboard/
                              potatos.js/.css (HUD, eco, shade, pausing), potatos-paused.html, potatos-waking.html
rootfs/defaults/xfce/         first-boot XFCE settings (wallpaper, session saving)
rootfs/etc/firefox/policies/  Firefox: session restore, no update checks
rootfs/usr/share/potatos/     wallpaper.svg, desktop launchers
rootfs/usr/local/bin/         potatos CLI, healthcheck, chromium wrapper (shm + restore), potatos-browser, potatos-session
rootfs/etc/xdg/autostart/     runs potatos-session at login (trusted launchers, browser restore)
railway.json                  legacy Railway Config-as-Code (ignored by new services, and by all after 2026-12-01)
.gitattributes                LF line endings everywhere (a CRLF checkout on Windows would break every script in the image)
.devcontainer/                GitHub Codespaces
docker-compose.yml            local use
scripts/smoke-test.sh         container-level tests
tests/e2e/                    browser-level test (Playwright)
bench/                        performance harness behind the numbers above
```

## License

MIT, see [LICENSE](LICENSE). Base images and bundled software keep their own
licenses (linuxserver/webtop: GPL-3.0; Selkies: MPL-2.0; Alpine packages:
various).
