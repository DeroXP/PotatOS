#!/usr/bin/env bash
# PotatOS smoke test: build the image, boot a few containers with different
# settings and check the HTTP behaviour from the outside.
#
#   scripts/smoke-test.sh                 # build potatos:dev and test it
#   SKIP_BUILD=1 scripts/smoke-test.sh    # test an existing image
#   DOCKERFILE=Dockerfile.gpu IMAGE=potatos:gpu BUILD_ARGS='--build-arg POTATOS_APT_PACKAGES=' scripts/smoke-test.sh
#                                         # the Debian/GPU variant (runs without a GPU: x264 path)
#
# Env:
#   IMAGE        image tag to build/test            (default potatos:dev)
#   DOCKERFILE   Dockerfile to build                (default Dockerfile)
#   BASE_PORT    first host port to use             (default 3300; uses BASE_PORT..+5)
#   BUILD_ARGS   extra `docker build` arguments, e.g.
#                BUILD_ARGS='--build-arg POTATOS_APK_PACKAGES=' for offline builds
#   TIMEOUT      seconds to wait for "healthy"      (default 180)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-potatos:dev}"
P="${BASE_PORT:-3300}"
TIMEOUT="${TIMEOUT:-180}"
PREFIX="potatos-smoke"
PASS=0
FAIL=0

say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }

NAMES=(default port password railway overrides idle h264client)
cleanup() { for n in "${NAMES[@]}"; do docker rm -fv "${PREFIX}-${n}" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

# expect <description> <expected-http-code> <curl args...>
expect() {
  local what="$1" want="$2"; shift 2
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true)"
  if [ "${got}" = "${want}" ]; then ok "${what} -> ${got}"; else bad "${what} -> ${got} (expected ${want})"; fi
}

# ws_upgrade <origin> <url> [curl args...] -> HTTP status of a WebSocket handshake
ws_upgrade() {
  local origin="$1" url="$2"; shift 2
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$@" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: ${origin}" "${url}" || true
}
expect_ws() { # expect_ws <description> <want> <origin> <url> [curl args...]
  local what="$1" want="$2"; shift 2
  local got; got="$(ws_upgrade "$@")"
  if [ "${got}" = "${want}" ]; then ok "${what} -> ${got}"; else bad "${what} -> ${got} (expected ${want})"; fi
}

# Settings exactly as the Selkies server resolves them from its environment.
selkies_eval() { # selkies_eval <container> <python expression>
  docker exec "$1" s6-envdir /run/s6/container_environment /lsiopy/bin/python3 -c \
    "from selkies.settings import settings as s; from selkies import capture_demand as c; print($2)" 2>/dev/null | tail -1 || true
}

wait_healthy() {
  local name="$1" status="" waited=0
  while [ "${waited}" -lt "${TIMEOUT}" ]; do
    status="$(docker inspect -f '{{.State.Health.Status}}' "${name}" 2>/dev/null || echo missing)"
    [ "${status}" = "healthy" ] && { ok "${name} healthy after ${waited}s"; return 0; }
    sleep 2; waited=$((waited + 2))
  done
  bad "${name} not healthy after ${TIMEOUT}s (status: ${status})"
  docker logs --tail 40 "${name}" 2>&1 | sed 's/^/    | /'
  return 1
}

run() { # run <suffix> <docker run args...>
  local name="${PREFIX}-$1"; shift
  docker rm -fv "${name}" >/dev/null 2>&1 || true
  docker run -d --name "${name}" --shm-size=1g "$@" "${IMAGE}" >/dev/null
}

if [ -z "${SKIP_BUILD:-}" ]; then
  say "Building ${IMAGE}"
  # shellcheck disable=SC2086
  docker build ${BUILD_ARGS:-} -f "${ROOT}/${DOCKERFILE:-Dockerfile}" -t "${IMAGE}" "${ROOT}"
fi

