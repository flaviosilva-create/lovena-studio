import { createClient } from "npm:@supabase/supabase-js@2";

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function validStripeSignature(rawBody: string, header: string, secret: string) {
  const fields = header.split(",").map((part) => part.split("=", 2));
  const timestamp = fields.find(([key]) => key === "t")?.[1];
  const signatures = fields.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const cryptoKey = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC", cryptoKey, new TextEncoder().encode(timestamp + "." + rawBody),
  );
  return signatures.some((signature) => constantTimeEqual(signature, toHex(new Uint8Array(signed))));
}

function makeSlug() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!webhookSecret) return reply(503, { error: "webhook_not_configured" });
  if (!supabaseUrl || !serviceRoleKey) return reply(500, { error: "server_configuration_error" });

  const signature = req.headers.get("Stripe-Signature");
  if (!signature) return reply(400, { error: "missing_signature" });
  const rawBody = await req.text();
  let verified = false;
  try { verified = await validStripeSignature(rawBody, signature, webhookSecret); }
  catch (error) { console.error("Stripe signature verification error", error); }
  if (!verified) return reply(400, { error: "invalid_signature" });

  let event: any;
  try { event = JSON.parse(rawBody); } catch { return reply(400, { error: "invalid_json" }); }
  const eventType = event?.type;
  const payload = event?.data?.object;
  if (!payload || typeof payload !== "object") return reply(400, { error: "invalid_event_payload" });

  try {
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (["checkout.session.expired", "checkout.session.async_payment_failed"].includes(eventType)) {
      if (typeof payload.id !== "string") return reply(400, { error: "invalid_session_payload" });
      const { error } = await admin.from("lovena_orders")
        .update({ payment_status: "failed", updated_at: new Date().toISOString() })
        .eq("stripe_checkout_session_id", payload.id)
        .eq("payment_status", "pending");
      if (error) throw error;
      return reply(200, { received: true, paymentFailed: true });
    }

    if (["charge.refunded", "charge.dispute.created", "charge.dispute.closed"].includes(eventType)) {
      const paymentIntent = payload.payment_intent;
      if (typeof paymentIntent !== "string") return reply(200, { received: true, ignored: true });
      const { data: order, error: orderError } = await admin.from("lovena_orders")
        .select("id, experience_id, payment_status, amount_total")
        .eq("stripe_payment_intent_id", paymentIntent)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order) return reply(200, { received: true, ignored: true });

      const now = new Date().toISOString();
      if (eventType === "charge.refunded") {
        const { error } = await admin.from("lovena_orders")
          .update({ payment_status: "refunded", updated_at: now })
          .eq("id", order.id);
        if (error) throw error;
        if (order.experience_id) {
          const { error: revokeError } = await admin.from("lovena_experiences")
            .update({ status: "removed", updated_at: now })
            .eq("id", order.experience_id)
            .eq("status", "published");
          if (revokeError) throw revokeError;
        }
        return reply(200, { received: true, refunded: true });
      }

      if (eventType === "charge.dispute.created") {
        const { error } = await admin.from("lovena_orders")
          .update({ payment_status: "disputed", updated_at: now })
          .eq("id", order.id);
        if (error) throw error;
        if (order.experience_id) {
          const { error: revokeError } = await admin.from("lovena_experiences")
            .update({ status: "removed", updated_at: now })
            .eq("id", order.experience_id)
            .eq("status", "published");
          if (revokeError) throw revokeError;
        }
        return reply(200, { received: true, disputed: true });
      }

      const disputeWon = payload.status === "won";
      const nextStatus = disputeWon ? "paid" : "disputed";
      const { error: disputeUpdateError } = await admin.from("lovena_orders")
        .update({ payment_status: nextStatus, updated_at: now })
        .eq("id", order.id);
      if (disputeUpdateError) throw disputeUpdateError;
      if (disputeWon && order.experience_id) {
        const { data: experience, error: experienceError } = await admin.from("lovena_experiences")
          .select("id, status, public_slug, online_expires_at")
          .eq("id", order.experience_id).maybeSingle();
        if (experienceError) throw experienceError;
        if (experience?.status === "removed" && experience.public_slug &&
            (!experience.online_expires_at || new Date(experience.online_expires_at).getTime() > Date.now())) {
          const { error: restoreError } = await admin.from("lovena_experiences")
            .update({ status: "published", updated_at: now })
            .eq("id", experience.id).eq("status", "removed");
          if (restoreError) throw restoreError;
        }
      }
      return reply(200, { received: true, disputeClosed: true, won: disputeWon });
    }

    if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(eventType)) {
      return reply(200, { received: true, ignored: true });
    }
    const session = payload;
    if (typeof session.id !== "string") return reply(400, { error: "invalid_session_payload" });
    if (session.payment_status !== "paid") return reply(200, { received: true, paymentPending: true });

    const { data: order, error: orderError } = await admin.from("lovena_orders")
      .select("id, experience_id, stripe_checkout_session_id, payment_status, amount_total, currency, plan")
      .eq("stripe_checkout_session_id", session.id).maybeSingle();
    if (orderError) throw orderError;
    if (!order) {
      console.error("No order for Stripe checkout session", session.id);
      return reply(500, { error: "order_not_found" });
    }
    if (session.metadata?.experience_id !== order.experience_id ||
        session.metadata?.order_id !== order.id ||
        session.amount_total !== order.amount_total ||
        String(session.currency).toLowerCase() !== String(order.currency).toLowerCase()) {
      console.error("Stripe session does not match Lovena order", session.id);
      return reply(400, { error: "checkout_mismatch" });
    }
    if (["refunded", "disputed"].includes(order.payment_status)) {
      return reply(409, { error: "payment_no_longer_eligible" });
    }

    if (order.payment_status !== "paid") {
      const { error: paymentUpdateError } = await admin.from("lovena_orders")
        .update({
          payment_status: "paid",
          stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : null,
          paid_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", order.id)
        .in("payment_status", ["pending", "failed"]);
      if (paymentUpdateError) throw paymentUpdateError;
    }

    const { data: experience, error: experienceError } = await admin.from("lovena_experiences")
      .select("id, status, public_slug, online_expires_at")
      .eq("id", order.experience_id).maybeSingle();
    if (experienceError) throw experienceError;
    if (!experience) throw new Error("Paid order's experience is missing.");

    if (experience.status === "draft" && !experience.public_slug) {
      const now = new Date();
      const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
      const { error: publishError } = await admin.from("lovena_experiences").update({
        status: "published",
        public_slug: makeSlug(),
        published_at: now.toISOString(),
        online_expires_at: expires.toISOString(),
        updated_at: now.toISOString(),
        plan: order.plan,
      }).eq("id", experience.id).eq("status", "draft").is("public_slug", null);
      if (publishError) throw publishError;
    } else if (experience.status !== "published" || !experience.public_slug) {
      console.error("Paid experience has an unexpected state", experience.id, experience.status);
      return reply(409, { error: "experience_not_publishable" });
    }

    return reply(200, { received: true, published: true });
  } catch (error) {
    console.error("Stripe webhook processing failed", error instanceof Error ? error.message : error);
    return reply(500, { error: "webhook_processing_failed" });
  }
});