#!/usr/bin/env bash
# PotatOS smoke test: build the image, boot a few containers with different
# settings and check the HTTP behaviour from the outside.
#
#   scripts/smoke-test.sh                 # build potatos:dev and test it
#   SKIP_BUILD=1 scripts/smoke-test.sh    # test an existing image
#
# Env:
#   IMAGE        image tag to build/test            (default potatos:dev)
#   BASE_PORT    first host port to use             (default 3300; uses BASE_PORT..+4)
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

NAMES=(default port password railway overrides h264client)
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
  docker build ${BUILD_ARGS:-} -t "${IMAGE}" "${ROOT}"
fi

say "Starting containers"
run default  -p "${P}:3000" -p "$((P + 1)):3001"
run port     -e PORT=8080 -e POTATOS_PROFILE=ultra -p "$((P + 2)):8080"
run password -e PASSWORD=smoke-pass -p "$((P + 3)):3000"
run railway  -e RAILWAY_ENVIRONMENT=production -e POTATOS_PROFILE=potato -e SELKIES_FRAMERATE=45 -p "$((P + 4)):3000"
run overrides -e POTATOS_PROFILE=potato -e SELKIES_MANUAL_RESOLUTION=false \
  -e SELKIES_ENCODER=h264enc,h265enc,vp8enc,vp9enc,av1enc,jpeg -e SELKIES_MICROPHONE_ENABLED=false -e NO_WEBCAM=1

say "Default container (http :${P}, https :$((P + 1)))"
if wait_healthy "${PREFIX}-default"; then
  expect "GET / (no password configured)" 200 "http://localhost:${P}/"
  expect "GET /healthz" 200 "http://localhost:${P}/healthz"
  expect "GET / over self-signed HTTPS" 200 -k "https://localhost:$((P + 1))/"
  # (capture first: `cmd | grep -q` can fail under pipefail when grep exits early)
  if grep -q '<title>PotatOS</title>' <<<"$(curl -s "http://localhost:${P}/")"; then ok "page title is PotatOS"; else bad "page title is not PotatOS"; fi
  if grep -q "Profile 'balanced'" <<<"$(docker logs "${PREFIX}-default" 2>&1)"; then ok "balanced profile applied by default"; else bad "balanced profile not applied"; fi
  if docker exec "${PREFIX}-default" test -f /config/Desktop/potatos-terminal.desktop; then ok "desktop launchers seeded"; else bad "desktop launchers missing"; fi
  if grep -q 'Profile: *balanced' <<<"$(docker exec -u abc "${PREFIX}-default" potatos info)"; then ok "potatos CLI works"; else bad "potatos CLI failed"; fi
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
  if docker exec "${PREFIX}-port" grep -q 'listen 8080 default_server' /etc/nginx/http.d/default.conf; then ok "nginx config listens on 8080"; else bad "nginx config not remapped"; fi
  # PaaS mode: only one public port, so Railway cannot pick the TLS one.
  LISTEN="$(docker exec "${PREFIX}-port" netstat -tln 2>/dev/null | awk '/LISTEN/ {print $4}' | grep -E ':(3001|8080)$' | sort | tr '\n' ' ' || true)"
  if [ "${LISTEN}" = "0.0.0.0:8080 127.0.0.1:3001 " ]; then ok "only PORT is public, HTTPS on 127.0.0.1 (${LISTEN% })"; else bad "unexpected listeners: ${LISTEN}"; fi
  if [ "$(selkies_eval "${PREFIX}-port" 's.use_css_scaling[0]')" = "True" ]; then ok "ultra keeps CSS scaling (no HiDPI 4K)"; else bad "ultra disables CSS scaling"; fi
fi

say "PASSWORD auth (host :$((P + 3)))"
if wait_healthy "${PREFIX}-password"; then
  expect "GET / without credentials" 401 "http://localhost:$((P + 3))/"
  expect "GET / with wrong credentials" 401 -u abc:wrong "http://localhost:$((P + 3))/"
  expect "GET / with correct credentials" 200 -u abc:smoke-pass "http://localhost:$((P + 3))/"
  expect "GET /api websocket path without credentials" 401 "http://localhost:$((P + 3))/api"
  expect "GET /healthz stays open" 200 "http://localhost:$((P + 3))/healthz"
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
fi

say "Result: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
