/** Domains reserved by RFC 2606 and commonly used as test artefacts. */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/** Reserved/special-use TLDs that can never receive real mail. */
const RESERVED_TLDS = ['.example', '.test', '.invalid', '.localhost'];

/** Disposable mailbox providers seen in bot and test registrations. */
const DISPOSABLE_DOMAINS = [
  'teleworm.us',
  'dayrep.com',
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'temp-mail.org',
  'tempmail.com',
  'yopmail.com',
  'trashmail.com',
  'sharklasers.com',
  'getnada.com',
  'dispostable.com',
  'maildrop.cc',
  'fakeinbox.com',
  'throwawaymail.com',
];

/**
 * True when the registration email uses a reserved, test-only or disposable
 * domain. Pure and case-insensitive; the caller decides whether to bypass it
 * for the e2e suite.
 */
export function isDisallowedEmailDomain(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  const domain = at === -1 ? '' : normalized.slice(at + 1);

  // A real domain needs a label and a dot. This also rejects "localhost",
  // bare hosts and malformed addresses such as "pas-un-email".
  if (!domain || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return true;
  }

  if (domain === 'localhost' || RESERVED_TLDS.some((tld) => domain.endsWith(tld))) {
    return true;
  }

  if (
    RESERVED_DOMAINS.some(
      (reserved) => domain === reserved || domain.endsWith(`.${reserved}`)
    )
  ) {
    return true;
  }

  if (domain.startsWith('example-')) {
    return true;
  }

  return DISPOSABLE_DOMAINS.some(
    (disposable) => domain === disposable || domain.endsWith(`.${disposable}`)
  );
}

/**
 * The e2e suite registers accounts with @example.com. The bypass is opt-in via
 * E2E=1 (set by playwright.config.ts) or NODE_ENV=test, so a production deploy
 * can never skip the policy by accident.
 */
export function isEmailDomainPolicyBypassed(): boolean {
  return process.env.E2E === '1' || process.env.NODE_ENV === 'test';
}
