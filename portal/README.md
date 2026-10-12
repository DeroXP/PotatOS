# PotatOS portal

One address for two desktops. The portal is a tiny [Caddy](https://caddyserver.com)
(about 10 MB of RAM, idle CPU) that runs on Railway next to the PotatOS
service and answers every visit with a redirect:

```
 you  --GET https://portal.../--> portal on Railway
                                     |  probes https://GPU_HOST/healthz (2 s connect, 3 s answer)
                                     |
            2xx (home PC is up)  <---+--->  anything else (off, asleep, unreachable)
            302 https://GPU_HOST/           302 https://CPU_HOST/
            (your Windows + NVIDIA desktop,  (PotatOS on Railway, wakes from
             docs/gpu-host.md)               Serverless sleep on this visit)
```

Rules it follows on purpose (see the comments in [Caddyfile](Caddyfile)):

- **Redirect, never proxy.** The video stream goes straight from your browser
  to whichever desktop you landed on. Proxying 20-50 Mbit/s through Railway
  would cost 9-22 GB of egress per hour ($0.05/GB).
- **It never contacts `CPU_HOST`.** A Serverless Railway service goes to sleep
  only when it receives no traffic, including traffic from other services in
  the project, so the portal only ever hands you its address.
- `Cache-Control: no-store` on the redirect, so your browser asks the portal
  again next time instead of remembering yesterday's answer.
- The path and query string are kept (`/foo?x=1` on the portal becomes
  `/foo?x=1` on the chosen desktop).
- `GET /healthz` answers `ok` (Railway's health check for the portal itself).

## Deploy on Railway (second service, same repository)

1. In your PotatOS project: **New → GitHub Repo**, pick the same repository.
2. **Settings → Source → Root Directory:** `portal/` (Railway then builds
   `portal/Dockerfile`).
3. **Settings → Deploy → Healthcheck Path:** `/healthz`.
4. **Variables:**
   - `GPU_HOST` = the public host name of your home desktop, e.g.
     `desktop.example.com` (no `https://`, no path).
   - `CPU_HOST` = the Railway domain of the PotatOS service, e.g.
     `potatos-production-1234.up.railway.app`.
   (`PORT` is injected by Railway.)
5. **Settings → Networking:** generate a public domain, or attach a custom
   one. This is the address you use from now on.
6. **Do not enable Serverless on the portal.** It only costs ~$0.10-0.20 per
   month awake (RAM $10/GB/month, CPU billed on use), and a sleeping portal
   would make every first visit a cold start. Serverless belongs on the
   PotatOS service, where it saves real money (see the README's
   *Idle & sleep*).

Each desktop keeps its own login (`PASSWORD`), its own `/config` and its own
browser profile; the portal only chooses.

## Test it locally

```bash
docker build -t potatos-portal portal/
docker run --rm -p 8080:8080 -e GPU_HOST=desktop.example.com -e CPU_HOST=potatos.up.railway.app potatos-portal
curl -i http://localhost:8080/healthz           # ok
curl -i 'http://localhost:8080/some/path?x=1'   # 302 to the GPU host if its /healthz answers, else to CPU_HOST
```

The redirector was verified here against stubs that look like the real
thing: the home side was `caddy/Caddyfile` itself (host-matched site block
for `GPU_HOST`, local certificate) in front of a `potatos-gpu` stub. The
probe arrives there with `Host: GPU_HOST` (the Caddyfile sets `header_up
Host`; without it the home Caddy answers its empty "no such site" 200 for
every visit and a dead desktop would still get the GPU redirect) and without
the visitor's `Cookie` / `Authorization` headers. Results: desktop up →
`302 https://GPU_HOST/some/path?x=1&y=2`; desktop container stopped (home
Caddy answers 502) → `302 https://CPU_HOST/...`; home Caddy unreachable →
`302 https://CPU_HOST/...` in ~10 ms (connection refused, no timeout wait);
the CPU side is never contacted.
