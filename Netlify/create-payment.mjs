import crypto from 'node:crypto';
import { readOrder, writeOrder } from './rapid-store.mjs';

const PLANS = Object.freeze({
  monthly:    { label: 'Monthly', amount: 499,  currency: 'PKR', days: 30 },
  six_months: { label: '6 Months', amount: 2550, currency: 'PKR', days: 180 },
  yearly:     { label: 'Yearly', amount: 4800, currency: 'PKR', days: 365 },
});

const API_BASE = (process.env.RG_API_BASE_URL || 'https://api.rapidgateway.pk').replace(/\/$/, '');

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!process.env.RG_SECRET_KEY) {
    return json({ error: 'Rapid Gateway is not configured yet. Add RG_SECRET_KEY in Netlify environment variables.' }, 503);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON request.' }, 400); }

  const planId = String(body?.plan || '');
  const plan = PLANS[planId];
  if (!plan) return json({ error: 'Invalid premium plan selected.' }, 400);

  const email = body?.email ? String(body.email).trim().toLowerCase() : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }

  const orderId = `MED-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  const origin = new URL(req.url).origin;
  const returnUrl = `${origin}/?rg_return=1&orderId=${encodeURIComponent(orderId)}`;
  const webhookUrl = process.env.RG_WEBHOOK_URL || `${origin}/.netlify/functions/rapid-webhook`;

  const order = {
    orderId,
    planId,
    planLabel: plan.label,
    amount: plan.amount,
    currency: plan.currency,
    days: plan.days,
    email: email || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    returnUrl,
  };
  await writeOrder(orderId, order);

  const payload = {
    amount: plan.amount,
    currency: plan.currency,
    methods: ['card', 'raast', 'easypaisa', 'jazzcash', 'bank_transfer'],
    customer: email ? { email } : {},
    return_url: returnUrl,
    webhook_url: webhookUrl,
    metadata: {
      merchant_order_id: orderId,
      plan_id: planId,
      product: 'MEDICIPATE Premium',
    },
  };

  try {
    const gatewayRes = await fetch(`${API_BASE}/v1/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RG_SECRET_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Idempotency-Key': orderId,
      },
      body: JSON.stringify(payload),
    });

    const gatewayData = await gatewayRes.json().catch(() => ({}));
    if (!gatewayRes.ok || !gatewayData.checkout_url) {
      await writeOrder(orderId, {
        ...order,
        status: 'gateway_error',
        gatewayResponse: gatewayData,
        updatedAt: new Date().toISOString(),
      });
      return json({ error: gatewayData?.message || gatewayData?.error || 'Rapid Gateway could not create the checkout.' }, 502);
    }

    await writeOrder(orderId, {
      ...order,
      gatewayPaymentId: gatewayData.id || gatewayData.payment_id || gatewayData.paymentId || null,
      checkoutUrl: gatewayData.checkout_url,
      gatewayStatus: gatewayData.status || null,
      updatedAt: new Date().toISOString(),
    });

    return json({
      orderId,
      planId,
      planLabel: plan.label,
      amount: plan.amount,
      currency: plan.currency,
      checkout_url: gatewayData.checkout_url,
    });
  } catch (error) {
    await writeOrder(orderId, { ...order, status: 'gateway_error', updatedAt: new Date().toISOString() });
    console.error('Rapid Gateway create-payment error:', error);
    return json({ error: 'Unable to reach Rapid Gateway. Please try again.' }, 502);
  }
}
