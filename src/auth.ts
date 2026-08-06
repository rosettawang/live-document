/**
 * Name gate + identity cookie.
 *
 * You type your name. That both lets you in and says who you are, so there is
 * nothing else to pick and nothing to mismatch.
 *
 * Rosetta, Aug 6, 2026: "should be your name not Your word and they might add
 * last name so as long as it starts with ed and kenia or rosetta." So matching
 * is a case-insensitive PREFIX: "Ed", "ed", "Ed Smith" and "Edward" all sign in
 * as Ed. Kenya answers to both spellings, because she writes "Kenia" and the
 * trip document says "Kenya" — being locked out by a vowel is worse than any
 * risk this gate is protecting against.
 *
 * This is deliberately weak. Any of the four can sign in as any other — raised
 * on Aug 5 and overruled ("its not that strict"), which is the right call for a
 * trip plan among friends. What it still does is keep crawlers and passers-by
 * off a guessable subdomain, and keep the metered Claude spend behind a door.
 * If booking references or card details ever land in the document, swap the
 * entries for real secrets: one command, no code change.
 */

const COOKIE = "iceland_who";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days — comfortably past the Aug 19 return

export const CREW = ["Rosetta", "Kenya", "Ed", "Ben"] as const;

/**
 * Parses the DOC_PASSCODE secret into word → name.
 *
 * Accepts, in increasing order of paranoia:
 *   "ada,bo,cyd"                → each word is the name, capitalised
 *   "Ada:swift,Bo:kestrel"      → explicit name for each match
 *   "Ada:ada,Ada:adah"          → two matches, same person
 *
 * The last form is how a name with two spellings is handled: both resolve to the
 * same person, so nobody is locked out by a vowel. Examples only — the real
 * values live in the DOC_PASSCODE secret and are not written down in the repo.
 */
export function parseCrew(secret: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of secret.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const i = entry.indexOf(":");
    const word = (i === -1 ? entry : entry.slice(i + 1)).trim();
    if (!word) continue;
    const name =
      i === -1
        ? word.charAt(0).toUpperCase() + word.slice(1)
        : entry.slice(0, i).trim() || word;
    map.set(word.toLowerCase(), name);
  }
  return map;
}

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Constant-time compare. A fast string !== leaks the passcode a character at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Resolves what someone typed to a person, or null.
 *
 * Longest match wins, so "kenia" beats a shorter entry if both prefix the
 * input. Every entry is considered rather than returning on the first hit —
 * with first names as the secret, timing is nowhere near the weakest link, but
 * there is no reason to leak position in the list.
 */
export function whoIs(supplied: string, secret: string): string | null {
  const typed = supplied.trim().toLowerCase().replace(/[ \t]+/g, " ");
  if (!typed) return null;

  let found: string | null = null;
  let matched = 0;
  for (const [word, name] of parseCrew(secret)) {
    if (typed.startsWith(word) && word.length > matched) {
      found = name;
      matched = word.length;
    }
  }
  return found;
}

export async function mintCookie(name: string, secret: string): Promise<string> {
  const payload = `${encodeURIComponent(name)}.${Date.now()}`;
  const sig = await hmac(secret, payload);
  const value = `${payload}.${sig}`;
  return `${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

/** Returns the signed-in name, or null. Verifies the signature — never trusts the cookie body. */
export async function readCookie(request: Request, secret: string): Promise<string | null> {
  const header = request.headers.get("Cookie");
  if (!header) return null;

  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;

  const parts = match[1].split(".");
  if (parts.length !== 3) return null;
  const [rawName, issued, sig] = parts;

  const expected = await hmac(secret, `${rawName}.${issued}`);
  if (!timingSafeEqual(sig, expected)) return null;

  const age = Date.now() - Number(issued);
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE * 1000) return null;

  try {
    const name = decodeURIComponent(rawName).slice(0, 40);
    return name || null;
  } catch {
    return null;
  }
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
