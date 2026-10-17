import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = (relative) => pathToFileURL(path.join(root, relative)).href;

/** Run ESM in a child process with NO email/scheduler variables and NO .env file (pure code defaults). */
function runWithCleanEnvironment(code, extraEnv = {}) {
  const env = { ...process.env };
  for (const name of ['EMAIL_ENABLED', 'ENABLE_SCHEDULER', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_TO', 'SENDGRID_API_KEY']) delete env[name];
  env.DOTENV_CONFIG_PATH = path.join(os.tmpdir(), `no-such-env-file-${process.pid}`);
  return execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { cwd: os.tmpdir(), encoding: 'utf8', env: { ...env, ...extraEnv } });
}

test('automatic email and the scheduler are disabled by default (pure code defaults)', () => {
  const out = JSON.parse(runWithCleanEnvironment(`
    import { config } from ${JSON.stringify(moduleUrl('src/config.js'))};
    import { initScheduledReports } from ${JSON.stringify(moduleUrl('src/cron.js'))};
    const quiet = { log() {}, warn() {}, error() {} };
    console.log(JSON.stringify({
      emailEnabled: config.emailEnabled, enableScheduler: config.enableScheduler,
      resendApiKey: config.resendApiKey, emailFrom: config.emailFrom, emailTo: config.emailTo,
      schedulerStarted: initScheduledReports({ logger: quiet }) !== null,
    }));
  `));
  assert.deepEqual(out, { emailEnabled: false, enableScheduler: false, resendApiKey: '', emailFrom: '', emailTo: [], schedulerStarted: false });
});

test('RESEND_API_KEY, EMAIL_FROM and EMAIL_TO are read from the environment (multiple recipients supported)', () => {
  const out = JSON.parse(runWithCleanEnvironment(`
    import { config } from ${JSON.stringify(moduleUrl('src/config.js'))};
    console.log(JSON.stringify({ key: config.resendApiKey, from: config.emailFrom, to: config.emailTo, enabled: config.emailEnabled }));
  `, { RESEND_API_KEY: 're_test_key_not_a_real_secret', EMAIL_FROM: 'Reports <reports@example.com>', EMAIL_TO: 'a@example.com, b@example.com ,c@example.org', EMAIL_ENABLED: 'true' }));
  assert.deepEqual(out, { key: 're_test_key_not_a_real_secret', from: 'Reports <reports@example.com>', to: ['a@example.com', 'b@example.com', 'c@example.org'], enabled: true });
});

test('the legacy SENDGRID_API_KEY is ignored: it can never enable or configure email', () => {
  const out = JSON.parse(runWithCleanEnvironment(`
    import { config } from ${JSON.stringify(moduleUrl('src/config.js'))};
    console.log(JSON.stringify({ key: config.resendApiKey, keys: Object.keys(config).filter((k) => /sendgrid/i.test(k)) }));
  `, { SENDGRID_API_KEY: 'legacy-placeholder-ignored' }));
  assert.deepEqual(out, { key: '', keys: [] });
});

function parseEnvFile(file) {
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

test('.env.example: Resend variables with placeholders only, email and scheduler off, no SendGrid', () => {
  const file = path.join(root, '.env.example');
  const values = parseEnvFile(file);
  assert.equal(values.EMAIL_ENABLED, 'false');
  assert.equal(values.ENABLE_SCHEDULER, 'false');
  assert.equal(values.RESEND_API_KEY, '', 'no key value in the example file');
  assert.equal(values.EMAIL_FROM, '');
  assert.equal(values.EMAIL_TO, '');
  assert.ok(!('SENDGRID_API_KEY' in values));
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /sendgrid/i);
});

test('the sendgrid package and code are gone; the official resend package is installed', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(dependencies.resend, 'resend is a dependency');
  assert.ok(!Object.keys(dependencies).some((name) => /sendgrid/i.test(name)));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.ok(lock.packages['node_modules/resend'], 'resend is in package-lock.json');
  assert.ok(!Object.keys(lock.packages).some((name) => /sendgrid/i.test(name)), 'no @sendgrid packages remain in the lock file');

  // Source: only the one-time migration warning in server.js may mention the old variable.
  for (const file of fs.readdirSync(path.join(root, 'src'))) {
    const text = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    if (file === 'server.js') {
      const mentions = text.match(/sendgrid/gi) ?? [];
      assert.ok(mentions.length > 0 && /no longer used/.test(text), 'server.js keeps the migration warning');
    } else {
      assert.doesNotMatch(text, /sendgrid/i, `src/${file} still mentions SendGrid`);
    }
  }
});

function* projectFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'reports', 'data'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* projectFiles(full);
    else if (entry.name !== 'package-lock.json' && entry.name !== '.env') yield full;
  }
}

test('no API keys or credential-looking values are committed anywhere in the project', () => {
  const ALLOWED_FAKES = new Set(['re_test_key_not_a_real_secret']);
  const patterns = [/\bre_[A-Za-z0-9_]{24,}\b/g, /\bSG\.[A-Za-z0-9_-]{16,}/g, /\bsk-[A-Za-z0-9]{20,}/g];
  const findings = [];
  for (const file of projectFiles(root)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (!ALLOWED_FAKES.has(match[0])) findings.push(`${path.relative(root, file)}: ${match[0].slice(0, 12)}...`);
      }
    }
  }
  assert.deepEqual(findings, []);
  assert.ok(!fs.existsSync(path.join(root, '.env.example.local')), 'sanity');
});

test('the Resend key is read only from configuration and is never logged or hard-coded in source', () => {
  for (const file of fs.readdirSync(path.join(root, 'src'))) {
    const text = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    assert.doesNotMatch(text, /re_[A-Za-z0-9]{8,}/, `src/${file} contains a key-like literal`);
    // Nothing may log the key or the config object that holds it.
    assert.doesNotMatch(text, /console\.\w+\([^)]*(apiKey|resendApiKey)/, `src/${file} logs the API key`);
    assert.doesNotMatch(text, /console\.\w+\([^)]*\bconfig\)/, `src/${file} logs the whole config`);
  }
  assert.match(fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8'), /process\.env\.RESEND_API_KEY/);
});
