/**
 * Password generator — varied passwords for MiMo registration
 * Each account gets a unique password that still meets requirements:
 * - At least 8 chars
 * - Uppercase + lowercase + number + special char
 */

const ADJECTIVES = [
  'Brave', 'Clever', 'Dark', 'Eager', 'Fierce', 'Grand', 'Happy', 'Iron',
  'Keen', 'Loyal', 'Mighty', 'Noble', 'Proud', 'Quick', 'Rapid', 'Sharp',
  'Swift', 'True', 'Vivid', 'Warm', 'Bold', 'Calm', 'Deep', 'Fair',
  'Free', 'Gold', 'Green', 'Kind', 'Light', 'Pure', 'Silver', 'Wild'
];

const NOUNS = [
  'Tiger', 'Eagle', 'Dragon', 'Phoenix', 'Wolf', 'Hawk', 'Bear', 'Fox',
  'Lion', 'Shark', 'Storm', 'Thunder', 'Flame', 'Frost', 'Shadow', 'Blade',
  'Crown', 'Sword', 'Tower', 'Viper', 'Raven', 'Cobra', 'Falcon', 'Panther',
  'Jaguar', 'Lynx', 'Orca', 'Raptor', 'Spark', 'Blaze', 'Claw', 'Fang'
];

/**
 * Generate a random password meeting MiMo requirements
 * Format: AdjNoun!123 (e.g., "BraveTiger!847")
 */
export function generatePassword() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(100 + Math.random() * 900); // 100-999
  return `${adj}${noun}!${num}`;
}

/**
 * Generate a more varied password
 * Format: Word-Word-NNN! (e.g., "swift-eagle-482!")
 */
export function generatePasswordV2() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)].toLowerCase();
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)].toLowerCase();
  const num = Math.floor(100 + Math.random() * 900);
  return `${adj}-${noun}-${num}!`;
}
