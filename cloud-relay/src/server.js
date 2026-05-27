import crypto from "crypto";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { createStripeCheckout, createStripePortal, updateSubscriptionSeats, updateBilling, verifyStripeSignature } from "./billing.js";
import { createSession, getAccountFromBearer, getAccountFromSessionToken, hashPassword, publicAccount, randomToken, slugify, verifyPassword } from "./auth.js";
import { loadStore, mutateStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const BASE_DOMAIN = process.env.BASE_DOMAIN || new URL(PUBLIC_URL).host;
const APP_HOSTNAME = new URL(PUBLIC_URL).hostname;
const APP_SUBDOMAIN = APP_HOSTNAME.endsWith(`.${BASE_DOMAIN}`)
  ? APP_HOSTNAME.slice(0, -(BASE_DOMAIN.length + 1))
  : "";
const RESERVED_SUBDOMAINS = new Set(["www", "app", APP_SUBDOMAIN].filter(Boolean));
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_SOLO = process.env.STRIPE_PRICE_SOLO || process.env.STRIPE_PRICE_RELAY || "";
const STRIPE_PRICE_TEAM = process.env.STRIPE_PRICE_TEAM || "";
const STRIPE_PRICE_SEAT = process.env.STRIPE_PRICE_SEAT || "";
const SESSION_COOKIE = "launchpad_relay_session";

const PLAN_LIMITS = {
  solo: { users: 1, nodes: 3 },
  team: { users: 5, nodes: 15 },
  relay: { users: 1, nodes: 3 },
};

function getTenantLimits(tenant) {
  const base = PLAN_LIMITS[tenant.billing?.plan] || PLAN_LIMITS.solo;
  const extra = tenant.billing?.extraSeats || 0;
  return { maxUsers: base.users + extra, maxNodes: base.nodes + extra };
}
const INVITE_TTL_MS = 7 * 86400_000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
// keyed by instanceToken → { accountId, instanceId, nodeId, ws, connectedAt, lastSeenAt }
const onlineNodes = new Map();
const pendingProxy = new Map();
// keyed by proxy request id → { res, resolve } for streaming SSE responses
const pendingStream = new Map();

// ── helpers ───────────────────────────────────────────────────────────────────

function auth(req, res, next) {
  const bearer = String(req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
  const bearerAccount = getAccountFromBearer(req.header("Authorization"));
  const account = bearerAccount || getAccountFromCookie(req);
  if (!account) return res.status(401).json({ error: "Unauthorized" });
  if (bearerAccount && bearer) setSessionCookie(res, bearer);
  req.account = account;
  next();
}

function parseCookies(req) {
  return Object.fromEntries(String(req.header("cookie") || "")
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const idx = part.indexOf("=");
      return idx === -1 ? [part, ""] : [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
    }));
}

function getAccountFromCookie(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  return token ? getAccountFromSessionToken(token) : null;
}

function setSessionCookie(res, token) {
  const secure = PUBLIC_URL.startsWith("https://") ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
}

function clearSessionCookie(res) {
  const secure = PUBLIC_URL.startsWith("https://") ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function accountIsPaid(account) {
  return !!account.billing?.relayEnabled && ["active", "trialing"].includes(account.billing.status);
}

function tenantIsPaid(tenant) {
  return !!tenant.billing?.relayEnabled && ["active", "trialing"].includes(tenant.billing.status);
}

function generatePairingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(6), b => chars[b % chars.length]).join("");
}

function instanceSubdomain(tenantSlug, instanceSlug) {
  return `${tenantSlug}-${instanceSlug}`;
}

function instanceRelayUrl(subdomain) {
  return `${PUBLIC_URL}/i/${encodeURIComponent(subdomain)}`;
}

function findInstanceBySubdomain(subdomain) {
  const store = loadStore();
  for (const tenant of (store.tenants || [])) {
    for (const inst of (tenant.instances || [])) {
      if (instanceSubdomain(tenant.slug, inst.slug) === subdomain) {
        return { tenant, instance: inst };
      }
    }
  }
  return null;
}

function requireInstanceOwner(req, res, found) {
  const account = getAccountFromCookie(req);
  const membership = account ? getMembership(account.id, found.tenant.id) : null;
  if (membership && canAccessInstance(membership, found.instance.id)) return account;

  const acceptsHtml = String(req.header("accept") || "").includes("text/html");
  if (!account && acceptsHtml && req.method === "GET") {
    return res.redirect(`/?next=${encodeURIComponent(req.originalUrl || req.url || "/")}`);
  }
  if (!account) return res.status(401).send("Sign in to access this BeeZee");
  return res.status(403).send("You do not have access to this BeeZee");
}

