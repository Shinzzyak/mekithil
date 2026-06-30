/**
 * Account Manager — handles referral rotation and account tracking.
 *
 * Reads/writes config/accounts.json to track created accounts and their referral codes.
 * Ensures each account is used as referral at most maxReferralsPerAccount times.
 * Rotates referrals using round-robin based on least-used-first.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ACCOUNTS_PATH = join(__dirname, '../../config/accounts.json');

class AccountManager {
  constructor(configPath = ACCOUNTS_PATH) {
    this.configPath = configPath;
    this.data = this.load();
  }

  load() {
    if (!existsSync(this.configPath)) {
      return {
        accounts: [],
        referral_pool: [],
        stats: {
          total_accounts: 0,
          active_accounts: 0,
          last_created: null,
          last_referral_used: null,
          referral_rotation_index: 0
        },
        config: {
          inviteCooldownMs: 300000,
          maxReferralsPerAccount: 10,
          referralCooldownHours: 24
        }
      };
    }

    try {
      const content = readFileSync(this.configPath, 'utf-8');
      return JSON.parse(content);
    } catch (e) {
      console.error(`[AccountManager] Error loading accounts: ${e.message}`);
      return this.getDefaultData();
    }
  }

  save() {
    try {
      writeFileSync(this.configPath, JSON.stringify(this.data, null, 2));
      console.log(`[AccountManager] Saved ${this.data.accounts.length} accounts`);
    } catch (e) {
      console.error(`[AccountManager] Error saving accounts: ${e.message}`);
    }
  }

  /**
   * Get next referral code using round-robin rotation.
   * Returns null if no referrals available or all at max usage.
   */
  getNextReferral() {
    const { referral_pool, config } = this.data;
    const { maxReferralsPerAccount } = config;

    if (referral_pool.length === 0) {
      console.log('[AccountManager] No referrals available in pool');
      return null;
    }

    // Find least-used referral that hasn't hit max
    let bestRef = null;
    let minUsage = Infinity;

    for (const ref of referral_pool) {
      const account = this.data.accounts.find(a => a.referral_code === ref);
      if (!account) continue;

      const usage = account.referrals_count || 0;
      if (usage < maxReferralsPerAccount && usage < minUsage) {
        minUsage = usage;
        bestRef = ref;
      }
    }

    if (!bestRef) {
      console.log(`[AccountManager] All referrals at max usage (${maxReferralsPerAccount})`);
      return null;
    }

    // Update usage count
    const account = this.data.accounts.find(a => a.referral_code === bestRef);
    if (account) {
      account.referrals_count = (account.referrals_count || 0) + 1;
      this.data.stats.last_referral_used = bestRef;
      this.save();
    }

    console.log(`[AccountManager] Using referral: ${bestRef} (used ${minUsage + 1}/${maxReferralsPerAccount} times)`);
    return bestRef;
  }

  /**
   * Add new account to tracking.
   */
  addAccount({ email, password, referral_code, api_key }) {
    const newAccount = {
      id: this.data.accounts.length + 1,
      email,
      password,
      referral_code,
      api_key,
      created_at: new Date().toISOString(),
      status: 'active',
      referrals_count: 0
    };

    this.data.accounts.push(newAccount);
    this.data.referral_pool.push(referral_code);
    this.data.stats.total_accounts = this.data.accounts.length;
    this.data.stats.active_accounts = this.data.accounts.filter(a => a.status === 'active').length;
    this.data.stats.last_created = newAccount.created_at;

    this.save();
    console.log(`[AccountManager] Added account #${newAccount.id}: ${email} (ref: ${referral_code})`);
    return newAccount;
  }

  /**
   * Get account stats.
   */
  getStats() {
    return {
      ...this.data.stats,
      total_accounts: this.data.accounts.length,
      active_accounts: this.data.accounts.filter(a => a.status === 'active').length,
      referral_pool_size: this.data.referral_pool.length
    };
  }
}

export { AccountManager };
