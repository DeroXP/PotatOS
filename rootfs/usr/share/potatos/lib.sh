# shellcheck shell=bash
# PotatOS: shared helpers for the boot scripts and the `potatos` CLI, sourced
# with `. /usr/share/potatos/lib.sh`. PotatOS ships as two images built from
# the same rootfs/: Alpine (Dockerfile, apk, nginx config in /etc/nginx/http.d)
# and Debian (Dockerfile.gpu, apt, /etc/nginx/sites-available). Everything
# that differs between the two lives here.

# nginx config written by the base image's init-nginx (empty if none found).
# shellcheck disable=SC2034  # used by the scripts that source this file
NGINX_CONFIG=""
for _f in /etc/nginx/http.d/default.conf /etc/nginx/sites-available/default; do
  [ -f "${_f}" ] && { NGINX_CONFIG="${_f}"; break; }
done
unset _f

# Package manager: apk (Alpine) or apt (Debian).
if command -v apk >/dev/null 2>&1; then POTATOS_PKG=apk; else POTATOS_PKG=apt; fi
pkg_install() {                 # pkg_install <package>...   (needs root)
  if [ "${POTATOS_PKG}" = apk ]; then apk add --no-cache "$@"
  else DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" && rm -rf /var/lib/apt/lists/*; fi
}
pkg_search() {                  # pkg_search <term>
  if [ "${POTATOS_PKG}" = apk ]; then apk --no-cache search -v "$@" 2>/dev/null
  else apt-cache search "$@" 2>/dev/null; fi
}

# CPUs this container may really use: the smaller of the affinity count
# (nproc) and the cgroup CPU quota (`docker run --cpus 2`, Kubernetes limits,
# PaaS plans on big hosts). nproc alone ignores quotas, so `auto` would pick a
# 60/120 fps profile on a 2-CPU budget. cgroup v2: cpu.max "quota period"
# ("max" = unlimited); v1: cpu.cfs_quota_us (-1 = unlimited) / cpu.cfs_period_us.
cpu_count() {
  local n q p
  n="$(nproc 2>/dev/null || echo 2)"
  if [ -r /sys/fs/cgroup/cpu.max ]; then
    read -r q p < /sys/fs/cgroup/cpu.max
  elif [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ]; then
    q="$(< /sys/fs/cgroup/cpu/cpu.cfs_quota_us)"; p="$(< /sys/fs/cgroup/cpu/cpu.cfs_period_us)"
  fi
  if [[ "${q:-}" =~ ^[0-9]+$ && "${p:-}" =~ ^[1-9][0-9]*$ ]]; then
    q=$(( (q + p - 1) / p ))                    # ceil(quota / period)
    [ "${q}" -ge 1 ] && [ "${q}" -lt "${n}" ] && n="${q}"
  fi
  echo "${n}"
}

# Browsers. POTATOS_BROWSER names one of: chromium | firefox | chrome | brave
# (chrome and brave only on the Debian image, see `potatos install-browser`).
#   browser_bin NAME      executable to start it (empty if not installed)
#   browser_desktop NAME  .desktop id for mimeapps.list
#   browser_comm NAME     process name (/proc/PID/comm) of its main process
#   browser_helper NAME   XFCE helpers.rc entry (exo "WebBrowser=")
# On Debian, Dockerfile.gpu links firefox-esr to /usr/local/bin/firefox, so
# `firefox` works on both images.
browser_bin() {
  local b
  case "$1" in
    chromium) b="chromium" ;;
    firefox)  b="firefox firefox-esr" ;;
    chrome)   b="google-chrome-stable google-chrome" ;;
    brave)    b="brave-browser brave" ;;
    *) return 1 ;;
  esac
  for b in ${b}; do command -v "${b}" 2>/dev/null && return 0; done
  return 1
}
browser_desktop() {
  case "$1" in
    chromium) echo chromium.desktop ;;
    firefox)  if [ -f /usr/share/applications/firefox-esr.desktop ]; then echo firefox-esr.desktop; else echo firefox.desktop; fi ;;
    chrome)   echo google-chrome.desktop ;;
    brave)    echo brave-browser.desktop ;;
  esac
}
browser_comm() {
  case "$1" in
    chromium) echo chromium ;;
    firefox)  if command -v firefox-esr >/dev/null 2>&1; then echo firefox-esr; else echo firefox; fi ;;
    chrome)   echo chrome ;;
    brave)    echo brave ;;
  esac
}
browser_helper() {
  case "$1" in chrome) echo google-chrome ;; *) echo "$1" ;; esac
}
# Browser name for a process comm (the reverse of browser_comm); empty if none.
browser_of_comm() {
  case "$1" in
    chromium) echo chromium ;;
    firefox|firefox-bin|firefox-esr) echo firefox ;;
    chrome) echo chrome ;;
    brave) echo brave ;;
  esac
}
# Is the browser's REAL process running? `pgrep -x chromium` would also match
# the wrapper scripts (their comm is "chromium" too), so match the binary path.
browser_running() {
  case "$1" in
    chromium) pgrep -f '^/usr/lib/chromium/chromium' ;;
    firefox)  pgrep -f '^/usr/lib/firefox(-esr)?/firefox' ;;
    chrome)   pgrep -f '^/opt/google/chrome/chrome' ;;
    brave)    pgrep -f '^/opt/brave.com/brave/brave' ;;
    *) return 1 ;;
  esac >/dev/null 2>&1
}
# Remove a browser's profile lock when it is stale. Each new container has a
# new host name and new PIDs, so after a platform sleep/wake or a redeploy the
# lock left by the old container ("host-pid" symlink) makes Chromium exit with
# "profile in use by another process on another computer" (and there is no
# dialog tool in the image to unlock it). Firefox keeps "lock" -> "ip:+pid".
#   browser_unlock NAME [force]   force = also when the pid is alive (login time)
browser_unlock() {
  local dir t host pid force="${2:-}" d
  case "$1" in
    chromium) dir="${HOME}/.config/chromium" ;;
    chrome)   dir="${HOME}/.config/google-chrome" ;;
    brave)    dir="${HOME}/.config/BraveSoftware/Brave-Browser" ;;
    firefox)
      for d in "${HOME}"/.mozilla/firefox/*/; do
        t="$(readlink "${d}lock" 2>/dev/null)" || continue
        pid="${t##*+}"
        if [ -n "${force}" ] || ! kill -0 "${pid}" 2>/dev/null; then rm -f "${d}lock" "${d}.parentlock"; fi
      done
      return 0 ;;
    *) return 0 ;;
  esac
  t="$(readlink "${dir}/SingletonLock" 2>/dev/null)" || return 0
  host="${t%-*}"; pid="${t##*-}"
  if [ -n "${force}" ] || [ "${host}" != "$(hostname)" ] || ! kill -0 "${pid}" 2>/dev/null; then
    rm -f "${dir}/SingletonLock" "${dir}/SingletonSocket" "${dir}/SingletonCookie"
  fi
}