function getMembership(accountId, tenantId) {
  return (loadStore().memberships || []).find(m => m.accountId === accountId && m.tenantId === tenantId) || null;
}

function canManageTenant(membership) {
  return ["owner", "admin"].includes(membership?.role);
}

function canOwnTenant(membership) {
  return membership?.role === "owner";
}

function canAccessInstance(membership, instanceId) {
  if (!membership) return false;
  if (["owner", "admin"].includes(membership.role)) return true;
  const access = membership.nodeAccess;
  return access === "all" || (Array.isArray(access) && access.includes(instanceId));
}

function currentTenant(req, res) {
  const tenantId = String(req.header("x-tenant-id") || req.query.tenantId || req.body?.tenantId || "");
  const store = loadStore();
  const memberships = (store.memberships || []).filter(m => m.accountId === req.account.id);
  const membership = memberships.find(m => m.tenantId === tenantId) || memberships[0];
  if (!membership) {
    res.status(428).json({ error: "Create or join a tenant first" });
    return null;
  }
  const tenant = (store.tenants || []).find(t => t.id === membership.tenantId);
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return null;
  }
  return { tenant, membership };
}

function publicTenant(tenant, membership) {
  const limits = getTenantLimits(tenant);
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    role: membership.role,
    billing: {
      ...(tenant.billing || { status: "inactive", plan: "free", relayEnabled: false }),
      extraSeats: tenant.billing?.extraSeats || 0,
      maxUsers: limits.maxUsers,
      maxNodes: limits.maxNodes,
    },
  };
}

function publicInstance(tenant, inst) {
  const sub = instanceSubdomain(tenant.slug, inst.slug);
  const node = onlineNodes.get(inst.token);
  return {
    id: inst.id,
    name: inst.name,
    slug: inst.slug,
    subdomain: sub,
    relayUrl: instanceRelayUrl(sub),
    token: inst.token,
    env: [
      `BEEZEE_RELAY_URL=${PUBLIC_URL}`,
      `BEEZEE_RELAY_NODE_ID=${sub}`,
      `BEEZEE_RELAY_TOKEN=${inst.token}`,
    ].join("\n"),
    createdAt: inst.createdAt,
    online: !!node,
    connectedAt: node?.connectedAt || null,
    lastSeenAt: node?.lastSeenAt || null,
    usageSnapshot: node?.usageSnapshot || inst.usageSnapshot || null,
  };
}

function rewritePathProxyBody(buffer, contentType, publicPrefix) {
  if (!publicPrefix) return buffer;
  const textType = /text\/html|text\/css|application\/javascript|text\/javascript/i.test(contentType || "");
  if (!textType) return buffer;

  let body = buffer.toString("utf8");
  if (/text\/html/i.test(contentType || "")) {
    const prefixScript = `<script>
(() => {
  const prefix = ${JSON.stringify(publicPrefix)};
  const addPrefix = value => typeof value === "string" && value.startsWith("/api") ? prefix + value : value;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === "string") return originalFetch(addPrefix(input), init);
    if (input instanceof Request && input.url.startsWith(location.origin + "/api")) {
      input = new Request(prefix + new URL(input.url).pathname + new URL(input.url).search, input);
    }
    return originalFetch(input, init);
  };
  const OriginalEventSource = window.EventSource;
  window.EventSource = function(url, config) { return new OriginalEventSource(addPrefix(url), config); };
})();
</script>`;
    body = body
      .replace(/(<head[^>]*>)/i, `$1${prefixScript}`)
      .replace(/\b(src|href)="\/(assets\/[^"]*)"/g, `$1="${publicPrefix}/$2"`);
  }
  body = body.replace(/url\(\/(assets\/[^)]+)\)/g, `url(${publicPrefix}/$1)`);
  return Buffer.from(body, "utf8");
}

// ── startup migration ─────────────────────────────────────────────────────────

