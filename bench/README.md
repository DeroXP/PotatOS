# PotatOS streaming benchmark

Repeatable CPU / fps / bandwidth measurements of a PotatOS container with a
real H.264 browser client. The numbers in the README's performance table come
from this harness: a 4-vCPU host with nothing else running, software x264
(no GPU), the container limited with `--cpus 2` or `--cpus 4`, 30 s per run,
2 interleaved repeats (`matrix-readme.txt`, 70 configs, plus `noviewer.sh`
for the frozen rows). The client sidecar runs on the same host, so its H.264
decoding (40-90 % of a core) competes for the same 4 vCPU; on a busier host
compare runs back-to-back and look at "CPU ms per frame" rather than raw fps.

Needs: Docker, Node 18+, `playwright-core` (`npm install` here, or
`ln -s ../tests/e2e/node_modules node_modules`) and a PotatOS image:
`docker build --build-arg POTATOS_APK_PACKAGES= -t potatos:bench ..`
(`matrix-readme.txt` names its images: `-t potatos:v2 ..` from this tree and
`potatos:v1` from `git worktree add /tmp/v1 807f380`, the previous release)

## Files
- `bench.mjs` - one run: fresh container (`--cpus`, `--cpuset`, `--profile`, `--env SELKIES_*`),
  optional client sidecar (the image's own Alpine Chromium, headless,
  `--network container:` so it loads `http://localhost:3000` = secure context,
  H.264 via WebCodecs), optional workload, measured for `--dur` seconds.
  Appends one JSON line to `--out` and prints a one-line summary. The
  measured container runs with the idle freeze, eco mode and tab-idle pause
  off, so a run measures streaming settings; pass them back with `--env`
  (e.g. `--env POTATOS_ECO=on`) to measure the savings.
- `workload.sh` - runs inside the container as `abc`: `static`, `term`
  (xfce4-terminal `ls -lR /usr` loop), `anim` (Chromium `--app` CSS animation),
  `motion` (= term + anim), `move` (anim window dragged), `drag` (a static
  terminal window dragged across the screen; isolates streaming cost from app cost).
- `anim.html` - deterministic CSS animation page.
- `tcpfwd.py` - re-publishes the sidecar's DevTools port (Chromium binds 127.0.0.1 only).
- `run-matrix.sh <matrix> <reps> <out.jsonl>` - interleaved repeats of a config list.
- `summarize.mjs <jsonl...> [--base label]` - markdown table + deltas vs a base config.
- `matrix-readme.txt` - every config behind the README's performance table:
  PotatOS v1 vs v2 `auto` / `balanced` / `ultra` × `--cpus` 2 / 4 × idle /
  still screen / motion × 720p / 1080p (/ 1440p), eco mode at a 120 fps
  target, and the A/B checks (Turbo, the VBV cap in CRF mode, the app
  Chromium's `--disable-gpu`, `RAYON_NUM_THREADS`, hidden tab, HUD and
  privacy shade client CPU).
- `noviewer.sh <label> <image> <cpus> <wait_s> [ENV=V...]` - no viewer, apps
  open: CPU and eth0 tx packets over 60 s, awake or after the idle freeze.
- `matrix-example.txt` - a smaller A/B set on the `anim` workload (CRF, CBR,
  fps, striped encoder, 720p).

## Metrics (per run)
- `cpu_pct`: container cgroup v1 `cpuacct.usage` delta, % of one core.
- `proc.*`: per-process CPU (% of one core) from `/proc/<pid>/stat`, grouped by name.
- `selkies_threads`, `selkies_hottest_thread_pct`: per-thread CPU of the selkies process.
- `client_fps` (the client's `window.fps`), `enc_fps`, `encode_ms`, `pipeline_ms`,
  `decode_ms`, `mbps_client`: Selkies' own `stream_stats`.
- `ms_per_frame`: CPU ms per delivered frame (selkies, Xvfb, container); the most
  robust number on a contended host.
- `mem_rss_mb`, `rss_mb.*`, `client_cpu_pct`, `host_load_*`.
- `proc.unaccounted`: CPU of processes that exited inside the window (mostly
  the `term` workload's short-lived `ls` runs), so app CPU = container CPU
  minus Selkies, Xvfb and the small fry.

`--cpus N` is a cgroup quota: the container still sees every host core in
`nproc`, and PotatOS's `auto` profile reads the quota (`cpu.max` /
`cpu.cfs_quota_us`) to size itself. `--cpuset 0,1` pins the container to
those cores (`nproc` = 2). Both put the same CPU budget on the stream; use
`--cpuset` to reproduce the README's "1-2 vCPU" rows exactly as a 2-core
Codespace sees them.

## Latest A/B checks (4-vCPU host, nothing else running, 2 repeats)
| Check | Result | Decision |
|---|---|---|
| Turbo on (`SELKIES_VIDEO_STREAMING_MODE=true`), still 1080p60 screen | container 14-18 → 51-52 %, Selkies 7 → 42 % | stays locked off |
| VBV cap in CRF mode (`SELKIES_VIDEO_BITRATE` 2000 / 8000 / 30000), 1080p60 terminal scroll | 26.2 / 26.2 / 26.2 Mbit/s, same CPU and fps | not a bandwidth lever; raise the CRF or use CBR |
| `--disable-gpu` for the app's Chromium (CSS animation, 1080p60) | app 73 → 73 %, Xvfb 7.8 → 7.3 %, RSS -16 MB | no change |
| `RAYON_NUM_THREADS=1` (pixelflux pool), still / motion, `--cpus` 2 and 4 | within ±1.5 % everywhere | no change |
| HUD off vs on (client CPU) | still 11.2 vs 11.6 %, animation 51.6 vs 51.5 % | the HUD costs nothing measurable |
| Privacy shade up while the stream plays (`--shaded`, client CPU; no shade: animation 50-52 %, still 11 %) | CSS blur on the live video: animation 130 %, still screen 51-55 %; blurred still: 35-36 % / 10 % | blurred still instead of a CSS blur on the live video |
| Eco mode at a 120 fps target, 60 Hz animation | Selkies -14 to -21 %, Xvfb -39 to -42 %, container -10 %, 60 fps kept | on (default) |

## Examples
```
node bench.mjs --label base --cpus 2 --viewport 1920x1080 --workload motion --dur 30
node bench.mjs --label auto-2core --cpuset 0,1 --profile auto --viewport 1920x1080 --workload motion
node bench.mjs --label idle --cpus 2 --viewport none --workload none
node bench.mjs --label hidden --cpus 2 --viewport 1920x1080 --workload static --hidden
node bench.mjs --label shade --cpus 4 --viewport 1920x1080 --workload anim --shaded
./run-matrix.sh matrix-example.txt 2 results.jsonl && node summarize.mjs results.jsonl --base anim-base
```
Ports: `--port P` uses P (web) and P+1 (DevTools). Containers are `bb-P` /
`bb-P-client` and are removed after each run unless `--keep`.
