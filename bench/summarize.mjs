#!/usr/bin/env node
// Summarize bench results: one row per label (mean over repeats, "a/b" shows each repeat for key columns).
//   node summarize.mjs results.jsonl [more.jsonl ...] [--base <label>]
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
let base = null;
const files = [];
for (let i = 0; i < args.length; i++) { if (args[i] === '--base') base = args[++i]; else files.push(args[i]); }
const rows = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const by = new Map();
for (const r of rows) { if (!by.has(r.label)) by.set(r.label, []); by.get(r.label).push(r); }
const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const cols = [
  ['runs', (rs) => String(rs.length)],
  ['screen', (rs) => rs[0].screen || '-'],
  ['cpus', (rs) => rs[0].cpus],
  ['container CPU %', (rs) => rs.map((r) => fmt(r.cpu_pct, 0)).join('/')],
  ['selkies %', (rs) => fmt(mean(rs.map((r) => r.proc?.selkies)))],
  ['Xvfb %', (rs) => fmt(mean(rs.map((r) => r.proc?.Xvfb)))],
  ['app chromium %', (rs) => fmt(mean(rs.map((r) => r.proc?.chromium)))],
  ['terminal+sh %', (rs) => fmt(mean(rs.map((r) => (r.proc?.terminal || 0) + (r.proc?.['workload-sh'] || 0))))],
  ['client fps', (rs) => rs.map((r) => fmt(r.client_fps?.mean, 0)).join('/')],
  ['enc fps', (rs) => fmt(mean(rs.map((r) => r.enc_fps?.mean)))],
  ['encode ms', (rs) => fmt(mean(rs.map((r) => r.encode_ms?.mean)))],
  ['pipeline ms', (rs) => fmt(mean(rs.map((r) => r.pipeline_ms?.mean)))],
  ['selkies CPU ms/frame', (rs) => fmt(mean(rs.map((r) => r.ms_per_frame?.selkies)), 2)],
  ['Xvfb CPU ms/frame', (rs) => fmt(mean(rs.map((r) => r.ms_per_frame?.Xvfb)), 2)],
  ['Mbit/s', (rs) => fmt(mean(rs.map((r) => r.mbps_client?.mean)))],
  ['RSS MB', (rs) => fmt(mean(rs.map((r) => r.mem_rss_mb)), 0)],
  ['host load', (rs) => fmt(mean(rs.map((r) => r.host_load_end)))],
];
console.log('| config | ' + cols.map((c) => c[0]).join(' | ') + ' |');
console.log('|' + '---|'.repeat(cols.length + 1));
for (const [label, rs] of by) console.log(`| ${label} | ` + cols.map((c) => c[1](rs)).join(' | ') + ' |');
if (base && by.has(base)) {
  const b = by.get(base);
  const bs = mean(b.map((r) => r.proc?.selkies)), bx = mean(b.map((r) => r.proc?.Xvfb)), bc = mean(b.map((r) => r.cpu_pct)), bf = mean(b.map((r) => r.client_fps?.mean));
  const bm = mean(b.map((r) => r.ms_per_frame?.selkies));
  console.log(`\nvs ${base}: d(container CPU) d(selkies) d(Xvfb) d(fps) d(selkies ms/frame)`);
  for (const [label, rs] of by) {
    if (label === base) continue;
    const pc = (x, y) => (Number.isFinite(x) && y ? `${x >= y ? '+' : ''}${(((x - y) / y) * 100).toFixed(0)}%` : '-');
    console.log(`${label.padEnd(22)} ${pc(mean(rs.map((r) => r.cpu_pct)), bc).padStart(6)} ${pc(mean(rs.map((r) => r.proc?.selkies)), bs).padStart(6)} ${pc(mean(rs.map((r) => r.proc?.Xvfb)), bx).padStart(6)} ${pc(mean(rs.map((r) => r.client_fps?.mean)), bf).padStart(6)} ${pc(mean(rs.map((r) => r.ms_per_frame?.selkies)), bm).padStart(6)}`);
  }
}
