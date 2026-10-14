// PotatOS end-to-end test: drives the real streamed desktop in headless Chromium.
//
//   1. open the PotatOS page, wait until the stream shows real (non-blank) frames
//   2. mouse: right-click the desktop -> XFCE context menu must appear
//   3. launcher: double-click the "Text Editor" desktop icon -> Mousepad opens
//      without an "Untrusted application launcher" dialog
//   4. keyboard: Ctrl+Alt+T opens a terminal, type `echo hello ...`
//   5. screenshots of every step go to tests/e2e/screenshots/
//   6. HUD overlay shows plausible values (resolution, fps/target, codec)
//   7. eco mode: target 120 fps + no input -> effective 60 (and NOT at a target
//      of 60); the first input restores 120. Needs a profile whose fps range
//      reaches 120 (POTATOS_PROFILE=balanced or ultra).
//   8. privacy shade: the stream blurs when the tab is hidden, a click clears it
//   9. visible-idle countdown appears after 90 s of a static desktop (the panel
//      clock's once-a-minute redraw must not restart the timer)
//  10. hidden tab -> the static paused page, the server sees 0 sessions, Resume;
//      a tab that is ALREADY hidden when the page loads pauses too
//  12. hardening: the security headers are on the page and its assets, and the
//      features they could break still work: mic + webcam on (fake devices,
//      Permissions-Policy camera/microphone=self), clipboard both ways
//      (clipboard-read/write=self), and the paused page's Resume never leaves
//      this origin (open-redirect guard)
//  11. (POTATOS_CONTAINER only) session restore: Chromium with 2 tabs, freeze
//      checkpoint, `docker kill` + a NEW container on the same /config volume
//      (new host name = the Railway sleep/wake and redeploy path: the stale
//      Chromium profile lock must not stop it), the tabs come back; then a
//      plain `docker stop` while the desktop is in use, `docker start`, the
//      tabs come back again (checkpoint at shutdown)
//
// Usage:
//   docker run -d --name potatos -p 3000:3000 --shm-size=1g -v potatos-e2e:/config -e POTATOS_PROFILE=balanced potatos
//   POTATOS_URL=http://localhost:3000 POTATOS_CONTAINER=potatos node tests/e2e/desktop.test.mjs
//   (without a volume at /config the new-container step falls back to `docker restart`)
// Optional env:
//   POTATOS_USER / POTATOS_PASSWORD  basic-auth credentials (when PASSWORD is set)
//   POTATOS_CONTAINER                docker container name: also verify inside the
//                                    container that the typed command really ran
//   CHROMIUM_PATH                    browser binary (default: Playwright's chromium
//                                    from PLAYWRIGHT_BROWSERS_PATH / /opt/pw-browsers)
//   HEADED=1                         show the browser window
//   EXPECT_CODEC=H264                fail unless the stream uses this codec (H264, AV1,
//                                    VP8, VP9, H265, JPEG). Note: Playwright's bundled
//                                    Chromium has no H.264 decoder, so it gets AV1/VP8;
//                                    scripts/smoke-test.sh checks the H.264 path with a
//                                    real Chromium build.

import { chromium } from 'playwright-core';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'screenshots');
const URL = process.env.POTATOS_URL || 'http://localhost:3000';
const CONTAINER = process.env.POTATOS_CONTAINER || '';
const MARKER = `hello from potatos ${Date.now() % 100000}`;
const OUT_FILE = '/tmp/potatos-e2e.txt';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const bin = join(root, d, 'chrome-linux', 'chrome');
      if (existsSync(bin)) return bin;
    }
  }
  return undefined; // let playwright-core resolve it
}

