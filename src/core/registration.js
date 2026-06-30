/**
 * Xiaomi MiMo Registration — Core class.
 *
 * Menggabungkan MimoRegistration + getReferralCode (sebelumnya di extras.js).
 * Tidak pakai prototype extension lagi.
 */

import { chromium } from 'playwright';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { TempmailClient } from '../clients/tempmail.js';
import { CaptchaSolver } from '../clients/captcha.js';
import { AccountManager } from '../utils/account-manager.js';
import { generateFingerprint, buildInitScript, buildExtraHeaders } from '../browser/fingerprint.js';
import { humanFill, humanFillLocator, humanClick, humanType, humanDelay } from '../browser/human.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Common English words yg sering ke-match regex code uppercase.
const REF_BLACKLIST = new Set([
  'YOUR', 'CODE', 'INVITE', 'REFERRAL', 'ENTER', 'COPY', 'SHARE',
  'EARN', 'NULL', 'NONE', 'TRUE', 'FALSE', 'EMPTY',
]);

/**
 * Validate ref code — Xiaomi MiMo invite codes are always EXACTLY 6 chars
 * alphanumeric uppercase.
 */
function isValidRefCode(s) {
  if (!s) return false;
  const up = String(s).toUpperCase().trim();
  if (up.length !== 6) return false;
  if (REF_BLACKLIST.has(up)) return false;
  return /^[A-Z0-9]{6}$/.test(up);
}


class MimoRegistration {
  constructor(config) {
    this.config = config;
    this.tempmail = new TempmailClient(config.tempmail.apiUrl);
    this.captcha = new CaptchaSolver(config.captcha.apiKey);
    this.browser = null;
    this.page = null;
    this.accountManager = new AccountManager();
    this.createdAccount = null;
  }
  async run() {
    try {
      console.log('═'.repeat(70));
      console.log('   Xiaomi MiMo Auto-Registration');
      console.log('   Browser Automation Approach');
      console.log('═'.repeat(70));
      console.log();

      // Step 1: Create tempmail
      console.log('[Step 1/7] Creating temporary email...');
      const email = await this.tempmail.createInbox();
      console.log(`✓ Email created: ${email}`);
      console.log();

      // Step 2: Launch browser with randomized fingerprint
      console.log('[Step 2/7] Launching browser...');
      const fp = generateFingerprint();
      this.fingerprint = fp;
      console.log(`  ↳ UA       : Chrome ${fp.chromeMajor} on Win64`);
      console.log(`  ↳ Viewport : ${fp.viewport.width}x${fp.viewport.height} (DPR ${fp.deviceScaleFactor})`);
      console.log(`  ↳ Locale   : ${fp.locale}  TZ: ${fp.timezone}`);
      console.log(`  ↳ CPU/Mem  : ${fp.hardwareConcurrency} cores / ${fp.deviceMemory} GB`);
      console.log(`  ↳ GPU      : ${fp.webgl.renderer.substring(0, 70)}…`);

      this.browser = await chromium.launch({
        headless: this.config.browser.headless,
        args: [
          // Hindari flag --headless yg kelihatan, dan window-size konsisten dgn viewport
          `--window-size=${fp.viewport.width},${fp.viewport.height}`,
          '--disable-blink-features=AutomationControlled',
        ],
      });

      // Pakai context terpisah biar bisa set UA/viewport/timezone/locale per loop
      const context = await this.browser.newContext({
        userAgent: fp.userAgent,
        viewport: fp.viewport,
        deviceScaleFactor: fp.deviceScaleFactor,
        locale: fp.locale,
        timezoneId: fp.timezone,
        screen: { width: fp.screen.width, height: fp.screen.height },
        extraHTTPHeaders: buildExtraHeaders(fp),
      });

      // Inject fingerprint overrides sebelum kode situs sempat baca navigator/screen/canvas
      await context.addInitScript({ content: buildInitScript(fp) });

      this.page = await context.newPage();
      
      // Wrap screenshot method to only capture if enabled or if it's an error screenshot
      const originalScreenshot = this.page.screenshot.bind(this.page);
      this.page.screenshot = async (options = {}) => {
        const isErrorScreenshot = options.path && options.path.includes('error');
        if (isErrorScreenshot || this.config.browser.screenshots === true) {
          return originalScreenshot(options);
        }
        return Buffer.alloc(0);
      };
      this.page.on('console', msg => {
        const txt = msg.text();
        if (txt.includes('error') || txt.includes('failed') || txt.includes('Success') || txt.includes('warn')) {
          console.log(`  [Browser Console] ${msg.type()}: ${txt.substring(0, 150)}`);
        }
      });
      this.page.on('pageerror', err => console.log(`  [Browser Error] ${err.message}`));
      this.page.on('request', req => {
        const url = req.url();
        if (url.includes('apply') || url.includes('form') || url.includes('platform') && req.method() === 'POST') {
          console.log(`  [Network Request] ${req.method()} ${url}`);
        }
      });
      this.page.on('response', res => {
        const url = res.url();
        if (url.includes('apply') || url.includes('form') || url.includes('platform') && res.request().method() === 'POST') {
          console.log(`  [Network Response] ${res.status()} ${url}`);
        }
      });
      console.log('✓ Browser launched');
      console.log();

      // Step 3: Navigate to registration page
      console.log('[Step 3/7] Opening registration page...');
      await this.page.goto(this.config.xiaomi.referralLink, {
        waitUntil: 'networkidle',
        timeout: this.config.browser.timeout
      });
      console.log('✓ Page loaded');
      console.log();

      // Step 4: Fill registration form
      console.log('[Step 4/7] Filling registration form...');
      await this.fillRegistrationForm(email);
      console.log('✓ Form filled');
      console.log();

      // Step 5: Submit registration (captcha appears AFTER click)
      console.log('[Step 5/7] Submitting registration...');
      await this.submitRegistration();
      console.log('✓ Submit clicked');
      console.log();

      // Step 6: Handle Xiaomi captcha modal (appears after submit)
      console.log('[Step 6/7] Handling captcha...');
      await this.handleXiaomiCaptcha();
      await this.handleImageCaptcha();
      console.log('✓ Captcha handled');
      console.log();

      // Step 7: Verify email
      console.log('[Step 7/7] Verifying email...');
      await this.verifyEmail(email);
      console.log('✓ Email verified');
      console.log();

      // Get cookies for session tokens
      console.log('  Extracting session cookies...');
      const cookies = await this.page.context().cookies();
      const passTokenCookie = cookies.find(c => c.name === 'passToken');
      const serviceTokenCookie = cookies.find(c => c.name === 'serviceToken');
      
      const passToken = passTokenCookie ? passTokenCookie.value : null;
      const serviceToken = serviceTokenCookie ? serviceTokenCookie.value : null;

      // Skip invite code — HWPMXZ is flagged/restricted
      // Redeem later using fresh referral codes from accounts.json
      console.log('  Skipping invite code redemption (use separate script to redeem later)');

      // 2. Create API Key
      let apiKey = null;
      try {
        apiKey = await this.createApiKey();
      } catch (keyErr) {
        console.log('  ! Failed to create API Key:', keyErr.message);
      }

      // 3. Fill Ultraspeed form (terakhir — tergantung saldo dulu udah masuk)
      try {
        await this.fillUltraspeedForm(email);
      } catch (formErr) {
        console.log('  ! Failed to complete Ultraspeed form submission:', formErr.message);
      }

      // Success
      console.log('═'.repeat(70));
      console.log('✅ REGISTRATION SUCCESSFUL');
      console.log('═'.repeat(70));
      console.log(`Email: ${email}`);
      console.log(`Password: ${this.config.xiaomi.password}`);
      console.log(`passToken: ${passToken || 'Not found'}`);
      console.log(`serviceToken: ${serviceToken || 'Not found'}`);
      console.log(`API Key: ${apiKey || 'Not created'}`);
      console.log();

      // Save to account manager for referral rotation
      // Note: referral_code will be added later when invite code is redeemed
      if (this.accountManager) {
        this.createdAccount = this.accountManager.addAccount({
          email,
          password: this.config.xiaomi.password,
          referral_code: null,
          api_key: apiKey
        });
      }

      return { 
        email, 
        password: this.config.xiaomi.password,
        passToken,
        serviceToken,
        apiKey
      };

    } catch (error) {
      console.error();
      console.error('═'.repeat(70));
      console.error('❌ REGISTRATION FAILED');
      console.error('═'.repeat(70));
      console.error(error.message);
      console.error();
      
      // Save screenshot on error
      if (this.page) {
        try {
          const screenshotPath = join(__dirname, 'mimo-error.png');
          await this.page.screenshot({ path: screenshotPath, fullPage: true });
          console.error(`Screenshot saved: ${screenshotPath}`);
        } catch (e) {
          console.error('Could not save screenshot:', e.message);
        }
      }
      
      throw error;
    } finally {
      if (this.browser) {
        await this.browser.close();
      }
    }
  }

