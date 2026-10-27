import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = req.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return jsonResponse(500, { error: "server_configuration_error" });
  if (!authorization.startsWith("Bearer ")) return jsonResponse(401, { error: "authentication_required" });

  try {
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userResult, error: authError } = await userClient.auth.getUser();
    if (authError || !userResult.user || userResult.user.is_anonymous) {
      return jsonResponse(401, { error: "verified_account_required" });
    }

    const body = await req.json().catch(() => ({}));
    const experienceId = typeof body.experience_id === "string" ? body.experience_id : "";
    if (!/^[0-9a-f-]{36}$/i.test(experienceId)) return jsonResponse(400, { error: "invalid_experience_id" });

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: experience, error: experienceError } = await admin
      .from("lovena_experiences")
      .select("id, owner_id, status, public_slug, plan")
      .eq("id", experienceId)
      .eq("owner_id", userResult.user.id)
      .maybeSingle();

    if (experienceError) {
      console.error("Experience lookup failed", experienceError.message);
      return jsonResponse(500, { error: "experience_lookup_failed" });
    }
    if (!experience) return jsonResponse(404, { error: "experience_not_found" });
    if (experience.status !== "draft" || experience.public_slug) return jsonResponse(409, { error: "experience_not_publishable" });

    const { data: paidOrder, error: orderError } = await admin
      .from("lovena_orders")
      .select("id, online_term, payment_status")
      .eq("experience_id", experienceId)
      .eq("payment_status", "paid")
      .eq("plan", experience.plan)
      .order("paid_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (orderError) {
      console.error("Order lookup failed", orderError.message);
      return jsonResponse(500, { error: "payment_verification_failed" });
    }
    if (!paidOrder) return jsonResponse(402, { error: "payment_required" });

    const slug = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
    const publishedAt = new Date();
    const expiresAt = paidOrder.online_term === "lifetime"
      ? null
      : new Date(publishedAt.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const { error: updateError } = await admin
      .from("lovena_experiences")
      .update({
        status: "published",
        public_slug: slug,
        published_at: publishedAt.toISOString(),
        online_expires_at: expiresAt,
        updated_at: publishedAt.toISOString(),
      })
      .eq("id", experienceId)
      .eq("owner_id", userResult.user.id)
      .eq("status", "draft")
      .is("public_slug", null);

    if (updateError) {
      console.error("Publish update failed", updateError.message);
      return jsonResponse(500, { error: "publish_failed" });
    }

    return jsonResponse(200, {
      slug,
      url: "https://flaviosilva-create.github.io/lovena-studio/" + (experience.plan === "simple" ? "experience-simple.html" : "experience.html") + "?slug=" + slug,
      expires_at: expiresAt,
    });
  } catch (error) {
    console.error("Unexpected publish error", error);
    return jsonResponse(500, { error: "internal_error" });
  }
});