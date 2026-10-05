#!/usr/bin/env node

/**
 * Secure Kaggle Credential Setup Utility
 *
 * Saves Kaggle credentials safely to ~/.kaggle/kaggle.json with restricted permissions.
 * Never leaks or prints credentials to console or logs.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('====================================================');
console.log('       DevSpace Ultra — Secure Kaggle Setup         ');
console.log('====================================================');
console.log('This script safely configures your Kaggle API key locally.');
console.log('Your secret will NOT be sent to ChatGPT or logged anywhere.\n');

const kaggleDir = path.join(os.homedir(), '.kaggle');
const kaggleJsonPath = path.join(kaggleDir, 'kaggle.json');

rl.question('Enter your Kaggle Username: ', (username) => {
  if (!username.trim()) {
    console.error('Username cannot be empty');
    rl.close();
    process.exit(1);
  }

  rl.question('Enter your Kaggle API Key: ', (key) => {
    if (!key.trim()) {
      console.error('API key cannot be empty');
      rl.close();
      process.exit(1);
    }

    if (!fs.existsSync(kaggleDir)) {
      fs.mkdirSync(kaggleDir, { recursive: true });
    }

    const payload = {
      username: username.trim(),
      key: key.trim()
    };

    fs.writeFileSync(kaggleJsonPath, JSON.stringify(payload, null, 2), { mode: 0o600 });

    console.log('\n\x1b[32m[SUCCESS]\x1b[0m Kaggle credentials successfully saved to:');
    console.log(`  ${kaggleJsonPath}`);
    console.log('File permissions set to 0600 (read/write by owner only).\n');
    rl.close();
  });
});
