import crypto from "crypto";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { createStripeCheckout, updateBilling, verifyStripeSignature } from "./billing.js";
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
const STRIPE_PRICE_RELAY = process.env.STRIPE_PRICE_RELAY || "";
const SESSION_COOKIE = "launchpad_relay_session";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
// keyed by instanceToken → { accountId, instanceId, nodeId, ws, connectedAt, lastSeenAt }
const onlineNodes = new Map();
const pendingProxy = new Map();

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

function generatePairingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(6), b => chars[b % chars.length]).join("");
}

function instanceSubdomain(accountSlug, instanceSlug) {
  return `${accountSlug}-${instanceSlug}`;
}

function instanceRelayUrl(subdomain) {
  return `${PUBLIC_URL}/i/${encodeURIComponent(subdomain)}`;
}

function findInstanceBySubdomain(subdomain) {
  const store = loadStore();
  for (const account of store.accounts) {
    for (const inst of (account.instances || [])) {
      if (instanceSubdomain(account.slug, inst.slug) === subdomain) {
        return { account, instance: inst };
      }
    }
  }
  return null;
}

function requireInstanceOwner(req, res, found) {
  const account = getAccountFromCookie(req);
  if (account?.id === found.account.id) return account;

  const acceptsHtml = String(req.header("accept") || "").includes("text/html");
  if (!account && acceptsHtml && req.method === "GET") {
    return res.redirect(`/?next=${encodeURIComponent(req.originalUrl || req.url || "/")}`);
  }
  if (!account) return res.status(401).send("Sign in to access this Launchpad");
  return res.status(403).send("You do not have access to this Launchpad");
}

