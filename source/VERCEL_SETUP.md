# Dé Kraft Essentials — Vercel deployment

The Vercel version now uses a Vercel serverless API instead of the AppDeploy SDK.

## Vercel project settings
- Root Directory: `source`
- Framework Preset: Vite
- Build Command: `npm run build`
- Output Directory: `dist`
- Install Command: `npm install`

## Required integrations and environment variables

1. Create/connect a Neon Postgres database to this Vercel project and add:
   - `DATABASE_URL` — Neon connection string (use the pooled connection string).

2. Add Vercel Blob storage to the same project:
   - `BLOB_READ_WRITE_TOKEN` — Vercel Blob read/write token.

3. In Vercel Project → Settings → Environment Variables, add:
   - `STORE_ADMIN_PASSWORD` — a strong, unique password of at least 12 characters. Do not put this value in GitHub or share it in chat.
   - `PAYSTACK_SECRET_KEY` — optional; only needed if server-side Paystack verification is enabled.

4. Apply the variables to Production (and Preview if desired), then redeploy.

## API health check
After deployment, open `/api/_healthcheck`. A healthy response is:
`{"ok":true,"database":"connected"}`

The first API request creates the products and orders tables and inserts the starter catalogue only when those product IDs are not already present.

## Notes
- Product images uploaded from the admin dashboard are stored in Vercel Blob.
- Product catalogue and customer orders are stored in Neon Postgres.
- Store admin requests are checked against `STORE_ADMIN_PASSWORD` on the server.
- WhatsApp remains the checkout and payment-confirmation channel; the site does not take card payments at checkout.
- Never commit database URLs, Blob tokens, Paystack keys, or the admin password to the repository.
