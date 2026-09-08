// create-payment.js
// Runs quietly on Netlify's server — never in the customer's browser.
// Matches what the MEDICIPATE checkout (index.html -> choosePlan()) sends and expects.

const PRICING = {
  monthly:   { amount: 499,  label: 'Monthly' },
  sixMonths: { amount: 2550, label: '6 Months' },
  yearly:    { amount: 4800, label: 'Yearly' },
};

export default async (req) => {
  try {
    const { planId, customer } = await req.json();

    const plan = PRICING[planId];
    if (!plan) {
      return json({ error: 'Invalid plan selected.' }, 400);
    }
    if (!customer || !customer.email) {
      return json({ error: 'Missing customer details.' }, 400);
    }

    const CLIENT_ID = process.env.RAPIDGATEWAY_CLIENT_ID;
    const CLIENT_SECRET = process.env.RAPIDGATEWAY_CLIENT_SECRET;
    const MERCHANT_ID = process.env.RAPIDGATEWAY_MERCHANT_ID;

    if (!CLIENT_ID || !CLIENT_SECRET || !MERCHANT_ID) {
      return json({ error: 'Server is not configured with Rapid Gateway credentials yet.' }, 500);
    }

    // Step 1 — Get a Bearer token
    const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const tokenRes = await fetch('https://secure.rapid-gateway.com/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return json({ error: 'Could not get token from Rapid Gateway.', details: errText }, 502);
    }

    const { access_token: bearerToken } = await tokenRes.json();

    // Step 2 — Create the payment / order
    const orderId = 'MP-' + Date.now();
    const origin = new URL(req.url).origin;

    const params = new URLSearchParams({
      merchantId: MERCHANT_ID,
      merchantTransactionId: orderId,
      amount: String(plan.amount),
      currency: 'PKR',
      description: `MEDICIPATE Premium — ${plan.label}`,
      customerName: customer.name || '',
      customerEmail: customer.email,
      successUrl: `${origin}/payment-success.html`,
      cancelUrl: `${origin}/payment-cancelled.html`,
    });

    const txnRes = await fetch('https://secure.rapid-gateway.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const txnData = await txnRes.json();

    if (!txnRes.ok) {
      return json({ error: 'Could not start the payment.', details: txnData }, 502);
    }

    const checkoutUrl = txnData.checkoutUrl || txnData.checkout_url || txnData.redirect_url;
    if (!checkoutUrl) {
      return json({ error: 'Rapid Gateway did not return a checkout link.', details: txnData }, 502);
    }

    return json({ checkout_url: checkoutUrl, orderId });

  } catch (err) {
    return json({ error: 'Unexpected server error.', details: String(err) }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