function migrateStore() {
  mutateStore(store => {
    if (!store.tenants) store.tenants = [];
    if (!store.memberships) store.memberships = [];
    if (!store.invitations) store.invitations = [];
    for (const account of store.accounts) {
      if (!account.instances) account.instances = [];
      let tenant = store.tenants.find(t => t.ownerAccountId === account.id);
      if (!tenant && (account.instances.length > 0 || account.slug)) {
        tenant = {
          id: randomToken(12),
          name: account.slug || account.email.split("@")[0] || "tenant",
          slug: account.slug || slugify(account.email.split("@")[0]),
          ownerAccountId: account.id,
          instances: account.instances,
          billing: account.billing || { provider: "stripe", status: "inactive", plan: "free", relayEnabled: false, currentPeriodEnd: null },
          createdAt: account.createdAt || new Date().toISOString(),
        };
        store.tenants.push(tenant);
      }
      if (tenant && !store.memberships.some(m => m.accountId === account.id && m.tenantId === tenant.id)) {
        store.memberships.push({ accountId: account.id, tenantId: tenant.id, role: "owner", nodeAccess: "all", createdAt: account.createdAt || new Date().toISOString() });
      }
      if (account.nodeToken) {
        const alreadyMigrated = tenant && (tenant.instances || []).some(i => i.token === account.nodeToken);
        if (!alreadyMigrated) {
          if (!tenant) {
            tenant = {
              id: randomToken(12),
              name: account.slug || account.email.split("@")[0] || "tenant",
              slug: account.slug || slugify(account.email.split("@")[0]),
              ownerAccountId: account.id,
              instances: [],
              billing: account.billing || { provider: "stripe", status: "inactive", plan: "free", relayEnabled: false, currentPeriodEnd: null },
              createdAt: account.createdAt || new Date().toISOString(),
            };
            store.tenants.push(tenant);
            store.memberships.push({ accountId: account.id, tenantId: tenant.id, role: "owner", nodeAccess: "all", createdAt: account.createdAt || new Date().toISOString() });
          }
          if (!tenant.instances) tenant.instances = [];
          tenant.instances.push({
            id: randomToken(12),
            name: "default",
            slug: "default",
            token: account.nodeToken,
            createdAt: account.createdAt || new Date().toISOString(),
          });
        }
        delete account.nodeToken;
      }
      account.instances = [];
    }
  });
}

// ── stripe webhook ────────────────────────────────────────────────────────────

app.post("/api/stripe/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const raw = req.body.toString("utf8");
  if (!verifyStripeSignature(raw, req.header("stripe-signature"), STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: "Invalid Stripe signature" });
  }
  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: "Invalid JSON" }); }

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object;
    const billingId = session?.metadata?.tenant_id || session?.metadata?.account_id;
    const customerId = session?.customer || null;
    const subscriptionId = session?.subscription || null;
    const plan = session?.metadata?.plan || null;
    if (billingId) updateBilling(billingId, "trialing", customerId, subscriptionId, 0, plan);
  } else if (event.type === "customer.subscription.updated") {
    const sub = event.data?.object;
    const billingId = sub?.metadata?.tenant_id || sub?.metadata?.account_id;
    if (billingId) {
      const seatItem = (sub.items?.data || []).find(item => item.price.id === STRIPE_PRICE_SEAT);
      const extraSeats = seatItem ? (seatItem.quantity || 0) : 0;
      const plan = sub?.metadata?.plan || null;
      updateBilling(billingId, sub.status || "canceled", null, sub.id, extraSeats, plan);
    }
  } else if (event.type === "customer.subscription.deleted") {
    const sub = event.data?.object;
    const billingId = sub?.metadata?.tenant_id || sub?.metadata?.account_id;
    if (billingId) updateBilling(billingId, "canceled", null, null, 0, null);
  }

  res.json({ received: true });
});

app.use("/api", express.json({ limit: "5mb" }));

// ── health ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "launchpad-cloud-relay", onlineNodes: onlineNodes.size });
});

