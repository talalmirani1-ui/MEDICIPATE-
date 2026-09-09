// MEDICIPATE — Rapid Gateway Payment Function

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

const FALLBACK_MOBILE_NO = '03000000000';

// Mirrors CONFIG.referral.plans[*].refereeDiscount in index.html.
// Kept server-side too so the amount actually charged always
// matches what the discount banner promised — never trust a
// discount amount sent from the client.
const REFEREE_DISCOUNTS = {
  monthly: 25,
  sixMonths: 100,
  yearly: 200
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

    // Referral code the customer arrived with (?ref=CODE), if any.
    // Stored on the pending order now so the webhook can credit the
    // referrer later without needing to round-trip it through
    // Rapid Gateway itself.
    const referralCode = (body.referralCode || '').trim() || null;

    // Recompute the discount server-side — never trust a discount
    // amount if the client ever sent one.
    const referralDiscount = referralCode ? (REFEREE_DISCOUNTS[planId] || 0) : 0;
    const payAmount = plan.amount - referralDiscount;

    // Phone is optional for MEDICIPATE checkout. Rapid Gateway's
    // CUSTOMER_MOBILE_NO field still needs *some* value on the
    // transaction, so we fall back to a placeholder instead of
    // blocking the user from paying.
    const customerPhone = (customer?.phone || '').trim();

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
    // 4. Rapid Gateway credentials
    // --------------------------------------------------

    const merchantId = process.env.RG_MERCHANT_ID;
    const clientSecret = process.env.RG_SECRET_KEY;

    if (!merchantId || !clientSecret) {
      console.error('RG_MERCHANT_ID / RG_SECRET_KEY is missing.');
      return json(
        { error: 'Rapid Gateway credentials are not configured.' },
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
      amount: payAmount,
      listAmount: plan.amount,
      currency: 'PKR',
      days: plan.days,

      // Referral attribution — read by the webhook once payment
      // is confirmed, so the referrer can be credited without
      // ever needing to pass this through Rapid Gateway itself.
      referralCode,
      referralDiscount,

      customer: {
        userId: supabaseUser.id,
        name: customer.name || supabaseUser.user_metadata?.name || '',
        email: supabaseUser.email,
        phone: customerPhone,
        phoneProvided: Boolean(customerPhone)
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
    // 7. Get OAuth2 bearer token from Rapid Gateway
    // --------------------------------------------------

    const creds = Buffer
      .from(`${merchantId}:${clientSecret}`)
      .toString('base64');

    const tokenRes = await fetch('https://secure.rapid-gateway.com/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    if (!tokenRes.ok) {
      const tokenErrText = await tokenRes.text().catch(() => '');
      console.error('Rapid Gateway token request failed:', tokenErrText);

      await writeOrder(orderId, {
        ...pendingOrder,
        status: 'failed',
        active: false,
        updatedAt: new Date().toISOString(),
        gatewayError: 'Token request failed: ' + tokenErrText
      });

      return json(
        { error: 'Could not authenticate with Rapid Gateway.' },
        502
      );
    }

    const tokenData = await tokenRes.json().catch(() => ({}));
    const accessTokenRG = tokenData.access_token;

    if (!accessTokenRG) {
      console.error('Rapid Gateway token response missing access_token:', tokenData);

      await writeOrder(orderId, {
        ...pendingOrder,
        status: 'failed',
        active: false,
        updatedAt: new Date().toISOString(),
        gatewayError: 'No access_token returned.'
      });

      return json(
        { error: 'Could not authenticate with Rapid Gateway.' },
        502
      );
    }

    // --------------------------------------------------
    // 8. Submit the transaction
    // --------------------------------------------------

    const txnBody = new URLSearchParams({
      MERCHANT_ID: merchantId,
      MERCHANT_NAME: 'MEDICIPATE',
      TXNAMT: String(payAmount),
      CURRENCY_CODE: 'PKR',
      // Rapid Gateway requires a value in this field even when the
      // customer hasn't given us a phone number — fall back to a
      // placeholder so checkout is never blocked on our side.
      CUSTOMER_MOBILE_NO: customerPhone || FALLBACK_MOBILE_NO,
      CUSTOMER_EMAIL_ADDRESS: supabaseUser.email,
      BASKET_ID: orderId,
      SUCCESS_URL: `${origin}/?rg_return=1&orderId=${encodeURIComponent(orderId)}`,
      FAILURE_URL: `${origin}/?rg_return=1&orderId=${encodeURIComponent(orderId)}`,
      CHECKOUT_URL: `${origin}/.netlify/functions/rapid-webhook`,
      VERSION: 'MY_VER_1.0',
      PROCCODE: '0'
    });

    const payRes = await fetch(
      'https://secure.rapid-gateway.com/rapid/process-transaction',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessTokenRG}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: txnBody.toString(),
        redirect: 'manual'
      }
    );

    const checkoutUrl = payRes.headers.get('location');

    // --------------------------------------------------
    // 9. Gateway failed / no redirect returned
    // --------------------------------------------------

    if (!checkoutUrl) {
      const payErrText = await payRes.text().catch(() => '');
      console.error('Rapid Gateway transaction failed:', payRes.status, payErrText);

      await writeOrder(orderId, {
        ...pendingOrder,
        status: 'failed',
        active: false,
        updatedAt: new Date().toISOString(),
        gatewayError: payErrText || ('HTTP ' + payRes.status)
      });

      return json(
        { error: 'Rapid Gateway did not return a checkout link.' },
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