say "Starting containers"
run default  -p "${P}:3000" -p "$((P + 1)):3001"
run port     -e PORT=8080 -e POTATOS_PROFILE=ultra -e POTATOS_BROWSER=firefox -e POTATOS_HUD=off -e POTATOS_QUIET_HOURS=07-07 -p "$((P + 2)):8080"
run password -e PASSWORD=smoke-pass -p "$((P + 3)):3000"
run railway  -e RAILWAY_ENVIRONMENT=production -e POTATOS_PROFILE=potato -e SELKIES_FRAMERATE=45 -p "$((P + 4)):3000"
run overrides -e POTATOS_PROFILE=potato -e SELKIES_MANUAL_RESOLUTION=false -e POTATOS_QUIET_HOURS=nonsense \
  -e SELKIES_ENCODER=h264enc,h265enc,vp8enc,vp9enc,av1enc,jpeg -e SELKIES_MICROPHONE_ENABLED=false -e NO_WEBCAM=1
# Idle watcher with a 20 s timeout (instead of 10 min) and quiet hours configured;
# a 2-CPU cgroup quota on a bigger host (what `docker --cpus` and PaaS plans do).
run idle     --cpus=2 -e POTATOS_IDLE_SECONDS=20 -e POTATOS_QUIET_HOURS=01-07 -p "$((P + 5)):3000"

say "Default container (http :${P}, https :$((P + 1)))"
if wait_healthy "${PREFIX}-default"; then
  expect "GET / (no password configured)" 200 "http://localhost:${P}/"
  expect "GET /healthz" 200 "http://localhost:${P}/healthz"
  expect "GET / over self-signed HTTPS" 200 -k "https://localhost:$((P + 1))/"
  # (capture first: `cmd | grep -q` can fail under pipefail when grep exits early)
  if grep -q '<title>PotatOS</title>' <<<"$(curl -s "http://localhost:${P}/")"; then ok "page title is PotatOS"; else bad "page title is not PotatOS"; fi
  if grep -q "Profile 'auto' on" <<<"$(docker logs "${PREFIX}-default" 2>&1)"; then ok "auto profile applied by default"; else bad "auto profile not applied"; fi
  if docker exec "${PREFIX}-default" test -f /config/Desktop/potatos-terminal.desktop; then ok "desktop launchers seeded"; else bad "desktop launchers missing"; fi
  INFO="$(docker exec -u abc "${PREFIX}-default" potatos info)"
  if grep -q 'Profile: *auto' <<<"${INFO}" && grep -q 'Eco mode: *on' <<<"${INFO}" && grep -q 'Browser: *chromium' <<<"${INFO}"; then ok "potatos CLI works (shows profile, eco, browser)"; else bad "potatos CLI output unexpected"; fi
  if [ "$(selkies_eval "${PREFIX}-default" 's.video_streaming_mode')" = "(False, True)" ]; then ok "Turbo (video_streaming_mode) locked off"; else bad "Turbo not locked off"; fi
  if grep -q 'window.POTATOS = {' <<<"$(curl -s "http://localhost:${P}/potatos-config.js")"; then ok "potatos-config.js generated at boot"; else bad "potatos-config.js missing"; fi
  if grep -q 'src="./potatos.js"' <<<"$(curl -s "http://localhost:${P}/")"; then ok "potatos.js injected into the dashboard"; else bad "potatos.js not injected"; fi
  expect "GET /potatos-paused.html" 200 "http://localhost:${P}/potatos-paused.html"
  if docker exec "${PREFIX}-default" test -x /usr/local/bin/potatos-browser -a -f /config/Desktop/potatos-browser.desktop; then ok "Browser launcher + potatos-browser chooser present"; else bad "browser launcher missing"; fi
  # Cross-site WebSocket hijacking guard: only same-origin pages may stream.
  expect_ws "WebSocket from a foreign origin" 403 "https://evil.example" "http://localhost:${P}/api/websockets"
  expect_ws "WebSocket from the same origin" 101 "http://localhost:${P}" "http://localhost:${P}/api/websockets"
  expect_ws "WebSocket via HTTPS proxy keeping Host" 101 "https://x.up.railway.app" "http://localhost:${P}/api/websockets" -H "Host: x.up.railway.app"
  # Runtime password (persisted in /config, re-applied on boot)
  docker exec -u abc "${PREFIX}-default" potatos set-password rt-pass >/dev/null
  expect "GET / after 'potatos set-password' without credentials" 401 "http://localhost:${P}/"
  expect "GET / after 'potatos set-password' with credentials" 200 -u abc:rt-pass "http://localhost:${P}/"
  docker exec "${PREFIX}-default" potatos set-password --off >/dev/null
  expect "GET / after 'potatos set-password --off'" 200 "http://localhost:${P}/"

  # The codec real users get: H.264 (x264). Playwright's Chromium cannot decode
  # H.264, so use the image's own Chromium as a headless client sharing the
  # container's network.
  docker run -d --name "${PREFIX}-h264client" --network "container:${PREFIX}-default" --shm-size=512m \
    --entrypoint /usr/bin/chromium "${IMAGE}" --headless=new --no-sandbox --disable-gpu \
    --window-size=1280,800 --autoplay-policy=no-user-gesture-required http://localhost:3000/ >/dev/null
  H264=""
  for _ in $(seq 1 30); do
    H264="$(docker logs "${PREFIX}-default" 2>&1 | grep -o 'Encoder: CPU (x264) | Mode: H264' | tail -1 || true)"
    [ -n "${H264}" ] && break
    sleep 2
  done
  if [ -n "${H264}" ]; then ok "browser client streams H.264 (${H264})"; else bad "no H.264 stream for the Alpine Chromium client"; fi
  docker rm -fv "${PREFIX}-h264client" >/dev/null 2>&1 || true
