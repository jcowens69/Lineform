# Lineform

Raster-to-vector app. Publish it on Vercel, then add these environment variables in the Vercel project before deploying. Do not commit their values.

- `STRIPE_SECRET_KEY` — Stripe secret key (`sk_test_…` or `sk_live_…`)
- `STRIPE_WEBHOOK_SECRET` — webhook signing secret (`whsec_…`)
- `DATABASE_URL` — Supabase Postgres URI, with `sslmode=require`
- `BETTER_AUTH_SECRET` — a long random string
- `BETTER_AUTH_URL` — the public site URL, such as `https://your-app.vercel.app`

Build command: `npm run build`. Leave the output directory blank.

Stripe webhook URL: `https://<your-domain>/api/stripe/webhook`

Events: `checkout.session.completed`, `customer.subscription.deleted`. Choose the Snapshot payload, not Thin.
