/**
 * OpenClaw wrapper — run mekithil chain and report to Telegram.
 *
 * Usage from OpenClaw:
 *   node scripts/openclaw-run.js --count 3 --seed HWPMXZ
 *
 * Reports each account via stdout markers that OpenClaw captures.
 */

import { ChainRunner } from '../src/runner/chain-runner.js';
import { config, seedRef as defaultSeed, proxyManager } from './chain-loop-config.js';
import { parseArgs } from 'util';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '1' },
    seed: { type: 'string', default: defaultSeed || '' },
  },
});

const count = parseInt(values.count || '1', 10);
const seedRef = values.seed || defaultSeed;

const runner = new ChainRunner(config, proxyManager);
const startTime = Date.now();

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

runner.on('start', ({ count: c, seedRef: ref }) => {
  console.log(`[START] Target: ${c} akun | Seed: ${ref || '-'}`);
});

runner.on('progress', (r) => {
  const elapsed = fmt(Date.now() - startTime);
  if (r.ok) {
    console.log(`[SUCCESS] ${r.email} | ref=${r.refCode || '-'} | api=${(r.apiKey || '-').substring(0, 20)} | ${elapsed}`);
  } else {
    console.log(`[FAIL] ${r.email || '?'} | ${r.error}`);
  }
});

runner.on('log', (msg) => {
  if (msg.startsWith('⏳') || msg.startsWith('🌐') || msg.startsWith('⏭')) {
    console.log(`[LOG] ${msg}`);
  }
});

runner.on('done', ({ okCount, failCount }) => {
  console.log(`[DONE] ok=${okCount} fail=${failCount} total=${fmt(Date.now() - startTime)}`);
});

runner.on('stopped', ({ okCount, failCount }) => {
  console.log(`[STOPPED] ok=${okCount} fail=${failCount}`);
});

process.on('SIGINT', () => runner.stop());
process.on('SIGTERM', () => runner.stop());

runner.start({ count, seedRef }).catch(err => {
  console.error(`[ERROR] ${err.message}`);
  process.exit(1);
});
