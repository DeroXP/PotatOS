#!/bin/bash
# PotatOS benchmark workload. Runs INSIDE the PotatOS container as user abc.
#
#   workload.sh start <kind>   kind = motion | term | anim | move | static
#   workload.sh stop
#
# motion = term + anim (the move part was dropped: in the first baseline runs it was a chained
#          xdotool that never flushed, so measured "motion" numbers are term + anim only)
#   term : xfce4-terminal (left half of the screen) running `ls -lR /usr` forever
#   anim : Chromium --app window (40% x 50% of the screen) with a CSS animation
#   (BENCH_CHROMIUM_FLAGS adds flags to that Chromium, for A/B tests)
#   move : xdotool drags the Chromium window back and forth (~30 moves/s)
# drag = a static terminal window (45% x 55% of the screen) dragged back and forth the same way:
#   lots of changed pixels per frame, almost no application CPU (isolates the streaming cost)
# Window sizes are relative to the X screen, so the changed area scales with
# the resolution like a real user's windows would.
set -u
export DISPLAY=:1
B=/tmp/bench
mkdir -p "$B"

geom() { xdotool getdisplaygeometry; }

start_term() {
  read -r W H < <(geom)
  local cols=$(( W / 2 / 8 )) rows=$(( (H - 80) / 18 ))
  xfce4-terminal --disable-server --hide-menubar --hide-toolbar --title=bench-term \
    --geometry="${cols}x${rows}+10+30" -x sh -c 'while :; do ls -lR /usr; done' \
    >/dev/null 2>&1 &
  echo $! >> "$B/pids"
}

start_anim() {
  read -r W H < <(geom)
  local ww=$(( W * 2 / 5 )) wh=$(( H / 2 ))
  # shellcheck disable=SC2086  # BENCH_CHROMIUM_FLAGS is a list of flags on purpose
  /usr/bin/chromium --no-sandbox --user-data-dir="$B/chr" --no-first-run --no-default-browser-check \
    --disable-features=Translate ${BENCH_CHROMIUM_FLAGS:-} --app="file://$B/anim.html" \
    --window-size="${ww},${wh}" --window-position="$(( W / 2 + 20 )),$(( H / 4 ))" \
    >/dev/null 2>&1 &
  echo $! >> "$B/pids"
}

start_dragwin() {
  read -r W H < <(geom)
  local cols=$(( W * 9 / 20 / 8 )) rows=$(( H * 11 / 20 / 18 ))
  xfce4-terminal --disable-server --hide-menubar --hide-toolbar --title=bench-drag \
    --geometry="${cols}x${rows}+0+$(( H / 5 ))" -x sh -c 'ls -l /usr/bin | head -200; exec sleep 100000' \
    >/dev/null 2>&1 &
  echo $! >> "$B/pids"
}

start_move() {
  local target="${1:-bench-anim}"
  read -r W H < <(geom)
  (
    wid=""
    for _ in $(seq 1 60); do
      wid="$(xdotool search --name "$target" 2>/dev/null | head -1)"
      [ -n "$wid" ] && break
      sleep 0.5
    done
    [ -z "$wid" ] && exit 0
    x0=$(( W / 2 - 40 )); span=$(( W / 2 - W * 2 / 5 + 20 )); y=$(( H / 4 ))
    if [ "$target" = bench-drag ]; then x0=0; span=$(( W / 2 )); y=$(( H / 5 )); fi
    # One xdotool process per move: a chained `xdotool windowmove ... sleep ...` does not
    # flush between commands, so only its last move would ever reach the X server.
    i=0; d=1
    while :; do
      xdotool windowmove "$wid" $(( x0 + span * i / 59 )) "$y" >/dev/null 2>&1 || sleep 1
      i=$(( i + d )); [ "$i" -ge 59 ] && d=-1; [ "$i" -le 0 ] && d=1
      sleep 0.033
    done
  ) &
  echo $! >> "$B/pids"
}

case "${1:-}" in
  start)
    : > "$B/pids"
    kind="${2:-motion}"
    case "$kind" in
      motion) start_term; start_anim ;;   # (baseline runs: the window move never took effect, see below)
      term)   start_term ;;
      anim)   start_anim ;;
      move)   start_anim; start_move ;;
      drag)   start_dragwin; start_move bench-drag ;;
      static) ;;
    esac
    ;;
  stop)
    [ -f "$B/pids" ] && while read -r p; do pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; done < "$B/pids"
    pkill -f 'bench-term' 2>/dev/null; pkill -f 'bench-drag' 2>/dev/null; pkill -f "$B/chr" 2>/dev/null; pkill -f 'ls -lR /usr' 2>/dev/null
    ;;
esac
exit 0
