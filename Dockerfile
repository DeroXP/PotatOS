# PotatOS - a lightweight Linux desktop you use from a web browser.
#
# Base: linuxserver/webtop (Alpine + XFCE + Selkies streaming + nginx + s6).
# `latest` tracks upstream security fixes. For reproducible builds, pin a digest:
#   docker build --build-arg BASE_IMAGE=linuxserver/webtop@sha256:529034b4cb77ac4ba3368b7667b50ebeb0c4b054943981d462c035a56ae4308b .
# (that digest is the one PotatOS was last tested against, Alpine 3.24 / Selkies 2.x)
ARG BASE_IMAGE=linuxserver/webtop:latest
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.title="PotatOS" \
      org.opencontainers.image.description="Lightweight Linux desktop (XFCE) streamed to any web browser" \
      org.opencontainers.image.licenses="MIT"

# Sane defaults. Everything here can be overridden at `docker run -e ...` time.
#   TITLE / SELKIES_UI_TITLE  - browser tab + sidebar branding
#   POTATOS_PROFILE           - potato | balanced | ultra | custom (see README)
ENV TITLE=PotatOS \
    SELKIES_UI_TITLE=PotatOS \
    POTATOS_PROFILE=balanced \
    TZ=Etc/UTC

# A few small, useful apps on top of what webtop already ships
# (chromium, xfce4-terminal, thunar, mousepad, ristretto, xarchiver,
#  pavucontrol, xfce4-taskmanager are already in the base image).
#   htop       - terminal task manager
#   mpv        - media player (reuses the ffmpeg libs already in the image)
#   galculator - calculator
# Override with --build-arg POTATOS_APK_PACKAGES="..." (empty = add nothing,
# e.g. for offline / air-gapped builds).
ARG POTATOS_APK_PACKAGES="htop mpv galculator"
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
ENV SELKIES_ALLOWED_ORIGINS= \
    SELKIES_ENCODER=

# Init scripts, launchers, wallpaper, first-boot XFCE defaults
# (/defaults/xfce/xfce4-desktop.xml -> PotatOS wallpaper; only used for a fresh
# /config) and the `potatos` helper CLI. Also brand the web client's tab title.
COPY rootfs/ /
RUN chmod 755 /custom-cont-init.d/* /usr/local/bin/potatos* /usr/local/bin/chromium \
 && chmod 644 /usr/share/potatos/launchers/*.desktop /etc/xdg/autostart/potatos-session.desktop \
 && for f in /usr/share/selkies/*/index.html; do sed -i 's#<title>Selkies</title>#<title>PotatOS</title>#' "$f"; done

# 3000 = HTTP (put behind an HTTPS proxy such as Railway/Codespaces)
# 3001 = HTTPS with a self-signed cert (needed for mic/webcam on a LAN IP);
#        bound to 127.0.0.1 only when PORT is set (PaaS mode, TLS is upstream)
EXPOSE 3000 3001

# Hits an unauthenticated /healthz on whatever port nginx actually listens on
# (CUSTOM_PORT, PORT on Railway, or 3000).
HEALTHCHECK --interval=20s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/usr/local/bin/potatos-healthcheck"]
