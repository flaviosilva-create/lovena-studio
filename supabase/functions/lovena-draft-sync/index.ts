import { createClient } from "npm:@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Cache-Control": "no-store" },
  });
}

function isOnlinePublicationOrder(order: any): boolean {
  if (order.purchase_type === "online" || order.purchase_type === "online_with_html") return true;
  if (order.purchase_type === "html_download") return false;
  const currency = String(order.currency || "usd").toLowerCase();
  const baseCents = currency === "brl"
    ? (order.plan === "simple" ? 999 : 1999)
    : (order.plan === "simple" ? 499 : 999);
  const addonCents = currency === "brl" ? 500 : 100;
  return order.includes_html_download === true
    ? order.amount_total >= baseCents + addonCents
    : order.amount_total >= baseCents;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = req.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anonKey || !serviceKey) return reply(500, { error: "server_configuration_error" });
  if (!authorization.startsWith("Bearer ")) return reply(401, { error: "authentication_required" });

  try {
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: authError } = await userClient.auth.getUser();
    if (authError || !userData.user) return reply(401, { error: "invalid_session" });
    const user = userData.user;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return reply(400, { error: "invalid_json" });

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (body.action === "prepare") {
      const requestedId = typeof body.experience_id === "string" ? body.experience_id : "";
      if (requestedId && !/^[0-9a-f-]{36}$/i.test(requestedId)) return reply(400, { error: "invalid_experience_id" });
      if (requestedId) {
        const { data, error } = await admin.from("lovena_experiences")
          .select("id,status,public_slug,owner_id").eq("id", requestedId).eq("owner_id", user.id).maybeSingle();
        if (error) return reply(500, { error: "draft_lookup_failed" });
        if (!data || data.status !== "draft" || data.public_slug) return reply(404, { error: "draft_not_found" });
        return reply(200, { experience_id: data.id, owner_id: user.id });
      }
      const plan = body.plan === "premium" ? "premium" : "simple";
      const { data, error } = await admin.from("lovena_experiences")
        .insert({ owner_id: user.id, status: "draft", plan, locale: "pt-BR", experience_data: {} })
        .select("id").single();
      if (error || !data) {
        console.error("Draft prepare failed", error?.message);
        return reply(500, { error: "draft_create_failed" });
      }
      return reply(200, { experience_id: data.id, owner_id: user.id });
    }

    if (body.action === "load-published" || body.action === "save-published") {
      // Published gifts are editable only by their verified owner and only while a matching paid order exists.
      // Anonymous purchase sessions are allowed on the same browser only when owner and paid-order checks below pass.
      const experienceId = typeof body.experience_id === "string" ? body.experience_id : "";
      if (!/^[0-9a-f-]{36}$/i.test(experienceId)) return reply(400, { error: "invalid_experience_id" });

      const isSave = body.action === "save-published";
      const snapshot = body.snapshot;
      if (isSave && (!snapshot || typeof snapshot !== "object" || JSON.stringify(snapshot).length > 1500000)) {
        return reply(413, { error: "snapshot_too_large_or_invalid" });
      }

      const { data: experience, error: experienceError } = await admin.from("lovena_experiences")
        .select("id,owner_id,status,public_slug,plan,locale,experience_data,updated_at,online_expires_at")
        .eq("id", experienceId).eq("owner_id", user.id).maybeSingle();
      if (experienceError) return reply(500, { error: "published_experience_lookup_failed" });
      if (!experience || experience.status !== "published" || !experience.public_slug) {
        return reply(404, { error: "published_experience_not_found" });
      }

      const { data: paidOrders, error: orderError } = await admin.from("lovena_orders")
        .select("id, plan, currency, amount_total, includes_html_download, purchase_type, payment_status, online_term")
        .eq("experience_id", experience.id)
        .eq("plan", experience.plan)
        .eq("payment_status", "paid")
        .order("paid_at", { ascending: false });
      if (orderError) return reply(500, { error: "payment_verification_failed" });
      const paidOrder = (paidOrders || []).find((order: any) => isOnlinePublicationOrder(order));
      if (!paidOrder) return reply(403, { error: "paid_publication_required" });

      if (!isSave) {
        return reply(200, {
          experience_id: experience.id,
          status: experience.status,
          public_slug: experience.public_slug,
          plan: experience.plan,
          locale: experience.locale,
          snapshot: experience.experience_data,
          updated_at: experience.updated_at,
          online_expires_at: experience.online_expires_at,
        });
      }

      const rawLocale = typeof snapshot.locale === "string"
        ? snapshot.locale
        : (snapshot.data && typeof snapshot.data.locale === "string"
          ? snapshot.data.locale
          : (snapshot.data && typeof snapshot.data.language === "string" ? snapshot.data.language : experience.locale));
      const locale = String(rawLocale || experience.locale || "en").trim().slice(0, 35);
      const now = new Date().toISOString();
      const { data: saved, error: saveError } = await admin.from("lovena_experiences")
        .update({ experience_data: snapshot, locale, updated_at: now })
        .eq("id", experience.id)
        .eq("owner_id", user.id)
        .eq("status", "published")
        .eq("public_slug", experience.public_slug)
        .select("id,public_slug,plan,locale,updated_at")
        .maybeSingle();
      if (saveError) {
        console.error("Published experience save failed", saveError.message);
        return reply(500, { error: "published_experience_save_failed" });
      }
      if (!saved) return reply(409, { error: "published_experience_changed" });

      return reply(200, {
        saved: true,
        experience_id: saved.id,
        public_slug: saved.public_slug,
        plan: saved.plan,
        locale: saved.locale,
        updated_at: saved.updated_at,
      });
    }

    if (body.action === "save") {
      const experienceId = typeof body.experience_id === "string" ? body.experience_id : "";
      const snapshot = body.snapshot;
      if (!/^[0-9a-f-]{36}$/i.test(experienceId)) return reply(400, { error: "invalid_experience_id" });
      if (!snapshot || typeof snapshot !== "object" || JSON.stringify(snapshot).length > 1500000) {
        return reply(413, { error: "snapshot_too_large_or_invalid" });
      }
      const { data: owned, error: ownError } = await admin.from("lovena_experiences")
        .select("id,status,public_slug").eq("id", experienceId).eq("owner_id", user.id).maybeSingle();
      if (ownError) return reply(500, { error: "draft_lookup_failed" });
      if (!owned || owned.status !== "draft" || owned.public_slug) return reply(404, { error: "draft_not_editable" });
      const { error } = await admin.from("lovena_experiences").update({
        experience_data: snapshot,
        updated_at: new Date().toISOString(),
      }).eq("id", experienceId).eq("owner_id", user.id).eq("status", "draft").is("public_slug", null);
      if (error) {
        console.error("Draft save failed", error.message);
        return reply(500, { error: "draft_save_failed" });
      }
      return reply(200, { saved: true, experience_id: experienceId, saved_at: new Date().toISOString() });
    }

    if (body.action === "load") {
      const requestedId = typeof body.experience_id === "string" ? body.experience_id : "";
      let query = admin.from("lovena_experiences")
        .select("id,plan,locale,experience_data,updated_at")
        .eq("owner_id", user.id).eq("status", "draft").is("public_slug", null)
        .order("updated_at", { ascending: false }).limit(1);
      if (requestedId) {
        if (!/^[0-9a-f-]{36}$/i.test(requestedId)) return reply(400, { error: "invalid_experience_id" });
        query = admin.from("lovena_experiences")
          .select("id,plan,locale,experience_data,updated_at")
          .eq("id", requestedId).eq("owner_id", user.id).eq("status", "draft").is("public_slug", null).limit(1);
      }
      const { data, error } = await query;
      if (error) return reply(500, { error: "draft_load_failed" });
      const draft = data?.[0];
      if (!draft) return reply(200, { draft: null });
      return reply(200, { draft: { experience_id: draft.id, plan: draft.plan, locale: draft.locale, snapshot: draft.experience_data, updated_at: draft.updated_at } });
    }

    return reply(400, { error: "unknown_action" });
  } catch (error) {
    console.error("Draft sync error", error);
    return reply(500, { error: "internal_error" });
  }
});