app.get(["/sw.js", "/registerSW.js"], (_req, res) => {
  res.type("application/javascript");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.send(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      self.registration.unregister(),
      caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key)))),
      self.clients.matchAll({ type: 'window' }).then(clients => clients.forEach(client => client.navigate(client.url))),
    ])
  );
});
`);
});

// ── auth ──────────────────────────────────────────────────────────────────────

app.post("/api/auth/register", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  let account;
  try {
    account = mutateStore(store => {
      if (store.accounts.some(a => a.email === email)) throw new Error("Email already registered");
      const row = {
        id: randomToken(12),
        email,
        passwordHash: hashPassword(password),
        billing: { provider: "stripe", status: "inactive", plan: "free", relayEnabled: false, currentPeriodEnd: null },
        createdAt: new Date().toISOString(),
      };
      store.accounts.push(row);
      return row;
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const token = createSession(account.id);
  setSessionCookie(res, token);
  res.json({ token, account: publicAccount(account) });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const account = loadStore().accounts.find(a => a.email === email);
  if (!account || !verifyPassword(String(req.body.password || ""), account.passwordHash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = createSession(account.id);
  setSessionCookie(res, token);
  res.json({ token, account: publicAccount(account) });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ account: publicAccount(req.account) });
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/auth/change-password", auth, (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "currentPassword and newPassword are required" });
  if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
  const account = loadStore().accounts.find(a => a.id === req.account.id);
  if (!account || !verifyPassword(currentPassword, account.passwordHash)) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  mutateStore(store => {
    const acc = store.accounts.find(a => a.id === req.account.id);
    if (acc) acc.passwordHash = hashPassword(newPassword);
  });
  res.json({ ok: true });
});

app.delete("/api/account", auth, (req, res) => {
  const password = String(req.body.password || "");
  if (!password) return res.status(400).json({ error: "Password is required to delete account" });
  const account = loadStore().accounts.find(a => a.id === req.account.id);
  if (!account || !verifyPassword(password, account.passwordHash)) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  const accountId = req.account.id;
  mutateStore(store => {
    store.accounts = store.accounts.filter(a => a.id !== accountId);
    store.sessions = (store.sessions || []).filter(s => s.accountId !== accountId);
    const ownedTenantIds = (store.memberships || [])
      .filter(m => m.accountId === accountId && m.role === "owner")
      .map(m => m.tenantId)
      .filter(tid => !(store.memberships || []).some(m => m.tenantId === tid && m.accountId !== accountId && m.role === "owner"));
    store.memberships = (store.memberships || []).filter(m => m.accountId !== accountId);
    for (const tid of ownedTenantIds) {
      const stillHasMembers = (store.memberships || []).some(m => m.tenantId === tid);
      if (!stillHasMembers) {
        store.tenants = (store.tenants || []).filter(t => t.id !== tid);
        store.memberships = (store.memberships || []).filter(m => m.tenantId !== tid);
      }
    }
  });
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── tenants ──────────────────────────────────────────────────────────────────

app.get("/api/tenants", auth, (req, res) => {
  const store = loadStore();
  const tenants = (store.memberships || [])
    .filter(m => m.accountId === req.account.id)
    .map(m => {
      const tenant = (store.tenants || []).find(t => t.id === m.tenantId);
      return tenant ? publicTenant(tenant, m) : null;
    })
    .filter(Boolean);
  res.json({ tenants });
});

app.post("/api/tenants", auth, (req, res) => {
  const name = String(req.body.name || "").trim();
  const slug = slugify(req.body.slug || name);
  if (!name || !slug) return res.status(400).json({ error: "name and slug are required" });
  if (RESERVED_SUBDOMAINS.has(slug)) return res.status(400).json({ error: "Subdomain is reserved" });

  try {
    const tenant = mutateStore(store => {
      if (!store.tenants) store.tenants = [];
      if (!store.memberships) store.memberships = [];
      if (store.memberships.some(m => m.accountId === req.account.id)) throw new Error("Account already belongs to a tenant");
      if (store.tenants.some(t => t.slug === slug)) throw new Error("Tenant slug already taken");
      const row = {
        id: randomToken(12),
        name,
        slug,
        ownerAccountId: req.account.id,
        instances: [],
        billing: { provider: "stripe", status: "inactive", plan: "free", relayEnabled: false, currentPeriodEnd: null },
        createdAt: new Date().toISOString(),
      };
      store.tenants.push(row);
      store.memberships.push({ tenantId: row.id, accountId: req.account.id, role: "owner", nodeAccess: "all", createdAt: row.createdAt });
      return row;
    });
    res.json({ tenant: publicTenant(tenant, { role: "owner" }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/invites/:token", (req, res) => {
  const store = loadStore();
  const invite = (store.invitations || []).find(i => i.token === req.params.token && !i.usedAt && i.expiresAt > Date.now());
  if (!invite) return res.status(404).json({ error: "Invite not found or expired" });
  const tenant = (store.tenants || []).find(t => t.id === invite.tenantId);
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  res.json({ invite: { tenantName: tenant.name, role: invite.role, expiresAt: invite.expiresAt } });
});

app.post("/api/invites/:token/accept", auth, (req, res) => {
  try {
    const tenant = mutateStore(store => {
      const invite = (store.invitations || []).find(i => i.token === req.params.token && !i.usedAt && i.expiresAt > Date.now());
      if (!invite) throw new Error("Invite not found or expired");
      const tenant = (store.tenants || []).find(t => t.id === invite.tenantId);
      if (!tenant) throw new Error("Tenant not found");
      if ((store.memberships || []).some(m => m.accountId === req.account.id && m.tenantId === tenant.id)) throw new Error("Already a member");
      const memberCount = (store.memberships || []).filter(m => m.tenantId === tenant.id).length;
      const limits = getTenantLimits(tenant);
      if (memberCount >= limits.maxUsers) throw new Error(`Member limit reached (${limits.maxUsers}). The workspace owner needs to add more seats.`);
      store.memberships.push({
        tenantId: tenant.id,
        accountId: req.account.id,
        role: invite.role || "member",
        nodeAccess: invite.nodeAccess || [],
        createdAt: new Date().toISOString(),
      });
      invite.usedAt = new Date().toISOString();
      invite.acceptedBy = req.account.id;
      return tenant;
    });
    res.json({ tenant });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/members", auth, (req, res) => {
  const current = currentTenant(req, res);
  if (!current) return;
  if (!canManageTenant(current.membership)) return res.status(403).json({ error: "Admins only" });
  const store = loadStore();
  const members = (store.memberships || [])
    .filter(m => m.tenantId === current.tenant.id)
    .map(m => {
      const account = store.accounts.find(a => a.id === m.accountId);
      return account ? { accountId: account.id, email: account.email, role: m.role, nodeAccess: m.nodeAccess || [] } : null;
    })
    .filter(Boolean);
  const invites = (store.invitations || [])
    .filter(i => i.tenantId === current.tenant.id && !i.usedAt && i.expiresAt > Date.now())
    .map(i => ({ token: i.token, role: i.role, nodeAccess: i.nodeAccess || [], link: `${PUBLIC_URL}/?invite=${i.token}`, expiresAt: i.expiresAt }));
  res.json({ members, invites });
});

app.post("/api/invites", auth, (req, res) => {
  const current = currentTenant(req, res);
  if (!current) return;
  if (!canManageTenant(current.membership)) return res.status(403).json({ error: "Admins only" });
  const role = req.body.role === "admin" && canOwnTenant(current.membership) ? "admin" : "member";
  const nodeAccess = role === "admin" ? "all" : (Array.isArray(req.body.nodeAccess) ? req.body.nodeAccess : []);
  const token = randomToken(24);
  mutateStore(store => {
    if (!store.invitations) store.invitations = [];
    store.invitations.push({
      token,
      tenantId: current.tenant.id,
      role,
      nodeAccess,
      createdBy: req.account.id,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + INVITE_TTL_MS,
    });
  });
  res.json({ invite: { token, role, nodeAccess, link: `${PUBLIC_URL}/?invite=${token}`, expiresAt: Date.now() + INVITE_TTL_MS } });
});

app.patch("/api/members/:accountId", auth, (req, res) => {
  const current = currentTenant(req, res);
  if (!current) return;
  if (!canOwnTenant(current.membership)) return res.status(403).json({ error: "Owner only" });
  try {
    const updated = mutateStore(store => {
      const member = (store.memberships || []).find(m => m.tenantId === current.tenant.id && m.accountId === req.params.accountId);
      if (!member) throw new Error("Member not found");
      if (member.role === "owner") throw new Error("Owner cannot be changed");
      if (["admin", "member"].includes(req.body.role)) member.role = req.body.role;
      member.nodeAccess = member.role === "admin" ? "all" : (Array.isArray(req.body.nodeAccess) ? req.body.nodeAccess : []);
      return member;
    });
    res.json({ member: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── instances ─────────────────────────────────────────────────────────────────

app.get("/api/instances", auth, (req, res) => {
  const current = currentTenant(req, res);
  if (!current) return;
  const instances = (current.tenant.instances || [])
    .filter(inst => canAccessInstance(current.membership, inst.id))
    .map(inst => publicInstance(current.tenant, inst));
  res.json({ instances });
});

app.post("/api/instances", auth, (req, res) => {
  const current = currentTenant(req, res);
  if (!current) return;
  if (!canManageTenant(current.membership)) return res.status(403).json({ error: "Admins only" });
  const limits = getTenantLimits(current.tenant);
  const nodeCount = (current.tenant.instances || []).length;
  if (nodeCount >= limits.maxNodes) {
    return res.status(400).json({ error: `Node limit reached (${limits.maxNodes}). Add extra seats to connect more nodes.` });
  }
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const slug = slugify(name);
  if (!slug) return res.status(400).json({ error: "Invalid name" });

  let created;
  let pairingCode;
  try {
    const { tenant: updatedTenant, instance: inst, code } = mutateStore(store => {
      const tenant = store.tenants.find(t => t.id === current.tenant.id);
      if (!tenant.instances) tenant.instances = [];
      const sub = instanceSubdomain(tenant.slug, slug);
      if (RESERVED_SUBDOMAINS.has(sub)) throw new Error("Subdomain is reserved");
      for (const t of store.tenants || []) {
        for (const existing of (t.instances || [])) {
          if (instanceSubdomain(t.slug, existing.slug) === sub) throw new Error("Instance name already taken");
        }
      }
      const inst = {
        id: randomToken(12),
        name,
        slug,
        token: randomToken(32),
        createdAt: new Date().toISOString(),
      };
      tenant.instances.push(inst);
      if (!store.pairingCodes) store.pairingCodes = [];
      store.pairingCodes = store.pairingCodes.filter(p => p.expiresAt > Date.now());
      const code = generatePairingCode();
      store.pairingCodes.push({ code, instanceId: inst.id, expiresAt: Date.now() + 10 * 60 * 1000, used: false });
      return { tenant, instance: inst, code };
    });
    created = publicInstance(updatedTenant, inst);
    pairingCode = code;
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json({
    instance: {
      ...created,
      pairingCode,
      pairLink: `http://localhost:4242/?pair=${pairingCode}&relay=${encodeURIComponent(PUBLIC_URL)}`,
    },
  });
});

