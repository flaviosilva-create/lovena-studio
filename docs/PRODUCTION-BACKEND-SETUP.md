# Lovena Studio — production backend setup

This repository currently contains a static HTML frontend. The SQL migration in
`supabase/migrations/202610260001_initial_lovena_schema.sql` prepares the core
database, but does not by itself enable payments or public publishing.

## Architecture

- Frontend: deploy the static site to a commercial static host (for example,
  Cloudflare Pages) rather than relying on GitHub Pages for a commercial SaaS.
- Database and media: Supabase Postgres plus a **private** Storage bucket named
  `lovena-media`.
- Payments: Stripe Checkout. Prices and entitlements must be calculated on the
  server, not accepted from browser-submitted amounts.
- Trusted server actions: Supabase Edge Functions using server-only secrets.
- Publishing: an experience becomes public only after a verified Stripe webhook
  confirms payment. Public pages must check the slug, publication state and
  expiration. Private media should be delivered using short-lived signed URLs.

## Suggested Edge Functions

1. `create-checkout`: validate plan/add-ons, create a pending order, and create
   a Stripe Checkout Session using server-side price configuration.
2. `stripe-webhook`: verify the raw request body against Stripe's webhook
   signature; handle duplicate deliveries idempotently; mark the order paid and
   grant the matching entitlement.
3. `save-experience`: validate and save a customer's draft and upload metadata.
4. `publish-experience`: verify the paid order before assigning a random public
   slug and setting the online expiration date.
5. `get-public-experience`: return only published, non-expired public content
   and short-lived signed media URLs.
6. `download-entitlement`: verify the paid HTML-download entitlement before
   creating a downloadable standalone HTML file.
7. `expire-experiences`: scheduled task to mark expired links and support the
   agreed grace period before permanent media deletion.

## Secrets / environment variables

Configure these in Supabase Edge Function secrets (never commit them):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- Server-side price IDs or validated price configuration for each supported
  plan, online term, and optional HTML download.

Only publishable Supabase settings may appear in the browser. Never expose the
service-role key, Stripe secret key, or webhook signing secret in frontend files.

## Before production

- Create the Supabase project and apply the SQL migration.
- Create the private `lovena-media` Storage bucket and add scoped upload/read
  authorization through Edge Functions.
- Implement and test the functions above before exposing checkout buttons.
- Configure Stripe test-mode products/prices and webhook; test successful,
  failed, duplicate and refunded payments before switching to live mode.
- Deploy the frontend to a commercial host and configure the custom domain.
- Add privacy/retention terms and a 30-day grace period before permanent deletion
  of expired experiences.
- Test the full flow on desktop and mobile, including a published link, expiry,
  HTML entitlement, and unauthorized access attempts.

## Current status

The database migration is a starting point only. No Supabase project, Storage
bucket, Stripe webhook, production secrets, commercial hosting, or production
payment flow is configured by this file. The RLS policies intentionally deny
direct browser access until trusted Edge Functions are implemented.
