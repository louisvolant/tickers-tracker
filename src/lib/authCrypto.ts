// Edge and Cloudflare Workers compatible cryptography using Web Crypto API

const PBKDF2_ITERATIONS = 100_000;
const HASH_LENGTH = 32;

/**
 * Hash a password using PBKDF2-HMAC-SHA256 with a random 16-byte salt.
 * Output format: "iterations.hexSalt.hexHash"
 */
export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256', length: HASH_LENGTH * 8 },
    true,
    ['sign']
  );

  const exported = await crypto.subtle.exportKey('raw', key);
  const hashHex = Array.from(new Uint8Array(exported))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const saltHex = Array.from(salt)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `${PBKDF2_ITERATIONS}.${saltHex}.${hashHex}`;
}

/**
 * Verify a plaintext password against a stored PBKDF2 hash string.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const parts = storedHash.split('.');
    if (parts.length !== 3) return false;

    const iterations = parseInt(parts[0], 10);
    const salt = new Uint8Array(
      parts[1].match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
    );
    const originalHashHex = parts[2];

    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits', 'deriveKey']
    );

    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'HMAC', hash: 'SHA-256', length: HASH_LENGTH * 8 },
      true,
      ['sign']
    );

    const exported = await crypto.subtle.exportKey('raw', key);
    const computedHex = Array.from(new Uint8Array(exported))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    return computedHex === originalHashHex;
  } catch (err) {
    console.error('Password verification error:', err);
    return false;
  }
}

/**
 * A short, non-secret marker of the stored password hash. PBKDF2 re-salts on
 * every write, so the marker changes whenever the password is set again;
 * embedding it in the session token lets verification reject tokens issued
 * before the last password change. Only a slice of the random salt is used,
 * so it reveals nothing about the password itself.
 *
 * Returns undefined for missing or malformed hashes: verification then
 * degrades to signature-plus-account-existence instead of locking the user out.
 */
export function passwordMarker(hashedPassword: string | undefined | null): string | undefined {
  if (!hashedPassword) return undefined;
  const parts = hashedPassword.split('.');
  if (parts.length !== 3 || parts[1].length < 12) return undefined;
  return parts[1].slice(0, 12);
}

/**
 * Sign session payload with HMAC-SHA256
 */
export async function signSession(payload: object, secretKey: string): Promise<string> {
  const enc = new TextEncoder();
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadStr).toString('base64url');

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  const sigB64 = Buffer.from(sigBuffer).toString('base64url');

  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify session token and return the full parsed payload (the `user` it
 * contains plus the token metadata such as `exp` and the password marker),
 * or null when the signature or the expiry check fails.
 */
export async function verifySession<T = any>(token: string, secretKey: string): Promise<T | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadB64, sigB64] = parts;
    const enc = new TextEncoder();

    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secretKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBytes = Buffer.from(sigB64, 'base64url');
    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      enc.encode(payloadB64)
    );

    if (!isValid) return null;

    const jsonStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const parsed = JSON.parse(jsonStr);

    if (parsed.exp && Date.now() > parsed.exp) {
      return null;
    }

    return parsed as T;
  } catch (err) {
    return null;
  }
}
