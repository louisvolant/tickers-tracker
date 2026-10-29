import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  isDisallowedEmailDomain,
  isEmailDomainPolicyBypassed,
} from '../src/lib/emailDomainPolicy';

describe('Registration email domain policy', () => {
  test('rejects reserved RFC 2606 domains and their subdomains', () => {
    for (const email of [
      'bot@example.com',
      'bot@sub.example.com',
      'bot@example.net',
      'bot@example.org',
    ]) {
      assert.strictEqual(isDisallowedEmailDomain(email), true, email);
    }
  });

  test('rejects reserved and special-use TLDs', () => {
    for (const email of [
      'bot@foo.example',
      'bot@foo.test',
      'bot@foo.invalid',
      'bot@foo.localhost',
      'bot@localhost',
    ]) {
      assert.strictEqual(isDisallowedEmailDomain(email), true, email);
    }
  });

  test('rejects test artefacts and disposable mailboxes', () => {
    for (const email of [
      'bot@example-hunt-2602.com',
      'bot@teleworm.us',
      'bot@dayrep.com',
      'bot@mailinator.com',
      'bot@guerrillamail.com',
      'bot@10minutemail.com',
      'bot@temp-mail.org',
      'bot@tempmail.com',
      'bot@yopmail.com',
      'bot@trashmail.com',
      'bot@sharklasers.com',
      'bot@getnada.com',
      'bot@dispostable.com',
      'bot@maildrop.cc',
      'bot@fakeinbox.com',
      'bot@throwawaymail.com',
    ]) {
      assert.strictEqual(isDisallowedEmailDomain(email), true, email);
    }
  });

  test('rejects malformed addresses without a usable domain', () => {
    for (const email of ['pas-un-email', 'bot@', 'bot@nodot']) {
      assert.strictEqual(isDisallowedEmailDomain(email), true, email);
    }
  });

  test('accepts real mailbox domains, including plus addressing', () => {
    for (const email of [
      'someone@gmail.com',
      'someone@googlemail.com',
      'someone@outlook.fr',
      'a+film@protonmail.com',
      'hello@tickertracker.net',
    ]) {
      assert.strictEqual(isDisallowedEmailDomain(email), false, email);
    }
  });

  test('is case-insensitive and ignores surrounding whitespace', () => {
    assert.strictEqual(isDisallowedEmailDomain('  BOT@EXAMPLE.COM  '), true);
    assert.strictEqual(isDisallowedEmailDomain('  SOMEONE@GMAIL.COM  '), false);
  });

  test('only bypasses the policy behind the explicit test flags', () => {
    const env = process.env as Record<string, string | undefined>;
    const previousE2E = env.E2E;
    const previousNodeEnv = env.NODE_ENV;

    try {
      delete env.E2E;
      env.NODE_ENV = 'production';
      assert.strictEqual(isEmailDomainPolicyBypassed(), false);

      env.E2E = '1';
      assert.strictEqual(isEmailDomainPolicyBypassed(), true);

      delete env.E2E;
      env.NODE_ENV = 'test';
      assert.strictEqual(isEmailDomainPolicyBypassed(), true);
    } finally {
      if (previousE2E === undefined) delete env.E2E;
      else env.E2E = previousE2E;
      if (previousNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = previousNodeEnv;
    }
  });
});
