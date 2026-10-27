/* Lovena Studio remote draft persistence. Publishable key is intended for browser use;
   access is restricted by database RLS. Never put a service-role key here. */
(function () {
  "use strict";
  var SUPABASE_URL = "https://cjlbiohykewwizbdtgvw.supabase.co";
  var SUPABASE_KEY = "sb_publishable_aW937JX-8n2NaDkohgjmfg_Q5sO9IxL";
  var CLIENT_VERSION = "2.49.1";
  var clientPromise = null;
  var sessionPromise = null;

  function client() {
    if (!clientPromise) {
      clientPromise = import("https://esm.sh/@supabase/supabase-js@" + CLIENT_VERSION)
        .then(function (mod) { return mod.createClient(SUPABASE_URL, SUPABASE_KEY, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        }); });
    }
    return clientPromise;
  }

  async function getUser(supabase) {
    var result = await supabase.auth.getUser();
    if (result.data && result.data.user) return result.data.user;
    if (!sessionPromise) {
      sessionPromise = supabase.auth.signInAnonymously().then(function (res) {
        if (res.error) throw res.error;
        return res.data.user;
      }).finally(function () { sessionPromise = null; });
    }
    return await sessionPromise;
  }

  function extensionFor(type) {
    var mime = (type || "").toLowerCase();
    if (mime.indexOf("image/png") === 0) return "png";
    if (mime.indexOf("image/webp") === 0) return "webp";
    if (mime.indexOf("image/gif") === 0) return "gif";
    if (mime.indexOf("image/avif") === 0) return "avif";
    return "jpg";
  }

  async function sha256(value) {
    var bytes = new TextEncoder().encode(value);
    var hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash)).map(function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  async function convertImages(value, context, memo) {
    if (typeof value === "string") {
      if (value.indexOf("lovena-media://") === 0) return value;
      if (value.indexOf("data:image/") !== 0) return value;
      if (memo.has(value)) return memo.get(value);
      var promise = (async function () {
        var blob = await (await fetch(value)).blob();
        if (!blob.type || blob.type.indexOf("image/") !== 0) throw new Error("Formato de imagem inválido.");
        if (blob.size > 20 * 1024 * 1024) throw new Error("Cada imagem deve ter até 20 MB.");
        var digest = await sha256(value);
        var path = context.userId + "/" + context.experienceId + "/" + digest + "." + extensionFor(blob.type);
        var upload = await context.supabase.storage.from("lovena-media").upload(path, blob, {
          upsert: true, contentType: blob.type, cacheControl: "3600"
        });
        if (upload.error) throw upload.error;
        var metadata = await context.supabase.from("lovena_media").upsert({
          experience_id: context.experienceId,
          storage_path: path,
          media_type: "image",
          content_type: blob.type,
          byte_size: blob.size,
          sort_order: 0
        }, { onConflict: "storage_path" });
        if (metadata.error) throw metadata.error;
        return "lovena-media://" + path;
      })();
      memo.set(value, promise);
      return await promise;
    }
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(await convertImages(value[i], context, memo));
      return arr;
    }
    if (value && typeof value === "object") {
      var out = {};
      for (var key of Object.keys(value)) out[key] = await convertImages(value[key], context, memo);
      return out;
    }
    return value;
  }

  async function saveDraft(snapshot, editorKey) {
    var supabase = await client();
    var user = await getUser(supabase);
    var idKey = "lovenaRemoteExperienceId:" + editorKey;
    var experienceId = localStorage.getItem(idKey);
    var row = null;

    if (experienceId) {
      var existing = await supabase.from("lovena_experiences")
        .select("id,status,public_slug").eq("id", experienceId).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data && existing.data.owner_id && existing.data.owner_id !== user.id) {
        localStorage.removeItem(idKey);
        experienceId = null;
      }
      if (existing.data && (existing.data.status !== "draft" || existing.data.public_slug)) {
        throw new Error("Esta experiência já foi publicada e não pode ser alterada como rascunho.");
      }
    }

    if (!experienceId) {
      var created = await supabase.from("lovena_experiences").insert({
        owner_id: user.id,
        status: "draft",
        public_slug: null,
        plan: editorKey === "lovenaSimpleExperienceDraftV1" ? "simple" : "premium",
        locale: (snapshot.data && (snapshot.data.locale || snapshot.data.language)) || document.documentElement.lang || "pt-BR",
        experience_data: {}
      }).select("id").single();
      if (created.error) throw created.error;
      experienceId = created.data.id;
      localStorage.setItem(idKey, experienceId);
    }

    var safeSnapshot = JSON.parse(JSON.stringify(snapshot));
    var transformed = await convertImages(safeSnapshot, {
      supabase: supabase, userId: user.id, experienceId: experienceId
    }, new Map());

    var updated = await supabase.from("lovena_experiences").update({
      experience_data: transformed,
      locale: (snapshot.data && (snapshot.data.locale || snapshot.data.language)) || document.documentElement.lang || "pt-BR",
      updated_at: new Date().toISOString()
    }).eq("id", experienceId).eq("owner_id", user.id).eq("status", "draft").is("public_slug", null).select("id").single();
    if (updated.error) throw updated.error;
    return { id: experienceId, userId: user.id, savedAt: new Date().toISOString() };
  }

  async function getPublicExperience(slug) {
    var response = await fetch(SUPABASE_URL + "/functions/v1/lovena-public-experience?slug=" + encodeURIComponent(slug), {
      method: "GET",
      headers: { apikey: SUPABASE_KEY }
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || "Não foi possível carregar esta experiência.");
    return body;
  }

  window.LovenaBackend = {
    saveDraft: saveDraft,
    getPublicExperience: getPublicExperience,
    projectUrl: SUPABASE_URL
  };
})();