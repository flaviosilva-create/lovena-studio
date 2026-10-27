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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return reply(500, { error: "server_configuration_error" });

  const accessToken = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return reply(401, { error: "authentication_required" });

  let input: { sessionId?: unknown; experienceId?: unknown };
  try { input = await req.json(); } catch { return reply(400, { error: "invalid_json" }); }
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const experienceId = typeof input.experienceId === "string" ? input.experienceId : "";
  if (!sessionId.startsWith("cs_") || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(experienceId)) {
    return reply(400, { error: "invalid_checkout_reference" });
  }

  try {
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
    const user = authData?.user;
    if (authError || !user) return reply(401, { error: "invalid_session" });

    const { data: experience, error: experienceError } = await admin
      .from("lovena_experiences")
      .select("id, owner_id, public_slug, status, online_expires_at")
      .eq("id", experienceId)
      .maybeSingle();
    if (experienceError) throw experienceError;
    if (!experience || experience.owner_id !== user.id) return reply(404, { error: "experience_not_found" });

    const { data: order, error: orderError } = await admin
      .from("lovena_orders")
      .select("id, experience_id, stripe_checkout_session_id, payment_status, amount_total, currency, plan")
      .eq("stripe_checkout_session_id", sessionId)
      .eq("experience_id", experienceId)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) return reply(404, { error: "checkout_not_found" });

    const publicUrl = order.payment_status === "paid" && experience.public_slug
      ? "https://flaviosilva-create.github.io/lovena-studio/experience.html?slug=" + encodeURIComponent(experience.public_slug)
      : null;
    return reply(200, {
      status: order.payment_status,
      experienceStatus: experience.status,
      publicUrl,
      amountTotal: order.amount_total,
      currency: order.currency,
      plan: order.plan,
    });
  } catch (error) {
    console.error("Checkout status error", error instanceof Error ? error.message : error);
    return reply(500, { error: "internal_error" });
  }
});