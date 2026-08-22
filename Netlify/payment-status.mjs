import { readOrder, writeOrder } from './rapid-store.mjs';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default async function handler(req) {
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  const url = new URL(req.url);
  const orderId = (url.searchParams.get('orderId') || '').trim();
  if (!orderId || !/^[A-Z0-9-]{10,80}$/i.test(orderId)) return json({ error: 'Invalid order ID.' }, 400);

  const order = await readOrder(orderId);
  if (!order) return json({ error: 'Order not found.' }, 404);

  if (order.status === 'paid' && order.expiresAt && Date.now() >= Number(order.expiresAt)) {
    const expired = { ...order, status: 'expired', active: false, updatedAt: new Date().toISOString() };
    await writeOrder(orderId, expired);
    return json({
      orderId,
      status: 'expired',
      plan: expired.planId,
      planLabel: expired.planLabel,
      amount: expired.amount,
      currency: expired.currency,
      expiresAt: expired.expiresAt,
    });
  }

  return json({
    orderId,
    status: order.status,
    plan: order.planId,
    planLabel: order.planLabel,
    amount: order.amount,
    currency: order.currency,
    paidAt: order.paidAt || null,
    expiresAt: order.expiresAt || null,
    unlockCode: order.status === 'paid' ? (order.unlockCode || null) : null,
  });
}
