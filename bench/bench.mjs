#!/usr/bin/env node
// PotatOS streaming benchmark: one run = one fresh container + (optionally) one real
// H.264 browser client + a reproducible desktop workload, measured for --dur seconds.
//
//   node bench.mjs --label balanced-1080-motion --cpus 2 --profile balanced \
//        --viewport 1920x1080 --workload motion --dur 30 [--env SELKIES_X=Y]... \
//        [--port 4100] [--image potatos:bench] [--out results.jsonl]
//
//   --cpus N          docker --cpus (a cgroup quota: nproc inside still shows the host's
//                     cores, so the `auto` profile sees the quota via cpu.max, not nproc)
//   --cpuset 0,1      docker --cpuset-cpus (pins to those cores: nproc shows 2)
//   --viewport none   no client at all (idle server)
//   --workload        none | static | motion | term | anim | move  (see workload.sh)
//   --keep            leave the containers running (prints their names)
//
// What is measured (window = after stream is up + workload warm-up):
//   cpu_pct        container cgroup CPU (cpuacct.usage), % of ONE core
//   proc.<name>    per-process CPU % of one core from /proc/<pid>/stat (grouped by comm)
//   mem_rss_mb     cgroup rss (memory.stat), plus cache/shmem
//   client_fps     frames the browser client rendered per second (window.fps, Selkies client)
//   enc_fps / encode_ms / pipeline_ms   server-side encode rate + per-frame cost
//                  (Selkies stream_stats, subscribed with the client's statsOpen message)
//   mbps_client    payload Mbit/s the client received (Selkies client byte counter)
//   mbps_lo        container loopback tx Mbit/s / 2 (selkies->nginx->client), cross-check
//   client_cpu_pct CPU % of the client sidecar (decode + render), for reference
//
// The client is the image's own Alpine Chromium (has an H.264 decoder; Playwright's
// bundled Chromium does not), run headless in a sidecar sharing the PotatOS network
// namespace so it reaches http://localhost:3000 (a secure context, WebCodecs works).
// Its DevTools port only binds 127.0.0.1, so tcpfwd.py republishes it on :9223.
// The PotatOS energy features (idle freeze, eco mode, tab idle pause) are turned
// off for the measured container unless you pass them with --env, so a run
// measures the streaming settings, not the savings.

import { chromium } from 'playwright-core';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---------- args ----------
const A = { env: [], cpus: '', cpuset: '', profile: 'balanced', viewport: '1920x1080', workload: 'motion',
  dur: 30, warmup: 8, port: 4100, image: process.env.IMAGE || 'potatos:bench', out: join(HERE, 'results.jsonl'),
  label: '', keep: false, chromiumFlags: '', clientCpus: '', settle: 6, statsOff: false };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, '');
  if (k === 'keep' || k === 'statsOff' || k === 'hidden' || k === 'disconnect') { A[k] = true; continue; }
  const v = process.argv[++i];
  if (Array.isArray(A[k])) A[k].push(v); else A[k] = ['dur', 'warmup', 'port', 'settle'].includes(k) ? Number(v) : v;
}
const NAME = `bb-${A.port}`;
const CNAME = `${NAME}-client`;
const CDP_PORT = A.port + 1;

// ---------- docker helpers ----------
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const dk = (...args) => sh('docker', args);
const dkq = (...args) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
const cexec = (user, script) => dk('exec', ...(user ? ['-u', user] : []), NAME, 'sh', '-c', script);
function cleanup() { for (const n of [CNAME, NAME]) dkq('rm', '-fv', n); }

async function waitFor(what, fn, timeoutS, stepMs = 1000) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutS) {
    try { const r = await fn(); if (r) return r; } catch { /* retry */ }
    await sleep(stepMs);
  }
  throw new Error(`timeout waiting for ${what}`);
}

// ---------- in-container snapshot ----------
const SNAP = 'echo CG $(cat /sys/fs/cgroup/cpuacct/cpuacct.usage); grep -E "^ *(lo|eth0):" /proc/net/dev; '
  + 'echo MEM; grep -E "^(rss|cache|shmem|mapped_file|total_rss) " /sys/fs/cgroup/memory/memory.stat; '
  + 'echo PROCS; cat /proc/[0-9]*/stat 2>/dev/null; '
  + 'echo TASKS; for p in $(pgrep -f "^/lsiopy/bin/python3 /lsiopy/bin/selkies"); do cat /proc/$p/task/*/stat 2>/dev/null; done';