app.delete("/api/instances/:id", auth, (req, res) => {
  const current = currentTenant(req, res);
  if (!current) return;
  if (!canManageTenant(current.membership)) return res.status(403).json({ error: "Admins only" });
  try {
    mutateStore(store => {
      const tenant = store.tenants.find(t => t.id === current.tenant.id);
      const idx = (tenant.instances || []).findIndex(i => i.id === req.params.id);
      if (idx === -1) throw new Error("Instance not found");
      const [inst] = tenant.instances.splice(idx, 1);
      onlineNodes.delete(inst.token);
    });
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
  res.json({ ok: true });
});

app.patch("/api/instances/:id", auth, (req, res) => {
  const current = currentTenant(req, res);
  if (!current) return;
  if (!canManageTenant(current.membership)) return res.status(403).json({ error: "Admins only" });
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });

  let updated;
  try {
    const { tenant, instance } = mutateStore(store => {
      const tenant = store.tenants.find(t => t.id === current.tenant.id);
      const inst = (tenant.instances || []).find(i => i.id === req.params.id);
      if (!inst) throw new Error("Instance not found");
      inst.name = name;
      return { tenant, instance: inst };
    });
    updated = publicInstance(tenant, instance);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ instance: updated });
});

app.post("/api/pair/claim", express.json(), (req, res) => {
  const code = String(req.body.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ error: "code is required" });

  try {
    const result = mutateStore(store => {
      if (!store.pairingCodes) store.pairingCodes = [];
      const pc = store.pairingCodes.find(p => p.code === code && p.expiresAt > Date.now() && !p.used);
      if (!pc) throw new Error("Invalid or expired pairing code");
      pc.used = true;
      for (const tenant of (store.tenants || [])) {
        const inst = (tenant.instances || []).find(i => i.id === pc.instanceId);
        if (inst) return { tenant, instance: inst };
      }
      throw new Error("Instance not found");
    });
    const sub = instanceSubdomain(result.tenant.slug, result.instance.slug);
    res.json({ instanceName: result.instance.name, nodeId: sub, token: result.instance.token, relayUrl: PUBLIC_URL });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── billing ───────────────────────────────────────────────────────────────────

app.post("/api/billing/checkout", auth, async (req, res) => {
  const current = currentTenant(req, res);
  if (!current) return;
  if (!canOwnTenant(current.membership)) return res.status(403).json({ error: "Owner only" });
  if (!STRIPE_SECRET_KEY) {
    return res.json({ mock: true });
  }
  const plan = req.body.plan === "team" ? "team" : "solo";
  const priceId = plan === "team" ? STRIPE_PRICE_TEAM : STRIPE_PRICE_SOLO;
  if (!priceId) return res.status(400).json({ error: `Plan "${plan}" is not configured` });
  try {
    const session = await createStripeCheckout({
      account: { ...req.account, id: current.tenant.id, slug: current.tenant.slug, email: req.account.email },
      publicUrl: PUBLIC_URL,
      priceId,
      secretKey: STRIPE_SECRET_KEY,
      trialDays: 14,
      plan,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(502).json({ error: err.message || "Stripe checkout failed" });
  }
});

app.post("/api/billing/portal", auth, async (req, res) => {
  const current = currentTenant(req, res);
  if (!current) return;
  if (!canOwnTenant(current.membership)) return res.status(403).json({ error: "Owner only" });
  const customerId = current.tenant.billing?.stripeCustomerId;
  if (!customerId || !STRIPE_SECRET_KEY) {
    return res.status(400).json({ error: "Billing portal not available" });
  }
  try {
    const session = await createStripePortal({
      customerId,
      returnUrl: `${PUBLIC_URL}/app`,
      secretKey: STRIPE_SECRET_KEY,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(502).json({ error: err.message || "Stripe portal failed" });
  }
});

app.post("/api/billing/mock", auth, (req, res) => {
  const current = currentTenant(req, res);
  if (!current) return;
  if (!canOwnTenant(current.membership)) return res.status(403).json({ error: "Owner only" });
  const status = req.body.active === false ? "canceled" : "active";
  const plan = ["solo", "team"].includes(req.body.plan) ? req.body.plan : "solo";
  const tenant = mutateStore(store => {
    const t = store.tenants.find(t => t.id === current.tenant.id);
    t.billing = { ...(t.billing || {}), provider: "stripe", status, plan, relayEnabled: ["active", "trialing"].includes(status), currentPeriodEnd: null };
    return t;
  });
  res.json({ tenant: publicTenant(tenant, current.membership) });
});

app.post("/api/billing/seats", auth, async (req, res) => {
  const current = currentTenant(req, res);
  if (!current) return;
  if (!canOwnTenant(current.membership)) return res.status(403).json({ error: "Owner only" });
  const seats = Math.max(0, parseInt(String(req.body.seats ?? 0), 10) || 0);
  const subscriptionId = current.tenant.billing?.stripeSubscriptionId;

  if (!subscriptionId || !STRIPE_SECRET_KEY || !STRIPE_PRICE_SEAT) {
    const tenant = mutateStore(store => {
      const t = store.tenants.find(t => t.id === current.tenant.id);
      if (!t) return null;
      t.billing = { ...t.billing, extraSeats: seats };
      return t;
    });
    return res.json({ tenant: publicTenant(tenant, current.membership) });
  }

  try {
    await updateSubscriptionSeats({ subscriptionId, seatPriceId: STRIPE_PRICE_SEAT, seats, secretKey: STRIPE_SECRET_KEY });
    const tenant = mutateStore(store => {
      const t = store.tenants.find(t => t.id === current.tenant.id);
      if (!t) return null;
      t.billing = { ...t.billing, extraSeats: seats };
      return t;
    });
    res.json({ tenant: publicTenant(tenant, current.membership) });
  } catch (err) {
    res.status(502).json({ error: err.message || "Failed to update seats" });
  }
});

// ── WebSocket node ────────────────────────────────────────────────────────────

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, PUBLIC_URL);
  if (url.pathname !== "/node") return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, PUBLIC_URL);
  const token = url.searchParams.get("token");
  const nodeId = url.searchParams.get("node_id") || "launchpad";

  const store = loadStore();
  let foundTenant = null;
  let foundInstance = null;

  outer: for (const tenant of (store.tenants || [])) {
    for (const inst of (tenant.instances || [])) {
      if (inst.token === token) {
        foundTenant = tenant;
        foundInstance = inst;
        break outer;
      }
    }
  }

  if (!foundTenant || !foundInstance) {
    ws.close(1008, "invalid node token");
    return;
  }
  if (!tenantIsPaid(foundTenant)) {
    ws.close(1008, "billing inactive");
    return;
  }

  const sub = instanceSubdomain(foundTenant.slug, foundInstance.slug);
  onlineNodes.set(token, {
    tenantId: foundTenant.id,
    instanceId: foundInstance.id,
    nodeId,
    ws,
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  send(ws, { type: "hello", tenant_id: foundTenant.id, relay_url: instanceRelayUrl(sub) });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const node = onlineNodes.get(token);
    if (node) node.lastSeenAt = new Date().toISOString();
    if (msg.type === "proxy_response" && pendingProxy.has(msg.id)) {
      const cb = pendingProxy.get(msg.id);
      pendingProxy.delete(msg.id);
      cb(msg);
    }
    if (msg.type === "proxy_chunk" && pendingStream.has(msg.id)) {
      const { res } = pendingStream.get(msg.id);
      if (!res.writableEnded) res.write(Buffer.from(msg.data_b64 || "", "base64"));
    }
    if (msg.type === "proxy_stream_end" && pendingStream.has(msg.id)) {
      const entry = pendingStream.get(msg.id);
      pendingStream.delete(msg.id);
      if (!entry.res.writableEnded) entry.res.end();
      entry.resolve();
    }
    if (msg.type === "usage_update" && msg.data && node) {
      node.usageSnapshot = msg.data;
      mutateStore(store => {
        const tenant = store.tenants.find(t => t.id === foundTenant.id);
        const inst = (tenant?.instances || []).find(i => i.id === foundInstance.id);
        if (inst) inst.usageSnapshot = msg.data;
      });
    }
  });
  ws.on("close", () => {
    const node = onlineNodes.get(token);
    if (node?.ws === ws) onlineNodes.delete(token);
  });
});

// ── HTTP proxy ────────────────────────────────────────────────────────────────

async function proxyToNode(tenant, instanceToken, req, res, stripPrefix = "") {
  if (!tenantIsPaid(tenant)) return res.status(402).send("Relay billing is inactive");
  const node = onlineNodes.get(instanceToken);
  if (!node) return res.status(503).send("BeeZee is offline");

  const body = await new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
  const id = randomToken(10);
  const rawUrl = req.originalUrl || req.url || "/";
  const publicPrefix = stripPrefix.replace(/\/$/, "");
  const targetPath = publicPrefix && rawUrl.startsWith(publicPrefix)
    ? rawUrl.slice(publicPrefix.length) || "/"
    : rawUrl;

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingProxy.delete(id);
      pendingStream.delete(id);
      if (!res.headersSent) res.status(504).send("BeeZee timed out");
      resolve();
    }, 30000);

    pendingProxy.set(id, msg => {
      clearTimeout(timer);
      const contentType = msg.headers?.["content-type"] || msg.headers?.["Content-Type"] || "";

      for (const [key, value] of Object.entries(msg.headers || {})) {
        const k = key.toLowerCase();
        if (["connection", "content-encoding", "content-length", "transfer-encoding"].includes(k)) continue;
        if (k === "location" && typeof value === "string" && value.startsWith("/") && publicPrefix) {
          res.setHeader(key, `${publicPrefix}${value}`);
        } else {
          res.setHeader(key, value);
        }
      }

      if (contentType.includes("text/event-stream")) {
        res.writeHead(msg.status || 200);
        const sseTimer = setTimeout(() => {
          pendingStream.delete(id);
          if (!res.writableEnded) res.end();
          resolve();
        }, 5 * 60 * 1000);
        pendingStream.set(id, {
          res,
          resolve: () => { clearTimeout(sseTimer); resolve(); },
        });
        req.on("close", () => {
          if (pendingStream.has(id)) {
            const entry = pendingStream.get(id);
            pendingStream.delete(id);
            entry.resolve();
          }
        });
      } else {
        const responseBody = rewritePathProxyBody(Buffer.from(msg.body_b64 || "", "base64"), contentType, publicPrefix);
        res.status(msg.status || 200).send(responseBody);
        resolve();
      }
    });

    send(node.ws, {
      type: "proxy_request",
      id,
      method: req.method,
      path: targetPath,
      headers: { accept: req.header("accept") || "*/*", "content-type": req.header("content-type") || "" },
      body_b64: body.toString("base64"),
    });
  });
}

