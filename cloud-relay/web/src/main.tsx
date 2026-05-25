import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckCircle2, Cloud, Copy, CreditCard, Loader2, LogOut, PlugZap, Server } from "lucide-react";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Input } from "./components/ui/input";
import "./style.css";

type Account = {
  id: string;
  email: string;
  slug: string;
  relayUrl: string;
  billing: { status: string; plan: string; relayEnabled: boolean; currentPeriodEnd?: string | null };
};

const tokenKey = "launchpadRelayToken";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(tokenKey);
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function AuthView({ onAuthed }: { onAuthed: (account: Account) => void }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    setError("");
    try {
      const body = mode === "register" ? { email, password, slug } : { email, password };
      const data = await api<{ token: string; account: Account }>(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      localStorage.setItem(tokenKey, data.token);
      onAuthed(data.account);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <section className="auth-panel">
        <div className="brand-mark"><Cloud size={24} /></div>
        <h1>Launchpad Cloud Relay</h1>
        <p>Connect a local Launchpad to a paid relay and open it from any device through a permanent subdomain.</p>
      </section>
      <Card className="auth-card">
        <div className="segmented">
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create</button>
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button>
        </div>
        <label>Email<Input value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
        <label>Password<Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
        {mode === "register" && (
          <label>Subdomain<Input value={slug} onChange={e => setSlug(e.target.value)} placeholder="my-launchpad" /></label>
        )}
        {error && <p className="error">{error}</p>}
        <Button onClick={submit} disabled={loading || !email || !password || (mode === "register" && !slug)}>
          {loading ? <Loader2 className="spin" size={16} /> : null}
          {mode === "register" ? "Create relay" : "Sign in"}
        </Button>
      </Card>
    </div>
  );
}

function AppView({ account, onLogout }: { account: Account; onLogout: () => void }) {
  const [current, setCurrent] = useState(account);
  const [nodes, setNodes] = useState<Array<{ nodeId: string; connectedAt: string; lastSeenAt: string }>>([]);
  const [connect, setConnect] = useState<{ env: string; relayUrl: string; nodeId: string; nodeToken: string } | null>(null);
  const [error, setError] = useState("");
  const paid = current.billing.relayEnabled;
  const statusLabel = paid ? `${current.billing.status} ${current.billing.plan}` : "inactive";

  const refresh = async () => {
    const [me, nodeData, connectData] = await Promise.all([
      api<{ account: Account }>("/api/me"),
      api<{ nodes: typeof nodes }>("/api/nodes"),
      api<typeof connect>("/api/connect"),
    ]);
    setCurrent(me.account);
    setNodes(nodeData.nodes);
    setConnect(connectData);
  };

  useEffect(() => {
    refresh().catch(err => setError(err.message));
    const timer = window.setInterval(() => refresh().catch(() => {}), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const checkout = async () => {
    setError("");
    const data = await api<{ url?: string; mock?: boolean }>("/api/billing/checkout", { method: "POST", body: JSON.stringify({}) });
    if (data.url) window.location.href = data.url;
    if (data.mock) {
      const updated = await api<{ account: Account }>("/api/billing/mock", { method: "POST", body: JSON.stringify({ active: true }) });
      setCurrent(updated.account);
    }
  };

  const copyEnv = async () => {
    if (connect) await navigator.clipboard.writeText(connect.env);
  };

  const online = nodes.length > 0;

  return (
    <div className="app-shell">
      <header>
        <div>
          <h1>Cloud Relay</h1>
          <p>{current.email}</p>
        </div>
        <Button className="secondary" onClick={onLogout}><LogOut size={16} />Sign out</Button>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="grid">
        <Card className="panel">
          <div className="panel-title"><CreditCard size={18} /> Billing</div>
          <strong>{statusLabel}</strong>
          <p>{paid ? "Relay access is enabled for this account." : "Activate billing to allow the local Launchpad node to connect."}</p>
          <Button onClick={checkout}>{paid ? "Manage billing" : "Start relay plan"}</Button>
        </Card>

        <Card className="panel">
          <div className="panel-title"><Server size={18} /> Local Launchpad</div>
          <strong>{online ? "Online" : "Waiting for node"}</strong>
          <p>{online ? nodes[0].nodeId : "Set these environment variables on the local Launchpad server and restart it."}</p>
          <Button className="secondary" onClick={copyEnv} disabled={!connect}><Copy size={16} />Copy env</Button>
        </Card>
      </div>

      <Card className="wide-panel">
        <div className="panel-title"><PlugZap size={18} /> Permanent Access</div>
        <a href={current.relayUrl} target="_blank" rel="noreferrer">{current.relayUrl}</a>
        <p>Point wildcard DNS for <code>*.{location.host}</code> at this relay host, then each account slug becomes a stable subdomain.</p>
        {connect && <pre>{connect.env}</pre>}
      </Card>

      <div className="checks">
        <span><CheckCircle2 size={15} /> Account authentication</span>
        <span><CheckCircle2 size={15} /> Stripe checkout and webhook</span>
        <span><CheckCircle2 size={15} /> WebSocket local-node tunnel</span>
      </div>
    </div>
  );
}

function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(!!localStorage.getItem(tokenKey));

  const logout = () => {
    localStorage.removeItem(tokenKey);
    setAccount(null);
  };

  useEffect(() => {
    if (!localStorage.getItem(tokenKey)) return;
    api<{ account: Account }>("/api/me")
      .then(data => setAccount(data.account))
      .catch(logout)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading"><Loader2 className="spin" />Loading</div>;
  return account ? <AppView account={account} onLogout={logout} /> : <AuthView onAuthed={setAccount} />;
}

createRoot(document.getElementById("root")!).render(<App />);
