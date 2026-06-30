/**
 * ChainRunner — reusable chain loop runner tanpa process.exit().
 * Emits events untuk integrasi bot Telegram / UI lainnya.
 *
 * Events:
 *   'start'    → { count, seedRef }
 *   'progress' → { idx, total, ok, email, refCode, apiKey, error }
 *   'done'     → { okCount, failCount, results[] }
 *   'stopped'  → { okCount, failCount, atIteration }
 *   'log'      → string (console replacement)
 */

import { EventEmitter } from 'events';
import { chromium } from 'playwright';
import { appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { MimoRegistration } from '../core/registration.js';
import { generateFingerprint, buildInitScript, buildExtraHeaders } from '../browser/fingerprint.js';
import { applyStealthPatches } from '../browser/stealth.js';
import { generatePassword } from '../utils/password-gen.js';

const PROXY_ERROR_PATTERN = /ERR_TUNNEL|ERR_PROXY|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang|timeout|NS_ERROR/i;

class ChainRunner extends EventEmitter {
  constructor(config, proxyManager, outputDir) {
    super();
    this.config = config;
    this.proxyManager = proxyManager;
    this.outputDir = outputDir || join(import.meta.dirname || '.', '..', '..', 'output');
    this.outputFile = join(this.outputDir, 'chain-result.txt');
    this.failLog = join(this.outputDir, 'chain-fail.log');
    this._aborted = false;
    this._running = false;
  }

  get running() { return this._running; }

  stop() {
    this._aborted = true;
    this.emit('log', '⏹ Stop requested — finishing current iteration...');
  }

  async start({ count, seedRef }) {
    if (this._running) {
      this.emit('log', '⚠ Chain is already running');
      return;
    }

    this._aborted = false;
    this._running = true;

    const results = [];
    let currentRef = seedRef;
    let okCount = 0, failCount = 0;

    this.emit('start', { count, seedRef });

    for (let i = 0; i < count && !this._aborted; i++) {
      const result = await this._runIteration(i, count, currentRef);

      if (result.ok) {
        okCount++;
        results.push(result);
        if (result.refCode) {
          currentRef = result.refCode;
        } else {
          this.emit('log', `⚠ Stopping — iteration ${i + 1} succeeded but no refCode captured`);
          break;
        }
      } else {
        failCount++;
        results.push(result);
        if (result.restricted) {
          this.emit('log', `⛔ Chain stopped: ${result.stopReason}`);
          break;
        }
        this.emit('log', `↻ Iteration failed, retrying with same seed ${currentRef}`);
      }

      // Rate limiting: 5-10 minutes between accounts to avoid detection
      // MiMo risk control flags rapid registration patterns
      if (i < count - 1 && !this._aborted) {
        const minDelay = this.config.xiaomi.inviteCooldownMs || 300000; // 5 min default
        const maxDelay = minDelay + 300000; // +5 min jitter
        const wait = minDelay + Math.floor(Math.random() * (maxDelay - minDelay));
        this.emit('log', `⏳ Waiting ${Math.round(wait/1000)}s (${Math.round(wait/60000)}min) before next account...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }

    this._running = false;

    if (this._aborted) {
      this.emit('stopped', { okCount, failCount, results });
    } else {
      this.emit('done', { okCount, failCount, results });
    }
  }

  async _runIteration(idx, total, currentRef) {
    const iterConfig = JSON.parse(JSON.stringify(this.config));
    iterConfig.xiaomi.inviteCode = currentRef;
    iterConfig.xiaomi.password = generatePassword(); // unique password per account
    iterConfig.xiaomi.referralLink =
      `https://platform.xiaomimimo.com/?ref=${encodeURIComponent(currentRef)}`;

    const reg = new MimoRegistration(iterConfig);
    let email = null, refCode = null, apiKey = null;
    let currentProxy = null;

    try {
      email = await reg.tempmail.createInbox();

      const fp = generateFingerprint();
      reg.fingerprint = fp;

      currentProxy = null;
      if (this.proxyManager && this.proxyManager.count > 0) {
        currentProxy = this.proxyManager.getNext();
        if (currentProxy) {
          const hint = this.proxyManager.getFingerprintHint(this.config.proxy?.defaultCountry || 'US');
          fp.locale = hint.locale;
          fp.timezone = hint.timezone;
          this.emit('log', `🌐 Using proxy: ${currentProxy.server}`);
        }
      }

      // Enhanced stealth: disable automation indicators
      reg.browser = await chromium.launch({
        headless: iterConfig.browser.headless,
        args: [
          `--window-size=${fp.viewport.width},${fp.viewport.height}`,
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-site-isolation-trials',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
        ],
      });

      const ctxOpts = {
        userAgent: fp.userAgent, viewport: fp.viewport,
        deviceScaleFactor: fp.deviceScaleFactor,
        locale: fp.locale, timezoneId: fp.timezone,
        screen: { width: fp.screen.width, height: fp.screen.height },
        extraHTTPHeaders: buildExtraHeaders(fp),
      };
      if (currentProxy) ctxOpts.proxy = currentProxy;

      const ctx = await reg.browser.newContext(ctxOpts);
      await ctx.addInitScript({ content: buildInitScript(fp) });
      reg.page = await ctx.newPage();

      // Apply additional stealth patches
      await applyStealthPatches(reg.page, ctx);

      const origScreenshot = reg.page.screenshot.bind(reg.page);
      reg.page.screenshot = async (opts = {}) => {
        const isError = opts.path && opts.path.includes('error');
        if (isError || iterConfig.browser.screenshots === true) return origScreenshot(opts);
        return Buffer.alloc(0);
      };

      await reg.page.goto(iterConfig.xiaomi.referralLink, {
        waitUntil: 'commit', timeout: iterConfig.browser.timeout,
      });
      await reg.page.waitForLoadState('domcontentloaded', { timeout: iterConfig.browser.timeout }).catch(() => {});

      await reg.fillRegistrationForm(email);
      await reg.submitRegistration();
      await reg.handleXiaomiCaptcha();
      await reg.handleImageCaptcha();
      await reg.verifyEmail(email);

      // Skip invite code by default to avoid ACCOUNT_RESTRICTED risk control
      // Redeem manually later after accounts cool down
      if (!iterConfig.xiaomi.skipInviteCode) {
        try { await reg.redeemInviteCode(); } catch (e) {
          if (e.code === 'ACCOUNT_RESTRICTED' || e.code === 'BALANCE_NOT_CREDITED') throw e;
        }
      } else {
        this.emit('log', '⏭ Skipping invite code redemption (skipInviteCode=true)');
      }

      try { apiKey = await reg.createApiKey(); } catch (e) {}
      try { await reg.fillUltraspeedForm(email); } catch (e) {}

      try {
        const captured = await reg.getReferralCode();
        if (captured && captured.toUpperCase() === currentRef.toUpperCase()) {
          refCode = null;
        } else {
          refCode = captured;
        }
      } catch (e) {}

      this._saveResult({ email, password: iterConfig.xiaomi.password, refCode, apiKey, invitedBy: currentRef });

      const result = { ok: true, idx, total, email, refCode, apiKey };
      this.emit('progress', result);
      return result;

    } catch (err) {
      if (currentProxy && this.proxyManager && PROXY_ERROR_PATTERN.test(err.message)) {
        this.proxyManager.reportFailure(currentProxy);
      }

      this._logFailed(email, err.message);

      const result = {
        ok: false, idx, total, email, error: err.message,
        restricted: err.code === 'ACCOUNT_RESTRICTED' || err.code === 'BALANCE_NOT_CREDITED',
        stopReason: err.code,
      };
      this.emit('progress', result);
      return result;
    } finally {
      if (reg.browser) await reg.browser.close().catch(() => {});
    }
  }

  _saveResult(row) {
    const line = [row.email, row.password, row.refCode || '', row.apiKey || '', row.invitedBy || ''].join(':') + '\n';
    if (!existsSync(this.outputFile)) {
      appendFileSync(this.outputFile, '# Chain loop results. Format: email:password:refCode:apiKey:invitedBy\n', 'utf8');
    }
    appendFileSync(this.outputFile, line, 'utf8');
  }

  _logFailed(email, error) {
    const line = `[${new Date().toISOString()}] ${email || 'unknown'}  | ${error}\n`;
    appendFileSync(this.failLog, line, 'utf8');
  }
}

export { ChainRunner };
