# Lovena Studio — backend and launch checklist

## Current architecture

- Frontend: static HTML pages published from GitHub Pages.
- Database and media: Supabase Postgres with a private Storage bucket named `lovena-media`.
- Server actions: Supabase Edge Functions for draft sync, checkout creation, checkout status, publication, and public experience delivery.
- Payments: Stripe Checkout Sessions, with server-side prices in USD: Simple US$4.99, Premium US$9.99, and optional HTML download US$1.00. Review pricing, tax obligations, and currency before production launch.
- Publication: the Stripe webhook is designed to verify signatures and confirm payment before publication. Do not treat a return to the success page as proof of payment.
- Accounts: anonymous sessions may save drafts in the current browser, but checkout and payment-status verification require a linked account.

## Deployed Supabase resources

Project: `cjlbiohykewwizbdtgvw` (region `sa-east-1`).

Active Edge Functions:
- `lovena-draft-sync`
- `lovena-create-checkout`
- `lovena-checkout-status`
- `lovena-publish-experience`
- `lovena-public-experience`
- `lovena-stripe-webhook`

The `lovena-media` bucket is private and has a 25 MiB upload limit. RLS policies are applied for owner-scoped drafts, media metadata, orders, and user-owned storage paths. The Supabase security advisor currently reports no security lints. The performance advisor reports unused indexes, an informational finding while the project has little or no workload; do not remove them until production query patterns are known.

## Required before any real payment

1. In Supabase Edge Function secrets, configure `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Keep both server-only; never commit them or put them in frontend code.
2. In the Stripe **test-mode** account, configure a webhook endpoint:
   `https://cjlbiohykewwizbdtgvw.supabase.co/functions/v1/lovena-stripe-webhook`
3. Subscribe at minimum to:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.refunded`
   - `charge.dispute.created`
   - `charge.dispute.closed`
4. Copy the webhook signing secret from Stripe into the Supabase secret named `STRIPE_WEBHOOK_SECRET`. Never paste it into chat or commit it.
5. Run test-mode end-to-end checks for paid, failed, expired, duplicate, refunded, and disputed sessions. Verify that unpaid sessions never publish and a refund/dispute revokes public access.
6. Confirm account creation, email confirmation/reset, cloud draft recovery on a second device, and image upload/public display.
7. Review the product's currency/prices, privacy/retention terms, expiry behavior, HTML-download entitlement, and hosting/domain choice before launch.

## Important limits

- Stripe test-mode currently has no webhook endpoint or saved products/prices visible to the connected Stripe integration. The checkout currently creates inline price data, so saved Product/Price records are not required, but the webhook must be configured.
- The available Supabase connection can deploy functions and apply migrations, but does not expose a secure function-secret setter. Configure the two Stripe secrets directly in the Supabase Dashboard.
- No successful end-to-end payment has been claimed or verified yet. Do not switch to Stripe live mode until the test checklist passes.
