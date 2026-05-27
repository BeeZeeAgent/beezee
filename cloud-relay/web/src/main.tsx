import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, Copy, CreditCard, Key, Link, Loader2, LogOut, Pencil, Plus, Server, Settings, Shield, Trash2, Users, X } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Combobox, MultiCombobox, type ComboboxOption } from "./components/ui/combobox";
import { Input } from "./components/ui/input";
import "./style.css";

type Account = {
  id: string;
  email: string;
  slug: string;
  memberships: { tenantId: string; tenantName: string; tenantSlug: string; role: Role }[];
  billing: { status: string; plan: string; relayEnabled: boolean; currentPeriodEnd?: string | null };
};

type Role = "owner" | "admin" | "member";

type Tenant = {
  id: string;
  name: string;
  slug: string;
  role: Role;
  billing: {
    status: string;
    plan: string;
    relayEnabled: boolean;
    currentPeriodEnd?: string | null;
    extraSeats: number;
    maxUsers: number;
    maxNodes: number;
  };
};

type Member = {
  accountId: string;
  email: string;
  role: Role;
  nodeAccess: "all" | string[];
};

type Invite = {
  token: string;
  role: Role;
  nodeAccess: "all" | string[];
  link: string;
  expiresAt: number;
};

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

type UsageSnapshot = {
  updatedAt: string;
  claude: {
    totalSessions: number;
    totalMessages: number;
    modelUsage: Record<string, ModelUsage>;
  } | null;
  codex: {
    modelUsage: Record<string, { promptTokens: number; completionTokens: number; requests: number }>;
  } | null;
} | null;

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
  usageSnapshot?: UsageSnapshot;
};

function fmtTok(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return n.toLocaleString();
}

