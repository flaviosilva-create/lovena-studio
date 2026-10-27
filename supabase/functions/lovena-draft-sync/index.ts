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