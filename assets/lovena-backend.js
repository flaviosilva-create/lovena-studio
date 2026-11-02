/* Lovena Studio backend bridge.
   Only the publishable Supabase key belongs in this browser file.
   Service-role keys and Stripe secrets must stay in Supabase Edge Function secrets. */
(function () {
  "use strict";
  var SUPABASE_URL = "https://cjlbiohykewwizbdtgvw.supabase.co";
  var SUPABASE_KEY = "sb_publishable_aW937JX-8n2NaDkohgjmfg_Q5sO9IxL";
  var CLIENT_VERSION = "2.49.1";
  var SITE_BASE = window.location.origin + "/";
  var clientPromise = null;
  var signInPromise = null;
  var mounted = false;
  var authSubscription = null;

  function client() {
    if (!clientPromise) {
      clientPromise = import("https://esm.sh/@supabase/supabase-js@" + CLIENT_VERSION)
        .then(function (mod) {
          return mod.createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
          });
        });
    }
    return clientPromise;
  }

  var ready = client().then(async function (supabase) {
    var res = await supabase.auth.getSession();
    if (res.error) console.warn("Lovena Auth session check:", res.error.message);
    return supabase;
  }).catch(function (error) {
    // A failed auth/CDN initialization must never prevent a published gift from rendering
    // or stop its independent, read-only public-experience request.
    console.warn("Lovena backend initialization failed; public experiences remain interactive.", error);
    return null;
  });

  async function currentSession(supabase) {
    var result = await supabase.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session || null;
  }

  async function currentUser(supabase, allowAnonymousCreation) {
    var session = await currentSession(supabase);
    if (session && session.user) return session.user;
    if (!allowAnonymousCreation) return null;
    if (!signInPromise) {
      signInPromise = supabase.auth.signInAnonymously().then(function (result) {
        if (result.error) throw result.error;
        if (!result.data || !result.data.user) throw new Error("Supabase did not return a valid session.");
        return result.data.user;
      }).finally(function () { signInPromise = null; });
    }
    return await signInPromise;
  }

  function isBrazilianVisitor() {
    if (window.LOVENA_REGION_COUNTRY) return window.LOVENA_REGION_COUNTRY === "BR";
    try {
      var locale = String(navigator.language || "").toLowerCase();
      var languages = Array.isArray(navigator.languages) ? navigator.languages.map(function (item) { return String(item).toLowerCase(); }) : [];
      var timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      var zones = "|America/Sao_Paulo|America/Fortaleza|America/Recife|America/Manaus|America/Belem|America/Bahia|America/Campo_Grande|America/Cuiaba|America/Porto_Velho|America/Boa_Vista|America/Rio_Branco|America/Noronha|America/Maceio|America/Araguaina|America/Santarem|";
      return locale === "pt-br" || languages.indexOf("pt-br") !== -1 || zones.indexOf("|" + timezone + "|") !== -1;
    } catch (error) { return String(navigator.language || "").toLowerCase() === "pt-br"; }
  }
  function planFor(editorKey) {
    return editorKey === "lovenaSimpleExperienceDraftV1" ? "simple" : "premium";
  }
  function remoteIdKey(editorKey) { return "lovenaRemoteExperienceId:" + editorKey; }
  function editorLabel(editorKey) { return planFor(editorKey) === "simple" ? "Lovena Simple" : "Lovena Premium"; }

  function extensionFor(type) {
    var mime = (type || "").toLowerCase();
    if (mime.indexOf("image/png") === 0) return "png";
    if (mime.indexOf("image/webp") === 0) return "webp";
    if (mime.indexOf("image/gif") === 0) return "gif";
    if (mime.indexOf("image/avif") === 0) return "avif";
    return "jpg";
  }

  async function sha256(value) {
    var hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash)).map(function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  async function convertImages(value, context, memo, sortCounter) {
    if (typeof value === "string") {
      if (value.indexOf("lovena-media://") === 0 || value.indexOf("data:image/") !== 0) return value;
      if (memo.has(value)) return memo.get(value);
      var promise = (async function () {
        var response = await fetch(value);
        if (!response.ok) throw new Error("Could not prepare a photo for cloud storage.");
        var blob = await response.blob();
        if (!blob.type || blob.type.indexOf("image/") !== 0) throw new Error("Invalid image format.");
        if (blob.size > 20 * 1024 * 1024) throw new Error("Each image must be 20 MB or smaller.");
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
          sort_order: sortCounter.value++
        }, { onConflict: "storage_path" });
        if (metadata.error) throw metadata.error;
        return "lovena-media://" + path;
      })();
      memo.set(value, promise);
      return await promise;
    }
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(await convertImages(value[i], context, memo, sortCounter));
      return arr;
    }
    if (value && typeof value === "object") {
      var out = {};
      for (var key of Object.keys(value)) out[key] = await convertImages(value[key], context, memo, sortCounter);
      return out;
    }
    return value;
  }

  function collectMediaPaths(value, paths) {
    if (typeof value === "string") {
      if (value.indexOf("lovena-media://") === 0) paths.add(value.slice("lovena-media://".length));
      return;
    }
    if (Array.isArray(value)) { value.forEach(function (item) { collectMediaPaths(item, paths); }); return; }
    if (value && typeof value === "object") Object.keys(value).forEach(function (key) { collectMediaPaths(value[key], paths); });
  }

  async function pruneUnusedMedia(supabase, experienceId, snapshot) {
    var used = new Set();
    collectMediaPaths(snapshot, used);
    var listed = await supabase.from("lovena_media").select("storage_path")
      .eq("experience_id", experienceId);
    if (listed.error) { console.warn("Lovena: could not check older media.", listed.error.message); return; }
    var remove = (listed.data || []).map(function (item) { return item.storage_path; }).filter(function (path) { return !used.has(path); });
    if (!remove.length) return;
    var objects = await supabase.storage.from("lovena-media").remove(remove);
    if (objects.error) console.warn("Lovena: some older media could not be removed.", objects.error.message);
    var metadata = await supabase.from("lovena_media").delete().eq("experience_id", experienceId).in("storage_path", remove);
    if (metadata.error) console.warn("Lovena: metadata for older media could not be removed.", metadata.error.message);
  }

  function storedSnapshotKey(editorKey) {
    return "lovenaStoredSnapshot:" + editorKey;
  }

  function containsStoredMediaReferences(value) {
    if (typeof value === "string") return value.indexOf("lovena-media://") === 0;
    if (Array.isArray(value)) return value.some(containsStoredMediaReferences);
    if (value && typeof value === "object") return Object.keys(value).some(function (key) {
      return containsStoredMediaReferences(value[key]);
    });
    return false;
  }

  function preserveStoredMediaReferences(current, source) {
    // A partially hydrated editor can report null/empty image fields even though
    // the last canonical snapshot still has saved media. Never overwrite those
    // durable references with missing values.
    if ((current === null || current === undefined || current === "") &&
        source !== null && source !== undefined && containsStoredMediaReferences(source)) {
      return source;
    }
    if (typeof current === "string" && typeof source === "string" &&
        source.indexOf("lovena-media://") === 0 && /^https?:\/\//i.test(current)) {
      return source;
    }
    if (Array.isArray(current) && Array.isArray(source)) {
      return current.map(function (value, index) {
        return index < source.length ? preserveStoredMediaReferences(value, source[index]) : value;
      });
    }
    if (current && typeof current === "object" && !Array.isArray(current) &&
        source && typeof source === "object" && !Array.isArray(source)) {
      var result = {};
      Object.keys(current).forEach(function (key) {
        result[key] = Object.prototype.hasOwnProperty.call(source, key)
          ? preserveStoredMediaReferences(current[key], source[key])
          : current[key];
      });
      return result;
    }
    return current;
  }

  async function syncPublishedExperience(supabase, action, experienceId, snapshot) {
    var session = await currentSession(supabase);
    if (!session || !session.access_token) throw new Error("Sign in to edit this published experience.");
    var payload = { action: action, experience_id: experienceId };
    if (snapshot) payload.snapshot = snapshot;
    var response = await fetch(SUPABASE_URL + "/functions/v1/lovena-draft-sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + session.access_token
      },
      body: JSON.stringify(payload),
      cache: "no-store"
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var messages = {
        published_experience_not_found: "This published experience is not available to this account.",
        paid_publication_required: "A confirmed payment is required to edit this published experience."
      };
      throw new Error(messages[body.error] || body.message || body.error || "Could not sync the published experience.");
    }
    return body;
  }

  async function findDraft(supabase, user, editorKey) {
    var plan = planFor(editorKey);
    var idKey = remoteIdKey(editorKey);
    var preferredId = localStorage.getItem(idKey);
    if (preferredId) {
      var found = await supabase.from("lovena_experiences")
        .select("id, owner_id, status, public_slug, plan, locale, experience_data, updated_at")
        .eq("id", preferredId).eq("owner_id", user.id).maybeSingle();
      if (found.error) throw found.error;
      if (found.data && found.data.status === "draft" && !found.data.public_slug) return found.data;
      if (found.data && found.data.status === "published" && found.data.public_slug && found.data.plan === plan) return found.data;
      if (!found.data) localStorage.removeItem(idKey);
    }
    var latest = await supabase.from("lovena_experiences")
      .select("id, owner_id, status, public_slug, plan, locale, experience_data, updated_at")
      .eq("owner_id", user.id).eq("status", "draft").is("public_slug", null).eq("plan", plan)
      .order("updated_at", { ascending: false }).limit(1);
    if (latest.error) throw latest.error;
    return latest.data && latest.data.length ? latest.data[0] : null;
  }

  async function resolvePrivateMedia(value, supabase) {
    if (typeof value === "string") {
      if (value.indexOf("lovena-media://") !== 0) return value;
      var path = value.slice("lovena-media://".length);
      var signed = await supabase.storage.from("lovena-media").createSignedUrl(path, 3600);
      if (signed.error || !signed.data || !signed.data.signedUrl) throw (signed.error || new Error("Could not open a saved photo."));
      return signed.data.signedUrl;
    }
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(await resolvePrivateMedia(value[i], supabase));
      return arr;
    }
    if (value && typeof value === "object") {
      var out = {};
      for (var key of Object.keys(value)) out[key] = await resolvePrivateMedia(value[key], supabase);
      return out;
    }
    return value;
  }

  async function loadDraft(editorKey) {
    var supabase = await client();
    var user = await currentUser(supabase, false);
    if (!user) return null;
    var row = await findDraft(supabase, user, editorKey);
    if (!row) return null;
    localStorage.setItem(remoteIdKey(editorKey), row.id);
    var storedSnapshot = row.experience_data || {};
    if (row.status === "published") {
      var published = await syncPublishedExperience(supabase, "load-published", row.id);
      storedSnapshot = published.snapshot || {};
    }
    localStorage.setItem(storedSnapshotKey(editorKey), JSON.stringify(storedSnapshot));
    var snapshot = await resolvePrivateMedia(storedSnapshot, supabase);
    return {
      id: row.id,
      snapshot: snapshot,
      updatedAt: row.updated_at,
      plan: row.plan,
      user: user,
      published: row.status === "published",
      publicSlug: row.public_slug || null
    };
  }

  async function saveDraft(snapshot, editorKey) {
    var supabase = await client();
    var user = await currentUser(supabase, true);
    var idKey = remoteIdKey(editorKey);
    var experienceId = localStorage.getItem(idKey);
    var existing = null;

    if (experienceId) {
      var lookup = await supabase.from("lovena_experiences")
        .select("id, owner_id, status, public_slug, plan")
        .eq("id", experienceId).eq("owner_id", user.id).maybeSingle();
      if (lookup.error) throw lookup.error;
      existing = lookup.data;
      if (existing && existing.status === "published" && existing.public_slug && existing.plan === planFor(editorKey)) {
        var sourceSnapshot = null;
        try { sourceSnapshot = JSON.parse(localStorage.getItem(storedSnapshotKey(editorKey)) || "null"); } catch (_) {}
        var publishedSnapshot = preserveStoredMediaReferences(JSON.parse(JSON.stringify(snapshot)), sourceSnapshot || {});
        var publishedTransformed = await convertImages(publishedSnapshot, {
          supabase: supabase, userId: user.id, experienceId: experienceId
        }, new Map(), { value: 0 });
        var publishedResult = await syncPublishedExperience(supabase, "save-published", experienceId, publishedTransformed);
        localStorage.setItem(storedSnapshotKey(editorKey), JSON.stringify(publishedTransformed));
        // Keep existing published media until a complete, explicit media diff is available.
        // A partial editor snapshot must never delete photos from a live shared page.
        return {
          id: experienceId,
          userId: user.id,
          savedAt: publishedResult.updated_at || new Date().toISOString(),
          anonymous: !!user.is_anonymous,
          published: true,
          publicSlug: publishedResult.public_slug,
          plan: publishedResult.plan
        };
      }
      if (!existing || existing.status !== "draft" || existing.public_slug) {
        localStorage.removeItem(idKey);
        experienceId = null;
      }
    }

    if (!experienceId) {
      var created = await supabase.from("lovena_experiences").insert({
        owner_id: user.id,
        status: "draft",
        public_slug: null,
        plan: planFor(editorKey),
        locale: (snapshot.data && (snapshot.data.locale || snapshot.data.language)) || document.documentElement.lang || "en",
        experience_data: {}
      }).select("id").single();
      if (created.error) throw created.error;
      experienceId = created.data.id;
      localStorage.setItem(idKey, experienceId);
    }

    var sourceSnapshot = null;
    try { sourceSnapshot = JSON.parse(localStorage.getItem(storedSnapshotKey(editorKey)) || "null"); } catch (_) {}
    var safeSnapshot = preserveStoredMediaReferences(JSON.parse(JSON.stringify(snapshot)), sourceSnapshot || {});
    var transformed = await convertImages(safeSnapshot, {
      supabase: supabase, userId: user.id, experienceId: experienceId
    }, new Map(), { value: 0 });

    var update = await supabase.from("lovena_experiences").update({
      experience_data: transformed,
      locale: (snapshot.data && (snapshot.data.locale || snapshot.data.language)) || document.documentElement.lang || "en",
      updated_at: new Date().toISOString()
    }).eq("id", experienceId).eq("owner_id", user.id).eq("status", "draft").is("public_slug", null).select("id").single();
    if (update.error) throw update.error;
    await pruneUnusedMedia(supabase, experienceId, transformed);
    localStorage.setItem(storedSnapshotKey(editorKey), JSON.stringify(transformed));
    return { id: experienceId, userId: user.id, savedAt: new Date().toISOString(), anonymous: !!user.is_anonymous, published: false };
  }

  async function getPublicExperience(slug) {
    if (!slug || !/^[a-zA-Z0-9_-]{6,160}$/.test(slug)) throw new Error("Invalid experience link.");
    var response = await fetch(SUPABASE_URL + "/functions/v1/lovena-public-experience?slug=" + encodeURIComponent(slug), {
      method: "GET",
      headers: { apikey: SUPABASE_KEY },
      cache: "no-store"
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || (response.status === 404 ? "This experience could not be found." : "Could not load this experience."));
    return body;
  }

  async function createCheckout(experienceId, editorKey, purchaseType) {
    var supabase = await client();
    var session = await currentSession(supabase);
    if (!session || !session.access_token) throw new Error("Could not start your Lovena session. Refresh the page and try again.");
    var type = purchaseType === "html_download" ? "html_download" : (purchaseType === "online_with_html" ? "online_with_html" : "online");
    if (window.LOVENA_REGION_READY) {
      try { await window.LOVENA_REGION_READY; } catch (regionError) {}
    }
    var countryCode = window.LOVENA_REGION_COUNTRY || (isBrazilianVisitor() ? "BR" : "US");
    var response = await fetch(SUPABASE_URL + "/functions/v1/lovena-create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + session.access_token },
      body: JSON.stringify({ experienceId: experienceId, plan: planFor(editorKey), purchaseType: type, countryCode: countryCode, currencyCode: (window.LOVENA_CURRENCY_CODE || (function () { try { return localStorage.getItem("lovenaPreferredCurrency"); } catch (_) { return ""; } })() || (countryCode === "BR" ? "brl" : "usd")) })
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok || !body.url) throw new Error(body.message || body.error || "Could not start checkout.");
    return body;
  }

  async function getCheckoutStatus(sessionId, experienceId) {
    var supabase = await client();
    var session = await currentSession(supabase);
    if (!session || !session.access_token) throw new Error("Your Lovena session was not found. Sign in again and try to verify.");
    var response = await fetch(SUPABASE_URL + "/functions/v1/lovena-checkout-status", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + session.access_token },
      body: JSON.stringify({ sessionId: sessionId, experienceId: experienceId })
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.message || body.error || "Could not verify the payment.");
    return body;
  }

  function reportGoogleAdsPurchase(conversion) {
    if (!conversion || conversion.status !== "paid") return;

    var transactionId = String(conversion.transactionId || "").trim();
    var amountMinor = Number(conversion.amountTotal);
    var currency = String(conversion.currency || "").toUpperCase();

    if (!transactionId || transactionId.length > 64 ||
        !Number.isFinite(amountMinor) || amountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(currency) ||
        typeof window.gtag !== "function") {
      return;
    }

    var storageKey = "lovenaGoogleAdsPurchaseSent:" + transactionId;
    try {
      if (window.localStorage.getItem(storageKey) === "sent") return;
    } catch (_) {}

    window.gtag("event", "conversion", {
      send_to: "AW-18513830218/Wrb4CJvWhJ4dEMrCivxE",
      transaction_id: transactionId,
      value: Math.round(amountMinor) / 100,
      currency: currency
    });

    try {
      window.localStorage.setItem(storageKey, "sent");
    } catch (_) {}
  }

  async function getPurchaseEntitlements(experienceId) {
    var supabase = await client();
    var session = await currentSession(supabase);
    if (!session || !session.access_token) return { onlinePaid: false, includesHtmlDownload: false, publicUrl: null };
    var response = await fetch(SUPABASE_URL + "/functions/v1/lovena-checkout-status", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + session.access_token },
      body: JSON.stringify({ action: "entitlements", experienceId: experienceId })
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.message || body.error || "Could not check purchases for this experience.");
    return body;
  }

  function mountEditor(options) {
    if (mounted || !options || !options.editorKey) return;
    var panel = document.getElementById("lovenaEditor");
    var scroll = panel && panel.querySelector(".ed-scroll");
    var status = document.getElementById("lovenaEditorStatus");
    if (!panel || !scroll) return;
    mounted = true;

    var box = document.createElement("section");
    box.className = "lovena-cloud-account";
    box.style.cssText = "margin:0 0 16px;padding:14px;border:1px solid #e5d1c2;border-radius:14px;background:linear-gradient(135deg,#fffaf6,#fff);color:#51392f";
    var heading = document.createElement("strong");
    heading.textContent = "Save and access your Lovena on other devices";
    heading.style.cssText = "display:block;font-size:14px;margin-bottom:6px";
    var description = document.createElement("p");
    description.style.cssText = "font-size:12px;line-height:1.55;margin:0 0 10px;color:#82695a";
    var authStatus = document.createElement("p");
    authStatus.style.cssText = "font-size:12px;line-height:1.4;margin:0 0 10px;color:#7a5947";
    authStatus.setAttribute("role", "status");
    var email = document.createElement("input");
    email.type = "email"; email.autocomplete = "email"; email.placeholder = "Your email";
    email.setAttribute("aria-label", "Lovena account email");
    email.style.cssText = "display:block;width:100%;box-sizing:border-box;padding:10px 11px;border:1px solid #dfc6b4;border-radius:9px;margin:7px 0;background:#fff;color:#51392f";
    var password = document.createElement("input");
    password.type = "password"; password.autocomplete = "current-password"; password.placeholder = "Password (at least 8 characters)";
    password.setAttribute("aria-label", "Lovena account password");
    password.style.cssText = email.style.cssText;
    var buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;flex-wrap:wrap;gap:7px;margin-top:8px";
    function makeButton(label) {
      var button = document.createElement("button");
      button.type = "button"; button.textContent = label;
      button.style.cssText = "border:1px solid #dec3b0;border-radius:9px;padding:9px 11px;background:#fff;color:#654739;font:600 12px Manrope,Arial,sans-serif;cursor:pointer";
      buttons.appendChild(button);
      return button;
    }
    var loginButton = makeButton("Entrar");
    var createButton = makeButton("Create account / link email");
    var cloudButton = makeButton("Load Latest Cloud Draft");
    var resetButton = makeButton("Forgot password");
    box.append(heading, description, authStatus, email, password, buttons);
    // Account creation is optional; the purchase flow does not show login or sign-up.
    // saveDraft() automatically creates a temporary anonymous session when needed.
    // Account fields stay outside the DOM so sign-up does not appear mandatory.

    var publication = document.createElement("section");
    publication.className = "lovena-cloud-publication";
    publication.style.cssText = "position:relative;margin:0 0 18px;padding:18px;border:2px solid #b78367;border-radius:16px;background:linear-gradient(145deg,#fff8f1,#fff);color:#51392f;box-shadow:0 8px 22px rgba(97,63,46,.10)";
    var publicationTitle = document.createElement("strong");
    var planIsSimple = planFor(options.editorKey) === "simple";
    var brazilianVisitor = isBrazilianVisitor();
    var activeCurrency = window.LOVENA_CURRENCY_CODE === "brl" || window.LOVENA_CURRENCY_CODE === "eur" || window.LOVENA_CURRENCY_CODE === "usd"
      ? window.LOVENA_CURRENCY_CODE
      : (brazilianVisitor ? "brl" : "usd");
    var currencyPrefix = activeCurrency === "brl" ? "R$ " : (activeCurrency === "eur" ? "€ " : "US$ ");
    var priceDecimalSeparator = activeCurrency === "usd" ? "." : ",";
    var addonCents = activeCurrency === "brl" ? 500 : 100;
    var basePriceCents = activeCurrency === "brl" ? (planIsSimple ? 999 : 1999) : (planIsSimple ? 499 : 999);
    var onlinePriceLabel = currencyPrefix + (basePriceCents / 100).toFixed(2).replace(".", priceDecimalSeparator);
    function priceLabel(cents) { return currencyPrefix + (cents / 100).toFixed(2).replace(".", priceDecimalSeparator); }
    publicationTitle.textContent = "Publish Your Lovena Page";
    publicationTitle.style.cssText = "display:block;font-size:13px;line-height:1.3;margin:0;color:#472b23";
    var publicationCopy = document.createElement("p");
    publicationCopy.style.cssText = "font-size:10.5px;line-height:1.4;margin:0;color:#765d50";
    var publicationTotal = document.createElement("div");
    publicationTotal.style.cssText = "font-size:17px;font-weight:850;letter-spacing:-.3px;margin:0;color:#59372f";
    var includeHtmlCheckbox = document.createElement("input");
    includeHtmlCheckbox.type = "checkbox";
    includeHtmlCheckbox.id = "lovenaIncludeHtmlDownload";
    includeHtmlCheckbox.style.cssText = "width:19px;height:19px;flex:0 0 19px;margin:1px 0 0;accent-color:#784b3d;cursor:pointer";
    var includeHtmlLabel = document.createElement("label");
    includeHtmlLabel.htmlFor = includeHtmlCheckbox.id;
    includeHtmlLabel.style.cssText = "display:flex;gap:8px;align-items:flex-start;padding:7px 9px;border:1px solid #dcc0ad;border-radius:10px;background:#fff;cursor:pointer;margin:0";
    var includeHtmlText = document.createElement("span");
    includeHtmlText.style.cssText = "display:grid;gap:2px;font-size:11px;line-height:1.3;color:#51392f";
    var includeHtmlTitle = document.createElement("strong");
    includeHtmlTitle.textContent = "Add offline HTML (+" + currencyPrefix + (addonCents / 100).toFixed(2).replace(".", ",") + ")";
    includeHtmlTitle.style.cssText = "font-size:11px";
    var includeHtmlHelp = document.createElement("span");
    includeHtmlHelp.textContent = "Also get an HTML file to download and keep offline. Optional.";
    includeHtmlHelp.style.cssText = "font-size:9.5px;line-height:1.35;color:#82695a";
    includeHtmlText.append(includeHtmlTitle, includeHtmlHelp);
    includeHtmlLabel.append(includeHtmlCheckbox, includeHtmlText);
    var htmlPurchaseButton = document.createElement("button");
    htmlPurchaseButton.type = "button";
    htmlPurchaseButton.textContent = "Offline HTML download · " + priceLabel(addonCents) + " (optional)";
    htmlPurchaseButton.hidden = true;
    htmlPurchaseButton.disabled = true;
    htmlPurchaseButton.style.cssText = "width:100%;border:1px solid #dec3b0;border-radius:10px;padding:11px;background:#fff;color:#654739;font:700 12px Manrope,Arial,sans-serif;cursor:pointer;margin-top:9px";
    var htmlPurchaseStatus = document.createElement("p");
    htmlPurchaseStatus.style.cssText = "font-size:12px;line-height:1.5;margin:7px 0 0;color:#82695a";
    htmlPurchaseStatus.textContent = "Optional: after paying for online publishing, you can pay " + priceLabel(addonCents) + " more to download the HTML and use it offline.";
    htmlPurchaseStatus.hidden = true;

    var paidSharePanel = document.createElement("div");
    paidSharePanel.hidden = true;
    paidSharePanel.style.cssText = "margin-top:12px;padding:12px;border:1px solid #d9c2af;border-radius:10px;background:#fffaf6";
    var paidShareTitle = document.createElement("strong");
    paidShareTitle.textContent = "Your link is ready to share";
    paidShareTitle.style.cssText = "display:block;font-size:12px;margin-bottom:6px";
    var paidShareNote = document.createElement("p");
    paidShareNote.textContent = "You can keep editing and saving this gift. The same shared link will show the latest saved version.";
    paidShareNote.style.cssText = "font-size:12px;line-height:1.55;color:#765d50;margin:0 0 9px";
    paidShareNote.hidden = true;
    var paidShareLink = document.createElement("a");
    paidShareLink.target = "_blank";
    paidShareLink.rel = "noopener noreferrer";
    paidShareLink.style.cssText = "display:block;color:#8b5541;font-size:12px;line-height:1.5;overflow-wrap:anywhere";
    paidShareLink.textContent = "Open Published Experience ↗";
    var copyPaidLinkButton = document.createElement("button");
    copyPaidLinkButton.type = "button";
    copyPaidLinkButton.textContent = "Copy Share Link";
    copyPaidLinkButton.style.cssText = "width:100%;border:1px solid #dec3b0;border-radius:9px;padding:9px;background:#fff;color:#654739;font:600 12px Manrope,Arial,sans-serif;cursor:pointer;margin-top:8px";
    var paidQrSection = document.createElement("section");
    paidQrSection.style.cssText = "display:grid;justify-items:center;gap:9px;margin-top:14px;padding:14px 10px;border:1px solid #e6d4c6;border-radius:12px;background:#fff";
    var paidQrTitle = document.createElement("strong");
    paidQrTitle.textContent = "A gift they can hold on to";
    paidQrTitle.style.cssText = "font:700 15px/1.35 'Playfair Display',Georgia,serif;color:#51392f;text-align:center";
    var paidQrCopy = document.createElement("p");
    paidQrCopy.textContent = "Turn your personal QR code into a small keepsake card, ready to print and hand over.";
    paidQrCopy.style.cssText = "font-size:10px;line-height:1.5;color:#82695a;text-align:center;margin:0";
    var paidQrImage = document.createElement("img");
    paidQrImage.alt = "QR code for your published Lovena experience";
    paidQrImage.width = 220;
    paidQrImage.height = 220;
    paidQrImage.style.cssText = "display:block;width:min(220px,100%);height:auto;aspect-ratio:1;object-fit:contain;background:#fff;border:1px solid #eee2d8;border-radius:8px";
    var paidQrActions = document.createElement("div");
    paidQrActions.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%";
    var downloadPaidQrButton = document.createElement("button");
    downloadPaidQrButton.type = "button";
    downloadPaidQrButton.textContent = "Download QR";
    downloadPaidQrButton.style.cssText = "border:1px solid #dec3b0;border-radius:9px;padding:10px 7px;background:#fff;color:#654739;font:700 11px Manrope,Arial,sans-serif;cursor:pointer";
    var printPaidQrButton = document.createElement("button");
    printPaidQrButton.type = "button";
    printPaidQrButton.textContent = "Print / Save Card";
    printPaidQrButton.style.cssText = downloadPaidQrButton.style.cssText;
    paidQrActions.append(downloadPaidQrButton, printPaidQrButton);
    var sharePaidQrButton = document.createElement("button");
    sharePaidQrButton.type = "button";
    sharePaidQrButton.textContent = "Share QR Code";
    sharePaidQrButton.style.cssText = "width:100%;border:1px solid #dec3b0;border-radius:9px;padding:10px;background:#fff;color:#654739;font:700 11px Manrope,Arial,sans-serif;cursor:pointer";
    var paidQrStatus = document.createElement("p");
    paidQrStatus.setAttribute("role", "status");
    paidQrStatus.style.cssText = "font-size:10px;line-height:1.45;color:#82695a;text-align:center;margin:0";
    var paidGiftCardPreview = document.createElement("article");
    paidGiftCardPreview.className = "lovena-backend-gift-card";
    paidGiftCardPreview.setAttribute("aria-label", "Preview of your printable Lovena gift card");
    var giftCardCopy = document.createElement("div");
    giftCardCopy.className = "lovena-backend-gift-card-copy";
    var giftCardBrand = document.createElement("div");
    giftCardBrand.className = "lovena-backend-gift-card-brand";
    giftCardBrand.textContent = "LOVENA";
    var giftCardKicker = document.createElement("div");
    giftCardKicker.className = "lovena-backend-gift-card-kicker";
    var giftCardHeading = document.createElement("h3");
    giftCardHeading.className = "lovena-backend-gift-card-heading";
    var giftCardMessage = document.createElement("p");
    giftCardMessage.className = "lovena-backend-gift-card-message";
    var giftCardNames = document.createElement("strong");
    giftCardNames.className = "lovena-backend-gift-card-names";
    var giftCardFooter = document.createElement("small");
    giftCardFooter.className = "lovena-backend-gift-card-footer";
    giftCardCopy.append(giftCardBrand, giftCardKicker, giftCardHeading, giftCardMessage, giftCardNames, giftCardFooter);
    var giftCardQrSide = document.createElement("div");
    giftCardQrSide.className = "lovena-backend-gift-card-qr-side";
    var giftCardQrFrame = document.createElement("div");
    giftCardQrFrame.className = "lovena-backend-gift-card-qr-frame";
    var giftCardQrImage = document.createElement("img");
    giftCardQrImage.alt = "Scan this code to open the published Lovena experience";
    giftCardQrFrame.appendChild(giftCardQrImage);
    var giftCardScan = document.createElement("strong");
    giftCardScan.className = "lovena-backend-gift-card-scan";
    var giftCardDomain = document.createElement("small");
    giftCardDomain.className = "lovena-backend-gift-card-domain";
    giftCardQrSide.append(giftCardQrFrame, giftCardScan, giftCardDomain);
    paidGiftCardPreview.append(giftCardCopy, giftCardQrSide);
    var paidGiftCardPrintNote = document.createElement("p");
    paidGiftCardPrintNote.className = "lovena-backend-gift-card-print-note";
    paidGiftCardPrintNote.textContent = "Print on A4 at 100% size and trim around the border — or choose Save as PDF.";
    var paidGiftCardStyles = document.createElement("style");
    paidGiftCardStyles.id = "lovenaBackendGiftCardStyles";
    paidGiftCardStyles.textContent = [
      ".lovena-backend-gift-card{position:relative;display:flex;align-items:stretch;gap:3.5%;width:100%;max-width:460px;aspect-ratio:1.48;margin:4px auto 0;overflow:hidden;padding:3.6%;border:1px solid #d7c8b8;border-radius:9px;background:#f7f1e8;color:#332522;box-shadow:0 7px 18px rgba(56,34,27,.09);-webkit-print-color-adjust:exact;print-color-adjust:exact}",
      ".lovena-backend-gift-card:before{content:'';position:absolute;inset:7px;border:1px solid #e1d5c8;border-radius:5px;pointer-events:none}",
      ".lovena-backend-gift-card-copy{position:relative;z-index:1;display:flex;flex:1 1 62%;flex-direction:column;align-items:flex-start;min-width:0;padding:2px 0}",
      ".lovena-backend-gift-card-brand{color:#774149;font:800 12px/1 Manrope,Arial,sans-serif;letter-spacing:3px}",
      ".lovena-backend-gift-card-kicker{margin-top:auto;margin-bottom:7px;color:#a15f61;font:800 7px/1.3 Manrope,Arial,sans-serif;letter-spacing:1.5px}",
      ".lovena-backend-gift-card-heading{max-width:100%;margin:0 0 7px;color:#3a2927;font:500 clamp(17px,3.8vw,24px)/1.08 Georgia,serif;letter-spacing:-.3px}",
      ".lovena-backend-gift-card-message{max-width:97%;margin:0;color:#78645d;font:400 clamp(8px,1.8vw,10px)/1.45 Manrope,Arial,sans-serif}",
      ".lovena-backend-gift-card-names{max-width:100%;margin-top:9px;overflow:hidden;color:#774149;font:700 clamp(9px,2vw,12px)/1.25 Manrope,Arial,sans-serif;text-overflow:ellipsis;white-space:nowrap}",
      ".lovena-backend-gift-card-footer{margin-top:auto;padding-top:7px;color:#9a8278;font:600 5.5px/1.25 Manrope,Arial,sans-serif;letter-spacing:1px}",
      ".lovena-backend-gift-card-qr-side{position:relative;z-index:1;display:flex;flex:0 0 34%;flex-direction:column;align-items:center;justify-content:center;min-width:0;padding:7px 5px;border:1px solid #e2d7cb;border-radius:6px;background:#fffdfa;text-align:center}",
      ".lovena-backend-gift-card-qr-frame{display:grid;place-items:center;width:min(100%,130px);aspect-ratio:1;margin:0 auto 7px;padding:4px;background:#fff}",
      ".lovena-backend-gift-card-qr-frame img{display:block;width:100%;height:100%;object-fit:contain;background:#fff}",
      ".lovena-backend-gift-card-scan{color:#774149;font:800 6.5px/1.25 Manrope,Arial,sans-serif;letter-spacing:.65px}",
      ".lovena-backend-gift-card-domain{max-width:100%;margin-top:4px;overflow:hidden;color:#a18b80;font:600 5px/1.2 Manrope,Arial,sans-serif;letter-spacing:.55px;text-overflow:ellipsis;white-space:nowrap}",
      ".lovena-backend-gift-card-print-note{margin:8px 0 0;color:#8d7a70;font-size:10px;line-height:1.45;text-align:center}"
    ].join("");
    if (!document.getElementById("lovenaBackendGiftCardStyles")) document.head.appendChild(paidGiftCardStyles);
    paidQrSection.append(paidQrTitle, paidQrCopy, paidGiftCardPreview, paidGiftCardPrintNote, paidQrActions, sharePaidQrButton, paidQrStatus);
    paidSharePanel.append(paidShareTitle, paidShareNote, paidShareLink, copyPaidLinkButton, paidQrSection);
    var publishButton = document.createElement("button");
    publishButton.type = "button";
    publishButton.textContent = "Publish Page & Pay " + onlinePriceLabel;
    publishButton.style.cssText = "display:block;width:100%;min-height:42px;border:0;border-radius:10px;padding:10px 12px;background:#59372f;color:#fff;font:800 12px/1.35 Manrope,Arial,sans-serif;cursor:pointer;margin:0;box-shadow:0 5px 12px rgba(89,55,47,.16)";
    var publishStatus = document.createElement("p");
    publishStatus.style.cssText = "font-size:10px;line-height:1.4;margin:0;color:#82695a;overflow-wrap:anywhere";
    publishStatus.setAttribute("role", "status");

    // Publishing, offline export, save, and preview actions live in their own panel.
    var publicationDock = document.createElement("section");
    publicationDock.className = "lovena-publication-dock";
    publicationDock.setAttribute("aria-label", "Publish and pay");
    publicationDock.style.cssText = "position:relative;display:grid;gap:8px;padding:14px;border:1px solid #e2cabb;border-radius:14px;background:#fffaf6;box-shadow:0 5px 16px rgba(73,33,28,.07)";
    var publicationDockHeader = document.createElement("div");
    publicationDockHeader.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0";
    var publicationDockLabel = document.createElement("strong");
    publicationDockLabel.textContent = "PUBLISH & PAY";
    publicationDockLabel.style.cssText = "font-size:10px;line-height:1.3;font-weight:850;letter-spacing:1.4px;color:#765044";
    publicationDockHeader.append(publicationDockLabel);

    var priceAndHtmlRow = document.createElement("div");
    priceAndHtmlRow.className = "lovena-price-html-row";
    priceAndHtmlRow.style.cssText = "display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:stretch;gap:8px;width:100%;min-width:0";
    publicationTotal.style.cssText = "display:flex;align-items:center;justify-content:flex-start;min-width:0;white-space:nowrap;font-size:14px;font-weight:850;letter-spacing:-.3px;margin:0;color:#59372f";
    includeHtmlLabel.style.cssText = "display:grid;grid-template-columns:17px minmax(0,1fr);flex:none;width:100%;min-width:0;box-sizing:border-box;gap:7px;align-items:center;padding:6px 8px;border:1px solid #dcc0ad;border-radius:9px;background:#fff;cursor:pointer;margin:0";
    includeHtmlCheckbox.style.cssText = "display:block;width:17px;height:17px;min-width:17px;flex:none;margin:0;accent-color:#784b3d;cursor:pointer";
    includeHtmlText.style.cssText = "display:grid;gap:2px;min-width:0;overflow-wrap:anywhere;font-size:10px;line-height:1.28;color:#51392f";
    includeHtmlTitle.style.cssText = "display:block;font-size:10px;line-height:1.3;overflow-wrap:anywhere";
    includeHtmlHelp.style.cssText = "display:block;font-size:9px;line-height:1.3;color:#82695a;overflow-wrap:anywhere";
    priceAndHtmlRow.append(publicationTotal, includeHtmlLabel);
    publicationDock.append(publicationDockHeader, publicationTitle, publicationCopy, priceAndHtmlRow, publishButton, publishStatus);

    var publicationBackdrop = document.createElement("div");
    publicationBackdrop.id = "lovenaPublicationBackdrop";
    publicationBackdrop.setAttribute("data-editor-only", "");
    publicationBackdrop.hidden = true;
    publicationBackdrop.style.cssText = "position:fixed;z-index:10004;inset:0;background:rgba(13,5,4,.66);backdrop-filter:blur(3px);opacity:0;pointer-events:none;transition:opacity .22s ease";
    var publicationPanel = document.createElement("aside");
    publicationPanel.id = "lovenaPublicationPanel";
    publicationPanel.setAttribute("data-editor-only", "");
    publicationPanel.setAttribute("role", "dialog");
    publicationPanel.setAttribute("aria-modal", "true");
    publicationPanel.setAttribute("aria-label", "Publish and export your Lovena page");
    publicationPanel.setAttribute("aria-hidden", "true");
    publicationPanel.hidden = true;
    publicationPanel.style.cssText = "position:fixed;z-index:10005;top:0;right:0;width:min(460px,96vw);height:100dvh;overflow:hidden;display:flex;flex-direction:column;background:#f7eee5;color:#382820;box-shadow:-20px 0 55px rgba(0,0,0,.28);font-family:Manrope,Arial,sans-serif;transform:translateX(102%);transition:transform .25s ease";
    var publicationPanelHeader = document.createElement("header");
    publicationPanelHeader.style.cssText = "display:flex;align-items:flex-start;gap:14px;justify-content:space-between;padding:21px 20px 17px;background:#2b100d;color:#f9eee5;border-bottom:1px solid rgba(255,255,255,.12);flex:0 0 auto";
    var publicationPanelHeading = document.createElement("div");
    var publicationPanelKicker = document.createElement("p");
    publicationPanelKicker.textContent = "LOVENA STUDIO";
    publicationPanelKicker.style.cssText = "font-size:9px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#c79a89;margin:0 0 7px";
    var publicationPanelTitle = document.createElement("h2");
    publicationPanelTitle.textContent = "Publish & Export";
    publicationPanelTitle.style.cssText = "font:400 24px/1.15 'Playfair Display',Georgia,serif;margin:0;color:#fff3e8";
    var publicationPanelCopy = document.createElement("p");
    publicationPanelCopy.textContent = "Manage online publishing and your downloadable gift here, separately from the editing tools.";
    publicationPanelCopy.style.cssText = "font-size:10px;line-height:1.6;color:#d8c3b5;margin:7px 0 0;max-width:330px";
    publicationPanelHeading.append(publicationPanelKicker, publicationPanelTitle, publicationPanelCopy);
    var publicationPanelClose = document.createElement("button");
    publicationPanelClose.type = "button";
    publicationPanelClose.textContent = "×";
    publicationPanelClose.setAttribute("aria-label", "Close publish and export panel");
    publicationPanelClose.style.cssText = "flex:0 0 34px;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.22);background:transparent;color:#fff0e6;font-size:23px;line-height:1;cursor:pointer";
    publicationPanelHeader.append(publicationPanelHeading, publicationPanelClose);
    var publicationPanelScroll = document.createElement("div");
    publicationPanelScroll.style.cssText = "flex:1;overflow:auto;overscroll-behavior:contain;padding:14px 16px calc(16px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:12px";
    publicationPanel.appendChild(publicationPanelHeader);
    publicationPanel.appendChild(publicationPanelScroll);

    var publicationTrigger = document.createElement("button");
    publicationTrigger.type = "button";
    publicationTrigger.id = "lovenaPublishExportTrigger";
    publicationTrigger.setAttribute("data-editor-only", "");
    publicationTrigger.setAttribute("aria-controls", "lovenaPublicationPanel");
    publicationTrigger.setAttribute("aria-expanded", "false");
    publicationTrigger.textContent = "Publish & Export";
    publicationTrigger.style.cssText = "position:fixed;z-index:10006;right:18px;left:auto;bottom:72px;display:flex;align-items:center;justify-content:center;gap:8px;max-width:calc(100vw - 36px);min-height:44px;border:1px solid rgba(248,227,212,.22);border-radius:999px;padding:12px 15px;background:#835845;color:#fff5eb;box-shadow:0 12px 30px rgba(0,0,0,.28);font:800 11px Manrope,Arial,sans-serif;cursor:pointer;white-space:nowrap";
    var publicationPanelStyle = document.createElement("style");
    publicationPanelStyle.setAttribute("data-editor-only", "");
    publicationPanelStyle.textContent = "#lovenaPublicationPanel .ed-actions{display:grid;gap:8px;border-top:0;padding:2px 0 5px;background:transparent}#lovenaPublicationPanel .ed-primary,#lovenaPublicationPanel .ed-secondary{display:flex;align-items:center;justify-content:center;gap:8px;min-height:42px;border-radius:999px;padding:10px 14px;font:800 11px Manrope,Arial,sans-serif;cursor:pointer;text-decoration:none;box-sizing:border-box}#lovenaPublicationPanel .ed-primary{border:1px solid #54241d;background:#54241d;color:#fff5eb;width:100%}#lovenaPublicationPanel .ed-secondary{border:1px solid #d8bfad;background:#fffaf5;color:#563b30}#lovenaPublicationPanel .ed-action-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}#lovenaPublicationPanel .ed-status{min-height:14px;text-align:center;color:#7e695d;font-size:9px}#lovenaPublicationPanel .ed-export-heading{display:grid;gap:7px;padding:15px 14px;border:1px solid #e2cabb;border-radius:13px;background:#fffaf6}#lovenaPublicationPanel .ed-export-heading>strong{font:700 16px/1.35 'Playfair Display',Georgia,serif;color:#51392f}#lovenaPublicationPanel .ed-export-heading .ed-help{font-size:10px;line-height:1.55;color:#82695a;margin:0}#lovenaPublicationPanel [data-editor-action='export']{width:100%;border-radius:11px}#lovenaPublicationPanel [data-editor-action='view'],#lovenaPublicationPanel [data-editor-action='save']{min-width:0}#lovenaPublishExportTrigger:focus-visible,#lovenaPublicationPanel button:focus-visible{outline:3px solid #d6a17e;outline-offset:3px}";
    document.head.appendChild(publicationPanelStyle);
    var actionFooter = panel.querySelector(".ed-actions");
    publication.append(htmlPurchaseButton, htmlPurchaseStatus, paidSharePanel);
    publicationPanelScroll.append(publicationDock, publication);
    if (actionFooter) publicationPanelScroll.appendChild(actionFooter);

    // After online publishing, expose an HTML-download entry inside the normal editing panel too.
    var editorExportSection = document.createElement("section");
    editorExportSection.className = "lovena-editor-offline-export";
    editorExportSection.setAttribute("data-editor-only", "");
    editorExportSection.setAttribute("aria-label", "Offline HTML download");
    editorExportSection.hidden = true;
    editorExportSection.style.cssText = "display:none;gap:8px;margin:0 0 14px;padding:14px;border:1px solid #e2cabb;border-radius:13px;background:#fffaf6;color:#51392f;box-shadow:0 4px 12px rgba(73,33,28,.06)";
    var editorExportTitle = document.createElement("strong");
    editorExportTitle.textContent = "A Digital Gift to Keep Forever";
    editorExportTitle.style.cssText = "font:700 16px/1.35 'Playfair Display',Georgia,serif;color:#51392f";
    var editorExportCopy = document.createElement("p");
    editorExportCopy.textContent = "Your page is published. Download a standalone HTML file with your photos, letter, stories, and animations.";
    editorExportCopy.style.cssText = "font-size:10px;line-height:1.55;color:#82695a;margin:0";
    var editorExportButton = document.createElement("button");
    editorExportButton.type = "button";
    editorExportButton.className = "ed-primary";
    editorExportButton.setAttribute("data-editor-action", "export");
    editorExportButton.textContent = "HTML offline bloqueado · US$ 1,00";
    editorExportButton.disabled = true;
    editorExportButton.setAttribute("aria-disabled", "true");
    editorExportButton.title = "Pay the additional $1.00 to unlock the offline HTML download.";
    editorExportButton.style.cssText = "width:100%;box-sizing:border-box";
    editorExportSection.append(editorExportTitle, editorExportCopy, editorExportButton);
    var editorNotice = scroll.querySelector(".ed-notice");
    if (editorNotice) editorNotice.insertAdjacentElement("afterend", editorExportSection);
    else scroll.insertBefore(editorExportSection, scroll.firstChild);

    document.body.append(publicationBackdrop, publicationPanel, publicationTrigger);

    function closePublicationPanel() {
      if (publicationPanel.hidden) return;
      publicationPanel.style.transform = "translateX(102%)";
      publicationBackdrop.style.opacity = "0";
      publicationBackdrop.style.pointerEvents = "none";
      publicationPanel.setAttribute("aria-hidden", "true");
      publicationTrigger.setAttribute("aria-expanded", "false");
      window.setTimeout(function () {
        if (publicationPanel.getAttribute("aria-hidden") === "true") {
          publicationPanel.hidden = true;
          publicationBackdrop.hidden = true;
        }
      }, 270);
    }
    function openPublicationPanel() {
      if (panel.getAttribute("aria-hidden") === "false" && panel.classList.contains("is-open")) {
        var closeEditorButton = panel.querySelector('[data-editor-action="close"]');
        if (closeEditorButton) closeEditorButton.click();
      }
      publicationBackdrop.hidden = false;
      publicationPanel.hidden = false;
      publicationPanel.setAttribute("aria-hidden", "false");
      publicationTrigger.setAttribute("aria-expanded", "true");
      publicationPanel.style.transform = "translateX(102%)";
      publicationBackdrop.style.opacity = "0";
      publicationBackdrop.style.pointerEvents = "auto";
      window.requestAnimationFrame(function () {
        publicationPanel.style.transform = "translateX(0)";
        publicationBackdrop.style.opacity = "1";
      });
      publicationPanelClose.focus();
    }
    publicationTrigger.addEventListener("click", function () {
      if (publicationPanel.hidden) openPublicationPanel();
      else closePublicationPanel();
    });
    publicationPanelClose.addEventListener("click", closePublicationPanel);
    publicationBackdrop.addEventListener("click", closePublicationPanel);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !publicationPanel.hidden) closePublicationPanel();
    });
    var previewExperienceButton = actionFooter && actionFooter.querySelector('[data-editor-action="view"]');
    if (previewExperienceButton) previewExperienceButton.addEventListener("click", closePublicationPanel);


    function updatePublicationPrice() {
      var total = basePriceCents + (includeHtmlCheckbox.checked ? addonCents : 0);
      onlinePriceLabel = priceLabel(total);
      publicationTotal.textContent = "Total: " + onlinePriceLabel;
      publicationCopy.textContent = (planIsSimple ? "Lovena Simple" : "Lovena Premium") + " · online publication for 1 year. " +
        (includeHtmlCheckbox.checked
          ? "Also includes the offline HTML download (+" + priceLabel(addonCents) + ")."
          : "Offline HTML is optional; select the checkbox beside the price to include it.");
      publishButton.textContent = "Publish Page & Pay " + onlinePriceLabel;
    }
    function applyRegionalPricing(isBrazil, selectedCurrency) {
      brazilianVisitor = !!isBrazil;
      activeCurrency = selectedCurrency === "brl" || selectedCurrency === "eur" || selectedCurrency === "usd"
        ? selectedCurrency
        : (brazilianVisitor ? "brl" : "usd");
      currencyPrefix = activeCurrency === "brl" ? "R$ " : (activeCurrency === "eur" ? "€ " : "US$ ");
      priceDecimalSeparator = activeCurrency === "usd" ? "." : ",";
      addonCents = activeCurrency === "brl" ? 500 : 100;
      basePriceCents = activeCurrency === "brl" ? (planIsSimple ? 999 : 1999) : (planIsSimple ? 499 : 999);
      includeHtmlTitle.textContent = "Add offline HTML (+" + priceLabel(addonCents) + ")";
      htmlPurchaseButton.textContent = "Offline HTML download · " + priceLabel(addonCents) + " (optional)";
      htmlPurchaseStatus.textContent = "Optional: after paying for online publishing, you can pay " + priceLabel(addonCents) + " more to download the HTML and use it offline.";
      updatePublicationPrice();
      htmlExportButtons.forEach(function (button) { if (button.disabled) button.textContent = "HTML offline bloqueado · " + priceLabel(addonCents); });
    }
    includeHtmlCheckbox.addEventListener("change", updatePublicationPrice);
    updatePublicationPrice();
    window.addEventListener("lovena:region-detected", function (event) {
      var country = event && event.detail && event.detail.countryCode;
      if (country) applyRegionalPricing(country === "BR", event.detail && event.detail.currencyCode);
    });
    if (window.LOVENA_REGION_READY) {
      window.LOVENA_REGION_READY.then(function (country) { applyRegionalPricing(country === "BR", window.LOVENA_CURRENCY_CODE); }).catch(function () {});
    }
    window.addEventListener("lovena:currency-changed", function (event) { applyRegionalPricing(window.LOVENA_IS_BRAZIL, event.detail && event.detail.currencyCode); });

    var htmlExportButtons = Array.from(document.querySelectorAll('[data-editor-action="export"]'));
    var originalExportText = htmlExportButtons.find(function (button) {
      return button !== editorExportButton;
    })?.textContent.trim() || "Download Complete Gift (.html)";
    function setHtmlExportButtons(htmlUnlocked) {
      htmlExportButtons = Array.from(document.querySelectorAll('[data-editor-action="export"]'));
      htmlExportButtons.forEach(function (button) {
        button.disabled = !htmlUnlocked;
        button.textContent = htmlUnlocked ? originalExportText : "HTML offline bloqueado · " + priceLabel(addonCents);
        button.title = htmlUnlocked
          ? "HTML download unlocked for this experience."
          : "Pay the additional " + priceLabel(addonCents) + " after publishing your online link to unlock this file.";
        button.setAttribute("aria-disabled", htmlUnlocked ? "false" : "true");
      });
    }
    setHtmlExportButtons(false);

    function renderPaidGiftCard(publicUrl) {
      var snapshot = {};
      try { snapshot = typeof options.getSnapshot === "function" ? (options.getSnapshot() || {}) : {}; } catch (_) {}
      var texts = snapshot.texts || {};
      var locale = String(snapshot.locale || snapshot.language || document.documentElement.getAttribute("data-lovena-language") || document.documentElement.lang || "en").toLowerCase();
      var pt = locale.indexOf("pt") === 0, es = locale.indexOf("es") === 0;
      var copy = pt ? {
        kicker: "UM PRESENTE SÓ DE VOCÊS",
        heading: "Um pedacinho da história de vocês.",
        message: "Fotos, palavras e músicas que guardam o que é especial para vocês.",
        scan: "APONTE A CÂMERA PARA ABRIR",
        footer: "FEITO PARA OS MOMENTOS QUE IMPORTAM",
        printNote: "Imprima em A4, em tamanho real (100%), e recorte pela borda — ou escolha Salvar como PDF."
      } : es ? {
        kicker: "UN PEQUEÑO REGALO",
        heading: "Un pedacito de su historia.",
        message: "Fotos, palabras y canciones que guardan lo especial de ustedes.",
        scan: "ESCANEA PARA ABRIR TU REGALO",
        footer: "HECHO PARA LOS MOMENTOS IMPORTANTES",
        printNote: "Imprime en A4 al 100 % y recorta el borde, o elige Guardar como PDF."
      } : {
        kicker: "A LITTLE SURPRISE",
        heading: "A little piece of your story.",
        message: "Your memories, words and music — kept in one private place.",
        scan: "SCAN TO OPEN YOUR GIFT",
        footer: "MADE FOR THE MOMENTS THAT MATTER",
        printNote: "Print on A4 at 100% size and trim around the border — or choose Save as PDF."
      };
      giftCardKicker.textContent = copy.kicker;
      giftCardHeading.textContent = copy.heading;
      giftCardMessage.textContent = copy.message;
      var cardName = String(texts.brand || "").trim();
      if (!cardName || /^(?:lovena|lovena studio)$/i.test(cardName)) {
        var visibleBrand = document.querySelector(".logo-word");
        cardName = visibleBrand && visibleBrand.textContent.trim() ? visibleBrand.textContent.trim() : "Your Lovena story";
      }
      giftCardNames.textContent = cardName.slice(0, 90);
      giftCardScan.textContent = copy.scan;
      paidQrTitle.textContent = pt ? "Um presente para entregar em mãos" : (es ? "Un regalo para entregar en persona" : "A gift they can hold on to");
      paidQrCopy.textContent = pt ? "Seu QR Code personalizado em um cartão especial, pronto para imprimir e entregar." : (es ? "Tu código QR personalizado en una tarjeta especial, lista para imprimir y regalar." : "Your personal QR code on a keepsake card, ready to print and hand over.");
      downloadPaidQrButton.textContent = pt ? "Baixar QR" : (es ? "Descargar QR" : "Download QR");
      printPaidQrButton.textContent = pt ? "Imprimir / Salvar PDF" : (es ? "Imprimir / Guardar PDF" : "Print / Save Card");
      sharePaidQrButton.textContent = pt ? "Compartilhar QR Code" : (es ? "Compartir código QR" : "Share QR Code");
      giftCardFooter.textContent = copy.footer;
      paidGiftCardPrintNote.textContent = copy.printNote;
      var qrUrl = paidQrImage.dataset.qrUrl || paidQrImage.src || "";
      giftCardQrImage.src = qrUrl;
      giftCardQrImage.onerror = function () { paidQrStatus.textContent = pt ? "Não foi possível carregar o QR Code. Verifique sua conexão." : (es ? "No se pudo cargar el código QR. Comprueba tu conexión." : "QR code could not load. Check your connection."); };
      var domain = "LOVENASTUDIO.COM";
      try { domain = new URL(publicUrl || paidShareLink.href).hostname.replace(/^www\./, "").toUpperCase(); } catch (_) {}
      giftCardDomain.textContent = domain;
      return { name: giftCardNames.textContent, copy: copy, qrUrl: qrUrl, domain: domain, locale: locale };
    }

    function escapeGiftCardHtml(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char];
      });
    }

    function printPaidGiftCard() {
      var imageUrl = paidQrImage.dataset.qrUrl;
      if (!imageUrl) { paidQrStatus.textContent = "Wait for your QR code to load first."; return; }
      var card = renderPaidGiftCard(paidShareLink.href);
      if (!card.qrUrl) { paidQrStatus.textContent = "Wait for your QR code to load first."; return; }
      var printWindow = window.open("", "_blank");
      if (!printWindow) { paidQrStatus.textContent = "Allow pop-ups to print the gift card."; return; }
      var safeName = escapeGiftCardHtml(card.name);
      var safeKicker = escapeGiftCardHtml(card.copy.kicker);
      var safeHeading = escapeGiftCardHtml(card.copy.heading);
      var safeMessage = escapeGiftCardHtml(card.copy.message);
      var safeScan = escapeGiftCardHtml(card.copy.scan);
      var safeFooter = escapeGiftCardHtml(card.copy.footer);
      var safeDomain = escapeGiftCardHtml(card.domain);
      var safeQrUrl = escapeGiftCardHtml(card.qrUrl);
      var printHtml = "<!doctype html><html lang='" + escapeGiftCardHtml(card.locale) + "'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Lovena Gift Card</title><style>" +
        "@page{size:A4 portrait;margin:0}*{box-sizing:border-box}html,body{width:210mm;height:297mm;margin:0;background:#fff}body{display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}" +
        ".card{position:relative;display:flex;align-items:stretch;gap:3.5%;width:148mm;height:100mm;padding:7mm;border:1px solid #d7c8b8;border-radius:2mm;background:#f7f1e8;color:#332522;overflow:hidden}" +
        ".card:before{content:'';position:absolute;inset:2mm;border:1px solid #e1d5c8;border-radius:1mm;pointer-events:none}" +
        ".copy{position:relative;z-index:1;display:flex;flex:1 1 62%;flex-direction:column;align-items:flex-start;min-width:0;padding:1mm 0}" +
        ".brand{color:#774149;font:800 3.2mm/1 Arial,sans-serif;letter-spacing:1mm}.kicker{margin-top:auto;margin-bottom:2mm;color:#a15f61;font:800 1.8mm/1.3 Arial,sans-serif;letter-spacing:.45mm}" +
        "h1{max-width:100%;margin:0 0 1.8mm;color:#3a2927;font:500 5.2mm/1.08 Georgia,serif;letter-spacing:-.1mm}p{max-width:97%;margin:0;color:#78645d;font:400 2.3mm/1.45 Arial,sans-serif}" +
        ".names{max-width:100%;margin-top:2.5mm;overflow:hidden;color:#774149;font:700 2.7mm/1.25 Arial,sans-serif;text-overflow:ellipsis;white-space:nowrap}.footer{margin-top:auto;padding-top:2mm;color:#9a8278;font:600 1.35mm/1.25 Arial,sans-serif;letter-spacing:.25mm}" +
        ".qrside{position:relative;z-index:1;display:flex;flex:0 0 34%;flex-direction:column;align-items:center;justify-content:center;min-width:0;padding:2mm 1.5mm;border:1px solid #e2d7cb;border-radius:1.5mm;background:#fffdfa;text-align:center}" +
        ".qrframe{display:grid;place-items:center;width:39mm;aspect-ratio:1;margin:0 auto 1.8mm;padding:1.2mm;background:#fff}.qrframe img{display:block;width:100%;height:100%;object-fit:contain}" +
        ".scan{color:#774149;font:800 1.7mm/1.25 Arial,sans-serif;letter-spacing:.2mm}.domain{max-width:100%;margin-top:1mm;overflow:hidden;color:#a18b80;font:600 1.35mm/1.2 Arial,sans-serif;letter-spacing:.15mm;text-overflow:ellipsis;white-space:nowrap}" +
        "</style></head><body><main class='card'><div class='copy'><div class='brand'>LOVENA</div><div class='kicker'>" + safeKicker + "</div><h1>" + safeHeading + "</h1><p>" + safeMessage + "</p><div class='names'>" + safeName + "</div><small class='footer'>" + safeFooter + "</small></div><div class='qrside'><div class='qrframe'><img id='giftQr' alt='Scan to open your Lovena gift' src='" + safeQrUrl + "'></div><strong class='scan'>" + safeScan + "</strong><small class='domain'>" + safeDomain + "</small></div></main><script>var q=document.getElementById('giftQr');var didPrint=false;function printCard(){if(didPrint)return;didPrint=true;window.focus();setTimeout(function(){window.print();},350)}if(q.complete&&q.naturalWidth)printCard();else q.onload=printCard;<\/script></body></html>";
      printWindow.document.open();
      printWindow.document.write(printHtml);
      printWindow.document.close();
      paidQrStatus.textContent = card.locale.indexOf("pt") === 0 ? "Seu cartão está pronto para imprimir ou salvar como PDF." : (card.locale.indexOf("es") === 0 ? "Tu tarjeta está lista para imprimir o guardar como PDF." : "Your gift card is ready to print or save as a PDF.");
    }

    function applyPurchaseEntitlements(entitlements) {
      var onlinePaid = !!(entitlements && entitlements.onlinePaid);
      var htmlUnlocked = !!(entitlements && entitlements.includesHtmlDownload);
      var publicUrl = entitlements && entitlements.publicUrl;
      setHtmlExportButtons(htmlUnlocked);
      editorExportCopy.textContent = htmlUnlocked
        ? "Download a standalone HTML file with your photos, letter, stories, and animations, ready to keep offline."
        : "Your page is published. The HTML download requires the optional " + priceLabel(addonCents) + " offline add-on in Publish & Export.";
      editorExportSection.hidden = !onlinePaid;
      editorExportSection.style.display = onlinePaid ? "grid" : "none";
      publicationDock.hidden = onlinePaid;
      publicationDock.style.display = onlinePaid ? "none" : "grid";
      publicationTrigger.textContent = onlinePaid ? "Export & Share" : "Publish & Export";
      publicationPanelCopy.textContent = onlinePaid
        ? "Your page is published. Manage sharing and the offline HTML download here."
        : "Manage online publishing and your downloadable gift here, separately from the editing tools.";
      if (htmlUnlocked) includeHtmlCheckbox.checked = true;
      includeHtmlCheckbox.disabled = onlinePaid;
      updatePublicationPrice();
      publishButton.disabled = onlinePaid;
      publishButton.textContent = onlinePaid
        ? "Payment confirmed · online link unlocked"
        : "Publish Page & Pay " + onlinePriceLabel;
      var showHtmlOption = onlinePaid && !!publicUrl;
      htmlPurchaseButton.hidden = !showHtmlOption;
      htmlPurchaseStatus.hidden = !showHtmlOption;
      htmlPurchaseButton.disabled = !showHtmlOption || htmlUnlocked;
      htmlPurchaseButton.textContent = htmlUnlocked
        ? "Download HTML desbloqueado ✓"
        : "Offline HTML download · $1.00 (optional)";
      htmlPurchaseStatus.textContent = htmlUnlocked
        ? "Additional purchase confirmed. The download button in the editor is unlocked."
        : "Optional: pay $1.00 more to download the HTML and keep your experience offline.";
      if (onlinePaid && publicUrl) {
        paidSharePanel.hidden = false;
        paidShareNote.hidden = false;
        paidShareLink.href = publicUrl;
        paidShareLink.textContent = publicUrl;
        paidQrImage.src = "https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=18&format=png&data=" + encodeURIComponent(publicUrl);
        paidQrImage.dataset.qrUrl = paidQrImage.src;
        renderPaidGiftCard(publicUrl);
        paidQrImage.onerror = function () { paidQrStatus.textContent = "QR code could not load. Check your connection and reopen Publish & Export."; };
        try { localStorage.setItem("lovenaPublicUrl:" + options.editorKey, publicUrl); } catch (_) {}
      } else {
        paidSharePanel.hidden = true;
        paidQrImage.removeAttribute("src");
        paidQrImage.removeAttribute("data-qr-url");
        paidQrStatus.textContent = "";
      }
    }

    async function getPaidQrBlob() {
      var qrUrl = paidQrImage.dataset.qrUrl;
      if (!qrUrl || !paidShareLink.href || paidShareLink.href === "about:blank") throw new Error("qr_not_ready");
      var response = await fetch(qrUrl, { mode: "cors" });
      if (!response.ok) throw new Error("qr_download_failed");
      return await response.blob();
    }
    downloadPaidQrButton.addEventListener("click", async function () {
      downloadPaidQrButton.disabled = true;
      try {
        var blob = await getPaidQrBlob();
        var objectUrl = URL.createObjectURL(blob);
        var anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = "lovena-qr-code.png";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1500);
        paidQrStatus.textContent = "QR code downloaded. You can print the PNG or send it to someone.";
      } catch (_) {
        paidQrStatus.textContent = "Automatic download failed. Open the QR image, then save it from your browser.";
      } finally {
        downloadPaidQrButton.disabled = false;
      }
    });
    printPaidQrButton.addEventListener("click", printPaidGiftCard);
    sharePaidQrButton.addEventListener("click", async function () {
      sharePaidQrButton.disabled = true;
      try {
        var blob = await getPaidQrBlob();
        if (navigator.share && navigator.canShare && typeof File !== "undefined") {
          var file = new File([blob], "lovena-qr-code.png", { type: blob.type || "image/png" });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ title: "My Lovena experience", text: "Scan this QR code to open my Lovena gift.", files: [file] });
            paidQrStatus.textContent = "QR code shared.";
          } else if (navigator.share) {
            await navigator.share({ title: "My Lovena experience", text: "Open this personal gift: " + paidShareLink.href, url: paidShareLink.href });
            paidQrStatus.textContent = "Share sheet opened with your personal link.";
          } else { throw new Error("share_unavailable"); }
        } else if (navigator.share) {
          await navigator.share({ title: "My Lovena experience", text: "Open this personal gift: " + paidShareLink.href, url: paidShareLink.href });
          paidQrStatus.textContent = "Share sheet opened with your personal link.";
        } else {
          await navigator.clipboard.writeText(paidShareLink.href);
          paidQrStatus.textContent = "Your device cannot share an image here, so the personal link was copied instead.";
        }
      } catch (error) {
        if (error && error.name === "AbortError") paidQrStatus.textContent = "Sharing canceled.";
        else paidQrStatus.textContent = "Could not share automatically. Download the QR code or copy the published link.";
      } finally {
        sharePaidQrButton.disabled = false;
      }
    });

    copyPaidLinkButton.addEventListener("click", async function () {
      var url = paidShareLink.href;
      if (!url || url === "about:blank") return;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(url);
        } else {
          var temporaryInput = document.createElement("textarea");
          temporaryInput.value = url;
          temporaryInput.style.position = "fixed";
          temporaryInput.style.opacity = "0";
          document.body.appendChild(temporaryInput);
          temporaryInput.select();
          var copied = document.execCommand("copy");
          temporaryInput.remove();
          if (!copied) throw new Error("copy_failed");
        }
        htmlPurchaseStatus.textContent = "Link copied. You can now share it with anyone.";
      } catch (_) {
        htmlPurchaseStatus.textContent = "Could not copy automatically. Click the link above, copy the address, and share it.";
      }
    });

    async function refreshPurchaseEntitlements() {
      var params = new URLSearchParams(window.location.search);
      var experienceId = params.get("experience_id") || localStorage.getItem(remoteIdKey(options.editorKey));
      if (!experienceId) {
        applyPurchaseEntitlements({ onlinePaid: false, includesHtmlDownload: false, publicUrl: null });
        return;
      }
      try {
        var entitlements = await getPurchaseEntitlements(experienceId);
        applyPurchaseEntitlements(entitlements);
      } catch (error) {
        htmlPurchaseStatus.textContent = error.message || "Could not verify purchases. Refresh the page and try again.";
      }
    }
    refreshPurchaseEntitlements();

    htmlPurchaseButton.addEventListener("click", async function () {
      var params = new URLSearchParams(window.location.search);
      var experienceId = params.get("experience_id") || localStorage.getItem(remoteIdKey(options.editorKey));
      if (!experienceId) {
        htmlPurchaseStatus.textContent = "Save your experience and publish its online link before purchasing the offline HTML.";
        return;
      }
      htmlPurchaseButton.disabled = true;
      htmlPurchaseButton.textContent = "Preparing HTML checkout…";
      try {
        var checkout = await createCheckout(experienceId, options.editorKey, "html_download");
        htmlPurchaseStatus.textContent = "Abrindo o checkout seguro da Stripe para o adicional de " + priceLabel(addonCents) + "…";
        window.location.assign(checkout.url);
      } catch (error) {
        htmlPurchaseStatus.textContent = error.message || "Could not start the offline HTML purchase.";
        await refreshPurchaseEntitlements();
      }
    });

    publishButton.addEventListener("click", async function () {
      if (!options || typeof options.getSnapshot !== "function") {
        publishStatus.textContent = "The editor is not ready to sync yet.";
        return;
      }
      publishButton.disabled = true;
      publishButton.textContent = "Saving securely…";
      publishStatus.textContent = "Saving text and photos to the cloud.";
      try {
        var snapshot = options.getSnapshot();
        localStorage.setItem(options.editorKey, JSON.stringify(snapshot));
        var result = await saveDraft(snapshot, options.editorKey);
        var selectedPurchaseType = includeHtmlCheckbox.checked ? "online_with_html" : "online";
        var checkout = await createCheckout(result.id, options.editorKey, selectedPurchaseType);
        publishStatus.textContent = includeHtmlCheckbox.checked
          ? "Opening secure checkout for online publishing and offline HTML…"
          : "Abrindo o checkout seguro do Stripe…";
        window.location.assign(checkout.url);
      } catch (error) {
        publishStatus.textContent = error.message || "Could not start checkout. Your local draft is still available.";
      } finally {
        publishButton.disabled = false;
        publishButton.textContent = "Publish Page & Pay " + onlinePriceLabel;
      }
    });

    function notify(message, isError) {
      authStatus.textContent = message;
      authStatus.style.color = isError ? "#a33d36" : "#7a5947";
      if (status) status.textContent = message;
    }
    async function refreshAuth() {
      try {
        var supabase = await client();
        var session = await currentSession(supabase);
        var user = session && session.user;
        if (!user) {
          description.textContent = "Your changes remain saved in this browser. Sign in or create an account to recover drafts on other devices.";
          notify("You are not connected to the cloud yet.", false);
          return;
        }
        if (user.is_anonymous) {
          description.textContent = "Your draft can sync in this browser. Link an email and password to recover your experience on other devices.";
          notify("Temporary session active in this browser.", false);
          email.value = email.value || (user.email || "");
        } else {
          description.textContent = "Your account is connected. Cloud drafts are associated with this user.";
          notify("Conectado como " + (user.email || "Lovena account") + ".", false);
          email.value = user.email || email.value;
        }
      } catch (error) {
        description.textContent = "Local saving remains available while the connection is being configured.";
        notify(error.message || "Could not check the account.", true);
      }
    }
    async function authAction(action) {
      var address = email.value.trim();
      var secret = password.value;
      if (!address || address.indexOf("@") < 1) { notify("Enter a valid email address.", true); return; }
      if (action !== "reset" && secret.length < 8) { notify("Use a password with at least 8 characters.", true); return; }
      loginButton.disabled = createButton.disabled = resetButton.disabled = true;
      try {
        var supabase = await client();
        var session = await currentSession(supabase);
        var user = session && session.user;
        if (action === "login") {
          var login = await supabase.auth.signInWithPassword({ email: address, password: secret });
          if (login.error) throw login.error;
          notify("Signed in. Cloud sync is connected.", false);
        } else if (action === "create") {
          var result;
          if (user && user.is_anonymous) {
            result = await supabase.auth.updateUser({ email: address, password: secret });
          } else {
            result = await supabase.auth.signUp({ email: address, password: secret });
          }
          if (result.error) throw result.error;
          if (result.data && result.data.session) {
            notify("Account ready. Your draft remains linked to it.", false);
          } else {
            notify("Check your email to confirm your account, then sign in here.", false);
          }
        } else {
          var reset = await supabase.auth.resetPasswordForEmail(address, {
            redirectTo: SITE_BASE + "experience.html?edit=1"
          });
          if (reset.error) throw reset.error;
          notify("If that email is registered, you will receive recovery instructions.", false);
        }
        await refreshAuth();
        if (status && action !== "reset") status.textContent = "Account updated · saving to the cloud";
      } catch (error) {
        notify(error.message || "Could not complete the account operation.", true);
      } finally {
        loginButton.disabled = createButton.disabled = resetButton.disabled = false;
      }
    }
    loginButton.addEventListener("click", function () { authAction("login"); });
    createButton.addEventListener("click", function () { authAction("create"); });
    resetButton.addEventListener("click", function () { authAction("reset"); });
    cloudButton.addEventListener("click", async function () {
      cloudButton.disabled = true;
      try {
        var local = localStorage.getItem(options.editorKey);
        if (local && !window.confirm("Loading the latest cloud draft will replace this browser's current draft. Continue?")) return;
        var remote = await loadDraft(options.editorKey);
        if (!remote) { notify("No cloud draft for this version was found for this account.", false); return; }
        localStorage.setItem(options.editorKey, JSON.stringify(remote.snapshot));
        localStorage.setItem(remoteIdKey(options.editorKey), remote.id);
        notify("Draft loaded. Updating the editor…", false);
        location.reload();
      } catch (error) {
        notify(error.message || "Could not load the cloud draft.", true);
      } finally {
        cloudButton.disabled = false;
      }
    });

    refreshAuth();
    client().then(function (supabase) {
      var result = supabase.auth.onAuthStateChange(function () { window.setTimeout(refreshAuth, 0); });
      authSubscription = result.data && result.data.subscription;
    }).catch(function (error) { console.warn("Lovena Auth listener:", error.message); });

    var query = new URLSearchParams(location.search);
    if (query.get("checkout") === "cancelled") {
      publishButton.disabled = false;
      publishStatus.textContent = "Payment canceled. Your draft is still saved; review it and try again whenever you are ready.";
    } else if (query.get("checkout") === "success") {
      var checkoutSessionId = query.get("session_id");
      var checkoutExperienceId = query.get("experience_id");
      var checkoutReturnStatus = document.createElement("p");
      checkoutReturnStatus.setAttribute("role", "status");
      checkoutReturnStatus.setAttribute("aria-live", "polite");
      checkoutReturnStatus.style.cssText = "font-size:12px;line-height:1.55;margin:9px 0;color:#765d50;overflow-wrap:anywhere";
      checkoutReturnStatus.textContent = "Securely confirming your payment…";
      var verifyButton = document.createElement("button");
      verifyButton.type = "button";
      verifyButton.textContent = "Checking payment…";
      verifyButton.style.cssText = "width:100%;border:1px solid #dec3b0;border-radius:10px;padding:10px;background:#fff;color:#654739;font:700 12px Manrope,Arial,sans-serif;cursor:pointer;margin-top:8px";
      publicationDock.insertBefore(verifyButton, publishStatus);
      publicationDock.insertBefore(checkoutReturnStatus, publishStatus);
      publishButton.disabled = true;
      publishButton.textContent = "Confirming payment…";
      var verifyAttempts = 0;
      var verifyRunning = false;
      var verifyTimer = null;
      var paymentConfirmed = false;
      var paymentStopped = false;

      async function verifyCheckoutPayment(manual) {
        if (verifyRunning || paymentConfirmed || paymentStopped) return;
        if (!checkoutSessionId || !checkoutExperienceId) {
          checkoutReturnStatus.textContent = "I could not find details for this payment session. Keep this page open and try opening the Stripe return link again.";
          verifyButton.disabled = false;
          verifyButton.textContent = "Missing payment details";
          paymentStopped = true;
          return;
        }
        verifyRunning = true;
        verifyAttempts += 1;
        verifyButton.disabled = true;
        verifyButton.textContent = "Checking payment…";
        checkoutReturnStatus.textContent = manual
          ? "Checking the latest status from Stripe…"
          : "Waiting for secure confirmation from Stripe. Do not make another purchase while we check this one.";
        var retry = false;
        try {
          var result = await getCheckoutStatus(checkoutSessionId, checkoutExperienceId);
          if (result.status === "paid" && (result.publicUrl || result.includesHtmlDownload)) {
            paymentConfirmed = true;
            reportGoogleAdsPurchase(result);
            applyPurchaseEntitlements(result);
            if (result.publicUrl) {
              checkoutReturnStatus.textContent = result.includesHtmlDownload
                ? "Payment confirmed! Your page is published and the HTML download is unlocked."
                : "Payment confirmed! Your page is published and ready to share.";
              try { localStorage.setItem("lovenaPublicUrl:" + options.editorKey, result.publicUrl); } catch (_) {}
            } else {
              checkoutReturnStatus.textContent = "Payment confirmed! The offline HTML download is unlocked. The online plan has not been confirmed as paid.";
            }
            publishStatus.textContent = checkoutReturnStatus.textContent;
            verifyButton.hidden = true;
          } else if (result.status === "failed" || result.status === "refunded" || result.status === "disputed") {
            paymentStopped = true;
            publishButton.disabled = result.status !== "failed";
            publishButton.textContent = result.status === "failed"
              ? "Try Publishing & Paying " + onlinePriceLabel
              : "Payment Not Eligible";
            checkoutReturnStatus.textContent = result.status === "failed"
              ? "This payment was not completed. Your draft is still saved; you can try again."
              : "This payment is not eligible for publication. Contact support before trying again.";
            verifyButton.hidden = true;
          } else {
            retry = verifyAttempts < 12;
            checkoutReturnStatus.textContent = "Your payment is still being confirmed. We will check again automatically; you do not need to create an account or repeat the purchase.";
          }
        } catch (error) {
          checkoutReturnStatus.textContent = error.message || "We could not confirm the payment yet. We will try again.";
          retry = verifyAttempts < 8;
        } finally {
          verifyRunning = false;
          if (paymentConfirmed || paymentStopped) {
            verifyButton.disabled = true;
          } else if (retry) {
            verifyButton.disabled = true;
            verifyButton.textContent = "Verificando automaticamente…";
            var delay = Math.min(1500 + verifyAttempts * 500, 5000);
            verifyTimer = window.setTimeout(function () { verifyCheckoutPayment(false); }, delay);
          } else {
            verifyButton.disabled = false;
            verifyButton.textContent = "Verify Payment Again";
            checkoutReturnStatus.textContent += " Use the button to check again. Do not purchase again while the status is pending.";
          }
          refreshPurchaseEntitlements();
        }
      }
      verifyButton.addEventListener("click", function () {
        verifyAttempts = 0;
        paymentStopped = false;
        if (verifyTimer) { window.clearTimeout(verifyTimer); verifyTimer = null; }
        verifyCheckoutPayment(true);
      });
      verifyCheckoutPayment(false);
    }

    if (query.get("checkout") === "cancelled" || query.get("checkout") === "success") {
      window.setTimeout(openPublicationPanel, 80);
    }

    if (options && options.setStatus) {
      window.addEventListener("lovena:cloud-saved", function (event) {
        var result = event.detail || {};
        notify(result.published
          ? "Published gift saved. The existing share link now shows these changes."
          : (result.anonymous
            ? "Cloud draft in this temporary session. Link an email to recover it on other devices."
            : "Draft synced to the cloud."), false);
      });
    }
  }

  window.LovenaBackend = {
    ready: ready,
    saveDraft: saveDraft,
    loadDraft: loadDraft,
    getPublicExperience: getPublicExperience,
    createCheckout: createCheckout,
    getCheckoutStatus: getCheckoutStatus,
    mountEditor: mountEditor,
    projectUrl: SUPABASE_URL,
    siteBase: SITE_BASE
  };
})();