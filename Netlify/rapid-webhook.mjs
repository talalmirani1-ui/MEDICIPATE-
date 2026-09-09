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

// --------------------------------------------------------------
// Supabase: flip profiles.is_pro = true on confirmed payment.
//
// Uses the SERVICE ROLE key (server-side only, never exposed to
// the client) because this write needs to bypass row-level
// security — the webhook isn't an authenticated end user.
//
// This is the piece that makes the referral commission trigger
// (see referral_program.sql) actually fire for Rapid Gateway
// payments: the trigger listens for is_pro flipping to true.
// --------------------------------------------------------------
async function markProInSupabase(order) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — cannot mark profile pro or attribute referral.'
    );
    return { ok: false, error: 'Supabase service role not configured.' };
  }

  if (!order?.userId) {
    console.error('Order has no userId — cannot update Supabase profile.', order?.orderId);
    return { ok: false, error: 'Order missing userId.' };
  }

  const patch = {
    is_pro: true,
    plan_id: order.planId || null
  };

  // Only set referred_by_code if this order actually carried a
  // referral code AND the profile doesn't already have one set
  // (first referral wins — avoids overwriting an earlier valid
  // attribution on a renewal/second purchase).
  if (order.referralCode) {
    patch.referred_by_code = order.referralCode;
  }

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(order.userId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(patch)
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Supabase profile update failed:', res.status, text);
      return { ok: false, error: text || ('HTTP ' + res.status) };
    }

    return { ok: true };
  } catch (err) {
    console.error('Supabase profile update threw:', err);
    return { ok: false, error: String(err) };
  }
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

    // --------------------------------------------------
    // Flip profiles.is_pro = true in Supabase.
    //
    // This is what actually unlocks Premium in the app (the
    // dashboard reads is_pro from Supabase, not from this blob
    // store) AND is what fires the referral commission trigger,
    // since that trigger watches for is_pro flipping to true.
    //
    // We log failures but still return 200 to Rapid Gateway —
    // the payment itself succeeded and is recorded above; a
    // Supabase hiccup here shouldn't make Rapid Gateway retry
    // the whole payment event indefinitely. If this fails, the
    // order is marked 'paid' but 'supabaseSyncPending' so it can
    // be reconciled manually.
    // --------------------------------------------------
    const supabaseResult = await markProInSupabase(paidOrder);

    if (!supabaseResult.ok) {
      console.error(
        'Payment marked paid but Supabase sync failed — needs manual reconciliation:',
        orderId,
        supabaseResult.error
      );

      await writeOrder(orderId, {
        ...paidOrder,
        supabaseSyncPending: true,
        supabaseSyncError: supabaseResult.error,
        updatedAt: new Date().toISOString()
      });
    } else {
      console.log(
        'Rapid Gateway payment marked paid and Supabase profile updated:',
        orderId,
        order.referralCode ? `(referral: ${order.referralCode})` : ''
      );
    }

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