  async fillRegistrationForm(email) {
    // 0. Tunggu semua redirect selesai — platform.xiaomimimo.com → account.xiaomi.com
    //    Dengan proxy bisa butuh 10+ detik, jadi tunggu URL stabil dulu.
    console.log('  Waiting for page to fully load (redirects)...');
    let currentUrl = this.page.url();
    for (let i = 0; i < 15; i++) {
      await this.page.waitForTimeout(1500);
      const newUrl = this.page.url();
      if (newUrl === currentUrl && newUrl.includes('account.xiaomi.com')) break;
      if (newUrl !== currentUrl) {
        console.log(`  ↳ Redirect: ${newUrl.substring(0, 80)}...`);
        currentUrl = newUrl;
      }
    }
    await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    console.log(`  ✓ Page stable: ${this.page.url().substring(0, 80)}...`);

    // 1. Accept cookies dulu kalau ada
    try {
      const cookieBtn = this.page.locator('button:has-text("Accept cookies"), button:has-text("Accept All")').first();
      if (await cookieBtn.count() > 0 && await cookieBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await cookieBtn.click({ timeout: 4000 });
        console.log('  ✓ Accepted cookies');
        await this.page.waitForTimeout(2000);
      }
    } catch (e) {}

    // 2. Click "Sign up" tab — multi-strategi
    console.log('  Looking for Sign up tab...');
    const tabSelectors = [
      '.ant-tabs-tab-btn:has-text("Sign up")',
      '[role="tab"]:has-text("Sign up")',
      '.ant-tabs-tab:has-text("Sign up")',
    ];
    let tabClicked = false;
    for (const sel of tabSelectors) {
      try {
        const tab = this.page.locator(sel).first();
        if (await tab.count() > 0 && await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
          await tab.click({ timeout: 5000 });
          console.log(`  ✓ Clicked Sign up tab (${sel})`);
          tabClicked = true;
          break;
        }
      } catch (e) {}
    }
    if (!tabClicked) {
      for (let attempt = 0; attempt < 3 && !tabClicked; attempt++) {
        try {
          tabClicked = await this.page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('.ant-tabs-tab-btn, [role="tab"]'));
            const el = all.find(e => {
              const txt = (e.textContent || '').trim();
              return txt === 'Sign up' && e.offsetHeight > 0;
            });
            if (el) { el.click(); return true; }
            return false;
          });
          if (tabClicked) console.log('  ✓ Clicked Sign up tab (DOM eval)');
        } catch (e) {
          if (attempt < 2) {
            console.log('  ! DOM eval retry...');
            await this.page.waitForTimeout(2000);
          }
        }
      }
    }
    if (!tabClicked) console.log('  ! Sign up tab not found — may already be on signup form');
    await this.page.waitForTimeout(3000);

    // 3. Wait for email input — name="email" setelah klik Sign up
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.page.waitForSelector('input[name="email"]', { timeout: 8000 });
        console.log('  ✓ Signup form visible');
        break;
      } catch (e) {
        if (attempt < 4) {
          console.log(`  ! Email input not ready (attempt ${attempt + 1}/5), retrying...`);
          await this.page.waitForTimeout(2000);
        } else {
          throw e;
        }
      }
    }

    // 4. Fill email
    await humanFill(this.page, 'input[name="email"]', email);
    console.log('  ✓ Filled email');
    await humanDelay(200, 500);

    // 5. Fill password (name="password")
    // NOTE: Xiaomi risk control detects keyboard events on password fields
    // and closes the page. Use Playwright .fill() for password fields.
    const pwdField = this.page.locator('input[name="password"]').first();
    if (await pwdField.count() > 0 && await pwdField.isVisible()) {
      await this.page.fill('input[name="password"]', this.config.xiaomi.password);
      console.log('  ✓ Filled password');
    }

    // 6. Fill confirm password (name="repassword")
    const repwdField = this.page.locator('input[name="repassword"]').first();
    if (await repwdField.count() > 0 && await repwdField.isVisible()) {
      await humanDelay(200, 450);
      await this.page.fill('input[name="repassword"]', this.config.xiaomi.password);
      console.log('  ✓ Filled confirm password');
    }

    // 6. Check terms agreement checkbox — klik wrapper Ant Design biar onChange ke-trigger
    const termsChecked = await this.page.evaluate(() => {
      const wrapper = document.querySelector('.ant-checkbox-wrapper');
      if (wrapper && wrapper.offsetHeight > 0) {
        wrapper.click();
        const input = wrapper.querySelector('.ant-checkbox-input, input[type="checkbox"]');
        return input ? input.checked : true;
      }
      const cb = document.querySelector('input[type="checkbox"]');
      if (cb && cb.offsetHeight > 0) {
        cb.click();
        return cb.checked;
      }
      return false;
    });
    if (termsChecked) {
      console.log('  ✓ Checked terms agreement');
    } else {
      // Fallback Playwright
      try {
        await this.page.click('.ant-checkbox-wrapper', { timeout: 3000 });
        console.log('  ✓ Checked terms (Playwright fallback)');
      } catch (e) {
        console.log('  ! Could not check terms checkbox');
      }
    }
  }

  async handleXiaomiCaptcha() {
    // Wait for Xiaomi captcha modal to appear after submit
    console.log('  Waiting for Xiaomi captcha modal...');
    
    try {
      // Wait for captcha modal to become visible
      await this.page.waitForSelector('.miverify_wind:not([style*="display: none"])', { 
        timeout: 15000 
      });
      console.log('  ✓ Captcha modal appeared');

      // Check if it is the image captcha instead of reCAPTCHA
      const isImageCaptcha = await this.page.$('input[name="icode"]').then(async el => el ? await el.isVisible() : false);
      if (isImageCaptcha) {
        console.log('  Image captcha detected directly, skipping reCAPTCHA check');
        return;
      }
      
      // Wait for the reCAPTCHA iframe to load in the DOM
      try {
        await this.page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 15000 });
        console.log('  ✓ reCAPTCHA iframe detected');
      } catch (e) {
        console.log('  ! reCAPTCHA iframe not found by selector, scanning frames...');
      }
      
      let retries = 5;
      let solved = false;
      
      while (retries > 0 && !solved) {
        // Check if image captcha is visible (in case it appeared after some actions)
        const isImageCaptchaInsideLoop = await this.page.$('input[name="icode"]').then(async el => el ? await el.isVisible() : false);
        if (isImageCaptchaInsideLoop) {
          console.log('  Image captcha detected inside loop, switching solver...');
          break;
        }

        const frames = this.page.frames(); // Get fresh list of frames in each attempt
        let anchorFrame = null;
        
        for (const frame of frames) {
          const url = frame.url();
          if (url.includes('recaptcha') && url.includes('anchor')) {
            anchorFrame = frame;
            break;
          }
        }
        
        if (anchorFrame) {
          console.log(`  Found reCAPTCHA checkbox iframe (attempt ${6 - retries}/5)`);
          
          try {
            await anchorFrame.waitForSelector('.recaptcha-checkbox-border', { timeout: 10000 });
            await anchorFrame.click('.recaptcha-checkbox-border');
            console.log('  ✓ Clicked reCAPTCHA checkbox');
            
            // Wait for either checkmark (success) or image challenge
            try {
              await anchorFrame.waitForSelector('.recaptcha-checkbox-checked', { timeout: 3000 });
              console.log('  ✓ reCAPTCHA verified (checkmark appeared)');
              solved = true;
            } catch (e) {
              // Checkmark didn't appear - likely image challenge
              console.log('  Image challenge detected, solving via 2Captcha...');
              
              // Extract sitekey from reCAPTCHA iframe
              const sitekey = await this.page.evaluate(() => {
                const frames = document.querySelectorAll('iframe[src*="recaptcha"]');
                for (const frame of frames) {
                  const match = frame.src.match(/k=([^&]+)/);
                  if (match) return match[1];
                }
                return null;
              });
              
              if (!sitekey) {
                throw new Error('Could not extract reCAPTCHA sitekey');
              }
              
              console.log(`  Sitekey: ${sitekey}`);
              
              // Solve via 2Captcha
              const solution = await this.captcha.solveCaptcha(sitekey, this.page.url());
              
              // Inject solution and trigger callback
              const callbackSuccess = await this.page.evaluate((token) => {
                // 1. Inject token into textarea
                const textareas = document.querySelectorAll('[id^="g-recaptcha-response"], [name^="g-recaptcha-response"]');
                textareas.forEach(textarea => {
                  textarea.value = token;
                  textarea.dispatchEvent(new Event('change', { bubbles: true }));
                  textarea.dispatchEvent(new Event('input', { bubbles: true }));
                });

                // 2. Find and execute recaptcha callback in ___grecaptcha_cfg
                if (typeof ___grecaptcha_cfg !== 'undefined' && ___grecaptcha_cfg.clients) {
                  const clients = ___grecaptcha_cfg.clients;
                  let called = false;
                  
                  function recursiveSearch(obj) {
                    if (called) return;
                    for (let key in obj) {
                      if (called) return;
                      let val = obj[key];
                      if (val !== null && typeof val === 'object') {
                        if (val.callback && typeof val.callback === 'function') {
                          try {
                            val.callback(token);
                            called = true;
                          } catch (err) {
                            console.error('Error invoking callback:', err);
                          }
                          return;
                        }
                        recursiveSearch(val);
                      }
                    }
                  }

                  Object.keys(clients).forEach(k => {
                    if (!called) {
                      recursiveSearch(clients[k]);
                    }
                  });
                  return called;
                }
                return false;
              }, solution);
              
              console.log(`  ✓ Solution injected, callback executed: ${callbackSuccess}`);
              solved = true;
            }
            
            // Modal should auto-close or we proceed immediately
            await this.page.waitForTimeout(2000);

            // Coba berbagai selector tombol proceed — halaman baru Xiaomi beda-beda
            const proceedSelectors = [
              '.miverify_panel_next',
              'button:has-text("Continue")',
              'button:has-text("Next")',
              'button.ant-btn-primary:has-text("Submit")',
              '.mi-captcha-code-form button.ant-btn-primary',
            ];
            for (const sel of proceedSelectors) {
              const btn = await this.page.$(sel);
              if (btn) {
                try {
                  await btn.click({ timeout: 4000 });
                  console.log(`  ✓ Proceed: ${sel}`);
                  break;
                } catch (e) {}
              }
            }
            
          } catch (e) {
            console.log(`  ! Captcha error: ${e.message}`);
          }
        } else {
          console.log(`  reCAPTCHA iframe not ready yet (attempt ${6 - retries}/5)`);
        }
        
        if (!solved) {
          retries--;
          if (retries > 0) {
            console.log(`  Waiting before retry... (${retries} attempts left)`);
            await this.page.waitForTimeout(3000);
          }
        }
      }
      
    } catch (e) {
      console.log('  No captcha modal appeared (might have auto-passed)');
    }
  }

  async handleImageCaptcha() {
    console.log('  Checking for image verification code modal...');
    
    try {
      // 1. Wait up to 10 seconds for the image captcha element to appear
      // If it doesn't appear, it means registration went straight to email verification
      try {
        await this.page.waitForSelector('img[src*="captcha"], img[src*="getCaptcha"], img[src*="code"], img[class*="captcha"]', { 
          timeout: 10000 
        });
        console.log('  ✓ Image captcha element detected');
      } catch (e) {
        console.log('  No image captcha element detected (likely proceeded to email verification)');
        return;
      }

      let imageRetries = 5;
      let solvedImage = false;

      while (imageRetries > 0 && !solvedImage) {
        // 2. Find the input field inside the modal
        const codeInput = await this.page.$('input[name="icode"]');
        if (!codeInput) {
          console.log('  No image captcha input found');
          return;
        }

        // 3. Locate the captcha image element
        let captchaImg = await this.page.$('img[src*="captcha"], img[src*="getCaptcha"], img[src*="code"], img[class*="captcha"]');
        if (!captchaImg) {
          throw new Error('Could not locate captcha image element');
        }

  // 4. Take a screenshot of the captcha image element
        console.log(`  Taking screenshot of captcha image (attempt ${6 - imageRetries}/5)...`);
        const imgBuffer = await captchaImg.screenshot();
        
        // Pre-process image for better OCR: convert to high-contrast grayscale
        let base64Image;
        try {
          // Use sharp for image preprocessing if available
          const sharp = (await import('sharp')).default;
          const processed = await sharp(imgBuffer)
            .greyscale()
            .normalize()  // Increase contrast
            .sharpen()    // Sharpen edges
            .toBuffer();
          base64Image = processed.toString('base64');
          console.log('  ✓ Pre-processed captcha image (greyscale + normalize + sharpen)');
        } catch (sharpErr) {
          // Fallback: use raw screenshot
          base64Image = imgBuffer.toString('base64');
          console.log('  ! sharp not available, using raw image');
        }

        // 5. Solve using 2Captcha
        const solution = await this.captcha.solveImageCaptcha(base64Image);
        console.log(`  ✓ Image captcha solved: ${solution}`);

        // 6. Fill code and submit
        await humanFill(this.page, codeInput, solution, { clear: 'select-all' });
        console.log('  ✓ Filled captcha code');

        // Find submit button — cari button "Submit" di form atau modal.
        // Di halaman baru (global.account.xiaomi.com) form-nya `.mi-captcha-code-form`
        // dengan tombol `.ant-btn-primary`. Di halaman lama ada di `.miverify_wind`.
        let submitBtn = null;
        const btnSelectors = [
          '.mi-captcha-code-form button.ant-btn-primary',
          '.mi-captcha-code-form button:has-text("Submit")',
          'form.mi-captcha-code-form button[type="submit"]',
          '.miverify_wind button:has-text("Submit")',
          '.miverify_wind .miverify_panel_next',
          'button.ant-btn-primary:has-text("Submit")',
        ];
        for (const sel of btnSelectors) {
          submitBtn = await this.page.$(sel);
          if (submitBtn) {
            console.log(`  ✓ Found submit button: ${sel}`);
            break;
          }
        }

        // Fallback: DOM eval — cari button "Submit" di mana pun
        if (!submitBtn) {
          console.log('  Searching for Submit button via DOM eval...');
          submitBtn = await this.page.evaluateHandle(() => {
            const btns = Array.from(document.querySelectorAll('button.ant-btn-primary, button'));
            const btn = btns.find(b => b.textContent.trim() === 'Submit' && b.offsetHeight > 0);
            return btn || null;
          });
          if (submitBtn.asElement()) {
            console.log('  ✓ Found Submit button via DOM eval');
          } else {
            submitBtn = null;
          }
        }

        if (submitBtn) {
          try {
            await submitBtn.click({ timeout: 5000 });
            console.log('  ✓ Clicked Submit button');
          } catch (clickErr) {
            console.log('  ! Button click failed, trying force click...');
            try {
              await submitBtn.click({ force: true, timeout: 3000 });
              console.log('  ✓ Clicked Submit (force)');
            } catch (e2) {
              // Last resort: Enter on input
              await codeInput.press('Enter');
              console.log('  ✓ Pressed Enter on input (last resort)');
            }
          }
        } else {
          // Absolutely last resort
          console.log('  ! No submit button found, pressing Enter...');
          await codeInput.press('Enter');
          console.log('  ✓ Pressed Enter on input');
        }

        // Wait a moment for validation to process (either modal disappears or error shows)
        await this.page.waitForTimeout(4000);

        // Check if error message is visible or if modal is still open
        const isErrorVisible = await this.page.evaluate(() => {
          const bodyText = document.body.innerText;
          return bodyText.includes('incorrect') || bodyText.includes('Incorrect') || bodyText.includes('salah');
        });

        const isStillVisible = await codeInput.isVisible().catch(() => false);

        if (isStillVisible && isErrorVisible) {
          console.log('  ! Entered captcha code was incorrect. Retrying with a new captcha...');
          
          // Click the captcha image to refresh it
          try {
            await captchaImg.click();
            await this.page.waitForTimeout(2000); // Wait for new image to load
          } catch (err) {
            console.log('  Could not click captcha image to refresh');
          }
          
          imageRetries--;
        } else {
          console.log('  ✓ Image captcha modal successfully handled (no error visible or modal closed)');
          solvedImage = true;
        }
      }

      if (!solvedImage) {
        throw new Error('Failed to solve image captcha after multiple attempts');
      }

      // Wait a moment for modal transition
      await this.page.waitForTimeout(3000);
    } catch (e) {
      console.log(`  ! Failed to handle image captcha: ${e.message}`);
      throw e;
    }
  }

  async handleCaptcha() {
    // Wait for reCAPTCHA iframe to load (it appears dynamically after form is filled)
    console.log('  Waiting for reCAPTCHA to load...');
    await this.page.waitForTimeout(3000);
    
    // Debug: Save HTML to see what's actually on page
    const html = await this.page.content();
    const fs = await import('fs');
    fs.writeFileSync('/tmp/page-source.html', html);
    console.log('  Saved HTML source to /tmp/page-source.html');
    
    // Look for any reCAPTCHA iframe
    const allIframes = await this.page.$$('iframe');
    console.log(`  Found ${allIframes.length} iframes on page`);
    
    for (const iframe of allIframes) {
      const src = await iframe.getAttribute('src');
      const title = await iframe.getAttribute('title');
      
      if ((src && src.includes('recaptcha')) || (title && title.includes('reCAPTCHA'))) {
        console.log(`  Found reCAPTCHA iframe: title="${title}", src="${src?.substring(0, 50)}..."`);
        
        // Try to click inside the iframe
        try {
          const frame = await iframe.contentFrame();
          if (frame) {
            // Wait for checkbox to be available
            await frame.waitForSelector('.recaptcha-checkbox-border', { timeout: 5000 });
            await frame.click('.recaptcha-checkbox-border');
            console.log('  ✓ Clicked reCAPTCHA checkbox');
            await this.page.waitForTimeout(3000);
            return;
          }
        } catch (e) {
          console.log(`  ! Failed to click checkbox: ${e.message}`);
        }
      }
    }

    console.log('  No reCAPTCHA iframe found');
  }

  async submitRegistration() {
    // Find and click submit button — "Next" is the button text on account.xiaomi.com
    console.log('  Looking for submit button...');
    const submitSelectors = [
      'button:has-text("Next")',
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Sign Up")',
      'button:has-text("Register")',
    ];
    let submitButton = null;
    for (const sel of submitSelectors) {
      submitButton = await this.page.$(sel);
      if (submitButton) {
        console.log(`  ✓ Found submit button: ${sel}`);
        break;
      }
    }

    if (!submitButton) {
      // Fallback DOM eval
      const clicked = await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const target = btns.find(b => {
          const txt = (b.textContent || '').trim();
          return txt === 'Next' && b.offsetHeight > 0;
        });
        if (target) { target.click(); return true; }
        return false;
      });
      if (clicked) {
        console.log('  ✓ Clicked Next (DOM eval fallback)');
      } else {
        throw new Error('Submit button not found');
      }
    } else {
      await submitButton.click();
    }

    // Wait for navigation or captcha modal to appear
    console.log('  Waiting for navigation or captcha modal...');
    try {
      await Promise.race([
        this.page.waitForNavigation({ timeout: 10000 }),
        this.page.waitForSelector('.miverify_wind:not([style*="display: none"])', { timeout: 10000 }),
        this.page.waitForSelector('[class*="captcha"], [class*="verify"]', { timeout: 10000 }),
      ]);
    } catch (e) {
      // Ignore timeout/error, proceed to captcha check
      await this.page.waitForTimeout(1500);
    }
  }

  async verifyEmail(email) {
    // Wait for verification email
    console.log('  Waiting for verification email...');
    
    // Retry up to 3 times with 10 second delays
    let messages = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      messages = await this.tempmail.getMessages(email);
      if (messages && messages.length > 0) break;
      console.log(`  No messages yet, retrying in 10 seconds... (attempt ${attempt + 1}/3)`);
      await this.page.waitForTimeout(10000);
    }

    // Extract verification code
    const code = this.tempmail.extractVerificationCode(messages);
    console.log(`  Verification code: ${code}`);

    // Find verification input field with robust waiting and selectors
    console.log('  Waiting for verification code input field to be visible...');
    let verificationInput = null;
    try {
      verificationInput = await this.page.waitForSelector('input[name="ticket"], input[name="code"], input[placeholder*="code" i], input[placeholder*="verification" i], input[placeholder*="Enter code" i]', { 
        timeout: 20000 
      });
    } catch (e) {
      console.log('  ! Verification input not found by selectors. Logging all page inputs:');
      const inputs = await this.page.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(el => ({
          tag: el.tagName,
          type: el.type,
          id: el.id,
          className: el.className,
          placeholder: el.placeholder,
          name: el.name,
          visible: el.offsetWidth > 0 && el.offsetHeight > 0
        }));
      });
      console.log(JSON.stringify(inputs, null, 2));
      throw new Error('Verification code input not found');
    }

    // Fill and submit verification code — ketik per karakter biar gak instant paste
    await humanFill(this.page, verificationInput, code);
    console.log('  ✓ Filled verification code');

    const verifyButton = await this.page.$('button:has-text("Submit"), button:has-text("Verify"), button:has-text("Confirm"), button[type="submit"]');
    if (verifyButton) {
      try {
        await verifyButton.click({ timeout: 5000 });
        console.log('  ✓ Clicked Submit/Verify button');
      } catch (clickErr) {
        console.log('  ! Submit button click failed, pressing Enter key instead...');
        await verificationInput.press('Enter');
      }
    } else {
      await verificationInput.press('Enter');
      console.log('  ✓ Pressed Enter on input');
    }

    // Wait for verification success
    await this.page.waitForTimeout(5000);
  }

  async clickConsoleMenu() {
    // Setelah signup, user biasanya landed di halaman referral atau dashboard.
    // Daripada page.goto langsung ke /console/balance (kelihatan otomatis),
    // klik link/menu "Console" beneran biar pola navigasinya mirip manusia.
    console.log('  Looking for Console menu...');

    // Coba beberapa selector — text=, role=link, atau tombol berlabel Console
    const candidates = [
      'a:has-text("Console")',
      'button:has-text("Console")',
      '[role="link"]:has-text("Console")',
      'header a:has-text("Console"), nav a:has-text("Console")',
    ];

    for (const selector of candidates) {
      try {
        const el = this.page.locator(selector).first();
        const count = await el.count();
        if (count === 0) continue;

        await el.waitFor({ state: 'visible', timeout: 3000 });
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await humanDelay(200, 400);
        await el.hover({ timeout: 2500 }).catch(() => {});
        await humanDelay(150, 300);

        // Klik native — biar cookies/session-nya kebawa via SPA navigation
        await el.click({ timeout: 5000 });
        console.log(`  ✓ Clicked Console menu (selector: ${selector})`);

        // Tunggu URL berubah ke /console/* atau networkidle
        await this.page.waitForURL(/\/console/, { timeout: 10000 }).catch(() => {});
        await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await humanDelay(800, 1500);

        const url = this.page.url();
        console.log(`  ✓ Now on: ${url}`);
        return true;
      } catch (e) {
        // selector berikutnya
      }
    }

    // Fallback DOM eval: cari elemen apa pun yang teksnya "Console" dan clickable
    const clicked = await this.page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"]'));
      const target = all.find(el => {
        const txt = (el.textContent || '').trim();
        return txt === 'Console' && el.offsetHeight > 0 && el.offsetWidth > 0;
      });
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      console.log('  ✓ Clicked Console menu via DOM eval fallback');
      await this.page.waitForURL(/\/console/, { timeout: 10000 }).catch(() => {});
      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(800, 1500);
      return true;
    }

    console.log('  ! Console menu not found — caller will fallback to direct URL');
    return false;
  }

  async readBalance() {
    // Baca TOTAL balance dari halaman /console/balance.
    //
    // Layout halaman Xiaomi MiMo:
    //   [Balance card]                [Alert card]
    //     $ 2.72                        $ -
    //     Cash Balance: $0.00           Balance Alerts Off
    //     Bonus Balance: $2.72
    //
    //   [Recharge section]
    //     $50  $100  $200  ...     ← preset buttons, bukan saldo!
    //
    // Yang dibutuhkan: angka di bawah label "Balance" (TOTAL = Cash + Bonus).
    // Akun baru: Cash $0.00 + Bonus $0.72/$2.72.
    //
    // Strategi:
    //   1. Cari "Balance\n$ X.XX" — total balance di card utama
    //   2. Sum Cash Balance + Bonus Balance kalau keduanya ketemu
    //   3. Fallback: angka $X.XX terkecil di halaman (saldo akun baru < $5)
    try {
      const value = await this.page.evaluate(() => {
        const text = document.body.innerText || '';

        // 1. "Balance" word-boundary, diikuti newline + "$ X.XX"
        //    Hindari "Cash Balance" / "Bonus Balance" / "Token Balance" /
        //    "Alert Threshold". Pakai negative lookbehind via leading marker.
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          // Match exactly "Balance" (kasus apa pun), bukan "Cash/Bonus/Token Balance"
          if (/^balance$/i.test(line)) {
            // Ambil angka $X.XX di baris berikut atau dalam 2 baris
            for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
              const m = lines[j].match(/\$\s*([0-9]+\.[0-9]{2})/);
              if (m) return parseFloat(m[1]);
            }
          }
        }

        // 2. Sum Cash + Bonus
        const cash = text.match(/cash\s+balance\s*[:\s]\s*\$\s*([0-9]+\.[0-9]{2})/i);
        const bonus = text.match(/bonus\s+balance\s*[:\s]\s*\$\s*([0-9]+\.[0-9]{2})/i);
        if (cash && bonus) {
          return parseFloat(cash[1]) + parseFloat(bonus[1]);
        }
        if (bonus) return parseFloat(bonus[1]);
        if (cash) return parseFloat(cash[1]);

        // 3. Fallback: angka $X.XX terkecil < $50 (saldo akun normal < $5,
        //    Recharge preset $50/$100/$200 dst pasti lebih besar)
        const allWithDecimal = [...text.matchAll(/\$\s*([0-9]+\.[0-9]{2})/g)]
          .map(m => parseFloat(m[1]))
          .filter(n => !isNaN(n) && n > 0 && n < 50);
        if (allWithDecimal.length > 0) {
          return Math.min(...allWithDecimal);
        }

        return null;
      });
      return typeof value === 'number' && !isNaN(value) ? value : null;
    } catch (e) {
      return null;
    }
  }

  async waitForOverlaysGone(timeout = 6000) {
    // Tunggu Ant Design modal-mask/wrap beneran hilang.
    // Setelah Confirm, mask masih bisa ke-render ~300-500ms dan ngeblock klik.
    try {
      await this.page.waitForFunction(() => {
        const masks = Array.from(document.querySelectorAll(
          '.ant-modal-mask, .ant-modal-wrap, .ant-modal-root .ant-modal-mask'
        ));
        return masks.every(m => {
          const style = window.getComputedStyle(m);
          if (style.display === 'none' || style.visibility === 'hidden') return true;
          if (m.offsetHeight === 0 || m.offsetWidth === 0) return true;
          // Mask yg fade-out (opacity ~0) juga sudah aman
          const op = parseFloat(style.opacity || '1');
          return op < 0.05;
        });
      }, { timeout });
      console.log('  ✓ Overlays gone');
    } catch (e) {
      console.log('  ! Some overlays still visible after timeout — continuing anyway');
    }
  }

  async handleTermsModal() {
    // Modal Terms & Agreements muncul sekali per session — bisa di balance,
    // api-keys, atau ultraspeed page tergantung mana yang dibuka pertama.
    // Method ini idempotent: kalau modal nggak ada, langsung return.
    //
    // Catatan: Ant Design ngehidden `.ant-checkbox-input` (display:none).
    // Klik input langsung pakai force=true ngeset value tapi nggak nge-trigger
    // React onChange — akibatnya tombol Confirm tetap disabled.
    // Solusi: klik wrapper visible (`.ant-checkbox` / `.ant-checkbox-wrapper`),
    // lalu tunggu Confirm benar-benar enabled.
    try {
      const termsModalOpen = await this.page.evaluate(() => {
        const wraps = Array.from(document.querySelectorAll('.ant-modal-wrap'));
        return wraps.some(wrap => {
          const style = wrap.style.display;
          if (style === 'none' || wrap.offsetHeight === 0) return false;
          const hasCheckbox = wrap.querySelector('.ant-checkbox-input, input[type="checkbox"]');
          const text = (wrap.innerText || '').toLowerCase();
          return !!hasCheckbox && (text.includes('agree') || text.includes('terms') || text.includes('agreement'));
        });
      });

      if (!termsModalOpen) {
        console.log('  No Terms & Agreements modal open');
        return false;
      }

      console.log('  Terms & Agreements modal detected (open), handling...');

      // 1) Klik wrapper checkbox yang visible — bukan input hidden
      // Coba urutan: .ant-checkbox-wrapper > .ant-checkbox > label terkait
      const checkboxClicked = await this.page.evaluate(() => {
        const modal = Array.from(document.querySelectorAll('.ant-modal-wrap'))
          .find(w => w.offsetHeight > 0 && w.style.display !== 'none');
        if (!modal) return { ok: false, reason: 'modal disappeared' };

        // Prioritas: wrapper visible
        const wrapper =
          modal.querySelector('.ant-checkbox-wrapper') ||
          modal.querySelector('.ant-checkbox') ||
          modal.querySelector('label.ant-checkbox-wrapper');

        if (!wrapper) return { ok: false, reason: 'no checkbox wrapper found' };

        // Klik native — biar Ant Design React onChange ke-trigger
        wrapper.click();

        // Cek sekarang checkbox-nya checked atau belum
        const input = modal.querySelector('.ant-checkbox-input, input[type="checkbox"]');
        return {
          ok: true,
          checked: input ? input.checked : null,
          wrapperClass: wrapper.className,
        };
      });

      console.log(`  Checkbox click result: ${JSON.stringify(checkboxClicked)}`);

      if (!checkboxClicked.ok) {
        // Fallback: klik via Playwright dengan force
        await this.page.click('.ant-modal-wrap .ant-checkbox-wrapper, .ant-modal-wrap .ant-checkbox', { force: true }).catch(() => {});
        console.log('  ✓ Clicked Terms checkbox (fallback Playwright)');
      }

      // Beri waktu Ant Design update state + enable tombol Confirm
      await this.page.waitForTimeout(800);

      // 2) Tunggu Confirm jadi enabled (max 5 detik)
      const confirmReady = await this.page.waitForFunction(() => {
        const modal = Array.from(document.querySelectorAll('.ant-modal-wrap'))
          .find(w => w.offsetHeight > 0 && w.style.display !== 'none');
        if (!modal) return false;
        const btns = Array.from(modal.querySelectorAll('.ant-modal-footer button, button'));
        const confirm = btns.find(b => /confirm|agree|continue|ok/i.test(b.textContent || ''));
        if (!confirm) return false;
        const disabled = confirm.disabled || confirm.classList.contains('ant-btn-disabled') || confirm.getAttribute('disabled') !== null;
        return !disabled;
      }, { timeout: 5000 }).catch(() => null);

      if (!confirmReady) {
        console.log('  ! Confirm button stayed disabled after checkbox click');
        // Coba klik checkbox lagi (kadang butuh dua kali)
        await this.page.click('.ant-modal-wrap .ant-checkbox-wrapper, .ant-modal-wrap .ant-checkbox', { force: true }).catch(() => {});
        await this.page.waitForTimeout(1500);
      }

      // 3) Klik Confirm
      const confirmBtn = await this.page.$('.ant-modal-wrap .ant-modal-footer .ant-btn-primary:not([disabled]):not(.ant-btn-disabled), .ant-modal-wrap button:has-text("Confirm"):not([disabled])');
      if (confirmBtn) {
        await confirmBtn.click({ force: true });
        console.log('  ✓ Clicked Terms & Agreements Confirm button');
      } else {
        // Fallback: cari tombol primary apa pun di modal
        const fallback = await this.page.$('.ant-modal-wrap .ant-btn-primary');
        if (fallback) {
          await fallback.click({ force: true });
          console.log('  ✓ Clicked Confirm (fallback ant-btn-primary)');
        } else {
          console.log('  ! Confirm button not found in Terms modal');
        }
      }

      // 4) Verifikasi modal beneran tertutup (max 5 detik)
      const closed = await this.page.waitForFunction(() => {
        const wraps = Array.from(document.querySelectorAll('.ant-modal-wrap'));
        return !wraps.some(w => {
          if (w.style.display === 'none' || w.offsetHeight === 0) return false;
          const text = (w.innerText || '').toLowerCase();
          return text.includes('agree') || text.includes('terms');
        });
      }, { timeout: 5000 }).catch(() => null);

      if (closed) {
        console.log('  ✓ Terms modal closed');
      } else {
        console.log('  ! Terms modal still visible after Confirm click');
        await this.page.screenshot({ path: 'screenshot-terms-stuck.png' }).catch(() => {});
      }

      await this.page.waitForTimeout(800);
      return true;
    } catch (e) {
      console.log('  ! Failed to handle Terms & Agreements modal:', e.message);
      return false;
    }
  }

  async handleOAuthRedirect() {
    let currentUrl = this.page.url();
    if (currentUrl.includes('account.xiaomi.com') || currentUrl.includes('login') || currentUrl.includes('auth')) {
      console.log('  Redirected to authorization page, logging in...');
      
      // Wait a moment for page/modals to load
      await this.page.waitForTimeout(2000);
      
      // Check if "Attention" agreement modal is present and click Agree
      const agreeBtn = await this.page.$('.miui-modal-wrap button:has-text("Agree"), button:has-text("Agree"), .miui-modal-wrap .btn-primary');
      if (agreeBtn) {
        console.log('  Found Xiaomi Account Agreement modal ("Attention") during OAuth redirect, clicking Agree...');
        await agreeBtn.click({ force: true });
        await this.page.waitForTimeout(3000);
      }
      
      // Wait for authorize button
      const authBtn = await this.page.waitForSelector('button:has-text("Agree"), button:has-text("Authorize"), button:has-text("Sign in"), #accept, .btn-primary', { timeout: 10000 }).catch(() => null);
      if (authBtn) {
        await authBtn.click();
        console.log('  ✓ Clicked authorize button');
        await this.page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
        await this.page.waitForTimeout(5000);
        await this.page.screenshot({ path: 'screenshot-after-auth.png', fullPage: true });
        console.log('  ✓ Captured screenshot-after-auth.png');
      }
    }
  }

  async selectDropdownOption(labelText, searchText, exact = false) {
    console.log(`  Selecting dropdown option for "${labelText}" matching "${searchText}"...`);
    try {
      const formItem = this.page.locator('.ant-form-item').filter({ hasText: new RegExp(`^${labelText}`) });
      if (await formItem.count() === 0) {
        console.log(`  ! Form item for label "${labelText}" not found`);
        return false;
      }
      
      let selector = formItem.first().locator('.ant-select-selector');
      if (await selector.count() === 0) {
        // Try fallback selectors for custom/nested dropdown components like FancyPhoneInput
        selector = formItem.first().locator('.ant-dropdown-trigger, [class*="callingCodeTrigger"], .ant-select, .ant-select-selection, [class*="select"]');
      }
      
      if (await selector.count() === 0) {
        console.log(`  ! Selector for label "${labelText}" not found. Listing all elements in form item:`);
        const elementInfo = await formItem.first().evaluate((el) => {
          return Array.from(el.querySelectorAll('*')).map(child => ({
            tag: child.tagName,
            class: child.className,
            text: child.textContent ? child.textContent.trim().substring(0, 30) : ''
          }));
        });
        console.log(JSON.stringify(elementInfo, null, 2));
        return false;
      }
      
      console.log(`  Clicking select trigger for "${labelText}"...`);
      await selector.first().click({ force: true });
      await this.page.waitForTimeout(1500);
      
      const clicked = await this.page.evaluate((args) => {
        const { search, isExact } = args;
        const dropdowns = Array.from(document.querySelectorAll('.ant-select-dropdown, .ant-dropdown, [class*="dropdown"], [class*="Dropdown"], [role="listbox"], [role="menu"]')).filter(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
        });
        
        if (dropdowns.length === 0) return { success: false, reason: 'No visible dropdown container found' };
        
        const dropdown = dropdowns[dropdowns.length - 1];
        const options = Array.from(dropdown.querySelectorAll('.ant-select-item-option, [role="option"], [role="menuitem"], li, a, span, div')).filter(el => {
          // Filter to only leaf-like or text-containing interactive elements
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && el.offsetHeight > 0;
        });
        
        // Try to match specific classes first to avoid matching parent wrappers containing all text
        let target = null;
        
        // 1. Try to find dedicated option classes first
        const specificOptions = Array.from(dropdown.querySelectorAll('.ant-select-item-option, .ant-dropdown-menu-item, [role="option"], [role="menuitem"], li'));
        target = specificOptions.find(opt => {
          const txt = (opt.textContent || '').trim();
          const title = opt.getAttribute('title') || '';
          const dataValue = opt.getAttribute('data-value') || '';
          if (isExact) {
            return txt === search || title === search || dataValue === search;
          } else {
            return txt.includes(search) || title.includes(search) || dataValue.includes(search);
          }
        });
        
        // 2. Fallback to leaf text elements (spans, divs, links) if dedicated options are not found
        if (!target) {
          const generalEls = Array.from(dropdown.querySelectorAll('span, div, a')).filter(el => {
            const style = window.getComputedStyle(el);
            // Ensure element is visible and contains text
            if (style.display === 'none' || el.offsetHeight === 0) return false;
            
            // Only look at elements that don't have block-level child elements containing text to target leaf nodes
            const childTextElements = Array.from(el.children).filter(child => {
              const childStyle = window.getComputedStyle(child);
              return childStyle.display !== 'none' && child.offsetHeight > 0 && child.textContent.trim().length > 0;
            });
            return childTextElements.length === 0;
          });
          
          target = generalEls.find(opt => {
            const txt = (opt.textContent || '').trim();
            if (isExact) {
              return txt === search;
            } else {
              return txt.includes(search);
            }
          });
        }
        
        if (target) {
          target.click();
          return { success: true, text: target.textContent ? target.textContent.trim() : '' };
        }
        
        return { success: false, reason: `Option matching "${search}" not found among ${options.length} options` };
      }, { search: searchText, isExact: exact });
      
      if (clicked.success) {
        console.log(`  ✓ Selected option: ${clicked.text}`);
        await this.page.waitForTimeout(1000);
        return true;
      } else {
        console.log(`  ! Selection failed: ${clicked.reason}`);
        
        // Custom handling for phone calling code dropdown which uses ant-dropdown
        if (labelText === 'Phone number') {
          console.log('  Trying fallback click for phone number dropdown options...');
          const opt = await this.page.$(`.ant-dropdown-menu-item:has-text("${searchText}"), .ant-dropdown-menu [title*="${searchText}"], .ant-dropdown :has-text("${searchText}")`);
          if (opt) {
            await opt.click({ force: true });
            console.log(`  ✓ Selected option via fallback class click for "${searchText}"`);
            await this.page.waitForTimeout(1000);
            return true;
          }
        }
        
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(500);
        return false;
      }
    } catch (e) {
      console.log(`  ! Error selecting dropdown for "${labelText}": ${e.message}`);
      return false;
    }
  }

  async redeemInviteCode(code = null) {
    console.log('[Step 7.6] Redeeming invite code...');

    // Use provided code or fallback to config
    const inviteCode = code || this.config.xiaomi.inviteCode || 'HWPMXZ';
    console.log(`  Invite code to redeem: ${inviteCode}`);

    // 1. Klik menu "Console" dulu — biar navigasi-nya mirip user beneran
    //    (bukan langsung page.goto ke /console/balance dari URL referral).
    const consoleClicked = await this.clickConsoleMenu();

    // 2. Setelah klik Console, kemungkinan landed di /console (overview) atau
    //    /console/balance. Cek URL — kalau bukan balance, navigasi ke sana
    //    via in-app link kalau ada, atau goto sebagai fallback.
    let url = this.page.url();
    if (!url.includes('/console/balance')) {
      console.log(`  Not on balance page yet (current: ${url}), navigating...`);

      // Coba klik link "Balance" di sidebar console dulu
      const balanceClicked = await this.page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, [role="link"], li, [role="menuitem"]'));
        const target = links.find(el => {
          const txt = (el.textContent || '').trim();
          return /^Balance$/i.test(txt) && el.offsetHeight > 0;
        });
        if (target) {
          target.scrollIntoView({ block: 'center' });
          target.click();
          return true;
        }
        return false;
      });

      if (balanceClicked) {
        console.log('  ✓ Clicked Balance link in console sidebar');
        await this.page.waitForURL(/\/console\/balance/, { timeout: 8000 }).catch(() => {});
        await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      } else {
        // Fallback terakhir: goto langsung
        console.log('  ! Balance link not found, falling back to direct goto...');
        await this.page.goto('https://platform.xiaomimimo.com/console/balance', {
          waitUntil: 'networkidle',
          timeout: this.config.browser.timeout,
        });
      }
    }
    await this.page.waitForTimeout(2500);

    await this.handleOAuthRedirect();
    await this.page.waitForTimeout(2000);

    // Close cookies modal if overlaying (do it before clicking to avoid click interception!)
    console.log('  Checking for cookies banner...');
    const acceptCookiesBtn = await this.page.waitForSelector('button:has-text("Accept All"), button:has-text("Accept"), button:has-text("Allow All")', { timeout: 4000 }).catch(() => null);
    if (acceptCookiesBtn) {
      await acceptCookiesBtn.click({ force: true }).catch(() => {});
      console.log('  ✓ Accepted cookies banner');
      await this.page.waitForTimeout(2000);
    }

    // Halaman pertama yang dibuka di console — Terms modal kemungkinan muncul di sini
    await this.handleTermsModal();

    // Tunggu sampai semua modal-mask/wrap beneran hilang dari layar.
    // Ant Design naruh display:none setelah animasi, tapi mask-nya kadang
    // nyangkut ~300-500ms dan nge-intercept klik berikutnya.
    await this.waitForOverlaysGone();

    // Take a screenshot to inspect the balance page
    await this.page.screenshot({ path: 'screenshot-balance.png', fullPage: false });
    console.log('  ✓ Captured screenshot-balance.png');

    // Snapshot balance SEBELUM redeem (untuk verifikasi nanti).
    // Format halaman biasanya: "Balance: $0.72" atau "Cash Balance $0.72"
    const balanceBefore = await this.readBalance();
    console.log(`  💰 Balance before redeem: $${balanceBefore !== null ? balanceBefore.toFixed(2) : 'unknown'}`);

    // Click "Enter invite code +$2" button/link
    console.log('  Checking for "Enter invite code" button...');

    // Cek dulu apakah link-nya emang ada — kalau akun udah pernah redeem,
    // link ini hilang dan diganti dengan tampilan saldo. Treat sebagai sukses.
    const linkExists = await this.page.evaluate(() => {
      return document.body.innerText.includes('Enter invite code');
    }).catch(() => false);

    if (!linkExists) {
      console.log('  ℹ "Enter invite code" link not found — account likely already redeemed.');
      // Cek apakah ada angka saldo > 0 sebagai konfirmasi
      const balanceText = await this.page.evaluate(() => {
        const matches = document.body.innerText.match(/\$\s*[\d.]+/g);
        return matches ? matches.slice(0, 3).join(', ') : 'unknown';
      }).catch(() => 'unknown');
      console.log(`  Balance hint: ${balanceText}`);
      return; // exit method, bukan error
    }

    let clicked = false;
    try {
      const el = this.page.locator('text=Enter invite code').first();
      await el.waitFor({ state: 'visible', timeout: 8000 });
      // Scroll ke link biar pasti dalam viewport (penting di viewport kecil 1280x720)
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await humanDelay(200, 400);
      // Hover dulu — biar event-nya mirip user beneran, BUKAN force:true
      // (force:true di selector text= sering klik elemen wrapper, bukan link click handler-nya)
      try {
        await el.hover({ timeout: 3000 });
        await humanDelay(150, 300);
        await el.click({ timeout: 5000 });
        clicked = true;
        console.log('  ✓ Clicked "Enter invite code" via hover+click');
      } catch (clickErr) {
        console.log(`  ! Native click failed (${clickErr.message.split('\n')[0]}), trying force click...`);
        await el.click({ force: true });
        clicked = true;
        console.log('  ✓ Clicked "Enter invite code" via force click');
      }
    } catch (err) {
      console.log('  Playwright locator click failed/timed out, trying backwards-eval leaf click...');
      clicked = await this.page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        // Search backwards to get leaf elements first
        for (let i = elements.length - 1; i >= 0; i--) {
          const el = elements[i];
          const text = (el.textContent || '').trim();
          if (text.includes('Enter invite code') && el.offsetHeight > 0) {
            const tagName = el.tagName.toLowerCase();
            if (['span', 'a', 'button', 'div'].includes(tagName) && el.children.length <= 1) {
              el.scrollIntoView({ block: 'center' });
              el.click();
              return true;
            }
          }
        }
        return false;
      });
      if (clicked) console.log('  ✓ Clicked "Enter invite code" via DOM eval fallback');
    }

    if (clicked) {
      console.log('  ✓ Entered invite code link clicked successfully');
      
      // Wait for modal container (.ant-modal) to be visible to ensure it's open
      console.log('  Waiting for redeem modal container (.ant-modal) to open...');
      const modal = await this.page.waitForSelector('.ant-modal, .ant-modal-wrap', { timeout: 10000 }).catch(() => null);
      if (!modal) {
        throw new Error('Redeem invite code modal did not open in time');
      }
      await this.page.waitForTimeout(1500);

      // Capture screenshot of the modal
      await this.page.screenshot({ path: 'screenshot-invite-modal.png' });
      console.log('  ✓ Captured screenshot-invite-modal.png');

      // Fill in the invite code - find input elements specifically inside the modal
      console.log('  Filling invite code...');
      
      // Select input elements inside the modal, excluding checkboxes
      const modalInputs = await this.page.$$('.ant-modal input:not([type="checkbox"]), .ant-modal-wrap input:not([type="checkbox"])');
      const visibleInputs = [];
      for (const input of modalInputs) {
        const isVisible = await input.isVisible().catch(() => false);
        if (isVisible) {
          visibleInputs.push(input);
        }
      }

      console.log(`  Found ${visibleInputs.length} visible inputs in modal`);

      if (visibleInputs.length >= 6) {
        console.log(`  Detected ${visibleInputs.length} invite code inputs, filling...`);

        // Clear all first
        for (const input of visibleInputs) {
          await input.fill('');
        }

        // Focus the first box dengan jeda manusia
        await humanDelay(150, 350);
        await visibleInputs[0].click({ force: true });
        await visibleInputs[0].focus();
        await humanDelay(120, 280);

        for (let i = 0; i < 6; i++) {
          // Get the index of the currently focused input box
          const activeIndex = await this.page.evaluate((elements) => {
            return elements.indexOf(document.activeElement);
          }, visibleInputs);

          if (activeIndex === i) {
            console.log(`  [Type] Box ${i} is active, typing "${inviteCode[i]}"`);
            await this.page.keyboard.type(inviteCode[i], { delay: 60 + Math.floor(Math.random() * 120) });
          } else {
            console.log(`  [Focus & Type] Box ${i} not active (active idx: ${activeIndex}), forcing focus`);
            await visibleInputs[i].click({ force: true });
            await visibleInputs[i].focus();
            await humanDelay(80, 180);
            await this.page.keyboard.press('Backspace');
            await this.page.keyboard.type(inviteCode[i], { delay: 60 + Math.floor(Math.random() * 120) });
          }
          // Jeda antar box biar mirip orang ngetik kode satu-satu
          await humanDelay(180, 380);
        }
      } else if (visibleInputs.length > 0) {
        console.log('  Filling invite code in single input...');
        await humanFill(this.page, visibleInputs[0], inviteCode);
      } else {
        console.log('  No inputs found in modal, trying to type invite code...');
        await humanType(this.page, inviteCode);
      }

      await this.page.waitForTimeout(1000);
      await this.page.screenshot({ path: 'screenshot-invite-filled.png' });
      console.log('  ✓ Captured screenshot-invite-filled.png');

      // Click the Redeem button
      console.log('  Clicking Redeem button...');
      const redeemBtn = await this.page.$('.ant-modal button:has-text("Redeem"), .ant-modal button:has-text("Redeem & get"), button:has-text("Redeem & get $2 credits")');
      let clickedRedeem = false;
      if (redeemBtn) {
        await redeemBtn.click({ force: true });
        clickedRedeem = true;
        console.log('  ✓ Clicked Redeem button');
      } else {
        clickedRedeem = await this.page.evaluate(() => {
          const modalEl = document.querySelector('.ant-modal');
          if (!modalEl) return false;
          const btns = Array.from(modalEl.querySelectorAll('button'));
          const targetBtn = btns.find(b => b.textContent.includes('Redeem') || b.textContent.includes('get $2'));
          if (targetBtn) {
            targetBtn.click();
            return true;
          }
          return false;
        });
        if (clickedRedeem) {
          console.log('  ✓ Clicked Redeem button (evaluate)');
        }
      }

      if (clickedRedeem) {
        await this.page.waitForTimeout(4000);
        await this.page.screenshot({ path: 'screenshot-invite-redeemed.png' });
        console.log('  ✓ Captured screenshot-invite-redeemed.png');

        // Cek notifikasi risk control / restriction setelah submit redeem.
        // Xiaomi nampilin pesan kira-kira:
        //   "Your account has risk control restrictions. Please contact customer service."
        // Kalau muncul, throw error khusus biar chain-loop bisa stop.
        const restrictionMsg = await this.page.evaluate(() => {
          const text = document.body.innerText || '';
          const patterns = [
            /risk\s*control\s*restriction/i,
            /account\s+has\s+risk\s+control/i,
            /contact\s+customer\s+service/i,
            /account\s+(is\s+)?restricted/i,
          ];
          for (const re of patterns) {
            const m = text.match(new RegExp('([^\\n]{0,200}' + re.source + '[^\\n]{0,200})', re.flags));
            if (m) return m[1].trim();
          }
          return null;
        }).catch(() => null);

        if (restrictionMsg) {
          console.log('  ❌ ACCOUNT RESTRICTED:');
          console.log(`     ${restrictionMsg}`);
          try {
            await this.page.screenshot({
              path: `error-restriction-${Date.now()}.png`,
              fullPage: true,
            });
          } catch (e) {}
          const err = new Error(`ACCOUNT_RESTRICTED: ${restrictionMsg}`);
          err.code = 'ACCOUNT_RESTRICTED';
          err.restrictionMsg = restrictionMsg;
          throw err;
        }

        // Verifikasi balance bertambah ~$2 setelah redeem.
        // Tutup modal redeem dulu (tombol X / Esc), lalu RELOAD halaman biar
        // widget balance di header re-fetch (tanpa reload, balance widget
        // sering masih nampilin nilai cached lama).
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(800);

        // Klik tombol close modal kalau Esc gak nutup
        try {
          await this.page.evaluate(() => {
            const closes = Array.from(document.querySelectorAll('.ant-modal-close, .ant-modal button[aria-label="Close"]'));
            for (const c of closes) {
              if (c.offsetHeight > 0) { c.click(); return; }
            }
          });
        } catch (e) {}
        await this.page.waitForTimeout(800);

        // Reload halaman biar fetch balance terbaru
        console.log('  Reloading balance page to refresh balance widget...');
        try {
          await this.page.reload({ waitUntil: 'networkidle', timeout: this.config.browser.timeout });
        } catch (e) {
          console.log(`  ! Reload error (lanjut): ${e.message}`);
        }
        await this.page.waitForTimeout(2000);
        await this.handleTermsModal().catch(() => {});
        await this.waitForOverlaysGone();

        // Re-read balance, beberapa kali kalau pertama masih cached
        let balanceAfter = null;
        for (let attempt = 1; attempt <= 4; attempt++) {
          balanceAfter = await this.readBalance();
          if (balanceAfter !== null && balanceBefore !== null && balanceAfter > balanceBefore) {
            break;
          }
          if (attempt < 4) {
            console.log(`  Balance attempt ${attempt}: $${balanceAfter !== null ? balanceAfter.toFixed(2) : '?'} — retry in 2s...`);
            await this.page.waitForTimeout(2000);
          }
        }
        console.log(`  💰 Balance after redeem : $${balanceAfter !== null ? balanceAfter.toFixed(2) : 'unknown'}`);

        if (balanceBefore !== null && balanceAfter !== null) {
          const delta = balanceAfter - balanceBefore;
          if (delta >= 1.5) {
            console.log(`  ✅ Balance verified: +$${delta.toFixed(2)} (expected ~+$2.00)`);
          } else if (delta > 0) {
            console.log(`  ⚠ Balance increased only +$${delta.toFixed(2)} (expected ~+$2.00) — partial credit?`);
          } else {
            console.log(`  ❌ Balance did NOT increase (before=$${balanceBefore.toFixed(2)}, after=$${balanceAfter.toFixed(2)})`);
            const err = new Error(`BALANCE_NOT_CREDITED: $${balanceBefore.toFixed(2)} → $${balanceAfter.toFixed(2)}`);
            err.code = 'BALANCE_NOT_CREDITED';
            err.balanceBefore = balanceBefore;
            err.balanceAfter = balanceAfter;
            try {
              await this.page.screenshot({
                path: `error-balance-${Date.now()}.png`,
                fullPage: true,
              });
            } catch (e) {}
            throw err;
          }
        } else {
          console.log('  ⚠ Could not parse balance, skipping verification');
        }
      } else {
        console.log('  ! Redeem button not found in modal');
      }
    } else {
      console.log('  ! "Enter invite code" button not found on balance page (might have already been redeemed).');
    }
  }

  async createApiKey() {
    console.log('[Step 7.7] Creating API Key...');

    // Navigate to API Keys page
    console.log('  Navigating to API Keys page...');
    await this.page.goto('https://platform.xiaomimimo.com/console/api-keys', {
      waitUntil: 'networkidle',
      timeout: this.config.browser.timeout
    });
    await this.page.waitForTimeout(4000);

    await this.handleOAuthRedirect();
    await this.page.waitForTimeout(2000);

    // Terms modal mungkin muncul di sini kalau halaman ini yang pertama dibuka
    await this.handleTermsModal();
    await this.waitForOverlaysGone();

    // Take screenshot of API Keys page
    await this.page.screenshot({ path: 'screenshot-apikeys-page.png' });
    console.log('  ✓ Captured screenshot-apikeys-page.png');

    // Cek dulu apakah akun sudah punya API key — kalau ada baris sk-... di tabel,
    // ambil yang pertama dan return (gak perlu bikin baru).
    const existingKey = await this.page.evaluate(() => {
      const text = document.body.innerText;
      // Format yang ditampilkan biasanya "sk-xxx...yyyy" (masked) atau full
      const match = text.match(/sk-[a-zA-Z0-9_\-]{6,}(?:\.{3}[a-zA-Z0-9_\-]{3,})?/);
      return match ? match[0] : null;
    }).catch(() => null);

    if (existingKey) {
      console.log(`  ℹ Account already has API key: ${existingKey}`);
      return existingKey;
    }

    // Click "Create API Key" button
    console.log('  Clicking "Create API Key" button...');
    const createBtn = await this.page.$('button:has-text("Create API Key"), .ant-btn:has-text("Create API Key")');
    if (createBtn) {
      await createBtn.click({ force: true });
    } else {
      const evalClicked = await this.page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Create API Key'));
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (!evalClicked) {
        throw new Error('Create API Key button not found');
      }
    }
    
    await this.page.waitForTimeout(2000);
    await this.page.screenshot({ path: 'screenshot-create-apikey-modal.png' });
    console.log('  ✓ Captured screenshot-create-apikey-modal.png');

    // Fill API Key Name input field
    console.log('  Filling API Key Name...');
    const nameInput = await this.page.waitForSelector('.ant-modal input[placeholder="Please enter"], .ant-modal-body input', { timeout: 5000 }).catch(() => null);
    if (nameInput) {
      await humanFill(this.page, nameInput, 'mykey');
    } else {
      await humanType(this.page, 'mykey');
    }
    await humanDelay(250, 500);

    // Click Confirm button
    console.log('  Clicking Confirm button...');
    const confirmBtn = await this.page.$('.ant-modal-footer button.ant-btn-primary, .ant-modal button:has-text("Confirm")');
    if (confirmBtn) {
      await confirmBtn.click({ force: true });
    } else {
      await this.page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.ant-modal button')).find(b => b.textContent.includes('Confirm'));
        if (btn) btn.click();
      });
    }

    await this.page.waitForTimeout(4000);
    await this.page.screenshot({ path: 'screenshot-apikey-created.png' });
    console.log('  ✓ Captured screenshot-apikey-created.png');

    // Extract the API key from the modal
    console.log('  Extracting API Key...');
    const apiKey = await this.page.evaluate(() => {
      const modals = Array.from(document.querySelectorAll('.ant-modal-wrap, .ant-modal, .ant-notification, .ant-message'));
      for (const modal of modals) {
        const text = modal.innerText;
        const match = text.match(/sk-[a-zA-Z0-9_\-]+/);
        if (match) return match[0];
        
        const input = modal.querySelector('input, textarea');
        if (input && input.value && input.value.startsWith('sk-')) {
          return input.value;
        }
      }
      
      const bodyText = document.body.innerText;
      const bodyMatch = bodyText.match(/sk-[a-zA-Z0-9_\-]+/);
      return bodyMatch ? bodyMatch[0] : null;
    });

    if (apiKey) {
      console.log(`  ✓ Extracted API Key: ${apiKey}`);
    } else {
      console.log('  ! Failed to extract API Key from screen');
    }

    // Close success modal if there is one
    const closeBtn = await this.page.$('.ant-modal-footer button, .ant-modal-wrap button:has-text("OK"), .ant-modal-wrap button:has-text("Close"), .ant-modal-wrap button:has-text("Confirm")');
    if (closeBtn) {
      await closeBtn.click().catch(() => {});
      await this.page.waitForTimeout(2000);
    } else {
      await this.page.keyboard.press('Escape').catch(() => {});
    }

    return apiKey;
  }

  async fillUltraspeedForm(email) {
    console.log('[Step 7.5] Navigating to Ultraspeed form page...');
    
    // Navigate to form page
    await this.page.goto('https://platform.xiaomimimo.com/ultraspeed', {
      waitUntil: 'networkidle',
      timeout: this.config.browser.timeout
    });
    console.log('✓ Form page loaded');
    await this.page.waitForTimeout(5000);

    // Debugging: take screenshot and print URL/Title
    console.log(`  Current page URL: ${this.page.url()}`);
    console.log(`  Current page Title: ${await this.page.title()}`);
    await this.page.screenshot({ path: 'screenshot-1-loaded.png', fullPage: true });
    console.log('  ✓ Captured screenshot-1-loaded.png');

    // Print any modal texts if present
    const modalTexts = await this.page.evaluate(() => {
      const modals = Array.from(document.querySelectorAll('.ant-modal, [class*="modal"], [class*="dialog"]'));
      return modals.map(m => m.innerText).filter(Boolean);
    });
    if (modalTexts.length > 0) {
      console.log('  [Debug] Modals/Dialogs detected on page:');
      modalTexts.forEach((text, i) => console.log(`    Modal ${i + 1}:\n${text}\n---`));
    }

    // Check if redirected to login/authorization page
    await this.handleOAuthRedirect();

    // Accept cookies if present (with waiting for selector)
    const acceptCookiesBtn = await this.page.waitForSelector('button:has-text("Accept All"), button:has-text("Accept")', { timeout: 4000 }).catch(() => null);
    if (acceptCookiesBtn) {
      await acceptCookiesBtn.click({ force: true }).catch(() => {});
      console.log('  ✓ Accepted cookies');
      await this.page.waitForTimeout(2000);
    }

    // Handle Terms & Agreements modal if present
    await this.handleTermsModal();
    await this.waitForOverlaysGone();

    // Generate random name and phone number
    const firstNames = ['Adit', 'Bintang', 'Rian', 'Bayu', 'Dedi', 'Dimas', 'Eko', 'Fajar', 'Gilang', 'Heri', 'Agus', 'Budi', 'Rudi', 'Hendro'];
    const lastNames = ['Nugraha', 'Wira', 'Saputra', 'Pratama', 'Hidayat', 'Kurniawan', 'Santoso', 'Wijaya', 'Susilo', 'Setiawan'];
    const randomName = `${firstNames[Math.floor(Math.random() * firstNames.length)]} Susilo ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
    
    const randomPhone = '812' + Math.floor(10000000 + Math.random() * 90000000); // 812xxxxxxxx
    
    console.log(`  Name to fill: ${randomName}`);
    console.log(`  Phone number to fill: +62${randomPhone}`);

    // Helper: fill field by label text using .ant-form-item filter (precise)
    // MODE CEPAT: pakai locator.fill() langsung, gak typing per-char
    const fillByLabel = async (labelText, value, inputSelector = 'input') => {
      try {
        const formItem = this.page.locator('.ant-form-item').filter({ hasText: new RegExp(`^${labelText}`) });
        const count = await formItem.count();
        if (count > 0) {
          const input = formItem.first().locator(inputSelector);
          if (await input.count() > 0) {
            await input.first().fill(value);
            console.log(`  ✓ Filled "${labelText}" via form-item filter (fast)`);
            await this.page.waitForTimeout(150);
            return true;
          }
        }
      } catch (e) {}
      return false;
    };

    // Wait for form to fully load
    await this.page.waitForSelector('.ant-form-item', { timeout: 10000 });
    await this.page.waitForTimeout(1000);

    // Get all visible inputs in order as fallback
    const allInputs = await this.page.$$('input[placeholder="Please enter"]:visible, input[placeholder*="enter" i]');
    console.log(`  Found ${allInputs.length} "Please enter" inputs on page`);

    // Fill "Your name" (input index 0)
    const nameFilled = await fillByLabel('Your name', randomName);
    if (!nameFilled) {
      const inputs = await this.page.$$('input[placeholder="Please enter"]');
      if (inputs[0]) { await inputs[0].fill(randomName); console.log('  ✓ Filled Name (fast fallback)'); await this.page.waitForTimeout(150); }
    }

    // Select Phone Prefix "+62" and fill Phone number
    try {
      await this.selectDropdownOption('Phone number', '+62', false);
      const phoneFormItem = this.page.locator('.ant-form-item').filter({ hasText: /^Phone number/ });
      const phoneInput = phoneFormItem.first().locator('input[placeholder="Please enter"]');
      if (await phoneInput.count() > 0) {
        await phoneInput.first().fill(randomPhone);
        console.log('  ✓ Filled Phone (fast)');
        await this.page.waitForTimeout(150);
      }
    } catch (e) {
      console.log('  ! Phone fill error:', e.message);
      const inputs = await this.page.$$('input[placeholder="Please enter"]');
      if (inputs[1]) { await inputs[1].fill(randomPhone); console.log('  ✓ Filled Phone (fast fallback)'); await this.page.waitForTimeout(150); }
    }

    // Fill "Email" (input index 2)
    const emailFilled = await fillByLabel('Email', email);
    if (!emailFilled) {
      const inputs = await this.page.$$('input[placeholder="Please enter"]');
      if (inputs[2]) { await inputs[2].fill(email); console.log('  ✓ Filled Email (fast fallback)'); await this.page.waitForTimeout(150); }
    }

    // Fill "Company name" (input index 3)
    const companyFilled = await fillByLabel('Company name', 'SignalStack');
    if (!companyFilled) {
      const inputs = await this.page.$$('input[placeholder="Please enter"]');
      if (inputs[3]) { await inputs[3].fill('SignalStack'); console.log('  ✓ Filled Company (fast fallback)'); await this.page.waitForTimeout(150); }
    }

    // Select "Industry" dropdown → exact match "Finance"
    try {
      await this.selectDropdownOption('Industry', 'Finance', true);
    } catch (e) {
      console.log('  ! Industry dropdown error:', e.message);
    }

    // Select "Your use case" dropdown → "Latency-critical tasks..."
    try {
      await this.selectDropdownOption('Your use case', 'Latency-critical', false);
    } catch (e) {
      console.log('  ! Use case dropdown error:', e.message);
    }

    // Fill "Anything else you'd like to share" textarea — MODE CEPAT
    const shareText = `Building automated trading systems that need to process market data and execute decisions in milliseconds. We use LLMs for risk assessment, sentiment analysis on news feeds, and generating trade rationale in real time. The challenge is that traditional models add too much latency to the decision loop. Exploring MiMo UltraSpeed to see if inference can happen fast enough to actually be part of the execution path rather than a post-hoc analysis tool. Running about 40k calls daily across different strategy pipelines.`;
    try {
      const textarea = this.page.locator('textarea').first();
      if (await textarea.count() > 0) {
        await textarea.fill(shareText);
        console.log('  ✓ Filled share textarea (fast)');
      }
    } catch (e) {
      console.log('  ! Textarea fill error:', e.message);
    }

    // Screenshot before submit
    await this.page.waitForTimeout(1000);
    await this.page.screenshot({ path: 'screenshot-3-before-submit.png', fullPage: true });
    console.log('  ✓ Captured screenshot-3-before-submit.png');

    // Submit Application
    console.log('  Submitting application...');
    try {
      // Find the button using both Playwright locator and page.evaluate fallback
      const clickedResult = await this.page.evaluate(() => {
        // Find all elements that look like buttons or are styled as buttons
        const allButtons = Array.from(document.querySelectorAll('button, [role="button"], .ant-btn, input[type="submit"]'));
        const submitBtn = allButtons.find(btn => {
          const txt = (btn.textContent || '').trim();
          return txt.includes('Submit') || txt.includes('Submit Application') || txt.includes('Application');
        });
        
        if (submitBtn) {
          // Check if disabled
          const isDisabled = submitBtn.disabled || submitBtn.getAttribute('disabled') !== null || submitBtn.classList.contains('ant-btn-disabled');
          
          // Scroll into view
          submitBtn.scrollIntoView({ block: 'center', inline: 'nearest' });
          
          // Click it natively
          submitBtn.click();
          return { success: true, text: submitBtn.textContent.trim(), disabled: isDisabled };
        }
        return { success: false, reason: 'No submit button found in DOM' };
      });
      
      console.log(`  ✓ Submit button click result: ${JSON.stringify(clickedResult)}`);
      
      // Wait for "Before you submit" modal to appear and click "Got it"
      console.log('  Waiting for "Before you submit" confirmation modal...');
      const gotItBtn = await this.page.waitForSelector('.ant-modal-wrap button:has-text("Got it"), button:has-text("Got it")', { timeout: 6000 }).catch(() => null);
      if (gotItBtn) {
        console.log('  ✓ Found "Got it" confirmation button, clicking...');
        await gotItBtn.click({ force: true });
        console.log('  ✓ Clicked "Got it" confirmation button');
        
        // Wait a few seconds for actual form submission to process
        await this.page.waitForTimeout(6000);
      } else {
        console.log('  ! "Got it" confirmation button not found (might have submitted directly or failed)');
      }
      
      // Print page text snapshot to check if it succeeded
      const postSubmitText = await this.page.evaluate(() => document.body.innerText);
      console.log('  [Post-Submit Text Snapshot (first 400 chars)]:\n', postSubmitText.substring(0, 400).replace(/\n/g, ' | '));
      
      await this.page.screenshot({ path: 'screenshot-4-after-submit.png', fullPage: true });
      console.log('  ✓ Captured screenshot-4-after-submit.png');
    } catch (e) {
      console.log('  ! Submit button error:', e.message);
    }
  }

  /**
   * Ambil kode referal milik akun yang sedang login.
   * Strategi:
   *   1. Scan semua link/href yang ada ?ref=XXXXXX
   *   2. Cari teks "Invite code: XXXXXX" di body
   *   3. Klik tombol "Refer & earn" / "Invite friends" → modal → scan + clipboard
   */
  async getReferralCode() {
    // Navigate ke balance page (kalau belum di sana)
    const currentUrl = this.page.url();
    if (!currentUrl.includes('/console/balance')) {
      try { await this.clickConsoleMenu(); } catch (e) {}

      if (!this.page.url().includes('/console/balance')) {
        await this.page.goto('https://platform.xiaomimimo.com/console/balance', {
          waitUntil: 'networkidle',
          timeout: this.config.browser.timeout,
        });
      }
      await this.handleOAuthRedirect();
      await humanDelay(1500, 2500);
      await this.handleTermsModal();
      await this.waitForOverlaysGone();
    }

    // Strategi 1: scan ?ref= di link/anchor/data-clipboard
    console.log('  Scanning for ?ref= links...');
    let refCode = await this.page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a, [data-href], [data-clipboard-text]'));
      for (const a of anchors) {
        const href = a.href || a.getAttribute('data-href') || a.getAttribute('data-clipboard-text') || '';
        const m = href.match(/[?&]ref=([A-Z0-9]{6})\b/i);
        if (m) return m[1].toUpperCase();
      }
      const inputs = Array.from(document.querySelectorAll('input[readonly], textarea[readonly]'));
      for (const inp of inputs) {
        const v = inp.value || '';
        const m = v.match(/[?&]ref=([A-Z0-9]{6})\b/i);
        if (m) return m[1].toUpperCase();
      }
      return null;
    });
    if (isValidRefCode(refCode)) return refCode;
    if (refCode) console.log('  ! Strategi 1 hasil "${refCode}" ditolak (blacklist/invalid)');
    refCode = null;

    // Strategi 2: regex teks plain — 3 pattern, hasil divalidasi
    console.log('  Scanning page text for ref code patterns...');
    refCode = await this.page.evaluate(() => {
      const text = document.body.innerText;
      const m1 = text.match(/[?&]ref=([A-Z0-9]{6})\b/i);
      if (m1) return m1[1].toUpperCase();
      const m2 = text.match(/(?:invite\s+code|referral\s+code|your\s+code)[\s:\n]+([A-Z0-9]{6})\b/i);
      if (m2) return m2[1].toUpperCase();
      const m3 = text.match(/\bcode\s*:\s*([A-Z0-9]{6})\b/i);
      if (m3) return m3[1].toUpperCase();
      return null;
    });
    if (isValidRefCode(refCode)) return refCode;
    if (refCode) console.log('  ! Strategi 2 hasil "${refCode}" ditolak (blacklist/invalid)');
    refCode = null;

    // Strategi 3: klik Refer & earn / Invite → modal → scan + clipboard
    console.log('  Trying to click Refer & earn / Invite button...');
    const opened = await this.page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const target = all.find(el => {
        const txt = (el.textContent || '').trim();
        return /^(Refer\s*&\s*earn|Refer\s*and\s*earn|Invite( friends)?|Share|Refer( friends)?)$/i.test(txt) && el.offsetHeight > 0;
      });
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.click();
        return true;
      }
      return false;
    });

    if (opened) {
      console.log('  ✓ Clicked Refer & earn / Invite button, waiting for modal...');
      await this.page.waitForFunction(() => {
        const modals = Array.from(document.querySelectorAll('.ant-modal, .ant-modal-content, .ant-modal-wrap, [role="dialog"]'));
        return modals.some(m => {
          if (m.offsetHeight === 0 || m.style.display === 'none') return false;
          const t = (m.innerText || '').toLowerCase();
          return t.includes('invite code') || t.includes('invite builder') || t.includes('refer & earn');
        });
      }, { timeout: 8000 }).catch(() => {});
      await humanDelay(800, 1400);

      try {
        await this.page.evaluate(async () => {
          try { await navigator.clipboard.writeText(''); } catch (e) {}
        });
      } catch (e) {}

      for (let attempt = 1; attempt <= 3 && !refCode; attempt++) {
        const candidate = await this.page.evaluate(() => {
          const modal = Array.from(document.querySelectorAll('.ant-modal, .ant-modal-content, .ant-modal-wrap, [role="dialog"]'))
            .find(m => m.offsetHeight > 0 && (m.style.display !== 'none'));
          const scope = modal || document.body;

          const els = Array.from(scope.querySelectorAll('a, [data-clipboard-text], [data-href], input, textarea, span, div'));
          for (const el of els) {
            const sources = [
              el.href, el.value, el.getAttribute('data-clipboard-text'),
              el.getAttribute('data-href'), el.getAttribute('data-link'),
              el.textContent,
            ];
            for (const s of sources) {
              if (!s) continue;
              const m = s.match(/[?&]ref=([A-Z0-9]{6})\b/i);
              if (m) return m[1].toUpperCase();
            }
          }
          const text = scope.innerText || '';
          const m1 = text.match(/[?&]ref=([A-Z0-9]{6})\b/i);
          if (m1) return m1[1].toUpperCase();
          const m2 = text.match(/(?:invite\s+code|referral\s+code|your\s+code)[\s:\n]+([A-Z0-9]{6})\b/i);
          if (m2) return m2[1].toUpperCase();
          const m3 = text.match(/\bcode\s*:\s*([A-Z0-9]{6})\b/i);
          if (m3) return m3[1].toUpperCase();
          return null;
        });
        if (isValidRefCode(candidate)) {
          refCode = candidate;
          break;
        }
        if (candidate) {
          console.log('  ! Modal attempt ${attempt} hasil "${candidate}" ditolak (blacklist)');
        }
        if (attempt < 3) {
          console.log('  Modal scan attempt ${attempt} empty, retry in 1.5s...');
          await humanDelay(1200, 1800);
        }
      }

      if (!refCode) {
        console.log('  ! Ref code not in modal text, trying Copy button + clipboard...');
        try {
          const ctx = this.page.context();
          await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});

          const copyBtnText = await this.page.evaluate(() => {
            const modals = Array.from(document.querySelectorAll('.ant-modal, .ant-modal-content, [role="dialog"]'))
              .filter(m => m.offsetHeight > 0);
            const referModal = modals.find(m => {
              const t = (m.innerText || '').toLowerCase();
              return t.includes('invite code') || t.includes('invite builder') || t.includes('refer & earn');
            }) || modals[modals.length - 1];
            if (!referModal) return null;

            const btns = Array.from(referModal.querySelectorAll('button, a, [role="button"], [data-clipboard-text]'));
            const copy = btns.find(b => /^(copy|copy link|salin)/i.test((b.textContent || '').trim()));
            if (!copy) return null;
            return {
              clipText: copy.getAttribute('data-clipboard-text'),
              link: copy.getAttribute('data-link') || copy.getAttribute('data-href'),
              value: copy.value,
            };
          });

          if (copyBtnText) {
            console.log('  Copy button attrs: ${JSON.stringify(copyBtnText)}');
            for (const v of Object.values(copyBtnText)) {
              if (!v) continue;
              const s = String(v);
              const m = s.match(/[?&]ref=([A-Z0-9]{6})\b/i);
              if (m && isValidRefCode(m[1])) { refCode = m[1].toUpperCase(); break; }
              const trimmed = s.trim().toUpperCase();
              if (isValidRefCode(trimmed)) { refCode = trimmed; break; }
            }
          }

          if (!refCode) {
            await this.page.bringToFront().catch(() => {});
            await this.page.evaluate(() => {
              const modal = Array.from(document.querySelectorAll('.ant-modal, .ant-modal-content, .ant-modal-wrap, [role="dialog"]'))
                .find(m => m.offsetHeight > 0);
              if (!modal) return false;
              const btns = Array.from(modal.querySelectorAll('button, a, [role="button"]'));
              const copy = btns.find(b => /^(copy|copy link|salin)/i.test((b.textContent || '').trim()));
              if (copy) { copy.click(); return true; }
              return false;
            });
            await humanDelay(900, 1400);

            const clipboardText = await this.page.evaluate(async () => {
              try { window.focus(); } catch (e) {}
              try {
                return await navigator.clipboard.readText();
              } catch (e) {
                return '';
              }
            });
            if (clipboardText) {
              console.log('  Clipboard: ${clipboardText.substring(0, 100)}');
              const m1 = clipboardText.match(/[?&]ref=([A-Z0-9]{6})\b/i);
              if (m1 && isValidRefCode(m1[1])) {
                refCode = m1[1].toUpperCase();
              } else {
                const trimmed = clipboardText.trim().toUpperCase();
                if (isValidRefCode(trimmed)) {
                  refCode = trimmed;
                } else {
                  const m2 = clipboardText.match(/\b([A-Z0-9]{6})\b/i);
                  if (m2 && isValidRefCode(m2[1])) refCode = m2[1].toUpperCase();
                }
              }
            } else {
              console.log('  ! Clipboard empty (page may have lost focus)');
            }
          }
        } catch (clipErr) {
          console.log('  ! Clipboard read error: ${clipErr.message}');
        }
      }

      if (!refCode) {
        console.log('  ! All strategies failed — dumping debug artifacts');
        try {
          const ts = Date.now();
          await this.page.screenshot({
            path: 'error-refcode-${ts}.png',
            fullPage: false,
          });
          const modalHtml = await this.page.evaluate(() => {
            const modal = Array.from(document.querySelectorAll('.ant-modal, .ant-modal-content, [role="dialog"]'))
              .find(m => m.offsetHeight > 0);
            return modal ? modal.outerHTML.substring(0, 2000) : 'NO_MODAL';
          });
          console.log('  Modal HTML (preview): ${modalHtml.substring(0, 500)}');
        } catch (e) {}
      }

      await this.page.keyboard.press('Escape').catch(() => {});
    }

    return refCode;
  }
}

export { MimoRegistration, isValidRefCode };
