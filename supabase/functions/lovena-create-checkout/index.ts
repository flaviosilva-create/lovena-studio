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

  let input: { experienceId?: unknown; plan?: unknown; purchaseType?: unknown; countryCode?: unknown; currencyCode?: unknown };
  try { input = await req.json(); } catch { return reply(400, { error: "invalid_json" }); }
  const experienceId = typeof input.experienceId === "string" ? input.experienceId : "";
  const plan = input.plan === "simple" || input.plan === "premium" ? input.plan : null;
  const purchaseType = input.purchaseType === "html_download"
    ? "html_download"
    : input.purchaseType === "online_with_html"
      ? "online_with_html"
      : "online";
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(experienceId) || !plan) {
    return reply(400, { error: "invalid_checkout_request" });
  }
  let edgeCountry = (req.headers.get("cf-ipcountry") || req.headers.get("x-vercel-ip-country") || req.headers.get("cloudfront-viewer-country") || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(edgeCountry)) {
    const clientIp = (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0] || "").trim();
    if (clientIp && /^[0-9a-f:.]+$/i.test(clientIp)) {
      try {
        const geoResponse = await fetch("https://ipapi.co/" + encodeURIComponent(clientIp) + "/country/", {
          headers: { "Accept": "text/plain" },
          signal: AbortSignal.timeout(1500),
        });
        if (geoResponse.ok) {
          const geoCountry = (await geoResponse.text()).trim().toUpperCase();
          if (/^[A-Z]{2}$/.test(geoCountry)) edgeCountry = geoCountry;
        }
      } catch (geoError) {
        console.warn("Checkout IP country lookup unavailable; using browser region fallback.");
      }
    }
  }
  const requestedCountry = typeof input.countryCode === "string" ? input.countryCode.trim().toUpperCase() : "";
  const isBrazil = /^[A-Z]{2}$/.test(edgeCountry) ? edgeCountry === "BR" : requestedCountry === "BR";
  const requestedCurrency = typeof input.currencyCode === "string" ? input.currencyCode.trim().toLowerCase() : "";
  const currency = requestedCurrency === "brl" || requestedCurrency === "usd" || requestedCurrency === "eur" ? requestedCurrency : (isBrazil ? "brl" : "usd");
  const isBRLCurrency = currency === "brl";
  const addonCents = isBRLCurrency ? 500 : 100;

  try {
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
    const user = authData?.user;
    if (authError || !user) return reply(401, { error: "invalid_session" });

    const { data: experience, error: experienceError } = await admin
      .from("lovena_experiences")
      .select("id, owner_id, status, public_slug, plan")
      .eq("id", experienceId)
      .maybeSingle();
    if (experienceError) throw experienceError;
    if (!experience || experience.owner_id !== user.id) return reply(404, { error: "draft_not_found" });
    if (experience.plan !== plan) return reply(409, { error: "plan_mismatch" });

    const baseCents = isBRLCurrency ? (plan === "simple" ? 999 : 1999) : (plan === "simple" ? 499 : 999);
    let totalCents = baseCents;
    let productName = isBrazil
      ? (plan === "simple" ? "Lovena Simple — página online por 1 ano" : "Lovena Premium — página online por 1 ano")
      : (plan === "simple" ? "Lovena Simple — online page for 1 year" : "Lovena Premium — online page for 1 year");
    let includesHtmlDownload = false;

    if (purchaseType === "html_download") {
      if (experience.status !== "published" || !experience.public_slug) {
        return reply(409, { error: "publish_required", message: "Primeiro conclua a compra e publique o link online. Depois você poderá desbloquear o HTML offline." });
      }
      const { data: orders, error: ordersError } = await admin
        .from("lovena_orders")
        .select("plan, payment_status, amount_total, currency, includes_html_download")
        .eq("experience_id", experienceId)
        .eq("payment_status", "paid");
      if (ordersError) throw ordersError;
      const hasOnlinePurchase = (orders || []).some((order: any) => {
        const orderCurrency = String(order.currency || "usd").toLowerCase();
        const orderBaseCents = orderCurrency === "brl" ? (plan === "simple" ? 999 : 1999) : (plan === "simple" ? 499 : 999);
        return order.plan === plan && order.amount_total >= orderBaseCents;
      });
      if (!hasOnlinePurchase) {
        return reply(402, { error: "online_purchase_required", message: "É necessário ter o link online pago antes de comprar o HTML offline." });
      }
      const alreadyHasHtml = (orders || []).some((order: any) => {
        const orderCurrency = String(order.currency || "usd").toLowerCase();
        const orderBaseCents = orderCurrency === "brl" ? (plan === "simple" ? 999 : 1999) : (plan === "simple" ? 499 : 999);
        const orderAddonCents = orderCurrency === "brl" ? 500 : 100;
        return order.plan === plan && order.includes_html_download === true &&
          (order.amount_total === orderAddonCents || order.amount_total >= orderBaseCents + orderAddonCents);
      });
      if (alreadyHasHtml) {
        return reply(409, { error: "html_download_already_purchased", message: "O download HTML desta experiência já está desbloqueado." });
      }
      totalCents = addonCents;
      includesHtmlDownload = true;
      productName = isBrazil ? "Lovena — arquivo HTML offline para baixar" : "Lovena — offline HTML download";
    } else {
      if (experience.status !== "draft" || experience.public_slug) {
        return reply(409, { error: "experience_not_editable", message: "Esta experiência já foi publicada ou não está mais disponível para compra inicial." });
      }
      if (purchaseType === "online_with_html") {
        totalCents = baseCents + addonCents;
        includesHtmlDownload = true;
      }
    }

    const { data: order, error: orderError } = await admin
      .from("lovena_orders")
      .insert({
        experience_id: experienceId,
        plan,
        currency,
        amount_total: totalCents,
        payment_status: "pending",
        online_term: "one_year",
        includes_html_download: includesHtmlDownload,
      })
      .select("id")
      .single();
    if (orderError) throw orderError;

    const editorPage = plan === "simple" ? "experience-simple.html" : "experience.html";
    const purchaseQuery = purchaseType === "html_download"
      ? "&purchase=html_download"
      : purchaseType === "online_with_html"
        ? "&purchase=online_with_html"
        : "&purchase=online";
    const successUrl = "https://flaviosilva-create.github.io/lovena-studio/" + editorPage +
      "?edit=1&checkout=success" + purchaseQuery +
      "&session_id={CHECKOUT_SESSION_ID}&experience_id=" + encodeURIComponent(experienceId);
    const cancelUrl = "https://flaviosilva-create.github.io/lovena-studio/" + editorPage +
      "?edit=1&checkout=cancelled" + purchaseQuery +
      "&experience_id=" + encodeURIComponent(experienceId);
    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("locale", isBrazil ? "pt-BR" : "en");
    form.set("success_url", successUrl);
    form.set("cancel_url", cancelUrl);
    form.set("client_reference_id", experienceId);
    if (user.email) form.set("customer_email", user.email);
    form.set("metadata[order_id]", order.id);
    form.set("metadata[experience_id]", experienceId);
    form.set("metadata[owner_id]", user.id);
    form.set("metadata[plan]", plan);
    form.set("metadata[purchase_type]", purchaseType);
    form.set("metadata[online_term]", "one_year");
    form.set("line_items[0][price_data][currency]", currency);
    form.set("line_items[0][price_data][unit_amount]", String(purchaseType === "online_with_html" ? baseCents : totalCents));
    form.set("line_items[0][price_data][product_data][name]", productName);
    form.set("line_items[0][quantity]", "1");
    if (purchaseType === "online_with_html") {
      form.set("line_items[1][price_data][currency]", currency);
      form.set("line_items[1][price_data][unit_amount]", String(addonCents));
      form.set("line_items[1][price_data][product_data][name]", isBrazil ? "Adicional opcional — download HTML offline" : "Optional add-on — offline HTML download");
      form.set("line_items[1][quantity]", "1");
    }

    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + stripeKey,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": "lovena-checkout-" + order.id,
      },
      body: form.toString(),
    });
    const session = await response.json().catch(() => ({}));
    if (!response.ok || !session.id || !session.url) {
      console.error("Stripe Checkout create failed", response.status, session?.error?.type || "unknown");
      await admin.from("lovena_orders").delete().eq("id", order.id).eq("payment_status", "pending");
      return reply(502, { error: "checkout_creation_failed", message: "A Stripe não conseguiu iniciar o checkout. Verifique a configuração do Stripe e tente novamente." });
    }
    const { error: updateError } = await admin
      .from("lovena_orders")
      .update({ stripe_checkout_session_id: session.id, updated_at: new Date().toISOString() })
      .eq("id", order.id);
    if (updateError) {
      console.error("Failed attaching Stripe session to order", updateError.message);
      return reply(500, { error: "order_update_failed" });
    }
    return reply(200, { url: session.url, sessionId: session.id, orderId: order.id, amountTotal: totalCents, currency, purchaseType });
  } catch (error) {
    console.error("Checkout error", error instanceof Error ? error.message : error);
    return reply(500, { error: "internal_error" });
  }
});