app.all("/r/:subdomain/*", (req, res) => {
  const found = findInstanceBySubdomain(req.params.subdomain);
  if (!found) return res.status(404).send("Unknown relay");
  const owner = requireInstanceOwner(req, res, found);
  if (!owner || res.headersSent) return;
  proxyToNode(found.tenant, found.instance.token, req, res, `/r/${req.params.subdomain}`);
});

app.all(["/i/:subdomain", "/i/:subdomain/*"], (req, res) => {
  const found = findInstanceBySubdomain(req.params.subdomain);
  if (!found) return res.status(404).send("Unknown relay");
  const owner = requireInstanceOwner(req, res, found);
  if (!owner || res.headersSent) return;
  proxyToNode(found.tenant, found.instance.token, req, res, `/i/${req.params.subdomain}`);
});

const webDist = path.join(__dirname, "../web/dist");

app.use((req, res, next) => {
  const host = req.hostname;
  if (host === APP_HOSTNAME) return next();
  const subdomain = host.endsWith(`.${BASE_DOMAIN}`) ? host.slice(0, -(BASE_DOMAIN.length + 1)) : "";
  if (!subdomain || RESERVED_SUBDOMAINS.has(subdomain)) return next();
  const found = findInstanceBySubdomain(subdomain);
  if (!found) return res.status(404).send("Unknown relay subdomain");
  const owner = requireInstanceOwner(req, res, found);
  if (!owner || res.headersSent) return;
  proxyToNode(found.tenant, found.instance.token, req, res);
});

app.use(express.static(webDist));

app.get("*", (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"));
});

// ── start ─────────────────────────────────────────────────────────────────────

migrateStore();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Launchpad cloud relay listening on ${PORT}`);
  console.log(`Public URL: ${PUBLIC_URL}`);
});