function snapshot(container = NAME) {
  const t0 = process.hrtime.bigint();
  const out = dk('exec', container, 'sh', '-c', SNAP);
  const t1 = process.hrtime.bigint();
  const s = { t: Number((t0 + t1) / 2n) / 1e9, cg: 0, net: {}, mem: {}, procs: new Map() };
  let mode = 'head';
  for (const line of out.split('\n')) {
    if (line.startsWith('CG ')) { s.cg = Number(line.slice(3)) / 1e9; continue; }
    if (line === 'MEM') { mode = 'mem'; continue; }
    if (line === 'PROCS') { mode = 'procs'; continue; }
    if (line === 'TASKS') { mode = 'tasks'; s.tasks = new Map(); continue; }
    if (mode === 'head') {
      const m = line.match(/^\s*(\w+):\s*(.*)$/);
      if (m) { const f = m[2].trim().split(/\s+/).map(Number); s.net[m[1]] = { rx: f[0], tx: f[8] }; }
    } else if (mode === 'mem') {
      const [k, v] = line.split(' '); if (k) s.mem[k] = Number(v);
    } else if (mode === 'tasks' && line) {
      const o = line.indexOf('('), c = line.lastIndexOf(')');
      if (o < 0 || c < 0) continue;
      const r = line.slice(c + 2).split(' ');
      s.tasks.set(Number(line.slice(0, o)), { comm: line.slice(o + 1, c), ticks: Number(r[11]) + Number(r[12]), start: r[19] });
    } else if (mode === 'procs' && line) {
      const o = line.indexOf('('), c = line.lastIndexOf(')');
      if (o < 0 || c < 0) continue;
      const pid = Number(line.slice(0, o)); const comm = line.slice(o + 1, c);
      const r = line.slice(c + 2).split(' ');
      s.procs.set(pid, { comm, ticks: Number(r[11]) + Number(r[12]), start: r[19], rss: Number(r[21]) * 4096 });
    }
  }
  return s;
}
function groupOf(comm) {
  if (/^selkies|^python3/.test(comm)) return 'selkies';
  if (/^Xvfb|^Xorg/.test(comm)) return 'Xvfb';
  if (/^chrom|^Chrom/.test(comm) || comm === 'ThreadPoolForeg') return 'chromium';
  if (/^xfce4-terminal/.test(comm)) return 'terminal';
  if (/^(ls|sh|bash|xdotool)$/.test(comm)) return 'workload-sh';
  for (const g of ['xfwm4', 'xfdesktop', 'xfce4-panel', 'pulseaudio', 'nginx', 'xfsettingsd', 'xfconfd', 'Thunar', 'thunar-real', 'dbus-daemon']) if (comm.startsWith(g)) return g;
  return 'other';
}
function diff(a, b) {
  const dt = b.t - a.t;
  const procs = {};
  let accounted = 0;
  for (const [pid, p] of b.procs) {
    const q = a.procs.get(pid);
    const d = q && q.start === p.start ? p.ticks - q.ticks : p.ticks; // new process: all of it
    if (d <= 0) continue;
    const g = groupOf(p.comm);
    procs[g] = (procs[g] || 0) + d;
    accounted += d;
  }
  const HZ = 100;
  const pct = (ticks) => Math.round((ticks / HZ / dt) * 1000) / 10;
  const out = { dt: Math.round(dt * 10) / 10, cpu_pct: Math.round(((b.cg - a.cg) / dt) * 1000) / 10, proc: {} };
  for (const [g, t] of Object.entries(procs).sort((x, y) => y[1] - x[1])) out.proc[g] = pct(t);
  out.proc.unaccounted = Math.round((out.cpu_pct - pct(accounted)) * 10) / 10;
  if (a.tasks && b.tasks) { // selkies threads, grouped by thread name (pixelflux capture/encode threads etc.)
    const th = {}; let top = 0;
    for (const [tid, t] of b.tasks) {
      const q = a.tasks.get(tid);
      const d = q && q.start === t.start ? t.ticks - q.ticks : t.ticks;
      if (d <= 0) continue;
      th[t.comm] = (th[t.comm] || 0) + d; top = Math.max(top, d);
    }
    out.selkies_threads = Object.fromEntries(Object.entries(th).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => [k, pct(v)]));
    out.selkies_hottest_thread_pct = pct(top);
    out.selkies_nthreads = b.tasks.size;
  }
  if (b.net.lo && a.net.lo) out.mbps_lo = Math.round(((b.net.lo.tx - a.net.lo.tx) * 8 / 1e6 / dt / 2) * 100) / 100;
  if (b.net.eth0 && a.net.eth0) out.mbps_eth0_tx = Math.round(((b.net.eth0.tx - a.net.eth0.tx) * 8 / 1e6 / dt) * 100) / 100;
  out.mem_rss_mb = Math.round((b.mem.total_rss ?? b.mem.rss) / 1048576);
  out.mem_cache_mb = Math.round(b.mem.cache / 1048576);
  out.mem_shmem_mb = Math.round((b.mem.shmem || 0) / 1048576);
  const rssBy = {};
  for (const p of b.procs.values()) { const g = groupOf(p.comm); rssBy[g] = (rssBy[g] || 0) + p.rss; }
  out.rss_mb = Object.fromEntries(Object.entries(rssBy).sort((x, y) => y[1] - x[1]).map(([g, v]) => [g, Math.round(v / 1048576)]));
  return out;
}
function sidecarCpu() { // seconds of CPU used by the client container so far
  try { return Number(dk('exec', CNAME, 'cat', '/sys/fs/cgroup/cpuacct/cpuacct.usage')) / 1e9; } catch { return NaN; }
}

