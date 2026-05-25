import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { createStripeCheckout, updateBilling, verifyStripeSignature } from "./billing.js";
import { createSession, getAccountFromBearer, hashPassword, publicAccount, randomToken, slugify, verifyPassword } from "./auth.js";
import { loadStore, mutateStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const BASE_DOMAIN = process.env.BASE_DOMAIN || new URL(PUBLIC_URL).host;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_RELAY = process.env.STRIPE_PRICE_RELAY || "";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const onlineNodes = new Map();
const pendingProxy = new Map();

function auth(req, res, next) {
  const account = getAccountFromBearer(req.header("Authorization"));
  if (!account) return res.status(401).json({ error: "Unauthorized" });
  req.account = account;
  next();
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function accountIsPaid(account) {
  return !!account.billing?.relayEnabled && ["active", "trialing"].includes(account.billing.status);
}

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

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "launchpad-cloud-relay", onlineNodes: onlineNodes.size });
});

app.post("/api/auth/register", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const slug = slugify(req.body.slug || email.split("@")[0]);
  if (!email || !password || !slug) return res.status(400).json({ error: "email, password, and slug are required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const account = mutateStore(store => {
    if (store.accounts.some(a => a.email === email)) throw new Error("Email already registered");
    if (store.accounts.some(a => a.slug === slug)) throw new Error("Subdomain already taken");
    const row = {
      id: randomToken(12),
      email,
      slug,
      passwordHash: hashPassword(password),
      nodeToken: randomToken(32),
      billing: { provider: "stripe", status: "inactive", plan: "free", relayEnabled: false, currentPeriodEnd: null },
      createdAt: new Date().toISOString(),
    };
    store.accounts.push(row);
    return row;
  });

  res.json({ token: createSession(account.id), account: publicAccount(account, BASE_DOMAIN) });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const account = loadStore().accounts.find(a => a.email === email);
  if (!account || !verifyPassword(String(req.body.password || ""), account.passwordHash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  res.json({ token: createSession(account.id), account: publicAccount(account, BASE_DOMAIN) });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ account: publicAccount(req.account, BASE_DOMAIN) });
});

app.get("/api/nodes", auth, (req, res) => {
  const node = onlineNodes.get(req.account.id);
  res.json({ nodes: node ? [{ nodeId: node.nodeId, connectedAt: node.connectedAt, lastSeenAt: node.lastSeenAt }] : [] });
});

app.get("/api/connect", auth, (req, res) => {
  res.json({
    nodeId: `launchpad-${req.account.slug}`,
    nodeToken: req.account.nodeToken,
    relayUrl: PUBLIC_URL,
    env: [
      `LAUNCHPAD_RELAY_URL=${PUBLIC_URL}`,
      `LAUNCHPAD_RELAY_NODE_ID=launchpad-${req.account.slug}`,
      `LAUNCHPAD_RELAY_TOKEN=${req.account.nodeToken}`,
    ].join("\n"),
  });
});

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
  res.json({ account: publicAccount(account, BASE_DOMAIN) });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, PUBLIC_URL);
  if (url.pathname !== "/node") return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, PUBLIC_URL);
  const token = url.searchParams.get("token");
  const nodeId = url.searchParams.get("node_id") || "launchpad";
  const account = loadStore().accounts.find(a => a.nodeToken === token);
  if (!account) {
    ws.close(1008, "invalid node token");
    return;
  }
  if (!accountIsPaid(account)) {
    ws.close(1008, "billing inactive");
    return;
  }

  onlineNodes.set(account.id, { accountId: account.id, nodeId, ws, connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() });
  send(ws, { type: "hello", account_id: account.id, relay_url: `https://${account.slug}.${BASE_DOMAIN}` });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const node = onlineNodes.get(account.id);
    if (node) node.lastSeenAt = new Date().toISOString();
    if (msg.type === "proxy_response" && pendingProxy.has(msg.id)) {
      pendingProxy.get(msg.id)(msg);
      pendingProxy.delete(msg.id);
    }
  });
  ws.on("close", () => {
    const node = onlineNodes.get(account.id);
    if (node?.ws === ws) onlineNodes.delete(account.id);
  });
});

async function proxyToNode(account, req, res, stripPrefix = "") {
  if (!accountIsPaid(account)) return res.status(402).send("Relay billing is inactive");
  const node = onlineNodes.get(account.id);
  if (!node) return res.status(503).send("Launchpad is offline");

  const body = await new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
  const id = randomToken(10);
  const rawUrl = req.originalUrl || req.url || "/";
  const targetPath = stripPrefix && rawUrl.startsWith(stripPrefix)
    ? rawUrl.slice(stripPrefix.length) || "/"
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
      res.setHeader(key, value);
    }
  }
  res.status(result.status || 200).send(Buffer.from(result.body_b64 || "", "base64"));
}

app.all("/r/:slug/*", (req, res) => {
  const account = loadStore().accounts.find(a => a.slug === req.params.slug);
  if (!account) return res.status(404).send("Unknown relay");
  proxyToNode(account, req, res, `/r/${req.params.slug}`);
});

const webDist = path.join(__dirname, "../web/dist");
app.use(express.static(webDist));

app.use((req, res, next) => {
  const host = req.hostname;
  const slug = host.endsWith(`.${BASE_DOMAIN}`) ? host.slice(0, -(BASE_DOMAIN.length + 1)) : "";
  if (!slug || slug === "www") return next();
  const account = loadStore().accounts.find(a => a.slug === slug);
  if (!account) return res.status(404).send("Unknown relay subdomain");
  proxyToNode(account, req, res);
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Launchpad cloud relay listening on ${PORT}`);
  console.log(`Public URL: ${PUBLIC_URL}`);
});