fi

say "PORT remap (PORT=8080 -> host :$((P + 2)))"
if wait_healthy "${PREFIX}-port"; then
  expect "GET / on remapped port" 200 "http://localhost:$((P + 2))/"
  expect "GET /healthz on remapped port" 200 "http://localhost:$((P + 2))/healthz"
  # (nginx config: /etc/nginx/http.d/default.conf on Alpine, sites-available/default on Debian)
  if grep -q 'listen 8080 default_server' <<<"$(docker exec "${PREFIX}-port" sh -c 'cat /etc/nginx/http.d/default.conf /etc/nginx/sites-available/default 2>/dev/null')"; then ok "nginx config listens on 8080"; else bad "nginx config not remapped"; fi
  # PaaS mode: only one public port, so Railway cannot pick the TLS one.
  LISTEN="$(docker exec "${PREFIX}-port" sh -c 'netstat -tln 2>/dev/null || ss -tln' | awk '/LISTEN/ {print $4}' | grep -E ':(3001|8080)$' | sort | tr '\n' ' ' || true)"
  if [ "${LISTEN}" = "0.0.0.0:8080 127.0.0.1:3001 " ]; then ok "only PORT is public, HTTPS on 127.0.0.1 (${LISTEN% })"; else bad "unexpected listeners: ${LISTEN}"; fi
  if [ "$(selkies_eval "${PREFIX}-port" 's.use_css_scaling[0]')" = "True" ]; then ok "ultra keeps CSS scaling (no HiDPI 4K)"; else bad "ultra disables CSS scaling"; fi
  if grep -qE 'x-scheme-handler/https=firefox(-esr)?\.desktop' <<<"$(docker exec "${PREFIX}-port" cat /config/.config/mimeapps.list)"; then ok "POTATOS_BROWSER=firefox seeded as default browser"; else bad "firefox not seeded as default browser"; fi
  if grep -q 'Browser: *firefox' <<<"$(docker exec -u abc "${PREFIX}-port" potatos info)"; then ok "potatos info shows the firefox choice"; else bad "potatos info does not show firefox"; fi
  if grep -q 'hud: "off"' <<<"$(curl -s "http://localhost:$((P + 2))/potatos-config.js")"; then ok "POTATOS_HUD=off reaches the client config"; else bad "POTATOS_HUD=off not in client config"; fi
  if grep -q "ignoring POTATOS_QUIET_HOURS='07-07'" <<<"$(docker logs "${PREFIX}-port" 2>&1)"; then ok "quiet hours with start == end rejected"; else bad "POTATOS_QUIET_HOURS=07-07 accepted (would mean 'always')"; fi
fi

say "PASSWORD auth (host :$((P + 3)))"
if wait_healthy "${PREFIX}-password"; then
  expect "GET / without credentials" 401 "http://localhost:$((P + 3))/"
  expect "GET / with wrong credentials" 401 -u abc:wrong "http://localhost:$((P + 3))/"
  expect "GET / with correct credentials" 200 -u abc:smoke-pass "http://localhost:$((P + 3))/"
  expect "GET /api websocket path without credentials" 401 "http://localhost:$((P + 3))/api"
  expect "GET /healthz stays open" 200 "http://localhost:$((P + 3))/healthz"
  expect "GET /potatos-paused.html needs no login" 200 "http://localhost:$((P + 3))/potatos-paused.html"
  expect "GET /potatos-waking.html needs no login" 200 "http://localhost:$((P + 3))/potatos-waking.html"
  # Basic auth is re-sent by browsers on cross-site WebSockets: the origin guard must still refuse.
  expect_ws "WebSocket from a foreign origin WITH credentials" 403 "https://evil.example" "http://localhost:$((P + 3))/api/websockets" -u abc:smoke-pass
