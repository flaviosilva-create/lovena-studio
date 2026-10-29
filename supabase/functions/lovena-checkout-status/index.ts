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

function makeSlug() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20);
}

function isOnlinePublicationOrder(order: any): boolean {
  if (order.purchase_type === "online" || order.purchase_type === "online_with_html") return true;
  if (order.purchase_type === "html_download") return false;
  const currency = String(order.currency || "usd").toLowerCase();
  const baseCents = currency === "brl"
    ? (order.plan === "simple" ? 999 : 1999)
    : (order.plan === "simple" ? 499 : 999);
  const addonCents = currency === "brl" ? 500 : 100;
  // An HTML-only order must not publish an online experience by itself.
  return order.includes_html_download === true
    ? order.amount_total >= baseCents + addonCents
    : order.amount_total >= baseCents;
}

async function ensurePublished(admin: any, experienceId: string, plan: string) {
  const { data: current, error: currentError } = await admin
    .from("lovena_experiences")
    .select("id, status, public_slug, online_expires_at")
    .eq("id", experienceId)
    .maybeSingle();
  if (currentError) throw currentError;
  if (!current) throw new Error("Paid order's experience is missing.");

  if (current.status === "draft" && !current.public_slug) {
    const now = new Date();
    const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    const { error: publishError } = await admin.from("lovena_experiences").update({
      status: "published",
      public_slug: makeSlug(),
      published_at: now.toISOString(),
      online_expires_at: expires.toISOString(),
      updated_at: now.toISOString(),
      plan,
    }).eq("id", experienceId).eq("status", "draft").is("public_slug", null);
    if (publishError) throw publishError;
  }

  const { data: finalExperience, error: finalError } = await admin
    .from("lovena_experiences")
    .select("id, status, public_slug, online_expires_at")
    .eq("id", experienceId)
    .maybeSingle();
  if (finalError) throw finalError;
  return finalExperience;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return reply(500, { error: "server_configuration_error" });
  const accessToken = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return reply(401, { error: "authentication_required" });

  let input: { sessionId?: unknown; experienceId?: unknown; action?: unknown };
  try { input = await req.json(); } catch { return reply(400, { error: "invalid_json" }); }
  const experienceId = typeof input.experienceId === "string" ? input.experienceId : "";
  const action = input.action === "entitlements" ? "entitlements" : "checkout";
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(experienceId)) return reply(400, { error: "invalid_experience_id" });
  if (action !== "entitlements" && !sessionId.startsWith("cs_")) return reply(400, { error: "invalid_checkout_reference" });

  try {
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
    const user = authData?.user;
    if (authError || !user) return reply(401, { error: "invalid_session" });

    const { data: experienceInitial, error: experienceError } = await admin
      .from("lovena_experiences")
      .select("id, owner_id, public_slug, status, online_expires_at, plan")
      .eq("id", experienceId)
      .maybeSingle();
    if (experienceError) throw experienceError;
    if (!experienceInitial || experienceInitial.owner_id !== user.id) return reply(404, { error: "experience_not_found" });

    const fetchOrders = async () => {
      const { data, error } = await admin
        .from("lovena_orders")
        .select("id, experience_id, stripe_checkout_session_id, stripe_payment_intent_id, payment_status, amount_total, currency, plan, includes_html_download, purchase_type")
        .eq("experience_id", experienceId);
      if (error) throw error;
      return data || [];
    };
    let matchingOrders = await fetchOrders();

    if (action !== "entitlements") {
      const selectedOrder = matchingOrders.find((item: any) => item.stripe_checkout_session_id === sessionId);
      if (!selectedOrder) return reply(404, { error: "checkout_not_found" });

      if (selectedOrder.payment_status === "paid") {
        // Recover a publication only for a paid online-plan order, never an HTML-only add-on.
        if (isOnlinePublicationOrder(selectedOrder)) {
          await ensurePublished(admin, experienceId, selectedOrder.plan);
        }
      } else if (!["refunded", "disputed"].includes(selectedOrder.payment_status)) {
        const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
        if (stripeKey) {
          try {
            const response = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sessionId), {
              method: "GET",
              headers: { "Authorization": "Bearer " + stripeKey },
            });
            if (response.ok) {
              const session = await response.json().catch(() => ({}));
              const orderCurrency = String(selectedOrder.currency || "usd").toLowerCase();
              const orderAddonCents = orderCurrency === "brl" ? 500 : 100;
              const expectedPurchaseType = selectedOrder.purchase_type || (selectedOrder.includes_html_download
                ? (selectedOrder.amount_total === orderAddonCents ? "html_download" : "online_with_html")
                : "online");
              const actualPurchaseType = session.metadata?.purchase_type;
              // Safely accept the existing HTML add-on session created with the legacy
              // online_with_html metadata label, only when its amount is exactly the add-on price.
              const isHtmlAddonMetadataAlias =
                !selectedOrder.purchase_type &&
                selectedOrder.includes_html_download === true &&
                selectedOrder.amount_total === orderAddonCents &&
                expectedPurchaseType === "html_download" &&
                actualPurchaseType === "online_with_html";
              const sessionMatchesOrder =
                session.id === sessionId &&
                session.status === "complete" &&
                session.payment_status === "paid" &&
                session.client_reference_id === experienceId &&
                session.metadata?.order_id === selectedOrder.id &&
                session.metadata?.experience_id === experienceId &&
                session.metadata?.owner_id === experienceInitial.owner_id &&
                session.metadata?.plan === selectedOrder.plan &&
                (actualPurchaseType === expectedPurchaseType || isHtmlAddonMetadataAlias) &&
                session.amount_total === selectedOrder.amount_total &&
                String(session.currency).toLowerCase() === String(selectedOrder.currency).toLowerCase();

              if (sessionMatchesOrder) {
                const now = new Date().toISOString();
                const { error: paymentUpdateError } = await admin.from("lovena_orders").update({
                  payment_status: "paid",
                  stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : null,
                  purchase_type: selectedOrder.purchase_type || (isHtmlAddonMetadataAlias ? "html_download" : session.metadata?.purchase_type),
                  customer_email: typeof session.customer_details?.email === "string" ? session.customer_details.email : null,
                  paid_at: now,
                  updated_at: now,
                }).eq("id", selectedOrder.id).in("payment_status", ["pending", "failed"]);
                if (paymentUpdateError) throw paymentUpdateError;
                if (isOnlinePublicationOrder(selectedOrder)) {
                  await ensurePublished(admin, experienceId, selectedOrder.plan);
                }
              } else if (session.id === sessionId && session.payment_status === "paid") {
                console.error("Stripe checkout reconciliation did not match the Lovena order", sessionId);
              }
            } else if (response.status !== 404) {
              console.error("Stripe checkout reconciliation request failed", response.status);
            }
          } catch (reconcileError) {
            console.error("Stripe checkout reconciliation error", reconcileError instanceof Error ? reconcileError.message : "unknown");
          }
        }
      }
      matchingOrders = await fetchOrders();
    }

    const { data: experience, error: refreshedExperienceError } = await admin
      .from("lovena_experiences")
      .select("id, owner_id, public_slug, status, online_expires_at, plan")
      .eq("id", experienceId)
      .maybeSingle();
    if (refreshedExperienceError) throw refreshedExperienceError;
    if (!experience || experience.owner_id !== user.id) return reply(404, { error: "experience_not_found" });

    const onlinePaid = matchingOrders.some((order: any) => {
      const currency = String(order.currency || "usd").toLowerCase();
      const baseCents = currency === "brl" ? (order.plan === "simple" ? 999 : 1999) : (order.plan === "simple" ? 499 : 999);
      const hasOnlineEntitlement = order.purchase_type
        ? ["online", "online_with_html"].includes(order.purchase_type)
        : order.amount_total >= baseCents;
      return order.plan === experience.plan && order.payment_status === "paid" && hasOnlineEntitlement;
    });
    const includesHtmlDownload = matchingOrders.some((order: any) => {
      const currency = String(order.currency || "usd").toLowerCase();
      const baseCents = currency === "brl" ? (order.plan === "simple" ? 999 : 1999) : (order.plan === "simple" ? 499 : 999);
      const addonCents = currency === "brl" ? 500 : 100;
      const hasHtmlEntitlement = order.purchase_type
        ? ["html_download", "online_with_html"].includes(order.purchase_type)
        : (order.amount_total === addonCents || order.amount_total >= baseCents + addonCents);
      return order.plan === experience.plan && order.payment_status === "paid" && order.includes_html_download === true && hasHtmlEntitlement;
    });
    const publicPage = experience.plan === "simple" ? "experience-simple.html" : "experience.html";
    const publicUrl = onlinePaid && experience.status === "published" && experience.public_slug
      ? "https://lovenastudio.com/" + publicPage + "?slug=" + encodeURIComponent(experience.public_slug)
      : null;
    const entitlements = {
      onlinePaid,
      includesHtmlDownload,
      publicUrl,
      plan: experience.plan,
      experienceStatus: experience.status,
    };
    if (action === "entitlements") return reply(200, entitlements);

    const order = matchingOrders.find((item: any) => item.stripe_checkout_session_id === sessionId);
    if (!order) return reply(404, { error: "checkout_not_found" });
    const orderAddonCents = String(order.currency || "usd").toLowerCase() === "brl" ? 500 : 100;
    const purchaseType = order.purchase_type || (order.includes_html_download
      ? (order.amount_total === orderAddonCents ? "html_download" : "online_with_html")
      : "online");
    return reply(200, {
      status: order.payment_status,
      experienceStatus: experience.status,
      publicUrl,
      amountTotal: order.amount_total,
      currency: order.currency,
      plan: order.plan,
      purchaseType,
      onlinePaid,
      includesHtmlDownload,
    });
  } catch (error) {
    console.error("Checkout status error", error instanceof Error ? error.message : error);
    return reply(500, { error: "internal_error" });
  }
});