// Pixel statistics of a PNG, computed in the page (no native deps needed).
// Returns { std, colors } for one image, or the fraction of changed pixels for two.
async function analyze(page, pngA, pngB) {
  return page.evaluate(async ([a, b]) => {
    const load = (b64) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = `data:image/png;base64,${b64}`;
    });
    const pixels = async (b64) => {
      const img = await load(b64);
      const c = new OffscreenCanvas(img.width, img.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, img.width, img.height).data;
    };
    const pa = await pixels(a);
    if (!b) {
      let sum = 0, sq = 0, n = 0;
      const buckets = new Set();
      for (let i = 0; i < pa.length; i += 16) { // sample every 4th pixel
        const l = 0.299 * pa[i] + 0.587 * pa[i + 1] + 0.114 * pa[i + 2];
        sum += l; sq += l * l; n++;
        buckets.add(((pa[i] >> 4) << 8) | ((pa[i + 1] >> 4) << 4) | (pa[i + 2] >> 4));
      }
      const mean = sum / n;
      return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), colors: buckets.size };
    }
    const pb = await pixels(b);
    if (pa.length !== pb.length) return 1;
    let changed = 0, n = 0;
    for (let i = 0; i < pa.length; i += 16) {
      const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
      if (d > 48) changed++;
      n++;
    }
    return changed / n;
  }, [pngA.toString('base64'), pngB ? pngB.toString('base64') : null]);
}

// The biggest visible <canvas>/<video> on the page is the remote desktop.
async function streamBox(page) {
  return page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('canvas, video')) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (!best || r.width * r.height > best.width * best.height) {
        best = { x: r.x, y: r.y, width: r.width, height: r.height, tag: el.tagName, id: el.id };
      }
    }
    return best && best.width > 200 && best.height > 150 ? best : null;
  });
}

async function shot(page, box, name) {
  const png = await page.screenshot({
    clip: { x: box.x, y: box.y, width: Math.floor(box.width), height: Math.floor(box.height) },
  });
  writeFileSync(join(SHOTS, name), png);
  log(`saved screenshots/${name}`);
  return png;
}

// Which codec/encoder did the client and server agree on?
async function negotiatedCodec(page) {
  const client = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/_encoder$/.test(k)) return localStorage.getItem(k);
    }
    return null;
  });
  let server = null;
  if (CONTAINER) {
    const logs = execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const all = [...logs.matchAll(/Encoder: ([^|]+)\| Mode: (\w+)/g)];
    if (all.length) { const m = all[all.length - 1]; server = { encoder: m[1].trim(), mode: m[2] }; }
  }
  return { client, server };
}