const stat = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((p, q) => p - q);
  if (!v.length) return null;
  const q = (f) => v[Math.min(v.length - 1, Math.floor(f * v.length))];
  return { mean: Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100, p10: q(0.1), p50: q(0.5), p90: q(0.9), n: v.length };
};

// ---------- main ----------
async function main() {
  cleanup();
  const env = [`POTATOS_PROFILE=${A.profile}`, 'POTATOS_IDLE_MINUTES=0', 'POTATOS_ECO=off', 'POTATOS_TAB_IDLE_MINUTES=0', ...A.env];
  const runArgs = ['run', '-d', '--name', NAME, '--shm-size=1g', '-p', `${A.port}:3000`, '-p', `${CDP_PORT}:9223`];
  if (A.cpus) runArgs.push(`--cpus=${A.cpus}`);
  if (A.cpuset) runArgs.push(`--cpuset-cpus=${A.cpuset}`);
  for (const e of env) runArgs.push('-e', e);
  runArgs.push(A.image);
  log(`start ${NAME} cpus=${A.cpus || 'host'} cpuset=${A.cpuset || '-'} ${env.join(' ')}`);
  dk(...runArgs);
  const t0 = Date.now();
  await waitFor('healthy', () => dk('inspect', '-f', '{{.State.Health.Status}}', NAME).trim() === 'healthy', 240, 2000);
  await waitFor('desktop', () => /xfdesktop/.test(cexec('', 'ps -eo comm')) && /xfce4-panel/.test(cexec('', 'ps -eo comm')), 120, 1000);
  const bootS = Math.round((Date.now() - t0) / 1000);
  log(`desktop up after ${bootS}s`);
  for (const f of ['workload.sh', 'anim.html']) dk('cp', join(HERE, f), `${NAME}:/tmp/${f}`);
  cexec('', 'mkdir -p /tmp/bench && mv /tmp/workload.sh /tmp/anim.html /tmp/bench/ && chown -R abc:abc /tmp/bench && chmod +x /tmp/bench/*.sh');
  await sleep(A.settle * 1000);

  const result = { label: A.label, ts: new Date().toISOString(), image: A.image, cpus: A.cpus || 'host', cpuset: A.cpuset || '', profile: A.profile,
    env: A.env, hidden: !!A.hidden, disconnect: !!A.disconnect, chromium_flags: A.chromiumFlags, viewport: A.viewport, workload: A.workload, dur: A.dur, boot_s: bootS,
    host_load_start: Math.round(os.loadavg()[0] * 10) / 10 };

  let browser = null, page = null;
  const samples = [];
  if (A.viewport !== 'none') {
    const [W, H] = A.viewport.split('x').map(Number);
    const cargs = ['run', '-d', '--name', CNAME, '--network', `container:${NAME}`, '--shm-size=512m'];
    if (A.clientCpus) cargs.push(`--cpus=${A.clientCpus}`);
    cargs.push('--entrypoint', '/usr/bin/chromium', A.image, '--headless=new', '--no-sandbox', '--disable-gpu',
      '--remote-debugging-port=9222', `--window-size=${W},${H}`, '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank');
    dk(...cargs);
    dk('cp', join(HERE, 'tcpfwd.py'), `${CNAME}:/tmp/tcpfwd.py`);
    dk('exec', '-d', CNAME, '/lsiopy/bin/python3', '/tmp/tcpfwd.py', '9223', '9222');
    browser = await waitFor('CDP', () => chromium.connectOverCDP(`http://localhost:${CDP_PORT}`, { timeout: 5000 }), 60, 1000);
    const ctx = browser.contexts()[0];
    page = ctx.pages()[0] || await ctx.newPage();
    // headless "window-size" includes emulated browser chrome; pin the CSS viewport exactly.
    await page.setViewportSize({ width: W, height: H });
    await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor('first frames', () => page.evaluate(() => (window.fps || 0) > 0), 90, 1000);
    if (!A.statsOff) await page.evaluate(() => window.postMessage({ type: 'statsOpen', open: true }, location.origin));
    log('client streaming');
    if (A.hidden) { // what a backgrounded / minimized tab does: the client sends STOP_VIDEO
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange')); });
      log('client tab marked hidden');
    }
    if (A.disconnect) { // connect, stream, then the user closes the tab: what keeps running?
      await sleep(5000);
      await browser.close().catch(() => {});
      dkq('rm', '-fv', CNAME);
      browser = null; page = null;
      log('client disconnected');
    }
  }

  if (A.workload !== 'none') dk('exec', '-u', 'abc', '-e', `BENCH_CHROMIUM_FLAGS=${A.chromiumFlags}`, '-d', NAME, 'bash', '/tmp/bench/workload.sh', 'start', A.workload);
  await sleep(A.warmup * 1000);
  result.screen = cexec('abc', 'DISPLAY=:1 xdotool getdisplaygeometry').trim().replace(' ', 'x');

  const s0 = snapshot();
  const c0 = page ? sidecarCpu() : NaN;
  const tEnd = Date.now() + A.dur * 1000;
  while (Date.now() < tEnd) {
    await sleep(1000);
    if (page) {
      try {
        samples.push(await page.evaluate(() => ({ fps: window.fps, s: window.stream_stats && window.stream_stats.latest,
          info: window.stream_info, cl: window.stream_client, iw: innerWidth, ih: innerHeight })));
      } catch (e) { log('sample failed', e.message); }
    }
  }
  const s1 = snapshot();
  const c1 = page ? sidecarCpu() : NaN;
  Object.assign(result, diff(s0, s1));
  result.host_load_end = Math.round(os.loadavg()[0] * 10) / 10;
  if (page) {
    result.client_cpu_pct = Math.round(((c1 - c0) / result.dt) * 1000) / 10;
    // stream_stats.latest repeats between ticks: keep each distinct sample once
    const seen = new Set();
    const ss = samples.map((x) => x.s).filter((s) => s && !seen.has(s.t) && seen.add(s.t));
    result.client_fps = stat(samples.map((x) => x.fps));
    result.enc_fps = stat(ss.map((s) => s.encoded_fps));
    result.encode_ms = stat(ss.map((s) => s.encode_ms));
    result.pipeline_ms = stat(ss.map((s) => s.pipeline_ms));
    result.decode_ms = stat(ss.map((s) => s.decode_ms));
    result.mbps_client = stat(ss.map((s) => s.mbps));
    result.selkies_host_cpu = stat(ss.map((s) => s.cpu_percent));
    const last = samples[samples.length - 1] || {};
    result.codec = last.cl?.codec; result.decoder = last.cl?.decoder; result.client_res = last.cl?.resolution;
    result.inner = `${last.iw}x${last.ih}`;
    result.stream_info = last.info ? { encoder: last.info.encoder, capture: last.info.capture, zero_copy: last.info.zero_copy } : null;
    result.raw_last = last.s;
    const fps = result.enc_fps?.mean || result.client_fps?.mean;
    if (fps > 0) { // CPU cost per delivered frame: comparable even when the host is contended
      result.ms_per_frame = { selkies: Math.round((result.proc.selkies || 0) * 10 / fps * 100) / 100,
        Xvfb: Math.round((result.proc.Xvfb || 0) * 10 / fps * 100) / 100,
        container: Math.round(result.cpu_pct * 10 / fps * 100) / 100 };
    }
  }
  const lg = dkq('logs', NAME); const logs = (lg.stdout + '\n' + lg.stderr).split('\n');
  result.encoder_log = (logs.filter((l) => /Encoder: /.test(l)).pop() || '').trim().slice(-160);
  if (browser) await browser.close().catch(() => {});
  if (A.workload !== 'none') { try { cexec('abc', 'bash /tmp/bench/workload.sh stop'); } catch { /* ignore */ } }
  appendFileSync(A.out, JSON.stringify(result) + '\n');
  const f = (x) => (x ? x.mean : '-');
  console.log([A.label, `cpu=${result.cpu_pct}%`, `selkies=${result.proc.selkies ?? 0}`, `Xvfb=${result.proc.Xvfb ?? 0}`,
    `chromium=${result.proc.chromium ?? 0}`, `fps=${f(result.client_fps)}`, `enc_fps=${f(result.enc_fps)}`, `enc_ms=${f(result.encode_ms)}`,
    `mbps=${f(result.mbps_client)}`, `ms/f=${result.ms_per_frame?.selkies ?? '-'}`, `load=${result.host_load_end}`, `lo=${result.mbps_lo}`, `rss=${result.mem_rss_mb}MB`, `screen=${result.screen}`,
    `codec=${result.codec ?? '-'}`, `client_cpu=${result.client_cpu_pct ?? '-'}`].join(' '));
}

main().catch((e) => { console.error('BENCH FAILED:', e.stack || e); process.exitCode = 1; })
  .finally(() => { if (!A.keep) cleanup(); else log(`kept ${NAME} ${CNAME}`); });
