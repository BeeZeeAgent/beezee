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

export async function createStripeCheckout({ account, publicUrl, priceId, secretKey, trialDays = 14, plan = "solo" }) {
  const params = new URLSearchParams({
    mode: "subscription",
    "payment_method_types[]": "card",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    customer_email: account.email,
    success_url: `${publicUrl}/app?checkout=success`,
    cancel_url: `${publicUrl}/app?checkout=cancel`,
    "metadata[tenant_id]": account.id,
    "metadata[slug]": account.slug,
    "metadata[plan]": plan,
    "subscription_data[metadata][tenant_id]": account.id,
    "subscription_data[metadata][slug]": account.slug,
    "subscription_data[metadata][plan]": plan,
  });
  if (trialDays > 0) {
    params.set("subscription_data[trial_period_days]", String(trialDays));
  }

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

export async function createStripePortal({ customerId, returnUrl, secretKey }) {
  const params = new URLSearchParams({
    customer: customerId,
    return_url: returnUrl,
  });
  const response = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Stripe portal failed");
  return data;
}

export async function updateSubscriptionSeats({ subscriptionId, seatPriceId, seats, secretKey }) {
  const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const sub = await subRes.json();
  if (!subRes.ok) throw new Error(sub?.error?.message || "Failed to fetch subscription");

  const seatItem = (sub.items?.data || []).find(item => item.price.id === seatPriceId);
  let params;

  if (seats === 0) {
    if (!seatItem) return sub;
    params = new URLSearchParams({
      "subscription_items[0][id]": seatItem.id,
      "subscription_items[0][deleted]": "true",
    });
  } else if (seatItem) {
    params = new URLSearchParams({
      "subscription_items[0][id]": seatItem.id,
      "subscription_items[0][quantity]": String(seats),
    });
  } else {
    params = new URLSearchParams({
      "subscription_items[0][price]": seatPriceId,
      "subscription_items[0][quantity]": String(seats),
    });
  }

  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Failed to update seats");
  return data;
}

export function updateBilling(accountId, status = "active", stripeCustomerId = null, stripeSubscriptionId = null, extraSeats = null, plan = null) {
  const active = status === "active" || status === "trialing";
  return mutateStore(store => {
    const row = (store.tenants || []).find(t => t.id === accountId)
      || (store.tenants || []).find(t => t.ownerAccountId === accountId)
      || store.accounts.find(a => a.id === accountId);
    if (!row) return null;
    row.billing = {
      ...row.billing,
      provider: "stripe",
      status,
      plan: plan || row.billing?.plan || "relay",
      relayEnabled: active,
      currentPeriodEnd: active ? new Date(Date.now() + 30 * 86400_000).toISOString() : null,
      ...(stripeCustomerId ? { stripeCustomerId } : {}),
      ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
      ...(extraSeats !== null ? { extraSeats } : {}),
    };
    return row;
  });
}
