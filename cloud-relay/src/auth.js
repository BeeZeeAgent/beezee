import crypto from "crypto";
import { loadStore, mutateStore } from "./store.js";

const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";

export function slugify(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

export function createSession(accountId) {
  const token = randomToken();
  const expiresAt = Date.now() + 30 * 86400_000;
  const signed = `${token}.${sign(token)}`;
  mutateStore(store => {
    store.sessions = store.sessions.filter(s => s.expiresAt > Date.now());
    store.sessions.push({ token, accountId, expiresAt });
  });
  return signed;
}

export function getAccountFromBearer(header) {
  const value = String(header || "").replace(/^Bearer\s+/i, "");
  const [token, signature] = value.split(".");
  if (!token || signature !== sign(token)) return null;
  const store = loadStore();
  const session = store.sessions.find(s => s.token === token && s.expiresAt > Date.now());
  if (!session) return null;
  return store.accounts.find(a => a.id === session.accountId) || null;
}

export function publicAccount(account, baseDomain) {
  return {
    id: account.id,
    email: account.email,
    slug: account.slug,
    relayUrl: `https://${account.slug}.${baseDomain}`,
    billing: account.billing || { status: "inactive", plan: "free", relayEnabled: false },
  };
}
