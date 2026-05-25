import crypto from "crypto";
import { mutateStore } from "./store.js";

export function verifyStripeSignature(payload, header, secret) {
  if (!secret) return true;
  const parts = Object.fromEntries(String(header || "").split(",").flatMap(part => {
    const idx = part.indexOf("=");
    return idx > -1 ? [[part.slice(0, idx), part.slice(idx + 1)]] : [];
  }));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function createStripeCheckout({ account, publicUrl, priceId, secretKey }) {
  const params = new URLSearchParams({
    mode: "subscription",
    "payment_method_types[]": "card",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    customer_email: account.email,
    success_url: `${publicUrl}/app?checkout=success`,
    cancel_url: `${publicUrl}/app?checkout=cancel`,
    "metadata[account_id]": account.id,
    "metadata[slug]": account.slug,
    "subscription_data[metadata][account_id]": account.id,
    "subscription_data[metadata][slug]": account.slug,
  });

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Stripe checkout failed");
  return data;
}

export function updateBilling(accountId, status = "active") {
  const active = status === "active" || status === "trialing";
  return mutateStore(store => {
    const account = store.accounts.find(a => a.id === accountId);
    if (!account) return null;
    account.billing = {
      provider: "stripe",
      status,
      plan: "relay",
      relayEnabled: active,
      currentPeriodEnd: active ? new Date(Date.now() + 30 * 86400_000).toISOString() : null,
    };
    return account;
  });
}