function inContainer(cmd, user = 'abc') {
  return execFileSync('docker', ['exec', '-u', user, CONTAINER, 'sh', '-c', cmd], { encoding: 'utf8' }).trim();
}
// (the Selkies log lines go to the container's stderr: read both streams)
const containerLogs = () => { const r = spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8', maxBuffer: 64 << 20 }); return (r.stdout || '') + (r.stderr || ''); };
// Count the server's "applied a live video setting" lines (eco mode evidence).
const liveApplies = () => (CONTAINER ? (containerLogs().match(/Applying video settings for 'primary' live/g) || []).length : -1);
const potatosState = (page) => page.evaluate(() => ({ p: window.__potatos, hud: document.getElementById('potatos-hud')?.textContent || '', cfg: window.POTATOS }));
// Simulate the tab going to the background (headless tabs are always "visible").
const setHidden = (page, hidden) => page.evaluate((h) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);
async function waitStream(page) {
  await page.waitForFunction(() => window.stream_info && window.__potatos && window.__potatos.fps !== null, null, { timeout: 90_000 });
}
async function waitHealthy() {
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    const st = spawnSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', CONTAINER], { encoding: 'utf8' }).stdout.trim();
    if (st === 'healthy') return;
    await sleep(3000);
  }
  throw new Error('container not healthy after restart');
}
// Replace the container by a NEW one with the same image, env, ports, shm size
// and /config volume (what a platform does on sleep/wake or redeploy: new
// container id, new host name, same data). Needs a mount at /config.
function recreateContainer() {
  const info = JSON.parse(execFileSync('docker', ['inspect', CONTAINER], { encoding: 'utf8' }))[0];
  const cfg = info.Mounts.find((m) => m.Destination === '/config');
  if (!cfg) return false;
  const args = ['run', '-d', '--name', CONTAINER, `--shm-size=${info.HostConfig.ShmSize || 67108864}`];
  for (const [port, binds] of Object.entries(info.HostConfig.PortBindings || {})) {
    for (const b of binds || []) args.push('-p', `${b.HostIp ? b.HostIp + ':' : ''}${b.HostPort}:${port.replace('/tcp', '')}`);
  }
  for (const e of info.Config.Env || []) args.push('-e', e);
  args.push('-v', `${cfg.Type === 'volume' ? cfg.Name : cfg.Source}:/config`);
  args.push(info.Config.Image);
  execFileSync('docker', ['kill', CONTAINER], { stdio: 'ignore' });      // not a clean stop: no exit hooks run
  execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  execFileSync('docker', args, { stdio: 'ignore' });
  return true;
}
const hostname = () => inContainer('hostname');
// Open Chromium (through the PotatOS wrapper, as the desktop does) with two tabs.
async function openChromiumTabs() {
  // (anchored: an unanchored pattern would match this very `sh -c` command line)
  inContainer("pkill -f '^/usr/lib/chromium/chromium' || true; sleep 1; "
    + 'DISPLAY=:1 nohup chromium "data:text/html,<title>potatos-restore-A</title>A" "data:text/html,<title>potatos-restore-B</title>B" >/dev/null 2>&1 </dev/null &');
  await sleep(10_000);
  const lock = inContainer('readlink ~/.config/chromium/SingletonLock || true');
  if (!lock) throw new Error('Chromium did not start (no SingletonLock)');
  return lock;
}
async function waitRestored(page) {
  await waitHealthy();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitStream(page);
  let win = '';
  for (let i = 0; i < 40 && !win; i++) {
    await sleep(2000);
    win = inContainer('DISPLAY=:1 xdotool search --name potatos-restore-A 2>/dev/null | head -1');
  }
  await sleep(2000);
  return win;
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const executablePath = findChromium();
  log(`browser: ${executablePath || '(playwright default)'}  url: ${URL}`);
  const browser = await chromium.launch({
    executablePath,
    headless: !process.env.HEADED,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      // Grant fake mic/cam so a permission prompt can never block the test.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: process.env.POTATOS_PASSWORD
      ? { username: process.env.POTATOS_USER || 'abc', password: process.env.POTATOS_PASSWORD }
      : undefined,
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write', 'microphone', 'camera'], { origin: new globalThis.URL(URL).origin });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log('page error:', m.text().slice(0, 200)); });
  // Security headers (10-potatos-port) on the page and every static asset it loads.
  const SEC_HEADERS = ['x-content-type-options', 'x-frame-options', 'content-security-policy', 'referrer-policy', 'permissions-policy'];
  const headerGaps = new Set();
  let throttled = 0;
  page.on('response', async (r) => {
    if (r.status() === 429) throttled++;
    if (!r.url().startsWith(new globalThis.URL(URL).origin) || r.status() >= 300) return;
    const h = await r.allHeaders().catch(() => ({}));
    for (const k of SEC_HEADERS) if (!h[k]) headerGaps.add(`${k} missing on ${r.url()}`);
  });
  // The sidebar's own status messages say whether mic / webcam really started.
  await page.addInitScript(() => { window.__sidebar = []; window.addEventListener('message', (e) => { if (e.data && e.data.type === 'sidebarButtonStatusUpdate') window.__sidebar.push(e.data); }); });

  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded' });
  if (!resp || resp.status() !== 200) throw new Error(`page returned HTTP ${resp && resp.status()}`);
  log(`page loaded: "${await page.title()}"`);

  // 1. Wait for real frames: the stream must show a busy picture (wallpaper,
  //    panel, icons), not a black/grey placeholder.
  let box = null, stats = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    box = await streamBox(page);
    if (box) {
      const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: Math.floor(box.width), height: Math.floor(box.height) } });
      stats = await analyze(page, png);
      if (stats.std > 20 && stats.colors > 40) break;
    }
    await sleep(1000);
  }
  if (!box || !stats || stats.std <= 20 || stats.colors <= 40) {
    await page.screenshot({ path: join(SHOTS, '00-failure.png') });
    throw new Error(`no non-blank stream frames (box=${JSON.stringify(box)} stats=${JSON.stringify(stats)})`);
  }
  log(`stream <${box.tag.toLowerCase()}${box.id ? '#' + box.id : ''}> ${Math.round(box.width)}x${Math.round(box.height)}: luminance std=${stats.std.toFixed(1)}, colors=${stats.colors}`);
  await sleep(4000); // let the desktop finish drawing icons/panel

  const codec = await negotiatedCodec(page);
  log(`codec: client encoder=${codec.client || '?'}  server=${codec.server ? `${codec.server.mode} via ${codec.server.encoder}` : '? (set POTATOS_CONTAINER)'}`);
  if (!codec.client && !codec.server) throw new Error('could not determine the negotiated codec');
  if (codec.server && codec.server.mode !== 'H264') {
    log(`note: not H.264 because this browser cannot decode it; real users on Chrome/Edge/Safari/Firefox get H.264`);
  }
  if (process.env.EXPECT_CODEC) {
    const norm = (x) => String(x || '').toUpperCase().replace(/ENC$/, '');
    const want = norm(process.env.EXPECT_CODEC);
    const got = norm(codec.server ? codec.server.mode : codec.client);
    if (got !== want) throw new Error(`expected codec ${want}, got ${got}`);
  }
  const desktop = await shot(page, box, '01-desktop.png');

  // 12. Hardening: headers, and what a too-strict policy would break.
  if (headerGaps.size) throw new Error(`security headers missing: ${[...headerGaps].slice(0, 5).join('; ')}`);
  if (throttled) throw new Error(`${throttled} request(s) of a normal page load were rate-limited (429)`);
  const sidebar = (key) => page.evaluate((k) => window.__sidebar.some((m) => m[k] === true), key);
  const pipeline = (name, on) => page.evaluate(([n, e]) => window.postMessage({ type: 'pipelineControl', pipeline: n, enabled: e }, location.origin), [name, on]);
  await pipeline('microphone', true);
  await pipeline('webcam', true);
  for (let i = 0; i < 10 && !((await sidebar('microphone')) && (await sidebar('webcam'))); i++) await sleep(1000);
  const micOn = await sidebar('microphone'), camOn = await sidebar('webcam');
  await pipeline('microphone', false);
  await pipeline('webcam', false);
  if (!micOn || !camOn) throw new Error(`mic/webcam did not start (mic ${micOn}, webcam ${camOn}): Permissions-Policy?`);
  log('mic and webcam start with fake devices (Permissions-Policy allows this origin)');
  if (CONTAINER) {
    const clip = `potatos-clip-${Date.now() % 100000}`;
    await page.evaluate((t) => navigator.clipboard.writeText(t), clip);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    let inDesktop = '';
    for (let i = 0; i < 10 && inDesktop !== clip; i++) { await sleep(1000); inDesktop = inContainer('DISPLAY=:1 xclip -o -selection clipboard 2>/dev/null || true'); }
    if (inDesktop !== clip) throw new Error(`clipboard browser -> desktop failed (desktop has "${inDesktop}")`);
    const back = `potatos-back-${Date.now() % 100000}`;
    inContainer(`printf %s ${back} | DISPLAY=:1 timeout 30 xclip -selection clipboard -loops 5 >/dev/null 2>&1 &`);
    let inBrowser = '';
    for (let i = 0; i < 15 && inBrowser !== back; i++) { await sleep(1000); inBrowser = await page.evaluate(() => navigator.clipboard.readText().catch((e) => `error ${e.name}`)); }
    if (inBrowser !== back) throw new Error(`clipboard desktop -> browser failed (browser has "${inBrowser}")`);
    log('clipboard works both ways');
  }
  {
    // "/.//evil.example" normalises to "//evil.example", a different host if followed as a path
    const guard = await context.newPage();
    await guard.goto(`${URL.replace(/\/$/, '')}/potatos-paused.html#reason=idle&back=${encodeURIComponent('/.//evil.example/x')}`);
    await guard.route('**/*', (r) => (new globalThis.URL(r.request().url()).hostname === 'evil.example' ? r.abort() : r.continue()));
    await guard.click('#r');
    await guard.waitForURL((u) => !/potatos-paused/.test(u.href), { timeout: 30_000 }).catch(() => {});
    const landed = new globalThis.URL(guard.url());
    await guard.close();
    if (landed.origin !== new globalThis.URL(URL).origin) throw new Error(`paused page Resume left the origin: ${landed.href}`);
    log(`paused page Resume with a crafted "back" stays on this origin (${landed.pathname})`);
  }

  // 2. Mouse: right-click an empty spot of the desktop -> context menu.
  const cx = box.x + box.width * 0.55, cy = box.y + box.height * 0.30;
  await page.mouse.move(cx - 100, cy - 50);
  await page.mouse.move(cx, cy, { steps: 10 });
  await page.mouse.click(cx, cy);
  await sleep(500);
  await page.mouse.click(cx, cy, { button: 'right' });
  await sleep(2000);
  const menu = await shot(page, box, '02-mouse-context-menu.png');
  const menuDiff = await analyze(page, desktop, menu);
  log(`right-click changed ${(menuDiff * 100).toFixed(2)}% of the screen`);
  if (menuDiff < 0.003) throw new Error('right-click did not change the screen (mouse input not working?)');
  await page.keyboard.press('Escape');
  await sleep(1000);

  // 3. Launcher: the stock desktop icons must be trusted (potatos-session).
  // xfdesktop places the icons in a 104x114 px grid whose order depends on
  // timing at first boot, so read the row/col it saved (icons.screen0.yaml)
  // when we can; otherwise assume "Text Editor" is the 7th icon of column 0.
  // A double-click that lands while xfdesktop is still busy (e.g. showing a
  // tooltip) can be swallowed, so try once more before failing.
  const sx = box.width / 1600, sy = box.height / 900;
  let ex = 63, ey = 710;
  if (CONTAINER) {
    // A previous run on the same container may have left windows (e.g. the
    // restored browser) over the icon: close every abc window first.
    inContainer('pkill -u abc -x "chromium|firefox|firefox-esr|xfce4-terminal|mousepad"; true');
    await sleep(2000);
    const yaml = inContainer('cat ~/.config/xfce4/desktop/icons.screen0.yaml 2>/dev/null || true');
    const m = /potatos-editor\.desktop":\s*\n\s*row:\s*(\d+)\s*\n\s*col:\s*(\d+)/.exec(yaml);
    if (m) { ex = 60 + 104 * Number(m[2]); ey = 70 + 114 * Number(m[1]); log(`Text Editor icon at row ${m[1]} col ${m[2]} -> (${ex}, ${ey})`); }
  }
  const editorRunning = () => inContainer('pgrep -x mousepad >/dev/null && echo running || echo missing');
  await page.mouse.dblclick(box.x + ex * sx, box.y + ey * sy);
  await sleep(4000);
  if (CONTAINER && editorRunning() !== 'running') {
    log('Text Editor launcher: first double-click was swallowed, retrying');
    await page.mouse.move(box.x + 300 * sx, box.y + 300 * sy);
    await sleep(1000);
    await page.mouse.dblclick(box.x + ex * sx, box.y + ey * sy);
    await sleep(4000);
  }
  await shot(page, box, '02b-launcher-text-editor.png');
  if (CONTAINER) {
    const editor = editorRunning();
    log(`Text Editor launcher -> mousepad ${editor}`);
    if (editor !== 'running') throw new Error('desktop launcher did not start Mousepad (untrusted-launcher dialog?)');
    inContainer('pkill -x mousepad || true');
    await sleep(1000);
  }

  // 4. Keyboard: open a terminal with the XFCE shortcut and type a command.
  await page.mouse.click(cx, cy); // focus the stream
  await sleep(300);
  await page.keyboard.press('Control+Alt+t');
  await sleep(4000);
  const termOpen = await shot(page, box, '03-terminal-open.png');
  log(`terminal shortcut changed ${(await analyze(page, desktop, termOpen) * 100).toFixed(2)}% of the screen`);
  await page.keyboard.type(`echo ${MARKER} | tee ${OUT_FILE}`, { delay: 35 });
  await page.keyboard.press('Enter');
  await sleep(2000);
  await shot(page, box, '04-terminal-typed.png');

  if (CONTAINER) {
    const got = inContainer(`cat ${OUT_FILE} 2>/dev/null || true`);
    log(`inside container ${OUT_FILE}: "${got}"`);
    if (got !== MARKER) throw new Error(`typed command did not run in the desktop (expected "${MARKER}")`);
  } else {
    log('POTATOS_CONTAINER not set: check screenshots/04-terminal-typed.png by eye');
  }

  // 5. A full-page screenshot including the Selkies sidebar/UI.
  await page.screenshot({ path: join(SHOTS, '05-full-page.png') });
  log('saved screenshots/05-full-page.png');

  // 6. HUD: "WxH  fps/target fps  codec  Mbit/s  rtt ms".
  await waitStream(page);
  let st = await potatosState(page);
  log(`HUD: "${st.hud}"`);
  const hudRe = /^(\d+)x(\d+)\s+(\d+)\/(\d+) fps\s+(\S+)\s+(\S+) Mbit\/s\s+(\S+) ms/;
  const hm = hudRe.exec(st.hud);
  if (!hm) throw new Error('HUD missing or malformed');
  if (Number(hm[1]) < 300 || Number(hm[4]) < 8 || Number(hm[4]) > 240) throw new Error(`HUD values implausible: ${st.hud}`);
  if (!(await page.isVisible('#potatos-hud'))) throw new Error('HUD not visible');

  // 7. Eco mode. Set the target to 120 the way the sidebar does. (This runs
  // before the hidden-tab steps: after a STOP/START_VIDEO cycle the server
  // applies queued settings only once the pipeline restart is done.)
  const ecoSeconds = st.cfg.ecoSeconds;
  // Start from 60: a framerate a client sets becomes the server's session
  // default for later clients, so a previous run may have left it at 120.
  await page.evaluate(() => window.postMessage({ type: 'settings', settings: { framerate: 60 } }, location.origin));
  await sleep(4000);
  const appliesBefore = liveApplies();
  await page.mouse.move(cx + 10, cy + 10);
  const tInput = Date.now();
  await page.evaluate(() => window.postMessage({ type: 'settings', settings: { framerate: 120 } }, location.origin));
  await sleep(1500);
  st = await potatosState(page);
  if (st.p.target !== 120) throw new Error(`target fps is ${st.p.target}, not 120: run the container with POTATOS_PROFILE=balanced (fps range up to 120)`);
  const waitApply = async (n) => { for (let i = 0; i < 15 && liveApplies() <= n; i++) await sleep(1000); return liveApplies(); };
  const applies0 = CONTAINER ? await waitApply(appliesBefore) : -1;
  if (CONTAINER && applies0 <= appliesBefore) throw new Error('server did not log a live framerate change for the 120 fps target');
  log(`eco: target 120 set, waiting ${ecoSeconds + 5} s without input`);
  await sleep(Math.max(0, tInput + (ecoSeconds + 5) * 1000 - Date.now()));
  st = await potatosState(page);
  if (!st.p.eco || st.p.target !== 60 || !/\[ECO\]/.test(st.hud)) throw new Error(`eco mode did not engage: ${JSON.stringify(st.p)} "${st.hud}"`);
  if (CONTAINER && (await waitApply(applies0)) <= applies0) throw new Error('server did not log a live framerate change for eco mode');
  await shot(page, box, '07-eco-active.png');
  log(`eco engaged: "${st.hud}"${CONTAINER ? ` (server live-apply lines ${applies0} -> ${liveApplies()})` : ''}`);
  await page.mouse.move(cx + 40, cy + 40, { steps: 3 });
  await sleep(1500);
  st = await potatosState(page);
  if (st.p.eco || st.p.target !== 120) throw new Error(`eco mode did not restore 120 on input: ${JSON.stringify(st.p)}`);
  log('eco restored 120 fps on the first input');
  await page.evaluate(() => window.postMessage({ type: 'settings', settings: { framerate: 60 } }, location.origin));
  await sleep((ecoSeconds + 5) * 1000);
  st = await potatosState(page);
  if (st.p.eco || st.p.target !== 60) throw new Error(`eco mode must not act at a 60 fps target: ${JSON.stringify(st.p)}`);
  log('eco stays off at a 60 fps target');

  // 8. Privacy shade: hidden tab -> blurred stream + overlay; click clears it.
  await setHidden(page, true);
  await sleep(500);
  // Covered by a blurred still of the last frame with the live element hidden,
  // or (before the first frame) the live element itself CSS-blurred.
  const blur = await page.evaluate(() => {
    const still = document.getElementById('potatos-shade-still');
    const live = [...document.querySelectorAll('#videoStream, #videoCanvas')];
    if (still && still.width > 1 && live.every((e) => getComputedStyle(e).visibility === 'hidden')) return `blurred still ${still.width}x${still.height}`;
    return live.map((e) => getComputedStyle(e).filter).find((f) => /blur/.test(f)) || 'none';
  });
  await shot(page, box, '06-privacy-shade.png');
  if (!/blur/.test(blur) || !(await page.isVisible('#potatos-shade'))) throw new Error(`privacy shade did not blur the stream (${blur})`);
  await setHidden(page, false);
  await page.mouse.click(cx, cy);
  await sleep(300);
  if (await page.isVisible('#potatos-shade')) throw new Error('privacy shade did not clear on click');
  if (await page.evaluate(() => !!document.getElementById('potatos-shade-still')
    || [...document.querySelectorAll('#videoStream, #videoCanvas')].some((e) => getComputedStyle(e).visibility === 'hidden' || /blur/.test(getComputedStyle(e).filter)))) {
    throw new Error('privacy shade left the stream hidden or blurred after the click');
  }
  log(`privacy shade: blurred while hidden (${blur}), cleared by a click`);

  // 9. Visible-idle countdown: 90 s of a static desktop instead of 30 min, so
  //    at least one panel-clock redraw (a 1-2 s burst of 5-6 fps) falls into
  //    the window; it must not reset the timer. 20 s countdown.
  await page.addInitScript(() => { window.POTATOS_OVERRIDE = { tabIdleMinutes: 1.5, countdownSeconds: 20, hiddenMinutes: 0.1 }; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitStream(page);
  const tIdle0 = Date.now();
  let maxFps = 0, maxRun = 0, bursts = 0;
  while (!(await page.isVisible('#potatos-countdown'))) {
    if (Date.now() - tIdle0 > 150_000) throw new Error(`no idle countdown after 150 s (max fps seen ${maxFps}, longest motion run ${maxRun} s)`);
    const p = (await potatosState(page)).p || {};
    maxFps = Math.max(maxFps, p.fps || 0); maxRun = Math.max(maxRun, p.motionRun || 0);
    if (p.motionRun === 1) bursts++;
    await sleep(1000);
  }
  const idleS = Math.round((Date.now() - tIdle0) / 1000);
  log(`countdown after ${idleS} s: "${await page.textContent('#potatos-countdown')}" (max fps ${maxFps}, ${bursts} fps bursts, longest ${maxRun} s)`);
  if (idleS < 85 || idleS > 110) throw new Error(`countdown appeared after ${idleS} s, expected ~90 s`);
  await shot(page, box, '08-idle-countdown.png');
  await page.mouse.move(cx + 20, cy + 20, { steps: 3 });
  await sleep(500);
  if (await page.isVisible('#potatos-countdown')) throw new Error('countdown did not cancel on input');

  // 10. Hidden tab -> paused page after 0.1 min; the server then has 0 sessions.
  await setHidden(page, true);
  await page.waitForURL(/potatos-paused\.html/, { timeout: 30_000 });
  await sleep(2000);
  await page.screenshot({ path: join(SHOTS, '09-paused-page.png') });
  log(`hidden tab landed on ${page.url()}`);
  if (CONTAINER) {
    const sessions = JSON.parse(inContainer('curl -s http://127.0.0.1:8082/api/sessions')).sessions;
    if (sessions.length !== 0) throw new Error(`server still has ${sessions.length} session(s) after the pause`);
    log('server sees 0 sessions while paused');
  }
  await page.click('#r');
  await page.waitForURL((u) => !/potatos-paused/.test(u.href), { timeout: 30_000 });
  await waitStream(page);
  log('resumed from the paused page');

  // 10b. A tab that is already hidden when the page loads (opened in the
  //      background): no visibilitychange event ever fires, it must still pause.
  const bg = await context.newPage();
  await bg.addInitScript(() => {
    window.POTATOS_OVERRIDE = { hiddenMinutes: 0.1 };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  });
  await bg.goto(URL, { waitUntil: 'domcontentloaded' });
  await bg.waitForURL(/potatos-paused\.html#reason=hidden/, { timeout: 40_000 });
  log(`background tab paused by itself: ${bg.url()}`);
  await bg.close();

  // 11. Session restore. (a) freeze checkpoint, then a NEW container on the
  //     same volume (docker kill + rm + run): new host name, stale Chromium
  //     lock; (b) `docker stop` while the desktop is in use (not frozen), then
  //     `docker start`: the shutdown checkpoint must record the browser.
  if (CONTAINER) {
    // (back to the real timers: the shortened ones above would pause this tab mid-step)
    await page.addInitScript(() => { window.POTATOS_OVERRIDE = {}; });
    const host0 = hostname();
    const lock0 = await openChromiumTabs();
    log(`Chromium up in ${host0}, profile lock -> ${lock0}`);
    const paused = inContainer('potatos idle pause', 'root'); // checkpoint + freeze now
    if (!/desktop: frozen/.test(paused)) throw new Error(`potatos idle pause failed: ${paused}`);
    let how;
    if (recreateContainer()) {
      how = `new container ${hostname()} (was ${host0})`;
      if (hostname() === host0) throw new Error('new container has the same host name?');
    } else {
      how = 'docker restart (no /config volume: start the container with -v name:/config for the real path)';
      execFileSync('docker', ['restart', CONTAINER], { stdio: 'ignore' });
    }
    log(`session checkpoint taken; ${how}`);
    const win = await waitRestored(page);
    await shot(page, box, '10-session-restored.png');
    if (!win) throw new Error('Chromium did not come back with its tabs in the new container (stale profile lock?)');
    const lock1 = inContainer('readlink ~/.config/chromium/SingletonLock || true');
    if (!lock1 || lock1 === lock0) throw new Error(`Chromium lock not renewed: ${lock1}`);
    const tabsB = inContainer('grep -a -l potatos-restore-B ~/.config/chromium/Default/Sessions/* | wc -l');
    log(`session restored in the new container: Chromium window ${win}, lock -> ${lock1}, tab B in ${tabsB} session file(s)`);

    // (b) plain stop while in use: the viewer (this page) is connected, nothing is frozen.
    const st2 = inContainer('potatos idle status');
    if (!/desktop: active/.test(st2)) throw new Error(`desktop not active before docker stop: ${st2}`);
    inContainer('pkill -x xfce4-terminal || true');
    execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
    const logs = containerLogs();
    if (!/session checkpoint saved \(shutdown\)/.test(logs)) throw new Error('no session checkpoint at shutdown (s6 stopped the watcher after the desktop?)');
    execFileSync('docker', ['start', CONTAINER], { stdio: 'ignore' });
    const win2 = await waitRestored(page);
    await shot(page, box, '11-session-restored-after-stop.png');
    if (!win2) throw new Error('Chromium did not come back after docker stop + start');
    log(`session restored after a plain docker stop while in use: Chromium window ${win2}`);
  } else {
    log('POTATOS_CONTAINER not set: skipping the session-restore step');
  }

  await browser.close();
  log('PASS');
}

main().catch((err) => {
  console.error('[e2e] FAIL:', err.message);
  process.exit(1);
});
