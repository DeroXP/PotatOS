# PotatOS on your own PC: Windows 11 + NVIDIA

Railway and Codespaces have no GPU, so there the screen is encoded in software
(x264: ~35 fps at 1440p on 4 vCPU, see the README's *Performance*). An NVIDIA
card at home has a dedicated video encoder (NVENC) that does 2560x1440 at
120 fps as a side job. This page sets up the **Debian/GPU variant of PotatOS**
(`Dockerfile.gpu`, `docker-compose.gpu.yml`) on a Windows 11 PC with Docker
Desktop, puts it behind HTTPS on your own domain, and explains what to expect.

Nothing on this page could be tested on a real GPU while it was written (the
build machine has none). The Debian image itself boots and passes the test
suite without a GPU (plain x264); the NVENC part follows NVIDIA's and
pixelflux's documentation and is marked **check this** where you have to
confirm it on your PC.

**Contents:** [What you get](#what-you-get-and-what-you-do-not) ·
[Prerequisites](#prerequisites) · [Check the GPU](#check-the-gpu-four-commands) ·
[Domain and router](#domain-and-router) · [First run](#first-run) ·
[If NVENC does not load](#if-nvenc-does-not-load) · [Uptime](#uptime-notes) ·
[Windows + Railway + portal](#windows--railway--portal) · [Keeping it safe](#keeping-it-safe)

## What you get, and what you do not

Docker Desktop runs Linux containers inside WSL2. WSL2 exposes an NVIDIA
GPU to Linux through *paravirtualisation* (`/dev/dxg` plus the driver's CUDA
and NVENC libraries), **not** as a normal Linux GPU (`/dev/dri`, OpenGL/Vulkan
rendering):

| | Native Linux (dual boot) | Windows 11 + Docker Desktop (this page) |
|---|---|---|
| Video **encoding** on the GPU (NVENC) | yes | yes (**check this**, see below) |
| Apps and the desktop **render** on the GPU | yes (GPU-backed X server, zero-copy capture) | no: Xvfb and Chromium render on the CPU |
| Frame path | screen stays on the GPU | each frame (14.7 MB at 1440p) is copied CPU → GPU, ~1.8 GB/s at 120 fps |
| Officially supported by linuxserver/Selkies | yes | no (community reports only) |

So on Windows: the expensive part, encoding, moves to the GPU, and the HUD
shows **`[HW]`**; the CPU still runs Xvfb, the window manager and your apps.
A modern 6-core CPU is fine for a browser-and-terminal desktop at 2K; a
heavy web app or video playing inside the desktop costs what it costs
without PotatOS.

## Prerequisites

- Windows 11, an NVIDIA GPU (GTX 10xx or newer; AV1 encode needs RTX 40xx),
  a few GB of free RAM for WSL.
- **NVIDIA driver 570 or newer** (595+ preferred; that is what NVIDIA
  validates for CUDA on WSL in 2026). Install the normal Windows driver
  from nvidia.com; do **not** install a Linux driver inside WSL.
- **Docker Desktop** with the **WSL 2 backend** (Settings → General → "Use
  the WSL 2 based engine"), then `wsl --update` in a terminal and a reboot.
  Docker Desktop's GPU support (`--gpus`) exists only with the WSL 2 backend.
- A domain name you control (or a free DDNS name), and access to your
  router's port forwarding.
- Upload bandwidth of at least 1.5x the stream bitrate: 2K at 120 fps is
  20-75 Mbit/s depending on what moves; gigabit is plenty.

Optional: `%USERPROFILE%\.wslconfig` to size WSL, for example

```
[wsl2]
memory=8GB
processors=6
```

## Check the GPU (four commands)

Run these in PowerShell or Windows Terminal. Each one isolates one layer.

**1. Does Docker see the GPU at all?**

```powershell
docker run --rm --gpus=all nvcr.io/nvidia/k8s/cuda-sample:nbody nbody -gpu -benchmark
```

Expected: a few lines ending in `... GFLOP/s`. If it fails with "could not
select device driver" or "no NVIDIA device", fix Docker Desktop / WSL / the
driver first; nothing below can work.

Now build and start PotatOS (see [First run](#first-run) for the `.env`
file), then run the remaining checks inside the container:

**2. Is the WSL GPU device and the encoder library in the container?**

```powershell
docker exec potatos-gpu sh -c 'ls -l /dev/dxg; ldconfig -p | grep -E "libcuda|libnvidia-encode"'
```

Expected: `/dev/dxg` is listed and both `libcuda.so.1` and
`libnvidia-encode.so.1` appear. If the libraries are missing, Docker's NVIDIA
hook did not mount them: add to the service in `docker-compose.gpu.yml`

```yaml
    volumes:
      - /usr/lib/wsl:/usr/lib/wsl:ro
    environment:
      - LD_LIBRARY_PATH=/usr/lib/wsl/lib
```

(the libraries live in `/usr/lib/wsl/lib` = `C:\Windows\System32\lxss\lib`).

**3. The possible blocker: EGL interop symbols.** pixelflux (the Selkies
capture/encode engine) loads two CUDA↔EGL functions as *mandatory* when it
opens NVENC. A 2022 report found them missing from WSL's `libcuda`. Check:

```powershell
docker exec potatos-gpu /lsiopy/bin/python3 -c "import ctypes;l=ctypes.CDLL('libcuda.so.1');l.cuGraphicsEGLRegisterImage;l.cuGraphicsResourceGetMappedEglFrame;print('ok')"
```

Expected: `ok`. An `AttributeError` means pixelflux's NVENC backend cannot
load on this WSL driver; it then logs `Missing symbol ...` and silently uses
x264. The upstream fix is one line (make the two symbols optional); until
then, a newer NVIDIA driver is the only thing to try. **Check this.**

**4. What does pixelflux pick?**

```powershell
docker exec potatos-gpu /lsiopy/bin/python3 -c "import pixelflux;print(pixelflux.hardware_encoders(-2,'true'))"
docker logs potatos-gpu 2>&1 | Select-String -Pattern 'Encoder:|NVENC|libcuda'
```

Expected: something like `{'h264': 'nvenc', ...}`, and after you connect a
browser the log shows `Encoder: NVENC H.264` (instead of `Encoder: CPU
(x264)`). Inside the desktop, `potatos info` prints the GPU line, and the HUD
in the browser tab shows `[HW]`.

Why `/dev/dri` is **not** passed into the container: pixelflux picks NVENC
when the container has *no* render node or one whose driver is `nvidia`.
WSL's only render node is a dummy `vgem`, which would make it try VA-API
(and fail) instead. Likewise `cuMemHostRegister` (pinned memory) is
unsupported on WSL; pixelflux falls back to pageable copies, which may cap
the upload rate at very high resolutions.

## Domain and router

1. **Name → home IP.** If your ISP gives you a changing IP, use dynamic DNS:
   either your router's built-in DDNS client, or one of the commented `ddns`
   services in `docker-compose.gpu.yml` (DuckDNS gives a free
   `something.duckdns.org`; the Cloudflare updater needs a domain on
   Cloudflare with an API token). The DNS record must point at your IP
   *directly*: no Cloudflare proxy ("orange cloud"), which would route the
   video through Cloudflare and breaks their free-plan terms.
2. **Router → PC.** Forward **TCP 443** from the internet to this PC's LAN IP
   (give the PC a fixed LAN IP or a DHCP reservation first). Optionally
   forward TCP 80 too: Caddy then gets its certificate with HTTP-01 as well
   and redirects `http://` visitors to `https://`; with 443 alone it uses
   TLS-ALPN, which works fine. UDP 443 enables HTTP/3 (optional).
3. **Windows firewall.** Docker Desktop opens published ports through its own
   backend; if Windows asks the first time, allow "Docker Desktop Backend"
   on private *and* public networks.
4. Many home routers cannot reach their own public address from inside the
   LAN ("hairpin NAT"). Test from a phone on mobile data, or add
   `<LAN-IP>  desktop.example.com` to `C:\Windows\System32\drivers\etc\hosts`
   on the PCs at home.

## First run

```powershell
git clone https://github.com/DeroXP/PotatOS.git
cd PotatOS
copy .env.gpu.example .env          # then edit: POTATOS_DOMAIN, PASSWORD, TZ (POTATOS_BROWSER optional)
docker compose -f docker-compose.gpu.yml up -d --build
docker compose -f docker-compose.gpu.yml logs -f
```

- Line endings: the repository's `.gitattributes` keeps every file at LF,
  whatever your Git for Windows `core.autocrlf` setting is. That matters:
  the scripts in `rootfs/` are copied into the image as they are, and a
  CRLF shebang does not run. If you copied the files some other way and the
  container boots without any `[potatos]` lines, that is why (`git config
  core.autocrlf false` and clone again).
- The build adds Firefox ESR, htop, mpv and galculator on top of
  `linuxserver/webtop:debian-xfce` (Chromium is already in the base image).
- Caddy asks Let's Encrypt for a certificate as soon as it starts; that
  needs the DNS record and the port forward in place. Watch for
  `certificate obtained successfully` in the logs. It retries by itself. No
  e-mail address is needed (Let's Encrypt stopped sending expiry mails); if
  you want one on the account anyway, add `{ email you@yourdomain.tld }` at
  the top of `caddy/Caddyfile` (not an example.com address, those are rejected).
- If `PASSWORD` is empty, a password is generated and printed in the
  `potatos-gpu` log in a box starting with `PotatOS login` (user `abc`). The
  login is mandatory on this setup (`POTATOS_REQUIRE_PASSWORD=true`).
- Open `https://<POTATOS_DOMAIN>`. The HUD (bottom-right) shows the
  resolution, fps, codec, Mbit/s and `[HW]` when NVENC is in use. The
  `ultra` profile streams at the browser window's size at up to 120 fps;
  make the window 2560x1440 (or set `POTATOS_RESOLUTION=2560x1440`) for 2K.
- Chrome or Brave instead of Chromium/Firefox: inside the desktop,
  `potatos install-browser chrome` (or `brave`) adds the vendor's apt
  repository and installs it; then set `POTATOS_BROWSER=chrome` in `.env`
  and `docker compose -f docker-compose.gpu.yml up -d` (the Compose file
  passes it to the container). Packages live in the container layer, so
  re-run the install after a rebuild. (Untested here: no internet in the
  build sandbox.)

Everything from the README applies here too: the idle freeze after 10
minutes (your PC's CPU drops to idle, the GPU is released), session restore,
eco mode, the privacy shade, quiet hours. Files are in the named volume
`potatos-config`.

### What to expect at 2K/120

- Encoding: a few percent of the GPU's video engine (Task Manager → GPU →
  "Video Encode"). Bitrate at CRF 20 (ultra) with a lot of motion:
  40-75 Mbit/s; `SELKIES_VIDEO_CRF=26,5-50` roughly halves it.
- CPU: Xvfb + the capture copy + Chromium's own rendering. `htop` inside the
  desktop shows it; expect 1-3 cores busy while a page animates at 120 fps.
  The frame upload path (~1.8 GB/s at 1440p120) is the part nobody has
  measured on WSL yet. **Check this**: if the HUD shows fps far below 120
  with the CPU not saturated, the upload is the limit; 90 or 60 fps in the
  sidebar may be the sweet spot.
- Latency: your home connection's round-trip time to wherever you are.

## If NVENC does not load

The log says `Encoder: CPU (x264)` and the HUD has no `[HW]`. Everything
still works; you are simply encoding in software on your PC's CPU:

- With a fast 6-8 core CPU, 1440p at 60 fps is realistic (x264 uses at most
  4 threads in pixelflux); 120 is not. Use `POTATOS_PROFILE=balanced` (60 fps
  target) and a 1080p window, or keep `ultra` and lower the fps in the
  sidebar.
- The real fix for a full-speed GPU desktop (GPU rendering, zero-copy
  capture, NVENC, all officially supported) is **Linux on the PC** (dual
  boot or a spare drive) with the NVIDIA driver and the NVIDIA Container
  Toolkit: then run the same `docker-compose.gpu.yml` and add
  `--device /dev/dri` / `/dev/nvidia*` as in the linuxserver webtop GPU
  guide. Hyper-V GPU partitioning gains nothing over WSL (same `/dev/dxg`
  path), and Sunshine/Moonlight streams your Windows desktop, not PotatOS.

## Uptime notes

- **Docker Desktop starts after you log in to Windows.** Enable "Start
  Docker Desktop when you sign in" and automatic login, or the desktop is
  down until someone logs in. The containers have `restart: unless-stopped`.
- **Sleep.** A sleeping PC is an offline server: Settings → System → Power →
  Screen and sleep → *Never* (when plugged in). The display may turn off.
- **Gaming / other GPU work** on the same PC competes for the video encoder
  and, more importantly, the CPU. Expect dropped frames in PotatOS while a
  game runs.
- **Windows Update** reboots. Set active hours; the portal (below) sends
  you to Railway in the meantime.
- **Idle:** after 10 minutes without a viewer the desktop is frozen (CPU
  idle, no network packets), so a PC that is on anyway costs nothing extra
  to leave serving.

## Windows + Railway + portal

```
                         https://portal.up.railway.app   (portal/, ~10 MB Caddy, always on)
                                   |  probes https://desktop.example.com/healthz
                 +-----------------+------------------+
                 | 2xx                                 | timeout / refused / 5xx
                 v                                     v
   302 https://desktop.example.com        302 https://potatos.up.railway.app
   your PC: Caddy (443, Let's Encrypt)    PotatOS Alpine image, CPU encode,
   -> potatos-gpu container (Debian,      Railway Serverless: asleep until
      NVENC, ultra profile)               this visit wakes it (~10-20 s,
                                          "waking up" page meanwhile)
```

One bookmark. When the PC is up you get the fast desktop; when it is off,
asleep or mid-update you land on the Railway one. The two desktops are
separate machines with separate files and browser profiles; the portal only
decides. Deployment of the portal: [portal/README.md](../portal/README.md).

## Keeping it safe

- A long random `PASSWORD`: it is the only thing between the internet and a
  desktop with `sudo`. Caddy has no request rate limiter without a plugin
  build, so the password *is* the rate limit; `docker compose -f
  docker-compose.gpu.yml logs caddy` shows every request (access
  log on stdout) if you want to look for guessing.
- HTTPS with HSTS is on; the stream's WebSocket only accepts your own origin
  (`SELKIES_ALLOWED_ORIGINS=https://<domain>` plus the same-origin default).
- Update now and then: `docker compose -f docker-compose.gpu.yml pull caddy`
  for Caddy, and for the desktop image
  `docker compose -f docker-compose.gpu.yml build --pull potatos-gpu` (this
  refreshes the `linuxserver/webtop:debian-xfce` base; `up --pull` does not
  rebuild) followed by `docker compose -f docker-compose.gpu.yml up -d`.
- Only Caddy's 80/443 are published; the desktop's port 3000 is reachable
  from the Compose network alone.
