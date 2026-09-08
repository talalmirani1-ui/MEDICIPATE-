// MEDICIPATE — Rapid Gateway Payment Function

import crypto from 'crypto';
import { writeOrder } from './rapid-store.mjs';

const PRICING = {
  monthly: {
    amount: 499,
    label: 'Monthly',
    days: 30
  },
  sixMonths: {
    amount: 2550,
    label: '6 Months',
    days: 180
  },
  yearly: {
    amount: 4800,
    label: 'Yearly',
    days: 365
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return json({ error: 'Method not allowed.' }, 405);
    }

    // --------------------------------------------------
    // 1. Read request
    // --------------------------------------------------

    const body = await req.json().catch(() => null);

    if (!body) {
      return json({ error: 'Invalid request.' }, 400);
    }

    const { planId, customer } = body;

    const plan = PRICING[planId];

    if (!plan) {
      return json({ error: 'Invalid plan selected.' }, 400);
    }

    if (!customer?.email) {
      return json({ error: 'Missing customer email.' }, 400);
    }

    // --------------------------------------------------
    // 2. Verify the logged-in Supabase user
    // --------------------------------------------------

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('Supabase environment variables missing.');
      return json(
        { error: 'Supabase authentication is not configured.' },
        500
      );
    }

    const authHeader = req.headers.get('authorization') || '';

    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return json(
        { error: 'Please log in before purchasing Premium.' },
        401
      );
    }

    const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (!accessToken) {
      return json(
        { error: 'Please log in before purchasing Premium.' },
        401
      );
    }

    const userResponse = await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        method: 'GET',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!userResponse.ok) {
      console.error(
        'Supabase authentication failed:',
        await userResponse.text()
      );

      return json(
        { error: 'Your login session is invalid. Please log in again.' },
        401
      );
    }

    const supabaseUser = await userResponse.json();

    if (!supabaseUser?.id || !supabaseUser?.email) {
      return json(
        { error: 'Unable to verify your account.' },
        401
      );
    }

    // --------------------------------------------------
    // 3. Make sure checkout email belongs to logged-in user
    // --------------------------------------------------

    if (
      String(customer.email).trim().toLowerCase() !==
      String(supabaseUser.email).trim().toLowerCase()
    ) {
      return json(
        { error: 'Account email verification failed.' },
        403
      );
    }

    // --------------------------------------------------
    // 4. Rapid Gateway secret
    // --------------------------------------------------

    const secretKey = process.env.RG_SECRET_KEY;

    if (!secretKey) {
      console.error('RG_SECRET_KEY is missing.');
      return json(
        { error: 'Rapid Gateway secret key is not configured.' },
        500
      );
    }

    // --------------------------------------------------
    // 5. Create unique MEDICIPATE order
    // --------------------------------------------------

    const orderId =
      'MEDICIPATE-' +
      Date.now().toString(36).toUpperCase() +
      '-' +
      crypto.randomUUID().slice(0, 8).toUpperCase();

    const origin = new URL(req.url).origin;

    const createdAt = new Date().toISOString();

    const expiresAt =
      Date.now() + plan.days * 24 * 60 * 60 * 1000;

    // --------------------------------------------------
    // 6. Save pending order BEFORE payment
    // --------------------------------------------------

    const pendingOrder = {
      orderId,

      userId: supabaseUser.id,

      planId,
      planLabel: plan.label,
      amount: plan.amount,
      currency: 'PKR',
      days: plan.days,

      customer: {
        userId: supabaseUser.id,
        name: customer.name || supabaseUser.user_metadata?.name || '',
        email: supabaseUser.email
      },

      status: 'pending',
      active: false,

      createdAt,
      updatedAt: createdAt,

      expiresAt,

      gateway: 'rapidgateway'
    };

    await writeOrder(orderId, pendingOrder);

    // --------------------------------------------------
    // 7. Create Rapid Gateway checkout
    // --------------------------------------------------

    const paymentResponse = await fetch(
      'https://api.rapidgateway.pk/v1/payments',
      {
        method: 'POST',

        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': orderId
        },

        body: JSON.stringify({
          amount: plan.amount,
          currency: 'PKR',

          methods: [
            'easypaisa',
            'jazzcash',
            'card',
            'raast'
          ],

          customer: {
            email: supabaseUser.email,

            ...(customer.name
              ? { name: customer.name }
              : {})
          },

          return_url:
            `${origin}/payment-success.html?orderId=${encodeURIComponent(orderId)}`,

          webhook_url:
            `${origin}/.netlify/functions/rapid-webhook`
        })
      }
    );

    const responseText = await paymentResponse.text();

    let paymentData = {};

    try {
      paymentData = JSON.parse(responseText);
    } catch {
      paymentData = {
        raw: responseText
      };
    }

    // --------------------------------------------------
    // 8. Gateway failed
    // --------------------------------------------------

    if (!paymentResponse.ok) {
      console.error(
        'Rapid Gateway payment creation failed:',
        paymentData
      );

      await writeOrder(orderId, {
        ...pendingOrder,
        status: 'failed',
        active: false,
        updatedAt: new Date().toISOString(),
        gatewayError: paymentData
      });

      return json(
        {
          error:
            'Rapid Gateway could not create the payment.'
        },
        502
      );
    }

    // --------------------------------------------------
    // 9. Find checkout URL
    // --------------------------------------------------

    const checkoutUrl =
      paymentData.checkout_url ||
      paymentData.checkoutUrl ||
      paymentData.redirect_url ||
      paymentData.redirectUrl;

    if (!checkoutUrl) {
      console.error(
        'Rapid Gateway did not return checkout URL:',
        paymentData
      );

      await writeOrder(orderId, {
        ...pendingOrder,
        status: 'failed',
        active: false,
        updatedAt: new Date().toISOString(),
        gatewayError: 'No checkout URL returned.'
      });

      return json(
        {
          error:
            'Rapid Gateway did not return a checkout link.'
        },
        502
      );
    }

    // --------------------------------------------------
    // 10. Return checkout to website
    // --------------------------------------------------

    return json({
      success: true,
      checkout_url: checkoutUrl,
      orderId
    });

  } catch (error) {
    console.error(
      'create-payment unexpected error:',
      error
    );

    return json(
      {
        error: 'Unexpected server error.'
      },
      500
    );
  }
        }
