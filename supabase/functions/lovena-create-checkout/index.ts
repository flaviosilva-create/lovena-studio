import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!stripeKey) return reply(503, { error: "payment_provider_not_configured", message: "O Stripe ainda não está configurado no backend. Adicione STRIPE_SECRET_KEY aos secrets da função no Supabase." });
  if (!supabaseUrl || !serviceRoleKey) return reply(500, { error: "server_configuration_error" });

  const authHeader = req.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) return reply(401, { error: "authentication_required" });

  let input: { experienceId?: unknown; plan?: unknown; htmlDownload?: unknown };
  try { input = await req.json(); } catch { return reply(400, { error: "invalid_json" }); }
  const experienceId = typeof input.experienceId === "string" ? input.experienceId : "";
  const plan = input.plan === "simple" || input.plan === "premium" ? input.plan : null;
  const htmlDownload = input.htmlDownload === true;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(experienceId) || !plan) {
    return reply(400, { error: "invalid_checkout_request" });
  }

  try {
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
    const user = authData?.user;
    if (authError || !user) return reply(401, { error: "invalid_session" });
    if (user.is_anonymous) return reply(401, { error: "verified_account_required" });

    const { data: experience, error: experienceError } = await admin
      .from("lovena_experiences")
      .select("id, owner_id, status, public_slug, plan")
      .eq("id", experienceId)
      .maybeSingle();
    if (experienceError) throw experienceError;
    if (!experience || experience.owner_id !== user.id) return reply(404, { error: "draft_not_found" });
    if (experience.status !== "draft" || experience.public_slug) return reply(409, { error: "experience_not_editable" });
    if (experience.plan !== plan) return reply(409, { error: "plan_mismatch" });

    const baseCents = plan === "simple" ? 499 : 999;
    const totalCents = baseCents + (htmlDownload ? 100 : 0);
    const currency = "usd";
    const { data: order, error: orderError } = await admin
      .from("lovena_orders")
      .insert({
        experience_id: experienceId,
        plan,
        currency,
        amount_total: totalCents,
        payment_status: "pending",
        online_term: "one_year",
        includes_html_download: htmlDownload,
      })
      .select("id")
      .single();
    if (orderError) throw orderError;

    const editorPage = plan === "simple" ? "experience-simple.html" : "experience.html";
    const successUrl = "https://flaviosilva-create.github.io/lovena-studio/" + editorPage + "?edit=1&checkout=success&session_id={CHECKOUT_SESSION_ID}&experience_id=" + encodeURIComponent(experienceId);
    const cancelUrl = "https://flaviosilva-create.github.io/lovena-studio/" + editorPage + "?edit=1&checkout=cancelled&experience_id=" + encodeURIComponent(experienceId);
    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("success_url", successUrl);
    form.set("cancel_url", cancelUrl);
    form.set("client_reference_id", experienceId);
    if (user.email) form.set("customer_email", user.email);
    form.set("metadata[order_id]", order.id);
    form.set("metadata[experience_id]", experienceId);
    form.set("metadata[owner_id]", user.id);
    form.set("metadata[plan]", plan);
    form.set("metadata[html_download]", htmlDownload ? "true" : "false");
    form.set("metadata[online_term]", "one_year");

    form.set("line_items[0][price_data][currency]", currency);
    form.set("line_items[0][price_data][unit_amount]", String(baseCents));
    form.set("line_items[0][price_data][product_data][name]", plan === "simple" ? "Lovena Simple — link online por 1 ano" : "Lovena Premium — link online por 1 ano");
    form.set("line_items[0][quantity]", "1");
    if (htmlDownload) {
      form.set("line_items[1][price_data][currency]", currency);
      form.set("line_items[1][price_data][unit_amount]", "100");
      form.set("line_items[1][price_data][product_data][name]", "Arquivo HTML para baixar");
      form.set("line_items[1][quantity]", "1");
    }

    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + stripeKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const session = await response.json().catch(() => ({}));
    if (!response.ok || !session.id || !session.url) {
      console.error("Stripe Checkout create failed", response.status, session?.error?.type || "unknown");
      await admin.from("lovena_orders").delete().eq("id", order.id).eq("payment_status", "pending");
      return reply(502, { error: "checkout_creation_failed", message: "O Stripe não conseguiu iniciar o checkout. Verifique a configuração do Stripe e tente novamente." });
    }

    const { error: updateError } = await admin
      .from("lovena_orders")
      .update({ stripe_checkout_session_id: session.id, updated_at: new Date().toISOString() })
      .eq("id", order.id);
    if (updateError) {
      console.error("Failed attaching Stripe session to order", updateError.message);
      return reply(500, { error: "order_update_failed" });
    }

    return reply(200, { url: session.url, sessionId: session.id, orderId: order.id, amountTotal: totalCents, currency });
  } catch (error) {
    console.error("Checkout error", error instanceof Error ? error.message : error);
    return reply(500, { error: "internal_error" });
  }
});