fi

say "Railway mode: auto-generated password + potato profile (host :$((P + 4)))"
if wait_healthy "${PREFIX}-railway"; then
  GEN_PW="$(docker logs "${PREFIX}-railway" 2>&1 | awk '/#    password:/ {print $NF}' | tail -1)"
  if [ -n "${GEN_PW}" ]; then ok "generated password printed to logs"; else bad "no generated password in logs"; fi
  expect "GET / without credentials" 401 "http://localhost:$((P + 4))/"
  expect "GET / with generated password" 200 -u "abc:${GEN_PW}" "http://localhost:$((P + 4))/"
  LOGS="$(docker logs "${PREFIX}-railway" 2>&1)"
  if grep -q "SELKIES_VIDEO_CRF=30,26-50" <<<"${LOGS}" && grep -q "SELKIES_MANUAL_WIDTH=1280" <<<"${LOGS}"; then ok "potato profile applied"; else bad "potato profile not applied"; fi
  if grep -q "SELKIES_FRAMERATE=45 (user override)" <<<"${LOGS}"; then ok "explicit SELKIES_* overrides profile"; else bad "user override not respected"; fi
  if grep -q "fixed 1280x720" <<<"${LOGS}"; then ok "Selkies started at fixed 1280x720"; else bad "Selkies did not pick up the 720p setting"; fi
fi

say "Explicit SELKIES_* / NO_WEBCAM beat the potato profile"
if wait_healthy "${PREFIX}-overrides"; then
  got="$(selkies_eval "${PREFIX}-overrides" 's.manual_resolution, s.manual_width')"
  if [ "${got}" = "(False, False) 0" ]; then ok "SELKIES_MANUAL_RESOLUTION=false respected"; else bad "manual resolution forced: ${got}"; fi
  got="$(docker exec "${PREFIX}-overrides" cat /run/s6/container_environment/SELKIES_ENCODER)"
  if [ "${got}" = "h264enc,h265enc,vp8enc,vp9enc,av1enc,jpeg" ]; then ok "explicit SELKIES_ENCODER kept"; else bad "SELKIES_ENCODER replaced: ${got}"; fi
  got="$(selkies_eval "${PREFIX}-overrides" 's.microphone_enabled, c.on_demand("microphone"), s.webcam_enabled, c.on_demand("webcam")')"
  if [ "${got}" = "(False, True) False (False, True) False" ]; then ok "mic and webcam locked off, no on-demand capture"; else bad "mic/webcam still capturable: ${got}"; fi
  if grep -q "ignoring POTATOS_QUIET_HOURS='nonsense'" <<<"$(docker logs "${PREFIX}-overrides" 2>&1)"; then ok "invalid POTATOS_QUIET_HOURS rejected"; else bad "invalid quiet hours not rejected"; fi
fi

