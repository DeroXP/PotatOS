# PotatOS - a lightweight Linux desktop you use from a web browser.
# (Alpine image. Dockerfile.gpu is the Debian/NVENC variant built from the same rootfs/.)
#
# Base: linuxserver/webtop (Alpine + XFCE + Selkies streaming + nginx + s6).
# `latest` is kept on purpose: a rebuild picks up upstream security fixes.
# For a reproducible build, pin the digest (or a version tag) instead:
#   docker build --build-arg BASE_IMAGE=linuxserver/webtop@sha256:529034b4cb77ac4ba3368b7667b50ebeb0c4b054943981d462c035a56ae4308b .
#   docker build --build-arg BASE_IMAGE=linuxserver/webtop:4436569b-ls319 .
# Last tested against: build 4436569b-ls319 (2026-10-10, Alpine 3.24,
# Chromium 152, nginx 1.30, Selkies 2.x), digest above. Check yours with
#   docker image inspect linuxserver/webtop:latest --format '{{index .Config.Labels "build_version"}}'
ARG BASE_IMAGE=linuxserver/webtop:latest
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.title="PotatOS" \
      org.opencontainers.image.description="Lightweight Linux desktop (XFCE) streamed to any web browser" \
      org.opencontainers.image.licenses="MIT"

# Sane defaults. Everything here can be overridden at `docker run -e ...` time.
#   TITLE / SELKIES_UI_TITLE  - browser tab + sidebar branding
#   POTATOS_PROFILE           - auto | potato | balanced | ultra | custom (see README)
#   POTATOS_BROWSER           - chromium | firefox: default browser + "Browser" launcher
#   POTATOS_IDLE_MINUTES      - freeze the desktop after N min without a viewer (0 = off)
#   START_DOCKER=false        - the base image would start a Docker daemon in
#                               privileged containers; it costs CPU and sends traffic
ENV TITLE=PotatOS \
    SELKIES_UI_TITLE=PotatOS \
    POTATOS_PROFILE=auto \
    POTATOS_BROWSER=chromium \
    POTATOS_IDLE_MINUTES=10 \
    START_DOCKER=false \
    TZ=Etc/UTC

# A few small, useful apps on top of what webtop already ships
# (chromium, xfce4-terminal, thunar, mousepad, ristretto, xarchiver,
#  pavucontrol, xfce4-taskmanager are already in the base image).
#   htop       - terminal task manager
#   mpv        - media player (reuses the ffmpeg libs already in the image)
#   galculator - calculator
#   firefox    - second browser (POTATOS_BROWSER=firefox makes it the default)
# Override with --build-arg POTATOS_APK_PACKAGES="..." (empty = add nothing,
# e.g. for offline / air-gapped builds).
ARG POTATOS_APK_PACKAGES="htop mpv galculator firefox"
RUN if [ -n "${POTATOS_APK_PACKAGES}" ]; then apk add --no-cache ${POTATOS_APK_PACKAGES}; fi \
 && rm -rf /var/cache/apk/* /tmp/* /root/.cache

# Streaming defaults (after the apk layer so editing them keeps that cache):
#   SELKIES_ALLOWED_ORIGINS - the base image sets "*", which lets ANY web page
#       the user visits open the desktop's control WebSocket (cross-site
#       WebSocket hijacking; HTTP basic auth does not stop it, because browsers
#       re-send the cached login). Empty = same-origin only. Behind a proxy that
#       rewrites the Host header, list your public origin(s) here.
#   SELKIES_ENCODER - empty marker: 20-potatos-profile writes the profile's
#       codec list unless you set one yourself.
#   SELKIES_VIDEO_STREAMING_MODE - "Turbo" re-encodes identical frames (a still
#       1080p60 desktop with a viewer: 51 % of a core instead of 14 %, measured
#       on 4 vCPU, see bench/) and one sidebar click would stick in the
#       browser's localStorage, so it is locked off. Set "true" to allow it.
ENV SELKIES_ALLOWED_ORIGINS= \
    SELKIES_ENCODER= \
    SELKIES_VIDEO_STREAMING_MODE="false|locked"

# Init scripts, the potatos-idle service (s6-rc, see below), launchers, wallpaper, first-boot XFCE
# defaults (/defaults/xfce/*.xml: wallpaper, session saving; only used for a
# fresh /config), Chromium and Firefox policies (/etc/chromium/policies/managed,
# /etc/firefox/policies: no telemetry, metrics or promo traffic, see README
# Security) and the `potatos` helper CLI.
# Web client: brand the tab title and inject the PotatOS add-ons (HUD, eco
# mode, pause pages...) into every dashboard. init-nginx copies the dashboard
# directory to /usr/share/selkies/web on each boot, so these edits survive;
# the settings file potatos-config.js is generated at boot (50-potatos-web).
# The idle watcher is a real s6-rc service (/etc/s6-overlay/s6-rc.d/svc-potatos-idle,
# depends on svc-de and svc-dbus) rather than a /custom-services.d file: s6 then
# stops it BEFORE the desktop at shutdown, so its session checkpoint still sees the apps.
COPY rootfs/ /
RUN chmod 755 /custom-cont-init.d/* /etc/s6-overlay/s6-rc.d/svc-potatos-idle/run /usr/local/bin/potatos* /usr/local/bin/chromium \
 && chmod 644 /usr/share/potatos/launchers/*.desktop /etc/xdg/autostart/potatos-session.desktop \
      /etc/firefox/policies/policies.json /etc/chromium/policies/managed/potatos.json \
      /usr/share/selkies/selkies-dashboard/potatos* \
 && for d in /usr/share/selkies/selkies-dashboard*/; do \
      cp -n /usr/share/selkies/selkies-dashboard/potatos* "$d" 2>/dev/null || true; \
      sed -i -e 's#<title>Selkies</title>#<title>PotatOS</title>#' \
             -e 's#</head>#<link rel="stylesheet" href="./potatos.css"><script src="./potatos-config.js"></script><script src="./potatos.js" defer></script></head>#' "$d/index.html"; \
    done

# 3000 = HTTP (put behind an HTTPS proxy such as Railway/Codespaces)
# 3001 = HTTPS with a self-signed cert (needed for mic/webcam on a LAN IP);
#        bound to 127.0.0.1 only when PORT is set (PaaS mode, TLS is upstream)
EXPOSE 3000 3001

# Hits an unauthenticated /healthz on whatever port nginx actually listens on
# (CUSTOM_PORT, PORT on Railway, or 3000).
HEALTHCHECK --interval=20s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/usr/local/bin/potatos-healthcheck"]