function publicInstance(account, inst) {
  const sub = instanceSubdomain(account.slug, inst.slug);
  const node = onlineNodes.get(inst.token);
  return {
    id: inst.id,
    name: inst.name,
    slug: inst.slug,
    subdomain: sub,
    relayUrl: instanceRelayUrl(sub),
    token: inst.token,
    env: [
      `LAUNCHPAD_RELAY_URL=${PUBLIC_URL}`,
      `LAUNCHPAD_RELAY_NODE_ID=${sub}`,
      `LAUNCHPAD_RELAY_TOKEN=${inst.token}`,
    ].join("\n"),
    createdAt: inst.createdAt,
    online: !!node,
    connectedAt: node?.connectedAt || null,
    lastSeenAt: node?.lastSeenAt || null,
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
    for (const account of store.accounts) {
      if (!account.instances) account.instances = [];
      if (account.nodeToken && account.instances.length === 0) {
        account.instances.push({
          id: randomToken(12),
          name: "default",
          slug: "default",
          token: account.nodeToken,
          createdAt: account.createdAt || new Date().toISOString(),
        });
      }
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
    if (session?.metadata?.account_id) updateBilling(session.metadata.account_id, "active");
  } else if (event.type === "customer.subscription.updated") {
    const sub = event.data?.object;
    if (sub?.metadata?.account_id) updateBilling(sub.metadata.account_id, sub.status || "canceled");
  } else if (event.type === "customer.subscription.deleted") {
    const sub = event.data?.object;
    if (sub?.metadata?.account_id) updateBilling(sub.metadata.account_id, "canceled");
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
  const slug = slugify(req.body.slug || email.split("@")[0]);
  if (!email || !password || !slug) return res.status(400).json({ error: "email, password, and slug are required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  if (RESERVED_SUBDOMAINS.has(slug)) return res.status(400).json({ error: "Subdomain is reserved" });

  let account;
  try {
    account = mutateStore(store => {
      if (store.accounts.some(a => a.email === email)) throw new Error("Email already registered");
      if (store.accounts.some(a => a.slug === slug)) throw new Error("Subdomain already taken");
      const row = {
        id: randomToken(12),
        email,
        slug,
        passwordHash: hashPassword(password),
        instances: [],
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

// ── instances ─────────────────────────────────────────────────────────────────

app.get("/api/instances", auth, (req, res) => {
  const account = loadStore().accounts.find(a => a.id === req.account.id);
  const instances = (account.instances || []).map(inst => publicInstance(account, inst));
  res.json({ instances });
});

app.post("/api/instances", auth, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const slug = slugify(name);
  if (!slug) return res.status(400).json({ error: "Invalid name" });

  let created;
  let pairingCode;
  try {
    const { account: updatedAccount, instance: inst, code } = mutateStore(store => {
      const account = store.accounts.find(a => a.id === req.account.id);
      if (!account.instances) account.instances = [];
      const sub = instanceSubdomain(account.slug, slug);
      if (RESERVED_SUBDOMAINS.has(sub)) throw new Error("Subdomain is reserved");
      for (const acc of store.accounts) {
        for (const existing of (acc.instances || [])) {
          if (instanceSubdomain(acc.slug, existing.slug) === sub) throw new Error("Instance name already taken");
        }
      }
      const inst = {
        id: randomToken(12),
        name,
        slug,
        token: randomToken(32),
        createdAt: new Date().toISOString(),
      };
      account.instances.push(inst);
      if (!store.pairingCodes) store.pairingCodes = [];
      store.pairingCodes = store.pairingCodes.filter(p => p.expiresAt > Date.now());
      const code = generatePairingCode();
      store.pairingCodes.push({ code, instanceId: inst.id, expiresAt: Date.now() + 10 * 60 * 1000, used: false });
      return { account, instance: inst, code };
    });
    created = publicInstance(updatedAccount, inst);
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
  try {
    mutateStore(store => {
      const account = store.accounts.find(a => a.id === req.account.id);
      const idx = (account.instances || []).findIndex(i => i.id === req.params.id);
      if (idx === -1) throw new Error("Instance not found");
      const [inst] = account.instances.splice(idx, 1);
      onlineNodes.delete(inst.token);
    });
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
  res.json({ ok: true });
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
      for (const account of store.accounts) {
        const inst = (account.instances || []).find(i => i.id === pc.instanceId);
        if (inst) return { account, instance: inst };
      }
      throw new Error("Instance not found");
    });
    const sub = instanceSubdomain(result.account.slug, result.instance.slug);
    res.json({ instanceName: result.instance.name, nodeId: sub, token: result.instance.token, relayUrl: PUBLIC_URL });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── billing ───────────────────────────────────────────────────────────────────

app.post("/api/billing/checkout", auth, async (req, res) => {
  if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_RELAY) {
    return res.json({ mock: true });
  }
  try {
    const session = await createStripeCheckout({
      account: req.account,
      publicUrl: PUBLIC_URL,
      priceId: STRIPE_PRICE_RELAY,
      secretKey: STRIPE_SECRET_KEY,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(502).json({ error: err.message || "Stripe checkout failed" });
  }
});

app.post("/api/billing/mock", auth, (req, res) => {
  const account = updateBilling(req.account.id, req.body.active === false ? "canceled" : "active");
  res.json({ account: publicAccount(account) });
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
  let foundAccount = null;
  let foundInstance = null;

  outer: for (const account of store.accounts) {
    for (const inst of (account.instances || [])) {
      if (inst.token === token) {
        foundAccount = account;
        foundInstance = inst;
        break outer;
      }
    }
  }

  if (!foundAccount || !foundInstance) {
    ws.close(1008, "invalid node token");
    return;
  }
  if (!accountIsPaid(foundAccount)) {
    ws.close(1008, "billing inactive");
    return;
  }

  const sub = instanceSubdomain(foundAccount.slug, foundInstance.slug);
  onlineNodes.set(token, {
    accountId: foundAccount.id,
    instanceId: foundInstance.id,
    nodeId,
    ws,
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  send(ws, { type: "hello", account_id: foundAccount.id, relay_url: instanceRelayUrl(sub) });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const node = onlineNodes.get(token);
    if (node) node.lastSeenAt = new Date().toISOString();
    if (msg.type === "proxy_response" && pendingProxy.has(msg.id)) {
      pendingProxy.get(msg.id)(msg);
      pendingProxy.delete(msg.id);
    }
  });
  ws.on("close", () => {
    const node = onlineNodes.get(token);
    if (node?.ws === ws) onlineNodes.delete(token);
  });
});

// ── HTTP proxy ────────────────────────────────────────────────────────────────

async function proxyToNode(account, instanceToken, req, res, stripPrefix = "") {
  if (!accountIsPaid(account)) return res.status(402).send("Relay billing is inactive");
  const node = onlineNodes.get(instanceToken);
  if (!node) return res.status(503).send("Launchpad is offline");

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

  const result = await new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingProxy.delete(id);
      resolve({ status: 504, headers: { "content-type": "text/plain" }, body_b64: Buffer.from("Launchpad timed out").toString("base64") });
    }, 30000);
    pendingProxy.set(id, msg => {
      clearTimeout(timer);
      resolve(msg);
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

  for (const [key, value] of Object.entries(result.headers || {})) {
    if (!["connection", "content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
      if (key.toLowerCase() === "location" && typeof value === "string" && value.startsWith("/") && publicPrefix) {
        res.setHeader(key, `${publicPrefix}${value}`);
      } else {
        res.setHeader(key, value);
      }
    }
  }
  const contentType = result.headers?.["content-type"] || result.headers?.["Content-Type"] || "";
  const responseBody = rewritePathProxyBody(Buffer.from(result.body_b64 || "", "base64"), contentType, publicPrefix);
  res.status(result.status || 200).send(responseBody);
}

app.all("/r/:subdomain/*", (req, res) => {
  const found = findInstanceBySubdomain(req.params.subdomain);
  if (!found) return res.status(404).send("Unknown relay");
  const owner = requireInstanceOwner(req, res, found);
  if (!owner || res.headersSent) return;
  proxyToNode(found.account, found.instance.token, req, res, `/r/${req.params.subdomain}`);
});

app.all(["/i/:subdomain", "/i/:subdomain/*"], (req, res) => {
  const found = findInstanceBySubdomain(req.params.subdomain);
  if (!found) return res.status(404).send("Unknown relay");
  const owner = requireInstanceOwner(req, res, found);
  if (!owner || res.headersSent) return;
  proxyToNode(found.account, found.instance.token, req, res, `/i/${req.params.subdomain}`);
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
  proxyToNode(found.account, found.instance.token, req, res);
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
