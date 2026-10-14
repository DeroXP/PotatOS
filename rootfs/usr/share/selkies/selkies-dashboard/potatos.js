// PotatOS add-ons for the Selkies web client (injected into index.html at build
// time, config from ./potatos-config.js = window.POTATOS, generated at boot by
// 50-potatos-web from the container's environment).
//
//   HUD           "WxH  fps/target  codec  Mbit/s  rtt ms  [ECO] [HW]" every second,
//                 bottom-right by default (the XFCE panel clock is top-right)
//   eco mode      target fps > 60 and no input for ecoSeconds -> target 60;
//                 the first input restores the original target. Never below 60.
//   hidden tab    tab hidden for hiddenMinutes -> potatos-paused.html (drops
//                 the WebSocket so a forgotten tab cannot keep the server awake);
//                 also when the tab is already hidden while this loads
//   visible idle  visible, no input and a static screen for tabIdleMinutes ->
//                 60 s countdown, then the paused page; never while frames
//                 keep arriving (video playing). "Keep arriving" = motionFps or
//                 more for motionSeconds in a row: the panel clock's redraw
//                 once a minute makes a 1-2 s burst of 5-6 fps, which must not
//                 restart a 30-minute timer.
//   privacy shade tab hidden (or window blurred, mode "focus") -> the stream is
//                 blurred until a click or key press (shown as a blurred still
//                 of its last frame, see the shade section for why)
//   quiet hours   inside the window, no input for quietInputMinutes -> paused page
//
// How settings are applied: the Selkies sidebar posts
// {type:'settings', settings:{...}} to window; selkies-core applies it, keeps
// it in localStorage (<origin>_framerate) and sends `_arg_fps` to the server,
// which logs "Applied framerate live via '_arg_fps': N fps". Eco mode uses the
// same message, so the sidebar, the server and the HUD all agree.
//
// Nothing here steals focus or input: overlays are pointer-events:none except
// the shade and the HUD's tiny toggle tab.
(() => {
  const C = Object.assign({
    hud: 'on', hudCorner: 'bottom-right', eco: true, ecoSeconds: 30, ecoFps: 60,
    hiddenMinutes: 10, tabIdleMinutes: 30, countdownSeconds: 60, motionFps: 5, motionSeconds: 5,
    shade: 'hidden', quietHours: '', quietInputMinutes: 5, tz: '', wakingSeconds: 20,
  }, window.POTATOS || {}, window.POTATOS_OVERRIDE || {}); // _OVERRIDE: tests
  const PAUSED = './potatos-paused.html';
  const LS = { hud: 'potatos.hud' };
  const SS = { ecoOrig: 'potatos.ecoOrig', shade: 'potatos.shade' }; // per tab (sessionStorage)
  const now = () => Date.now();
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const el = (tag, id, text) => { const e = document.createElement(tag); e.id = id; if (text) e.textContent = text; return e; };
  const store = (s) => ({ get: (k) => { try { return s.getItem(k); } catch { return null; } },
    set: (k, v) => { try { s.setItem(k, v); } catch { /* private mode */ } },
    del: (k) => { try { s.removeItem(k); } catch { /* ignore */ } } });
  const ls = store(localStorage), ss = store(sessionStorage);
  const settings = (s) => window.postMessage({ type: 'settings', settings: s }, location.origin);
  const connected = () => !!window.stream_info; // set by selkies-core once the stream is up

  // Target fps as the client has it: the persisted sidebar value (key ends with
  // "_framerate"), else what the server sent (window.framerate).
  function fpsKey() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.endsWith('_framerate') && !k.startsWith('potatos')) return k;
      }
    } catch { /* ignore */ }
    return null;
  }
  function target() {
    const k = fpsKey();
    const v = k ? num(ls.get(k)) : null;
    return v || num(window.framerate) || 0;
  }

  // --- input tracking -----------------------------------------------------
  let lastInput = now();
  const onInput = () => { lastInput = now(); if (eco.active) eco.restore(); countdown.cancel(); };
  for (const ev of ['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart', 'pointerdown']) {
    window.addEventListener(ev, onInput, { capture: true, passive: true });
  }

  // --- eco mode -----------------------------------------------------------
  // The "original target" marker lives in sessionStorage: it exists for the
  // reload of THIS tab, and localStorage is shared by every tab of the site.
  const eco = {
    active: false, orig: 0, pending: ss.get(SS.ecoOrig),
    engage() { this.orig = target(); this.active = true; ss.set(SS.ecoOrig, String(this.orig)); settings({ framerate: C.ecoFps }); },
    restore() {
      this.active = false; ss.del(SS.ecoOrig);
      // Also write the persisted value directly: on pagehide the settings
      // message may never be handled, and the next client would start at 60.
      const k = fpsKey(); if (k) ls.set(k, String(this.orig));
      settings({ framerate: this.orig });
    },
    tick() {
      if (!C.eco || !connected()) return;
      // A reload while eco was active left 60 in localStorage: put the original back.
      if (this.pending) { const o = num(this.pending); this.pending = null; ss.del(SS.ecoOrig); if (o > C.ecoFps) settings({ framerate: o }); return; }
      if (!this.active && target() > C.ecoFps && now() - lastInput >= C.ecoSeconds * 1000) this.engage();
    },
  };
  window.addEventListener('pagehide', () => { if (eco.active) eco.restore(); });

  // --- pausing (hidden tab, visible idle, quiet hours) --------------------
  function pause(reason) {
    if (eco.active) eco.restore();   // leave the server at the user's target
    const back = location.pathname + location.search;
    location.replace(`${PAUSED}#reason=${reason}&back=${encodeURIComponent(back)}`);
  }
  const countdown = {
    box: null, until: 0,
    start() {
      if (this.until) return;
      this.until = now() + C.countdownSeconds * 1000;
      this.box = el('div', 'potatos-countdown');
      document.body.appendChild(this.box);
      this.tick();
    },
    cancel() { if (!this.until) return; this.until = 0; this.box.remove(); this.box = null; },
    tick() {
      if (!this.until) return;
      const left = Math.ceil((this.until - now()) / 1000);
      if (left <= 0) { pause('idle'); return; }
      this.box.textContent = `No activity: pausing the desktop in ${left} s. Move the mouse to stay.`;
    },
  };
  let staticSince = now();   // last time frames kept arriving or the user did something
  let motionRun = 0;         // consecutive 1 s samples with fps >= motionFps
  let hiddenTimer = null;
  function quietNow() {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(C.quietHours || '');
    if (!m) return false;
    let h;
    try { h = parseInt(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: C.tz || undefined }).format(new Date()), 10); }
    catch { h = new Date().getHours(); }
    const [a, b] = [+m[1] % 24, +m[2] % 24];
    if (a === b) return false;   // an empty window, never "always"
    return a < b ? h >= a && h < b : h >= a || h < b;
  }
  function onVisibility() {
    if (document.hidden) {
      if (C.shade !== 'off') shade.show();
      if (C.hiddenMinutes > 0 && !hiddenTimer) hiddenTimer = setTimeout(() => pause('hidden'), C.hiddenMinutes * 60000);
    } else if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; }
  }
  document.addEventListener('visibilitychange', onVisibility);

  // --- privacy shade ------------------------------------------------------
  // The live stream is hidden behind a blurred still of its last frame: one
  // drawImage into a 1/16-size canvas (smoothed, plus a 1 px canvas blur),
  // which the browser scales back up. A CSS blur on the live <video>/<canvas>
  // looks the same but is recomputed for every video frame and for every HUD
  // update drawn over it. Measured on a client without GPU compositing
  // (headless Chromium, 1080p60, bench.mjs --shaded, 2 runs each): shade up on
  // a still screen 51-55 % of a core with the CSS blur, 10 % with the still
  // (11 % without a shade); with a moving screen 130 % vs 35-36 % (50-52 %
  // without a shade: the hidden live element is not composited at all). Revealing is instant:
  // the live element kept receiving frames. Until a frame exists (e.g. back
  // from the paused page, still connecting) the CSS blur is the fallback and
  // the 1 s tick swaps in a still as soon as it can.
  const liveView = () => [...document.querySelectorAll('#videoStream, #videoCanvas')]
    .find((e) => e.getBoundingClientRect().width > 1) || null;
  function blurredStill(src) {
    const W = src.videoWidth || src.width, H = src.videoHeight || src.height;
    if (!(W > 1 && H > 1) || (src.tagName === 'VIDEO' && src.readyState < 2)) return null;
    try {
      const s = document.createElement('canvas');
      const x = s.getContext('2d');
      const k = 'filter' in x ? 16 : 32;   // no canvas filter (Safari): scale down further instead
      s.width = Math.max(1, Math.round(W / k)); s.height = Math.max(1, Math.round(H / k));
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      if (k === 16) x.filter = 'blur(1px)';
      x.drawImage(src, 0, 0, s.width, s.height);
      return s;
    } catch { return null; }
  }
  const shade = {
    box: null, still: null, src: null,
    show() {
      if (this.box) return;
      this.box = el('div', 'potatos-shade', 'PotatOS: click or press a key to show the desktop');
      this.box.addEventListener('click', (e) => { e.stopPropagation(); this.hide(); });
      document.body.appendChild(this.box);
      document.body.classList.add('potatos-shaded');   // CSS blur until the still is up
      this.freeze();
    },
    freeze() {
      if (!this.box || this.still) return;
      const src = liveView();
      const s = src && blurredStill(src);
      if (!s) return;
      s.id = 'potatos-shade-still';
      this.still = s; this.src = src; this.place();
      document.body.appendChild(s);
      document.body.classList.add('potatos-still');    // hides the live element (potatos.css)
    },
    place() {
      if (!this.still) return;
      const r = this.src.getBoundingClientRect();      // still laid out while visibility:hidden
      Object.assign(this.still.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    },
    hide() {
      if (!this.box) return;
      this.box.remove(); this.box = null;
      if (this.still) { this.still.remove(); this.still = null; this.src = null; }
      document.body.classList.remove('potatos-shaded', 'potatos-still');
    },
  };
  window.addEventListener('keydown', () => shade.hide(), { capture: true, passive: true });
  window.addEventListener('resize', () => shade.place());
  if (C.shade === 'focus') window.addEventListener('blur', () => shade.show());

  // --- HUD ----------------------------------------------------------------
  const hud = {
    box: null, tab: null,
    on() { return C.hud !== 'off' && ls.get(LS.hud) !== 'off'; },
    mount() {
      if (C.hud === 'off') return;
      this.tab = el('div', 'potatos-hud-tab');
      this.tab.title = 'PotatOS stats (click to toggle)';
      this.tab.addEventListener('click', (e) => { e.stopPropagation(); ls.set(LS.hud, this.on() ? 'off' : 'on'); this.tick(); });
      this.box = el('div', 'potatos-hud');
      for (const e of [this.box, this.tab]) { e.classList.add(`potatos-${C.hudCorner}`); document.body.appendChild(e); }
    },
    tick() {
      if (!this.box) return;
      if (!this.on()) { this.box.hidden = true; return; }
      this.box.hidden = false;
      // Keeps the server sending stats ("statsOpen" is what the sidebar's stats
      // panel sends; the server ignores repeats).
      try { window.postMessage({ type: 'statsOpen', open: true }, location.origin); } catch { /* ignore */ }
      const c = document.getElementById('videoCanvas');
      const s = (window.stream_stats && window.stream_stats.latest) || {};
      const info = window.stream_info || {};
      const res = c && c.width > 1 ? `${c.width}x${c.height}` : '-';
      const f = (v, d = 1) => (num(v) === null ? '-' : num(v).toFixed(d));
      const flags = (eco.active ? ' [ECO]' : '') + (info.hardware ? ' [HW]' : '');
      this.box.textContent = `${res}  ${f(window.fps, 0)}/${target() || '-'} fps  ${info.codec || window.encoder || '-'}  ${f(s.mbps)} Mbit/s  ${f(s.rtt_ms, 0)} ms${flags}`;
    },
  };

  // --- waking overlay: shown until the stream is connected ----------------
  // After wakingSeconds without a connection it turns into a small hint, so
  // Selkies' own status / sidebar stay reachable when the WebSocket is
  // refused (wrong SELKIES_ALLOWED_ORIGINS behind a Host-rewriting proxy, ...).
  const waking = el('div', 'potatos-waking', 'PotatOS is starting the desktop…');

  function start() {
    hud.mount();
    document.body.appendChild(waking);
    const t0 = now();
    // Returning from the paused page after a hidden-tab pause: keep the shade up.
    if (ss.get(SS.shade) && C.shade !== 'off') { ss.del(SS.shade); shade.show(); }
    // Opened in the background (Ctrl/middle-click, window.open without focus):
    // no visibilitychange event will come for the state the tab is already in.
    if (document.hidden) onVisibility();
    setInterval(() => {
      if (connected()) waking.remove();
      else if (now() - t0 >= C.wakingSeconds * 1000 && !waking.classList.contains('potatos-waking-late')) {
        waking.classList.add('potatos-waking-late');
        waking.textContent = 'PotatOS: still waiting for the stream. If this stays, check the container log (docker logs) and SELKIES_ALLOWED_ORIGINS, or reload.';
      }
      const fps = num(window.fps) || 0;
      motionRun = fps >= C.motionFps ? motionRun + 1 : 0;
      const moving = motionRun >= C.motionSeconds;  // frames keep arriving = screen really changing
      hud.tick();
      eco.tick();
      shade.freeze();   // shaded before the first frame: swap the CSS blur for a still
      if (document.hidden || moving || now() - lastInput < 1000) { staticSince = now(); if (moving) countdown.cancel(); }
      const idleMs = now() - lastInput;
      // Test hook + what the HUD shows, available even with the HUD off.
      const s = (window.stream_stats && window.stream_stats.latest) || {};
      window.__potatos = { fps: num(window.fps), target: target(), eco: eco.active, idleMs, moving, motionRun, staticMs: now() - staticSince, latest: s, quiet: quietNow() };
      if (C.quietHours && quietNow() && idleMs >= C.quietInputMinutes * 60000) { pause('quiet'); return; }
      if (C.tabIdleMinutes > 0 && !document.hidden && now() - staticSince >= C.tabIdleMinutes * 60000) countdown.start();
      countdown.tick();
    }, 1000);
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
