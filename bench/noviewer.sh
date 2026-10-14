#!/usr/bin/env bash
# No-viewer energy check: apps open (workload 'anim' = Chromium CSS animation), no client.
#   ./noviewer.sh <label> <image> <cpus> <wait_s> [ENV=VALUE ...] >> noviewer.jsonl
# Boots a fresh container (balanced, eco and tab-idle pause off), starts the
# workload, restarts the idle watcher so its countdown starts with the apps
# open, waits <wait_s> (the freeze happens inside it when POTATOS_IDLE_SECONDS
# is shorter), then samples 60 s: container CPU (cgroup v1 cpuacct), CPU per
# process, eth0 tx packets/bytes and the watcher state. Prints one JSON line.
# README rows: ./noviewer.sh frozen potatos 2 30 POTATOS_IDLE_SECONDS=20
#              ./noviewer.sh awake  potatos 2 30 POTATOS_IDLE_MINUTES=0
# Env: NAME (container name, default bb-noviewer).
set -u
LABEL="$1"; IMAGE="$2"; CPUS="$3"; WAIT="$4"; shift 4
HERE="$(cd "$(dirname "$0")" && pwd)"
N="${NAME:-bb-noviewer}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; docker rm -fv "$N" >/dev/null 2>&1' EXIT
docker rm -fv "$N" >/dev/null 2>&1
ENVS=()
for e in "$@"; do ENVS+=(-e "$e"); done
docker run -d --name "$N" --shm-size=1g --cpus="$CPUS" -e POTATOS_PROFILE=balanced -e POTATOS_ECO=off -e POTATOS_TAB_IDLE_MINUTES=0 "${ENVS[@]}" "$IMAGE" >/dev/null
for _ in $(seq 1 120); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$N")" = healthy ] && break; sleep 2; done
for _ in $(seq 1 60); do docker exec "$N" sh -c 'ps -eo comm' | grep -q xfce4-panel && break; sleep 1; done
docker cp "$HERE/workload.sh" "$N:/tmp/workload.sh"; docker cp "$HERE/anim.html" "$N:/tmp/anim.html"
docker exec "$N" sh -c 'mkdir -p /tmp/bench && mv /tmp/workload.sh /tmp/anim.html /tmp/bench/ && chown -R abc:abc /tmp/bench && chmod +x /tmp/bench/*.sh'
docker exec -u abc -d "$N" bash /tmp/bench/workload.sh start anim
sleep 5
docker exec "$N" sh -c 's6-svc -r /run/service/svc-potatos-idle 2>/dev/null' || true
sleep "$WAIT"
# shellcheck disable=SC2016  # expands inside the container
SNAP='echo CG $(cat /sys/fs/cgroup/cpuacct/cpuacct.usage); grep -E "^ *eth0:" /proc/net/dev; for f in /proc/[0-9]*/stat; do cat $f 2>/dev/null; echo; done'
docker exec "$N" sh -c "$SNAP" > "$TMP/a"; ta=$(date +%s.%N)
sleep 60
docker exec "$N" sh -c "$SNAP" > "$TMP/b"; tb=$(date +%s.%N)
STATE="$(docker exec "$N" sh -c 'cat /run/potatos-idle/state 2>/dev/null | head -1' | tr -d '\n')"
LOGL="$(docker logs "$N" 2>&1 | grep -E 'potatos-idle\] (suspended|resumed)' | tail -2 | tr '\n' ' ' | tr -d '"')"
python3 - "$LABEL" "$IMAGE" "$CPUS" "$ta" "$tb" "$STATE" "$LOGL" "$TMP/a" "$TMP/b" <<'PY'
import sys, json, re
label, image, cpus, ta, tb, state, logl, fa, fb = sys.argv[1:10]
dt = float(tb) - float(ta)
def parse(p):
    cg = 0; tx = None; procs = {}
    for line in open(p):
        line = line.rstrip('\n')
        if line.startswith('CG '): cg = int(line[3:]); continue
        m = re.match(r'^\s*eth0:\s*(.*)$', line)
        if m: f = [int(x) for x in m.group(1).split()]; tx = (f[9], f[8]); continue
        o, c = line.find('('), line.rfind(')')
        if o < 0 or c < 0: continue
        pid = int(line[:o]); comm = line[o+1:c]; r = line[c+2:].split()
        procs[pid] = (comm, int(r[11]) + int(r[12]), r[19], r[0])
    return cg, tx, procs
a, b = parse(fa), parse(fb)
by = {}
for pid, (comm, t, st, s) in b[2].items():
    q = a[2].get(pid); d = t - q[1] if q and q[2] == st else t
    if d > 0:
        g = 'selkies' if comm.startswith(('selkies', 'python3')) else 'chromium' if comm.lower().startswith('chrom') else comm
        by[g] = by.get(g, 0) + d
stopped = sum(1 for (comm, t, st, s) in b[2].values() if s == 'T')
out = dict(label=label, image=image, cpus=cpus, dt=round(dt, 1), cpu_pct=round((b[0] - a[0]) / 1e9 / dt * 100, 2),
           proc={k: round(v / 100 / dt * 100, 2) for k, v in sorted(by.items(), key=lambda x: -x[1])[:8]},
           eth0_tx_packets=b[1][0] - a[1][0], eth0_tx_bytes=b[1][1] - a[1][1], procs_stopped=stopped, state=state, log=logl.strip())
print(json.dumps(out))
PY
