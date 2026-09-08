import crypto from 'node:crypto';
import { readOrder, writeOrder } from './rapid-store.mjs';

function response(text = 'OK', status = 200) {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8'
    }
  });
}

function constantTimeEqual(a, b) {
  if (!a || !b) return false;

  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));

  return (
    aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb)
  );
}

function verifySignature(rawBody, timestamp, signature, secret) {
  if (!timestamp || !signature || !secret) return false;

  const ts = Number(timestamp);

  // Rapid Gateway uses a 5-minute timestamp window.
  if (
    !Number.isFinite(ts) ||
    Math.abs(Math.floor(Date.now() / 1000) - ts) > 300
  ) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')
    .toUpperCase();

  return constantTimeEqual(
    expected,
    String(signature).toUpperCase()
  );
}

function getEventType(event) {
  return String(
    event?.eventType ||
    event?.event_type ||
    event?.type ||
    ''
  ).toLowerCase();
}

function getStatus(event) {
  return String(
    event?.status ||
    event?.data?.status ||
    ''
  ).toUpperCase();
}

function getOrderId(event) {
  return String(
    event?.merchantTransactionId ||
    event?.merchant_transaction_id ||
    event?.data?.merchantTransactionId ||
    event?.data?.merchant_transaction_id ||
    event?.metadata?.merchant_order_id ||
    event?.data?.metadata?.merchant_order_id ||
    ''
  ).trim();
}

function getEventId(event) {
  return String(
    event?.eventId ||
    event?.deliveryId ||
    event?.id ||
    ''
  ).trim();
}

function isSuccessful(event) {
  const type = getEventType(event);
  const status = getStatus(event);

  return (
    type === 'transaction.completed' ||
    type === 'payment.succeeded' ||
    status === 'SUCCESS' ||
    status === 'SUCCEEDED' ||
    status === 'PAID'
  );
}

function isFailed(event) {
  const type = getEventType(event);
  const status = getStatus(event);

  return (
    type === 'transaction.failed' ||
    type === 'payment.failed' ||
    ['FAILED', 'DECLINED', 'CANCELLED'].includes(status)
  );
}

function isRefundedOrReversed(event) {
  const type = getEventType(event);
  const status = getStatus(event);

  return (
    type.startsWith('refund.') ||
    type.startsWith('reversal.') ||
    ['REFUNDED', 'REVERSED'].includes(status)
  );
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return response('Method not allowed.', 405);
  }

  const rawBody = await req.text();

  let event;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return response('Invalid JSON.', 400);
  }

  const eventType = getEventType(event);

  /*
   * Rapid Gateway portal test event.
   *
   * This event does not represent a payment and must never
   * unlock premium access or modify an order.
   *
   * We acknowledge it immediately so the Rapid Gateway
   * dashboard can confirm that this endpoint is reachable.
   */
  if (eventType === 'webhook.test') {
    console.log('Rapid Gateway webhook.test received.');
    return response('OK', 200);
  }

  /*
   * REAL PAYMENT EVENTS
   *
   * These MUST have a configured webhook salt.
   */
  const webhookSecret = process.env.RG_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('RG_WEBHOOK_SECRET is not configured.');
    return response('Webhook secret not configured.', 503);
  }

  const signature =
    req.headers.get('x-rapidgateway-signature') ||
    req.headers.get('x-rapidpay-signature');

  const timestamp =
    req.headers.get('x-rapidgateway-timestamp') ||
    req.headers.get('x-rapidpay-timestamp');

  if (
    !verifySignature(
      rawBody,
      timestamp,
      signature,
      webhookSecret
    )
  ) {
    console.error('Rapid Gateway webhook signature verification failed.');
    return response('Invalid signature.', 401);
  }

  const orderId = getOrderId(event);

  if (!orderId) {
    console.error('Webhook missing merchant transaction ID.');
    return response('Missing merchant order ID.', 400);
  }

  const order = await readOrder(orderId);

  if (!order) {
    console.error('Order not found:', orderId);
    return response('Order not found.', 404);
  }

  const eventId = getEventId(event);

  /*
   * Idempotency:
   * Rapid Gateway may retry the same event.
   */
  if (eventId && order.lastEventId === eventId) {
    return response('OK', 200);
  }

  const gatewayAmount = Number(
    event?.amount ??
    event?.data?.amount
  );

  /*
   * SUCCESS
   */
  if (isSuccessful(event)) {
    if (
      !Number.isFinite(gatewayAmount) ||
      gatewayAmount !== Number(order.amount)
    ) {
      console.error('Rapid Gateway amount mismatch:', {
        orderId,
        gatewayAmount,
        expected: order.amount
      });

      return response('Amount mismatch.', 400);
    }

    const now = Date.now();

    const unlockCode =
      order.unlockCode ||
      crypto
        .randomBytes(9)
        .toString('base64url')
        .replace(/[-_]/g, '')
        .slice(0, 12)
        .toUpperCase();

    const paidOrder = {
      ...order,
      status: 'paid',
      active: true,

      paidAt:
        order.paidAt ||
        new Date(now).toISOString(),

      expiresAt:
        order.expiresAt ||
        now +
          Number(order.days) *
            24 *
            60 *
            60 *
            1000,

      unlockCode,

      gatewayTxnRef:
        event?.gatewayTxnRef ||
        event?.data?.gatewayTxnRef ||
        order.gatewayTxnRef ||
        null,

      lastEventId:
        eventId ||
        order.lastEventId ||
        null,

      updatedAt: new Date().toISOString()
    };

    await writeOrder(orderId, paidOrder);

    console.log(
      'Rapid Gateway payment marked paid:',
      orderId
    );

    return response('OK', 200);
  }

  /*
   * FAILED PAYMENT
   */
  if (isFailed(event)) {
    await writeOrder(orderId, {
      ...order,
      status: 'failed',
      lastEventId:
        eventId ||
        order.lastEventId ||
        null,
      updatedAt: new Date().toISOString()
    });

    return response('OK', 200);
  }

  /*
   * REFUND / REVERSAL
   */
  if (isRefundedOrReversed(event)) {
    const type = getEventType(event);

    await writeOrder(orderId, {
      ...order,
      status: type.startsWith('refund.')
        ? 'refunded'
        : 'reversed',
      active: false,
      lastEventId:
        eventId ||
        order.lastEventId ||
        null,
      updatedAt: new Date().toISOString()
    });

    return response('OK', 200);
  }

  /*
   * Unknown but valid signed event.
   * Acknowledge it so Rapid Gateway does not retry forever.
   */
  await writeOrder(orderId, {
    ...order,
    lastEventId:
      eventId ||
      order.lastEventId ||
      null,
    updatedAt: new Date().toISOString()
  });

  return response('OK', 200);
}
