# PotatOS streaming benchmark

Repeatable CPU / fps / bandwidth measurements of a PotatOS container with a
real H.264 browser client. The numbers in the README's performance table come
from this harness (4-vCPU host shared with other work, so compare runs
back-to-back, 2 repeats, and look at "CPU ms per frame" rather than raw fps).

Needs: Docker, Node 18+, `playwright-core` (`npm install` here, or
`ln -s ../tests/e2e/node_modules node_modules`) and a PotatOS image:
`docker build --build-arg POTATOS_APK_PACKAGES= -t potatos:bench ..`

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
- `matrix-example.txt` - the A/B configs behind the README table.

## Metrics (per run)
- `cpu_pct`: container cgroup v1 `cpuacct.usage` delta, % of one core.
- `proc.*`: per-process CPU (% of one core) from `/proc/<pid>/stat`, grouped by name.
- `selkies_threads`, `selkies_hottest_thread_pct`: per-thread CPU of the selkies process.
- `client_fps` (the client's `window.fps`), `enc_fps`, `encode_ms`, `pipeline_ms`,
  `decode_ms`, `mbps_client`: Selkies' own `stream_stats`.
- `ms_per_frame`: CPU ms per delivered frame (selkies, Xvfb, container); the most
  robust number on a contended host.
- `mem_rss_mb`, `rss_mb.*`, `client_cpu_pct`, `host_load_*`.

`--cpus N` is a cgroup quota: the container still sees every host core in
`nproc`, and PotatOS's `auto` profile reads the quota (`cpu.max` /
`cpu.cfs_quota_us`) to size itself. `--cpuset 0,1` pins the container to
those cores (`nproc` = 2). Both put the same CPU budget on the stream; use
`--cpuset` to reproduce the README's "1-2 vCPU" rows exactly as a 2-core
Codespace sees them.

## Examples
```
node bench.mjs --label base --cpus 2 --viewport 1920x1080 --workload motion --dur 30
node bench.mjs --label auto-2core --cpuset 0,1 --profile auto --viewport 1920x1080 --workload motion
node bench.mjs --label idle --cpus 2 --viewport none --workload none
node bench.mjs --label hidden --cpus 2 --viewport 1920x1080 --workload static --hidden
./run-matrix.sh matrix-example.txt 2 results.jsonl && node summarize.mjs results.jsonl --base anim-base
```
Ports: `--port P` uses P (web) and P+1 (DevTools). Containers are `bb-P` /
`bb-P-client` and are removed after each run unless `--keep`.
