/**
 * Captcha Solver Client — YesCaptcha
 *
 * Supports:
 *   - reCAPTCHA v2
 *   - Image captcha
 */

import fetch from 'node-fetch';

class CaptchaSolver {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.yescaptcha.com';
  }

  async solveCaptcha(sitekey, pageUrl) {
    console.log('[Captcha] Creating task...');

    const taskId = await this.createTask(sitekey, pageUrl);
    console.log(`[Captcha] Task ID: ${taskId}`);

    const solution = await this.waitForSolution(taskId);
    console.log('[Captcha] ✓ Solved');

    return solution;
  }

  async solveImageCaptcha(base64Image) {
    console.log('[Captcha] Creating image captcha task...');
    const url = `${this.baseUrl}/createTask`;

    const body = {
      clientKey: this.apiKey,
      task: {
        type: 'ImageToTextTask',
        body: base64Image,
        module: 'yescaptcha',
        recognizingThreshold: 90,
        caseSensitive: true,
        numeric: 0, // 0 = no restrictions, 1 = digits only, 2 = letters only
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (data.errorId !== 0) {
      throw new Error(`YesCaptcha image task failed: ${data.errorDescription || 'Unknown error'}`);
    }

    const taskId = data.taskId;
    console.log(`[Captcha] Image Task ID: ${taskId}`);

    // Use longer polling for image captcha (180s vs 90s for reCAPTCHA)
    const solution = await this.waitForSolution(taskId, 180000);
    console.log(`[Captcha] ✓ Solved: ${solution}`);

    return solution;
  }

  async createTask(sitekey, pageUrl) {
    const url = `${this.baseUrl}/createTask`;

    const body = {
      clientKey: this.apiKey,
      task: {
        type: 'RecaptchaV2TaskProxyless',
        websiteURL: pageUrl,
        websiteKey: sitekey
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (data.errorId !== 0) {
      throw new Error(`YesCaptcha task creation failed: ${data.errorDescription || 'Unknown error'}`);
    }

    return data.taskId;
  }

  async waitForSolution(taskId, maxWait = 300000, interval = 3000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, interval));

      const url = `${this.baseUrl}/getTaskResult`;
      const body = {
        clientKey: this.apiKey,
        taskId: taskId
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await response.json();

      if (data.status === 'ready') {
        return data.solution.gRecaptchaResponse || data.solution.text;
      }

      if (data.errorId !== 0 && data.errorCode !== 'ERROR_CAPTCHA_NOT_READY') {
        throw new Error(`YesCaptcha error: ${data.errorDescription || 'Unknown error'}`);
      }

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`[Captcha] Waiting... (${elapsed}s)`);
    }

    throw new Error('Captcha solving timeout');
  }
}

export { CaptchaSolver };
