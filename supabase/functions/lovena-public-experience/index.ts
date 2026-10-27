import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};


function resolveMediaReferences(value: unknown, mediaUrls: Map<string, string>): unknown {
  if (typeof value === "string") {
    if (!value.startsWith("lovena-media://")) return value;
    return mediaUrls.get(value.slice("lovena-media://".length)) ?? "";
  }
  if (Array.isArray(value)) return value.map((item) => resolveMediaReferences(item, mediaUrls));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, resolveMediaReferences(item, mediaUrls)]));
  }
  return value;
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const url = new URL(req.url);
  const slug = (url.searchParams.get("slug") ?? "").trim();
  if (!slug || slug.length > 160 || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    return jsonResponse(400, { error: "invalid_slug" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "server_configuration_error" });
  }

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: experience, error } = await supabase
      .from("lovena_experiences")
      .select("id, public_slug, status, plan, locale, experience_data, online_expires_at, published_at, created_at")
      .eq("public_slug", slug)
      .eq("status", "published")
      .maybeSingle();

    if (error) {
      console.error("Experience lookup failed", error.message);
      return jsonResponse(500, { error: "lookup_failed" });
    }
    if (!experience) {
      return jsonResponse(404, { error: "experience_not_found" });
    }

    if (experience.online_expires_at && new Date(experience.online_expires_at).getTime() <= Date.now()) {
      return jsonResponse(410, { error: "experience_expired" });
    }

    const { data: mediaRows, error: mediaError } = await supabase
      .from("lovena_media")
      .select("id, storage_path, media_type, content_type, byte_size, sort_order")
      .eq("experience_id", experience.id)
      .order("sort_order", { ascending: true });

    if (mediaError) {
      console.error("Media lookup failed", mediaError.message);
      return jsonResponse(500, { error: "media_lookup_failed" });
    }

    const mediaUrls = new Map<string, string>();
    const media = await Promise.all((mediaRows ?? []).map(async (item) => {
      const { data, error: signError } = await supabase.storage
        .from("lovena-media")
        .createSignedUrl(item.storage_path, 60 * 10);
      if (signError || !data?.signedUrl) {
        console.error("Media URL signing failed", item.id, signError?.message);
        return {
          id: item.id,
          type: item.media_type,
          content_type: item.content_type,
          sort_order: item.sort_order,
          unavailable: true,
        };
      }
      mediaUrls.set(item.storage_path, data.signedUrl);
      return {
        id: item.id,
        type: item.media_type,
        content_type: item.content_type,
        sort_order: item.sort_order,
        url: data.signedUrl,
      };
    }));

    return jsonResponse(200, {
      experience: {
        slug: experience.public_slug,
        plan: experience.plan,
        locale: experience.locale,
        data: resolveMediaReferences(experience.experience_data, mediaUrls),
        published_at: experience.published_at,
        expires_at: experience.online_expires_at,
      },
      media,
    });
  } catch (error) {
    console.error("Unexpected public experience error", error);
    return jsonResponse(500, { error: "internal_error" });
  }
});