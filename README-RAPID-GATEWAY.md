# MEDICIPATE — Rapid Gateway + PWA deployment

This package keeps the existing MEDICIPATE HTML application and adds the server-side payment layer and PWA files.

## Netlify environment variables

Add these in **Netlify → Project configuration → Environment variables**:

- `RG_SECRET_KEY` — Rapid Gateway server/live secret key.
- `RG_WEBHOOK_SECRET` — Rapid Gateway webhook signing salt/secret from Developers → Webhooks.
- `RG_API_BASE_URL` — optional; defaults to `https://api.rapidgateway.pk`.
- `RG_WEBHOOK_URL` — optional; normally leave unset so the function uses `https://YOUR-SITE/.netlify/functions/rapid-webhook`.

Do **not** put `RG_SECRET_KEY` or `RG_WEBHOOK_SECRET` into `index.html` or any client-side JavaScript.

## Plans

The server is authoritative for the exact amounts:

- Monthly — PKR 499 — 30 days
- 6 Months — PKR 2,550 — 180 days
- Yearly — PKR 4,800 — 365 days

The browser sends only the plan ID. The backend maps the plan ID to its fixed amount before creating the Rapid Gateway payment, preventing a client from changing the price.

## Rapid Gateway setup

1. Create/verify your Rapid Gateway merchant account.
2. Add the environment variables above.
3. In Rapid Gateway, register the webhook URL:
   `https://YOUR-NETLIFY-DOMAIN/.netlify/functions/rapid-webhook`
4. Use the sandbox key first and make a test payment.
5. After the webhook reaches MEDICIPATE and the order becomes `paid`, the site automatically unlocks the selected plan and shows the generated premium unlock code.
6. Switch `RG_SECRET_KEY` to the live key when ready.

Rapid Gateway's current developer guidance says custom sites should create the payment server-side, redirect to the hosted `checkout_url`, and use the signed webhook as the source of truth for fulfillment. The webhook handler in this package verifies the HMAC signature and checks the timestamp window before unlocking access.

## PWA

The package includes:

- `manifest.webmanifest`
- `sw.js`
- `icons/icon-192.png`
- `icons/icon-512.png`
- `assets/medicipate-logo.png`

The HTML registers the service worker automatically after page load.

## Important

Payment confirmation is deliberately **not** based only on the customer's success-page redirect. The frontend polls the MEDICIPATE status function, while the server only changes an order to `paid` after a verified Rapid Gateway webhook. This is the correct fulfillment pattern for a payment integration.