say "Idle watcher: freeze after 20 s without a viewer (host :$((P + 5)))"
if wait_healthy "${PREFIX}-idle"; then
  IDLE="${PREFIX}-idle"
  if grep -q 'quiet hours 01:00-07:00' <<<"$(docker logs "${IDLE}" 2>&1)"; then ok "quiet hours parsed"; else bad "quiet hours not parsed"; fi
  if docker exec "${IDLE}" test -d /run/service/svc-potatos-idle; then ok "watcher runs as the s6-rc service svc-potatos-idle"; else bad "svc-potatos-idle service missing"; fi
  # --cpus=2 is a cgroup quota: nproc still says 4 here, the profile must say 2.
  if grep -q "Profile 'auto' on 2 vCPU" <<<"$(docker logs "${IDLE}" 2>&1)" && grep -q 'CPU: *2 vCPU' <<<"$(docker exec -u abc "${IDLE}" potatos info)"; then ok "auto profile and potatos info see the 2-CPU quota (nproc=$(docker exec "${IDLE}" nproc))"; else bad "cgroup CPU quota ignored by auto / potatos info"; fi
  # Nothing touches the container now; the watcher must freeze within ~20 s + boot slack.
  SUSPENDED=""
  for _ in $(seq 1 45); do
    SUSPENDED="$(docker logs "${IDLE}" 2>&1 | grep -o 'suspended: froze [0-9]* desktop processes' | tail -1 || true)"
    [ -n "${SUSPENDED}" ] && break
    sleep 2
  done
  if [ -n "${SUSPENDED}" ]; then ok "watcher ${SUSPENDED}"; else bad "watcher did not suspend"; docker logs --tail 10 "${IDLE}" 2>&1 | sed 's/^/    | /'; fi
  STOPPED="$(docker exec "${IDLE}" sh -c 'ps -u abc -o stat= | grep -c "^T"' || true)"
  if [ "${STOPPED:-0}" -ge 10 ]; then ok "${STOPPED} desktop processes in state T (stopped)"; else bad "only ${STOPPED} stopped processes"; fi
  if grep -q 'desktop: frozen' <<<"$(docker exec "${IDLE}" potatos idle status)"; then ok "potatos idle status reports frozen"; else bad "potatos idle status wrong"; fi
  # Railway Serverless sleeps a service that sends no packets: eth0 tx must not move for 30 s.
  TX="$(docker exec "${IDLE}" sh -c 'a=$(awk "/eth0/ {print \$11}" /proc/net/dev); sleep 30; b=$(awk "/eth0/ {print \$11}" /proc/net/dev); echo "$a $b"')"
  if [ "${TX%% *}" = "${TX##* }" ]; then ok "0 outbound packets on eth0 in 30 s while frozen (${TX%% *} -> ${TX##* })"; else bad "outbound packets while frozen: ${TX}"; fi
  expect "GET / while frozen" 200 "http://localhost:$((P + 5))/"
  RESUMED=""
  for _ in $(seq 1 10); do
    RESUMED="$(docker logs "${IDLE}" 2>&1 | grep -o 'resumed [0-9]* desktop processes (page requested)' | tail -1 || true)"
    [ -n "${RESUMED}" ] && break
    sleep 1
  done
  if [ -n "${RESUMED}" ]; then ok "page request thaws the desktop (${RESUMED})"; else bad "desktop not thawed by a page request"; fi
  # pause/resume as the desktop user (must not hang: the CLI only sudo's the signal)
  if grep -q 'desktop: frozen' <<<"$(timeout 20 docker exec -u abc "${IDLE}" potatos idle pause)"; then ok "potatos idle pause (as abc) freezes"; else bad "potatos idle pause failed or hung"; fi
  # A 404 (or a scanner's 401) must not wake a frozen desktop; a real page load must.
  expect "GET /nope while frozen" 404 "http://localhost:$((P + 5))/nope"
  sleep 4
  if grep -q 'desktop: frozen' <<<"$(docker exec "${IDLE}" potatos idle status)"; then ok "a 404 does not thaw the desktop"; else bad "a 404 thawed the desktop"; fi
  if grep -q 'desktop: active' <<<"$(timeout 20 docker exec -u abc "${IDLE}" potatos idle resume)"; then ok "potatos idle resume (as abc) thaws"; else bad "potatos idle resume failed"; fi
  if ! grep -qE 'environ: Permission denied|HTTP 000000' <<<"$(docker logs "${IDLE}" 2>&1)"; then ok "no shell error noise in the watcher log"; else bad "watcher log has error noise (environ / HTTP 000000)"; fi
  # Waking page: with the streaming server down, nginx answers every page with it.
  docker exec "${IDLE}" s6-svc -d /run/service/svc-selkies
  sleep 2
  if grep -q '<title>PotatOS (waking up)</title>' <<<"$(curl -s "http://localhost:$((P + 5))/")"; then ok "waking page served while selkies is down"; else bad "no waking page while selkies is down"; fi
  expect "GET /api/sessions while selkies is down" 502 "http://localhost:$((P + 5))/api/sessions"
  docker exec "${IDLE}" s6-svc -u /run/service/svc-selkies
  sleep 5
  expect "GET / after selkies is back" 200 "http://localhost:$((P + 5))/"
fi

say "Result: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
