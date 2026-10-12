// PotatOS end-to-end test: drives the real streamed desktop in headless Chromium.
//
//   1. open the PotatOS page, wait until the stream shows real (non-blank) frames
//   2. mouse: right-click the desktop -> XFCE context menu must appear
//   3. launcher: double-click the "Text Editor" desktop icon -> Mousepad opens
//      without an "Untrusted application launcher" dialog
//   4. keyboard: Ctrl+Alt+T opens a terminal, type `echo hello ...`
//   5. screenshots of every step go to tests/e2e/screenshots/
//
// Usage:
//   POTATOS_URL=http://localhost:3000 node tests/e2e/desktop.test.mjs
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
import { execFileSync } from 'node:child_process';
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

function inContainer(cmd) {
  return execFileSync('docker', ['exec', '-u', 'abc', CONTAINER, 'sh', '-c', cmd], { encoding: 'utf8' }).trim();
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
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log('page error:', m.text().slice(0, 200)); });

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

  // 3. Launcher: the stock desktop icons must be trusted (potatos-session). The
  // icon column is laid out by xfdesktop; "Text Editor" is the 7th icon.
  // A double-click that lands while xfdesktop is still busy (e.g. showing a
  // tooltip) can be swallowed, so try once more before failing.
  const sx = box.width / 1600, sy = box.height / 900;
  const editorRunning = () => inContainer('pgrep -x mousepad >/dev/null && echo running || echo missing');
  await page.mouse.dblclick(box.x + 63 * sx, box.y + 710 * sy);
  await sleep(4000);
  if (CONTAINER && editorRunning() !== 'running') {
    log('Text Editor launcher: first double-click was swallowed, retrying');
    await page.mouse.move(box.x + 300 * sx, box.y + 300 * sy);
    await sleep(1000);
    await page.mouse.dblclick(box.x + 63 * sx, box.y + 710 * sy);
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
  await browser.close();
  log('PASS');
}

main().catch((err) => {
  console.error('[e2e] FAIL:', err.message);
  process.exit(1);
});
