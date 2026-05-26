import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Cloud, Copy, CreditCard, Loader2, LogOut, Plus, Server, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Input } from "./components/ui/input";
import "./style.css";

type Account = {
  id: string;
  email: string;
  slug: string;
  billing: { status: string; plan: string; relayEnabled: boolean; currentPeriodEnd?: string | null };
};

type Instance = {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  relayUrl: string;
  token: string;
  env: string;
  createdAt: string;
  online: boolean;
  connectedAt: string | null;
  lastSeenAt: string | null;
  pairingCode?: string;
  pairLink?: string;
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
        <p>Connect one or more local Launchpad instances and access them from anywhere through permanent app URLs.</p>
      </section>
      <Card className="auth-card">
        <div className="segmented">
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create</button>
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button>
        </div>
        <label>Email<Input value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
        <label>Password<Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
        {mode === "register" && (
          <label>
            Account slug
            <Input value={slug} onChange={e => setSlug(e.target.value)} placeholder="my-account" />
            <span style={{ fontSize: 11, color: "#71717a" }}>Used as a prefix for your instance URLs</span>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <Button onClick={submit} disabled={loading || !email || !password || (mode === "register" && !slug)}>
          {loading ? <Loader2 className="spin" size={16} /> : null}
          {mode === "register" ? "Create account" : "Sign in"}
        </Button>
      </Card>
    </div>
  );
}

function InstanceCard({ instance, onDelete }: { instance: Instance; onDelete: (id: string) => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(instance.env);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const del = async () => {
    if (!confirm(`Delete instance "${instance.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try { await onDelete(instance.id); } finally { setDeleting(false); }
  };

  return (
    <Card className="instance-card">
      <div className="instance-header">
        <div className="instance-name">
          <strong>{instance.name}</strong>
          <span className={`badge ${instance.online ? "online" : "offline"}`}>
            {instance.online ? "Online" : "Offline"}
          </span>
        </div>
        <button className="delete-btn" onClick={del} disabled={deleting} title="Delete instance">
          {deleting ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
        </button>
      </div>
      <a href={instance.relayUrl} target="_blank" rel="noreferrer" className="relay-url">{instance.relayUrl}</a>
      <pre>{instance.env}</pre>
      <Button variant="outline" size="sm" onClick={copy}>
        <Copy size={14} />{copied ? "Copied!" : "Copy env vars"}
      </Button>
    </Card>
  );
}

function AppView({ account, onLogout }: { account: Account; onLogout: () => void }) {
  const [current, setCurrent] = useState(account);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [pairing, setPairing] = useState<Instance | null>(null);
  const [error, setError] = useState("");
  const paid = current.billing.relayEnabled;
  const statusLabel = paid ? `${current.billing.status} · ${current.billing.plan}` : "inactive";

  const refresh = async () => {
    const [me, instData] = await Promise.all([
      api<{ account: Account }>("/api/me"),
      api<{ instances: Instance[] }>("/api/instances"),
    ]);
    setCurrent(me.account);
    setInstances(instData.instances);
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

  const startAdding = () => {
    setAdding(true);
    setAddError("");
    setNewName("");
  };

  const createInstance = async () => {
    if (!newName.trim()) return;
    setAddLoading(true);
    setAddError("");
    try {
      const data = await api<{ instance: Instance }>("/api/instances", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim() }),
      });
      setInstances(prev => [...prev, data.instance]);
      setAdding(false);
      setNewName("");
      if (data.instance.pairingCode) setPairing(data.instance);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to create instance");
    } finally {
      setAddLoading(false);
    }
  };

  const deleteInstance = async (id: string) => {
    await api(`/api/instances/${id}`, { method: "DELETE" });
    setInstances(prev => prev.filter(i => i.id !== id));
  };

  return (
    <div className="app-shell">
      <header>
        <div>
          <h1>Cloud Relay</h1>
          <p>{current.email}</p>
        </div>
        <Button variant="outline" onClick={onLogout}><LogOut size={16} />Sign out</Button>
      </header>

      {error && <p className="error">{error}</p>}

      {pairing && (
        <Card className="pairing-panel">
          <div className="pairing-header">
            <strong>Connect "{pairing.name}"</strong>
            <button className="delete-btn" onClick={() => setPairing(null)} title="Dismiss">✕</button>
          </div>
          <p style={{ margin: 0, color: "#71717a", fontSize: 13 }}>
            Open this link on the machine running Launchpad to connect it automatically. The code expires in 10 minutes.
          </p>
          <div className="pairing-code">{pairing.pairingCode}</div>
          <a className="pair-link-btn" href={pairing.pairLink} target="_blank" rel="noreferrer">
            Open on local machine →
          </a>
          <details>
            <summary style={{ fontSize: 13, color: "#71717a", cursor: "pointer" }}>Manual setup (env vars)</summary>
            <pre style={{ marginTop: 8 }}>{pairing.env}</pre>
          </details>
        </Card>
      )}

      <Card className="panel billing-panel">
        <div className="panel-title"><CreditCard size={18} /> Billing</div>
        <strong>{statusLabel}</strong>
        <p>{paid ? "Relay access is enabled. Nodes can connect." : "Activate billing so local Launchpad nodes can connect."}</p>
        <div><Button onClick={checkout}>{paid ? "Manage billing" : "Start relay plan"}</Button></div>
      </Card>

      <div className="instances-section">
        <div className="instances-header">
          <div className="panel-title"><Server size={18} /> Instances</div>
          {!adding && (
            <Button variant="outline" size="sm" onClick={startAdding}>
              <Plus size={14} />Add instance
            </Button>
          )}
        </div>

        {adding && (
          <Card className="add-form">
            <strong>New instance</strong>
            <p style={{ margin: 0, color: "#71717a", fontSize: 13 }}>
              Name this Launchpad (e.g. "home pi", "work server"). Its URL will be <code>/i/{current.slug}-name</code>
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="home-pi"
                onKeyDown={e => e.key === "Enter" && createInstance()}
                autoFocus
              />
              <Button onClick={createInstance} disabled={addLoading || !newName.trim()}>
                {addLoading ? <Loader2 size={14} className="spin" /> : null}
                Create
              </Button>
              <Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
            {addError && <p className="error">{addError}</p>}
          </Card>
        )}

        {instances.length === 0 && !adding && (
          <Card className="panel">
            <p style={{ margin: 0, color: "#71717a" }}>No instances yet. Add one to connect a local Launchpad.</p>
          </Card>
        )}

        <div className="instances-list">
          {instances.map(inst => (
            <InstanceCard key={inst.id} instance={inst} onDelete={deleteInstance} />
          ))}
        </div>
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