const tokenKey = "launchpadRelayToken";
const tenantKey = "launchpadRelayTenant";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(tokenKey);
  const tenantId = localStorage.getItem(tenantKey);
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { "X-Tenant-Id": tenantId } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function AvatarDropdown({ email, onLogout, onOpenSettings }: { email: string; onLogout: () => void; onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const initials = email.split("@")[0].slice(0, 2).toUpperCase();

  return (
    <div className="avatar-menu" ref={ref}>
      <button className="avatar-btn" onClick={() => setOpen(o => !o)} title={email} aria-label="Account menu">
        {initials}
      </button>
      {open && (
        <div className="avatar-dropdown">
          <div className="avatar-dropdown-email">{email}</div>
          <button className="avatar-dropdown-item" onClick={() => { setOpen(false); onOpenSettings(); }}>
            <Settings size={14} />
            Account settings
          </button>
          <div className="avatar-dropdown-divider" />
          <button className="avatar-dropdown-item" onClick={() => { setOpen(false); onLogout(); }}>
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function AuthView({ onAuthed }: { onAuthed: (account: Account) => void }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    setError("");
    try {
      const body = { email, password };
      const data = await api<{ token: string; account: Account }>(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      localStorage.setItem(tokenKey, data.token);
      const next = new URLSearchParams(window.location.search).get("next");
      if (next?.startsWith("/i/") || next?.startsWith("/r/")) {
        window.location.href = next;
        return;
      }
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
        <img src="/beezee-logo.svg" alt="BeeZee" style={{ height: 52, width: 52, marginBottom: 18 }} />
        <h1>BeeZee</h1>
        <p>Connect one or more local BeeZee instances and access them from anywhere through permanent app URLs.</p>
      </section>
      <Card className="auth-card">
        <div className="segmented">
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create</button>
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button>
        </div>
        <label>Email<Input value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
        <label>Password<Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
        {error && <p className="error">{error}</p>}
        <Button onClick={submit} disabled={loading || !email || !password}>
          {loading ? <Loader2 className="spin" size={16} /> : null}
          {mode === "register" ? "Create account" : "Sign in"}
        </Button>
      </Card>
    </div>
  );
}

function InstanceCard({ instance, onDelete, onRename }: {
  instance: Instance;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(instance.name);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState("");

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

  const startEdit = () => { setEditName(instance.name); setRenameError(""); setEditing(true); };

  const saveEdit = async () => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === instance.name) { setEditing(false); return; }
    setRenaming(true);
    setRenameError("");
    try {
      await onRename(instance.id, trimmed);
      setEditing(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setRenaming(false);
    }
  };

  return (
    <div className="instance-card">
      <div className="instance-header">
        <div className="instance-name" style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(false); }}
                style={{ height: 28, padding: "0 8px", fontSize: 14, maxWidth: 180 }}
                autoFocus
              />
              <Button size="sm" onClick={saveEdit} disabled={renaming || !editName.trim()} style={{ height: 28, padding: "0 10px" }}>
                {renaming ? <Loader2 size={12} className="spin" /> : <Check size={12} />}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(false)} style={{ height: 28, padding: "0 8px" }}>
                <X size={12} />
              </Button>
            </div>
          ) : (
            <>
              <strong>{instance.name}</strong>
              <button className="edit-name-btn" onClick={startEdit} title="Rename">
                <Pencil size={12} />
              </button>
              <span className={`badge ${instance.online ? "online" : "offline"}`}>
                {instance.online ? "Online" : "Offline"}
              </span>
            </>
          )}
        </div>
        {!editing && (
          <button className="delete-btn" onClick={del} disabled={deleting} title="Delete instance">
            {deleting ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
          </button>
        )}
      </div>
      {renameError && <p className="error">{renameError}</p>}
      <a href={instance.relayUrl} target="_blank" rel="noreferrer" className="relay-url">{instance.relayUrl}</a>
      <div className="env-block">
        <pre>{instance.env}</pre>
        <button className="env-copy-btn" onClick={copy} title={copied ? "Copied" : "Copy env vars"}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      </div>
      {(instance.usageSnapshot?.claude || instance.usageSnapshot?.codex) && (
        <div className="usage-snapshot">
          {instance.usageSnapshot?.claude && Object.entries(instance.usageSnapshot.claude.modelUsage).map(([model, u]) => (
            <div key={model} className="usage-model-row">
              <span className="usage-model-name">{model.replace(/^claude-/, "").replace(/-\d{8}$/, "")}</span>
              <span className="usage-stat"><strong>{fmtTok(u.outputTokens)}</strong> out</span>
              <span className="usage-stat"><strong>{fmtTok(u.cacheReadInputTokens)}</strong> cache</span>
            </div>
          ))}
          {instance.usageSnapshot?.codex && Object.entries(instance.usageSnapshot.codex.modelUsage).map(([model, u]) => (
            <div key={model} className="usage-model-row">
              <span className="usage-model-name">{model}</span>
              <span className="usage-stat"><strong>{fmtTok(u.promptTokens)}</strong> in</span>
              <span className="usage-stat"><strong>{fmtTok(u.completionTokens)}</strong> out</span>
            </div>
          ))}
          {instance.usageSnapshot?.claude && (
            <div className="usage-footer">
              {instance.usageSnapshot.claude.totalSessions} sessions · {instance.usageSnapshot.claude.totalMessages.toLocaleString()} messages
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SeatControls({ tenant, onUpdate }: { tenant: Tenant; onUpdate: (t: Tenant) => void }) {
  const [seatError, setSeatError] = useState("");
  const [loading, setLoading] = useState<"inc" | "dec" | null>(null);
  const seats = tenant.billing.extraSeats;

  const update = async (next: number) => {
    setSeatError("");
    setLoading(next > seats ? "inc" : "dec");
    try {
      const data = await api<{ tenant: Tenant }>("/api/billing/seats", {
        method: "POST",
        body: JSON.stringify({ seats: next }),
      });
      onUpdate(data.tenant);
    } catch (err) {
      setSeatError(err instanceof Error ? err.message : "Failed to update seats");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="seat-controls">
      <div className="seat-row">
        <div>
          <div className="seat-label">Extra seats</div>
          <div className="seat-caption">+1 user &amp; +1 node per seat · $2/seat/month</div>
        </div>
        <div className="seat-stepper">
          <button onClick={() => update(seats - 1)} disabled={seats <= 0 || loading !== null}>
            {loading === "dec" ? <Loader2 size={12} className="spin" /> : "−"}
          </button>
          <span className="seat-count">{seats}</span>
          <button onClick={() => update(seats + 1)} disabled={loading !== null}>
            {loading === "inc" ? <Loader2 size={12} className="spin" /> : "+"}
          </button>
        </div>
      </div>
      <div className="seat-limits">{tenant.billing.maxUsers} users · {tenant.billing.maxNodes} nodes total</div>
      {seatError && <p className="error">{seatError}</p>}
    </div>
  );
}

const PLANS = [
  {
    id: "solo" as const,
    name: "Solo",
    price: "$4",
    description: "For individual developers",
    features: ["1 user", "3 nodes", "Usage observability", "Session sync", "Remote access"],
  },
  {
    id: "team" as const,
    name: "Team",
    price: "$12",
    description: "For small teams",
    features: ["Up to 5 users", "15 nodes", "Usage observability", "Session sync", "Remote access", "Role-based access control"],
    highlighted: true,
  },
];

function PricingCards({ onSelectPlan, loading }: { onSelectPlan: (plan: "solo" | "team") => void; loading: "solo" | "team" | null }) {
  return (
    <div className="pricing-cards">
      {PLANS.map(plan => (
        <div key={plan.id} className={`pricing-card${plan.highlighted ? " pricing-card--highlighted" : ""}`}>
          <div className="pricing-card-header">
            <div className="pricing-card-name">{plan.name}</div>
            <div className="pricing-card-price">
              <span className="pricing-price">{plan.price}</span>
              <span className="pricing-period">/ month</span>
            </div>
            <div className="pricing-card-desc">{plan.description}</div>
          </div>
          <ul className="pricing-features">
            {plan.features.map(f => (
              <li key={f}><Check size={13} className="pricing-check" />{f}</li>
            ))}
          </ul>
          <Button
            className="pricing-cta"
            variant={plan.highlighted ? "default" : "outline"}
            onClick={() => onSelectPlan(plan.id)}
            disabled={loading !== null}
          >
            {loading === plan.id ? <Loader2 size={14} className="spin" /> : null}
            Start {plan.name} — 14-day free trial
          </Button>
        </div>
      ))}
    </div>
  );
}

function AccountSettingsModal({ account, tenant, onUpdateTenant, onClose, onLogout }: {
  account: Account;
  tenant: Tenant;
  onUpdateTenant: (t: Tenant) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [checkoutLoading, setCheckoutLoading] = useState<"solo" | "team" | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [billingError, setBillingError] = useState("");
  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [pwdLoading, setPwdLoading] = useState(false);
  const [pwdError, setPwdError] = useState("");
  const [pwdSuccess, setPwdSuccess] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const paid = tenant.billing.relayEnabled;
  const statusLabel = paid ? `${tenant.billing.status} · ${tenant.billing.plan}` : "inactive";

  const checkout = async (plan: "solo" | "team") => {
    setBillingError("");
    setCheckoutLoading(plan);
    try {
      const data = await api<{ url?: string; mock?: boolean }>("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan }) });
      if (data.url) { window.location.href = data.url; return; }
      if (data.mock) {
        const updated = await api<{ tenant: Tenant }>("/api/billing/mock", { method: "POST", body: JSON.stringify({ active: true, plan }) });
        onUpdateTenant(updated.tenant);
      }
    } catch (err) {
      setBillingError(err instanceof Error ? err.message : "Checkout failed");
    } finally {
      setCheckoutLoading(null);
    }
  };

  const openPortal = async () => {
    setBillingError("");
    setPortalLoading(true);
    try {
      const data = await api<{ url: string }>("/api/billing/portal", { method: "POST", body: JSON.stringify({}) });
      window.location.href = data.url;
    } catch (err) {
      setBillingError(err instanceof Error ? err.message : "Could not open billing portal");
    } finally {
      setPortalLoading(false);
    }
  };

  const changePassword = async () => {
    if (newPwd !== confirmPwd) { setPwdError("Passwords don't match"); return; }
    setPwdError("");
    setPwdSuccess(false);
    setPwdLoading(true);
    try {
      await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: currentPwd, newPassword: newPwd }) });
      setPwdSuccess(true);
      setCurrentPwd("");
      setNewPwd("");
      setConfirmPwd("");
    } catch (err) {
      setPwdError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPwdLoading(false);
    }
  };

  const deleteAccount = async () => {
    setDeleteError("");
    setDeleteLoading(true);
    try {
      await api("/api/account", { method: "DELETE", body: JSON.stringify({ password: deleteConfirm }) });
      onLogout();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete account");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id="settings-title">Account settings</h2>
          <button className="delete-btn" onClick={onClose} title="Close"><X size={14} /></button>
        </div>

        <div className="settings-section">
          <div className="panel-title"><CreditCard size={16} /> Billing</div>
          {billingError && <p className="error">{billingError}</p>}
          {paid ? (
            <>
              <strong>{statusLabel}</strong>
              <p style={{ margin: "6px 0 0", color: "#71717a", fontSize: 13 }}>Relay access is enabled. Nodes can connect.</p>
              {tenant.role === "owner" && (
                <div style={{ marginTop: 8 }}>
                  <SeatControls tenant={tenant} onUpdate={onUpdateTenant} />
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                <Button variant="outline" onClick={openPortal} disabled={portalLoading}>
                  {portalLoading ? <Loader2 size={14} className="spin" /> : null}
                  Manage billing
                </Button>
              </div>
            </>
          ) : (
            <>
              <p style={{ marginBottom: 16, color: "#71717a", fontSize: 13 }}>Start your 14-day free trial. No charge until the trial ends.</p>
              <PricingCards onSelectPlan={checkout} loading={checkoutLoading} />
            </>
          )}
        </div>

        <div className="settings-divider" />

        <div className="settings-section">
          <div className="panel-title"><Key size={16} /> Change password</div>
          {pwdSuccess && <p style={{ color: "#15803d", fontSize: 13, margin: 0 }}>Password updated successfully.</p>}
          {pwdError && <p className="error">{pwdError}</p>}
          <label className="settings-label">Current password<Input type="password" value={currentPwd} onChange={e => setCurrentPwd(e.target.value)} autoComplete="current-password" /></label>
          <label className="settings-label">New password<Input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} autoComplete="new-password" /></label>
          <label className="settings-label">Confirm new password<Input type="password" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} autoComplete="new-password" /></label>
          <Button onClick={changePassword} disabled={pwdLoading || !currentPwd || !newPwd || !confirmPwd}>
            {pwdLoading ? <Loader2 size={14} className="spin" /> : null}
            Save password
          </Button>
        </div>

        <div className="settings-divider" />

        <div className="settings-section">
          <div className="panel-title" style={{ color: "#dc2626" }}><Trash2 size={16} /> Delete account</div>
          <p style={{ fontSize: 13, color: "#71717a", margin: 0 }}>Permanently deletes your account and all associated data. This cannot be undone.</p>
          {!showDelete ? (
            <Button variant="outline" style={{ borderColor: "#dc2626", color: "#dc2626", width: "fit-content" }} onClick={() => setShowDelete(true)}>
              Delete account
            </Button>
          ) : (
            <>
              <label className="settings-label">Confirm with your password<Input type="password" value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} placeholder="Enter password to confirm" /></label>
              {deleteError && <p className="error">{deleteError}</p>}
              <div style={{ display: "flex", gap: 8 }}>
                <Button variant="outline" onClick={() => { setShowDelete(false); setDeleteConfirm(""); setDeleteError(""); }}>Cancel</Button>
                <Button style={{ background: "#dc2626", color: "#fff" }} onClick={deleteAccount} disabled={deleteLoading || !deleteConfirm}>
                  {deleteLoading ? <Loader2 size={14} className="spin" /> : null}
                  Confirm delete
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateTenantView({ account, onCreated, onLogout }: { account: Account; onCreated: (tenant: Tenant) => void; onLogout: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inviteToken = new URLSearchParams(window.location.search).get("invite");

  const acceptInvite = async () => {
    if (!inviteToken) return;
    setLoading(true);
    setError("");
    try {
      const data = await api<{ tenant: Tenant }>(`/api/invites/${inviteToken}/accept`, { method: "POST", body: JSON.stringify({}) });
      localStorage.setItem(tenantKey, data.tenant.id);
      window.history.replaceState({}, "", "/");
      onCreated(data.tenant);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept invite");
    } finally {
      setLoading(false);
    }
  };

  const createTenant = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ tenant: Tenant }>("/api/tenants", { method: "POST", body: JSON.stringify({ name, slug }) });
      localStorage.setItem(tenantKey, data.tenant.id);
      onCreated(data.tenant);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create tenant");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell narrow">
      <header>
        <div>
          <h1>BeeZee</h1>
        </div>
        <AvatarDropdown email={account.email} onLogout={onLogout} onOpenSettings={() => {}} />
      </header>
      {inviteToken ? (
        <div className="tenant-form">
          <div className="panel-title"><Link size={18} /> Tenant invite</div>
          <p>Accept the invite link to join this tenant.</p>
          {error && <p className="error">{error}</p>}
          <Button onClick={acceptInvite} disabled={loading}>{loading ? <Loader2 className="spin" size={16} /> : null}Join tenant</Button>
        </div>
      ) : (
        <>
          <div className="tenant-form">
            <div className="panel-title"><Shield size={18} /> New tenant</div>
            <label>Name<Input value={name} onChange={e => setName(e.target.value)} placeholder="Acme Ops" /></label>
            <label>Slug<Input value={slug} onChange={e => setSlug(e.target.value)} placeholder="acme" /></label>
            {error && <p className="error">{error}</p>}
            <Button onClick={createTenant} disabled={loading || !name || !slug}>{loading ? <Loader2 className="spin" size={16} /> : null}Create tenant</Button>
          </div>
          <div className="onboarding-plans">
            <p className="onboarding-plans-label">Includes a <strong>14-day free trial</strong> — choose a plan after setup</p>
            <div className="pricing-cards pricing-cards--preview">
              {PLANS.map(plan => (
                <div key={plan.id} className={`pricing-card${plan.highlighted ? " pricing-card--highlighted" : ""}`}>
                  <div className="pricing-card-header">
                    <div className="pricing-card-name">{plan.name}</div>
                    <div className="pricing-card-price">
                      <span className="pricing-price">{plan.price}</span>
                      <span className="pricing-period">/ month</span>
                    </div>
                  </div>
                  <ul className="pricing-features">
                    {plan.features.map(f => (
                      <li key={f}><Check size={13} className="pricing-check" />{f}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function NodeAccessCombobox({ instances, value, onChange, disabled }: {
  instances: Instance[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  if (!instances.length) return null;
  const options = instances.map(inst => ({ value: inst.id, label: inst.name }));
  return (
    <MultiCombobox
      className="node-combobox"
      options={options}
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder="Select nodes"
    />
  );
}

const roleOptions: ComboboxOption[] = [
  { value: "owner", label: "Owner", disabled: true },
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];

function RoleBadge({ role }: { role: Role }) {
  const label = role.charAt(0).toUpperCase() + role.slice(1);
  return <Badge className={`role-badge role-badge--${role}`}>{label}</Badge>;
}

function MembersPanel({ tenant, instances }: { tenant: Tenant; instances: Instance[] }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [role, setRole] = useState<Role>("member");
  const [nodeAccess, setNodeAccess] = useState<string[]>([]);
  const [error, setError] = useState("");

  const canManage = tenant.role === "owner" || tenant.role === "admin";
  const isOwner = tenant.role === "owner";

  const refresh = async () => {
    if (!canManage) return;
    const data = await api<{ members: Member[]; invites: Invite[] }>("/api/members");
    setMembers(data.members);
  };

  useEffect(() => { refresh().catch(err => setError(err.message)); }, [tenant.id, instances.length]);
  if (!canManage) return null;

  const createInvite = async () => {
    setError("");
    setInviteLoading(true);
    try {
      const access = role === "admin" ? "all" : nodeAccess;
      const data = await api<{ invite: Invite }>("/api/invites", { method: "POST", body: JSON.stringify({ role, nodeAccess: access }) });
      await navigator.clipboard.writeText(data.invite.link);
      setInviteOpen(false);
      setRole("member");
      setNodeAccess([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite");
    } finally {
      setInviteLoading(false);
    }
  };

  return (
    <div className="members-section">
      <div className="instances-header">
        <div className="panel-title"><Users size={18} /> Members</div>
        <Button
          size="sm"
          onClick={() => { setError(""); setInviteOpen(true); }}
          style={{ background: "#FFE566", color: "#000", border: "none" }}
        >
          <Plus size={14} />Create invite
        </Button>
      </div>
      {inviteOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setInviteOpen(false)}>
          <div className="invite-modal" role="dialog" aria-modal="true" aria-labelledby="invite-title" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 id="invite-title">Create invite</h2>
              <button className="delete-btn" onClick={() => setInviteOpen(false)} title="Close"><X size={14} /></button>
            </div>
            <div className="modal-fields">
              <label>
                Role
                <Combobox
                  className="role-combobox"
                  options={roleOptions.map(option => ({ ...option, disabled: option.value === "owner" || (!isOwner && option.value === "admin") }))}
                  value={role}
                  onChange={value => setRole(value as Role)}
                  disabled={!isOwner}
                  placeholder="Role"
                />
              </label>
              {role === "member" && (
                <label>
                  Nodes
                  <NodeAccessCombobox instances={instances} value={nodeAccess} onChange={setNodeAccess} />
                </label>
              )}
            </div>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button onClick={createInvite} disabled={inviteLoading}>
                {inviteLoading ? <Loader2 size={14} className="spin" /> : null}
                Create invite
              </Button>
            </div>
          </div>
        </div>
      )}
      {!inviteOpen && error && <p className="error">{error}</p>}
      <div className="members-table-wrap">
        <table className="members-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {members.map(member => (
              <tr key={member.accountId}>
                <td>{member.email}</td>
                <td><RoleBadge role={member.role} /></td>
              </tr>
            ))}
            {!members.length && (
              <tr>
                <td colSpan={2} className="empty-table">No members yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AppView({ account, tenant, onLogout }: { account: Account; tenant: Tenant; onLogout: () => void }) {
  const [current, setCurrent] = useState(account);
  const [currentTenant, setCurrentTenant] = useState(tenant);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [pairing, setPairing] = useState<Instance | null>(null);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refresh = async () => {
    const [me, tenantData, instData] = await Promise.all([
      api<{ account: Account }>("/api/me"),
      api<{ tenants: Tenant[] }>("/api/tenants"),
      api<{ instances: Instance[] }>("/api/instances"),
    ]);
    setCurrent(me.account);
    setCurrentTenant(tenantData.tenants.find(t => t.id === currentTenant.id) || tenantData.tenants[0] || currentTenant);
    setInstances(instData.instances);
  };

  useEffect(() => {
    refresh().catch(err => setError(err.message));
    const timer = window.setInterval(() => refresh().catch(() => {}), 5000);
    return () => window.clearInterval(timer);
  }, []);

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
    if (pairing?.id === id) setPairing(null);
  };

  const renameInstance = async (id: string, name: string) => {
    const data = await api<{ instance: Instance }>(`/api/instances/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    setInstances(prev => prev.map(i => i.id === id ? { ...i, ...data.instance } : i));
    if (pairing?.id === id) setPairing(prev => prev ? { ...prev, ...data.instance } : null);
  };

  return (
    <div className="app-shell">
      <header>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img src="/beezee-logo.svg" alt="BeeZee" style={{ height: 32, width: 32, flexShrink: 0 }} />
          <h1>BeeZee</h1>
        </div>
        <AvatarDropdown email={current.email} onLogout={onLogout} onOpenSettings={() => setSettingsOpen(true)} />
      </header>

      {settingsOpen && (
        <AccountSettingsModal
          account={current}
          tenant={currentTenant}
          onUpdateTenant={setCurrentTenant}
          onClose={() => setSettingsOpen(false)}
          onLogout={onLogout}
        />
      )}

      {error && <p className="error">{error}</p>}

      {pairing && (
        <Card className="pairing-panel">
          <div className="pairing-header">
            <strong>Connect "{pairing.name}"</strong>
            <button className="delete-btn" onClick={() => setPairing(null)} title="Dismiss">✕</button>
          </div>
          <p style={{ margin: 0, color: "#71717a", fontSize: 13 }}>
            Open this link on the machine running BeeZee to connect it automatically. The code expires in 10 minutes.
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

      <div className="instances-section">
        <div className="instances-header">
          <div className="panel-title"><Server size={18} /> Instances</div>
          {!adding && (
            <Button size="sm" onClick={startAdding} style={{ background: "#FFE566", color: "#000", border: "none" }}>
              <Plus size={14} />Add instance
            </Button>
          )}
        </div>

        {adding && (
          <div className="add-form">
            <strong>New instance</strong>
            <p style={{ margin: 0, color: "#71717a", fontSize: 13 }}>Name this BeeZee. Its URL will use <code>/i/{currentTenant.slug}-name</code></p>
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
          </div>
        )}

        {instances.length === 0 && !adding && (
          <p style={{ margin: 0, color: "#71717a" }}>No instances yet. Add one to connect a local BeeZee.</p>
        )}

        <div className="instances-list">
          {instances
            .filter(inst => !pairing || inst.id !== pairing.id)
            .map(inst => (
              <InstanceCard key={inst.id} instance={inst} onDelete={deleteInstance} onRename={renameInstance} />
            ))}
        </div>
      </div>
      <hr className="section-divider" />
      <MembersPanel tenant={currentTenant} instances={instances} />
    </div>
  );
}

function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(!!localStorage.getItem(tokenKey));

  const logout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    } catch {}
    localStorage.removeItem(tokenKey);
    localStorage.removeItem(tenantKey);
    setAccount(null);
    setTenant(null);
  };

  const loadTenants = async () => {
    const data = await api<{ tenants: Tenant[] }>("/api/tenants");
    const saved = localStorage.getItem(tenantKey);
    const selected = data.tenants.find(t => t.id === saved) || data.tenants[0] || null;
    if (selected) localStorage.setItem(tenantKey, selected.id);
    setTenant(selected);
    return selected;
  };

  const onAuthed = async (nextAccount: Account) => {
    setAccount(nextAccount);
    const selected = await loadTenants();
    const inviteToken = new URLSearchParams(window.location.search).get("invite");
    if (inviteToken && selected) {
      try {
        const data = await api<{ tenant: Tenant }>(`/api/invites/${inviteToken}/accept`, { method: "POST", body: JSON.stringify({}) });
        localStorage.setItem(tenantKey, data.tenant.id);
        setTenant(data.tenant);
        window.history.replaceState({}, "", "/");
      } catch {}
    }
  };

  useEffect(() => {
    if (!localStorage.getItem(tokenKey)) return;
    api<{ account: Account }>("/api/me")
      .then(async data => {
        setAccount(data.account);
        await loadTenants();
      })
      .catch(logout)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading"><Loader2 className="spin" />Loading</div>;
  if (!account) return <AuthView onAuthed={onAuthed} />;
  if (!tenant) return <CreateTenantView account={account} onCreated={setTenant} onLogout={logout} />;
  return <AppView account={account} tenant={tenant} onLogout={logout} />;
}

createRoot(document.getElementById("root")!).render(<App />);
