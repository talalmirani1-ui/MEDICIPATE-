import crypto from 'node:crypto';
import { readOrder, writeOrder } from './rapid-store.mjs';

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function verifySignature(rawBody, timestamp, signature, secret) {
  if (!timestamp || !signature || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')
    .toUpperCase();
  return constantTimeEqual(expected, String(signature).toUpperCase());
}

function successEvent(event) {
  const type = String(event?.eventType || event?.type || '').toLowerCase();
  const status = String(event?.status || event?.data?.status || '').toUpperCase();
  return type === 'transaction.completed' || type === 'payment.succeeded' || status === 'SUCCESS' || status === 'SUCCEEDED' || status === 'PAID';
}

function failedEvent(event) {
  const type = String(event?.eventType || event?.type || '').toLowerCase();
  const status = String(event?.status || event?.data?.status || '').toUpperCase();
  return type === 'transaction.failed' || type === 'payment.failed' || ['FAILED','DECLINED','CANCELLED'].includes(status);
}

function refundedEvent(event) {
  const type = String(event?.eventType || event?.type || '').toLowerCase();
  const status = String(event?.status || event?.data?.status || '').toUpperCase();
  return type.startsWith('refund.') || type.startsWith('reversal.') || ['REFUNDED','REVERSED'].includes(status);
}

export default async function handler(req) {
  if (req.method !== 'POST') return textResponse('Method not allowed.', 405);
  if (!process.env.RG_WEBHOOK_SECRET) return textResponse('Webhook secret not configured.', 503);

  const rawBody = await req.text();
  const signature = req.headers.get('x-rapidgateway-signature') || req.headers.get('x-rapidpay-signature');
  const timestamp = req.headers.get('x-rapidgateway-timestamp') || req.headers.get('x-rapidpay-timestamp');

  if (!verifySignature(rawBody, timestamp, signature, process.env.RG_WEBHOOK_SECRET)) {
    return textResponse('Invalid signature.', 401);
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return textResponse('Invalid JSON.', 400); }

  // Rapid Gateway's current webhook guide uses merchantTransactionId and eventId.
  // We also accept the common nested/legacy aliases so sandbox transitions are smoother.
  const orderId = String(
    event?.merchantTransactionId ||
    event?.merchant_transaction_id ||
    event?.metadata?.merchant_order_id ||
    event?.data?.merchantTransactionId ||
    event?.data?.merchant_transaction_id ||
    event?.data?.metadata?.merchant_order_id ||
    ''
  ).trim();
  if (!orderId) return textResponse('Missing merchant order ID.', 400);

  const order = await readOrder(orderId);
  if (!order) return textResponse('Order not found.', 404);

  const eventId = String(event?.eventId || event?.deliveryId || event?.id || '').trim();
  if (eventId && order.lastEventId === eventId) return textResponse('OK');

  const gatewayAmount = Number(event?.amount ?? event?.data?.amount);
  if (successEvent(event)) {
    if (!Number.isFinite(gatewayAmount) || gatewayAmount !== Number(order.amount)) {
      console.error('Rapid Gateway amount mismatch', { orderId, gatewayAmount, expected: order.amount });
      return textResponse('Amount mismatch.', 400);
    }

    const now = Date.now();
    const unlockCode = order.unlockCode || crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, '').slice(0, 12).toUpperCase();
    const paid = {
      ...order,
      status: 'paid',
      active: true,
      paidAt: order.paidAt || new Date(now).toISOString(),
      expiresAt: order.expiresAt || now + Number(order.days) * 24 * 60 * 60 * 1000,
      unlockCode,
      gatewayTxnRef: event?.gatewayTxnRef || event?.data?.gatewayTxnRef || order.gatewayTxnRef || null,
      lastEventId: eventId || order.lastEventId || null,
      updatedAt: new Date().toISOString(),
    };
    await writeOrder(orderId, paid);
    return textResponse('OK');
  }

  if (failedEvent(event)) {
    await writeOrder(orderId, { ...order, status: 'failed', lastEventId: eventId || order.lastEventId || null, updatedAt: new Date().toISOString() });
    return textResponse('OK');
  }

  if (refundedEvent(event)) {
    await writeOrder(orderId, { ...order, status: String(event?.eventType || event?.type || '').toLowerCase().startsWith('refund.') ? 'refunded' : 'reversed', active: false, lastEventId: eventId || order.lastEventId || null, updatedAt: new Date().toISOString() });
    return textResponse('OK');
  }

  // Test/unknown events are acknowledged so Rapid Gateway does not retry them forever.
  await writeOrder(orderId, { ...order, lastEventId: eventId || order.lastEventId || null, updatedAt: new Date().toISOString() });
  return textResponse('OK');
}
