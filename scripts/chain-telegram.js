#!/usr/bin/env node
/**
 * Telegram-integrated chain loop runner.
 * Reports each account result to Telegram via process.stdout markers.
 *
 * Usage:
 *   node scripts/chain-telegram.js --count 5
 *   node scripts/chain-telegram.js --count 3 --seed HWPMXZ
 */

import { ChainRunner } from '../src/runner/chain-runner.js';
import { config, count, seedRef, proxyManager } from './chain-loop-config.js';

const runner = new ChainRunner(config, proxyManager);
const startTime = Date.now();

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

function sendTelegram(msg) {
  console.log(`[TELEGRAM_REPORT] ${msg}`);
}

runner.on('start', ({ count, seedRef: ref }) => {
  sendTelegram(`🚀 **Chain dimulai**\n• Target: ${count} akun\n• Seed: \`${ref || '-'}\``);
});

runner.on('progress', (r) => {
  const elapsed = formatDuration(Date.now() - startTime);
  if (r.ok) {
    const lines = [
      `✅ **Akun ${r.idx + 1}/${r.total} sukses**`,
      `• Email: \`${r.email}\``,
      r.refCode ? `• Ref: \`${r.refCode}\`` : null,
      r.apiKey ? `• API: \`${r.apiKey.substring(0, 24)}...\`` : null,
      `• Waktu: ${elapsed}`,
    ].filter(Boolean);
    sendTelegram(lines.join('\n'));
  } else {
    const lines = [
      `❌ **Akun ${r.idx + 1}/${r.total} gagal**`,
      `• Email: \`${r.email || '?'}\``,
      `• Error: ${r.error}`,
      r.restricted ? `• ⛔ STOPPED: ${r.stopReason}` : null,
    ].filter(Boolean);
    sendTelegram(lines.join('\n'));
  }
});

runner.on('log', (msg) => {
  if (msg.startsWith('⏳') || msg.startsWith('🌐') || msg.startsWith('⏭')) {
    console.log(msg);
  }
});

runner.on('done', ({ okCount, failCount }) => {
  const elapsed = formatDuration(Date.now() - startTime);
  sendTelegram([
    `🏁 **Chain selesai**`,
    `• ✅ Sukses: ${okCount}`,
    `• ❌ Gagal: ${failCount}`,
    `• Total waktu: ${elapsed}`,
  ].join('\n'));
});

runner.on('stopped', ({ okCount, failCount }) => {
  const elapsed = formatDuration(Date.now() - startTime);
  sendTelegram([
    `⏹ **Chain dihentikan**`,
    `• ✅ Sukses: ${okCount}`,
    `• ❌ Gagal: ${failCount}`,
    `• Waktu: ${elapsed}`,
  ].join('\n'));
});

process.on('SIGINT', () => {
  sendTelegram(`⏸️ Stop requested...`);
  runner.stop();
});
process.on('SIGTERM', () => runner.stop());

runner.start({ count, seedRef }).catch(err => {
  sendTelegram(`💥 **Fatal error:** ${err.message}`);
  process.exit(1);
});
