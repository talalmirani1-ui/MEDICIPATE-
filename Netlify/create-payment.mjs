// Netlify Function — Rapid Gateway payment checkout

const PRICING = {
  monthly:  { amount: 499,  label: 'Monthly' },
  sixMonths: { amount: 2550, label: '6 Months' },
  yearly:   { amount: 4800, label: 'Yearly' }
};

export default async (req) => {
  try {
    if (req.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const { planId, customer } = await req.json();

    const plan = PRICING[planId];

    if (!plan) {
      return json({ error: 'Invalid plan selected.' }, 400);
    }

    if (!customer?.email) {
      return json({ error: 'Missing customer email.' }, 400);
    }

    const secretKey = process.env.RG_SECRET_KEY;

    if (!secretKey) {
      return json(
        { error: 'Rapid Gateway secret key is not configured.' },
        500
      );
    }

    // Unique order ID for this checkout
    const orderId =
      'MEDICIPATE-' +
      Date.now().toString(36).toUpperCase() +
      '-' +
      crypto.randomUUID().slice(0, 8).toUpperCase();

    const origin = new URL(req.url).origin;

    const paymentResponse = await fetch(
      'https://api.rapidgateway.pk/v1/payments',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
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
            email: customer.email,
            ...(customer.name ? { name: customer.name } : {})
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
      paymentData = { raw: responseText };
    }

    if (!paymentResponse.ok) {
      console.error('Rapid Gateway error:', paymentData);

      return json(
        {
          error: 'Rapid Gateway could not create the payment.',
          details: paymentData
        },
        502
      );
    }

    const checkoutUrl =
      paymentData.checkout_url ||
      paymentData.checkoutUrl ||
      paymentData.redirect_url ||
      paymentData.redirectUrl;

    if (!checkoutUrl) {
      console.error(
        'Rapid Gateway response did not contain checkout URL:',
        paymentData
      );

      return json(
        {
          error: 'Rapid Gateway did not return a checkout link.',
          details: paymentData
        },
        502
      );
    }

    return json({
      checkout_url: checkoutUrl,
      orderId
    });

  } catch (error) {
    console.error('create-payment error:', error);

    return json(
      {
        error: 'Unexpected server error.',
        details: String(error)
      },
      500
    );
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}
