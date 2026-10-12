# PotatOS portal: a ~10 MB Caddy that sends visitors to the GPU desktop at home
# when it is up, otherwise to the PotatOS service on Railway. See README.md.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
# Railway injects PORT; the Caddyfile listens on it (8080 when unset).
EXPOSE 8080
