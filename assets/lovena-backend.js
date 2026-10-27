/* Lovena Studio backend bridge.
   Only the publishable Supabase key belongs in this browser file.
   Service-role keys and Stripe secrets must stay in Supabase Edge Function secrets. */
(function () {
  "use strict";
  var SUPABASE_URL = "https://cjlbiohykewwizbdtgvw.supabase.co";
  var SUPABASE_KEY = "sb_publishable_aW937JX-8n2NaDkohgjmfg_Q5sO9IxL";
  var CLIENT_VERSION = "2.49.1";
  var SITE_BASE = "https://flaviosilva-create.github.io/lovena-studio/";
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
        if (!result.data || !result.data.user) throw new Error("O Supabase não retornou uma sessão válida.");
        return result.data.user;
      }).finally(function () { signInPromise = null; });
    }
    return await signInPromise;
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
        if (!response.ok) throw new Error("Não foi possível preparar uma foto para a nuvem.");
        var blob = await response.blob();
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
    if (listed.error) { console.warn("Lovena: não foi possível verificar mídias antigas.", listed.error.message); return; }
    var remove = (listed.data || []).map(function (item) { return item.storage_path; }).filter(function (path) { return !used.has(path); });
    if (!remove.length) return;
    var objects = await supabase.storage.from("lovena-media").remove(remove);
    if (objects.error) console.warn("Lovena: algumas mídias antigas não foram removidas.", objects.error.message);
    var metadata = await supabase.from("lovena_media").delete().eq("experience_id", experienceId).in("storage_path", remove);
    if (metadata.error) console.warn("Lovena: metadados de mídia antiga não foram removidos.", metadata.error.message);
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
      if (signed.error || !signed.data || !signed.data.signedUrl) throw (signed.error || new Error("Não foi possível abrir uma foto salva."));
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
    var snapshot = await resolvePrivateMedia(row.experience_data || {}, supabase);
    return { id: row.id, snapshot: snapshot, updatedAt: row.updated_at, plan: row.plan, user: user };
  }

  async function saveDraft(snapshot, editorKey) {
    var supabase = await client();
    var user = await currentUser(supabase, true);
    var idKey = remoteIdKey(editorKey);
    var experienceId = localStorage.getItem(idKey);
    var existing = null;

    if (experienceId) {
      var lookup = await supabase.from("lovena_experiences")
        .select("id, owner_id, status, public_slug")
        .eq("id", experienceId).eq("owner_id", user.id).maybeSingle();
      if (lookup.error) throw lookup.error;
      existing = lookup.data;
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
    }, new Map(), { value: 0 });

    var update = await supabase.from("lovena_experiences").update({
      experience_data: transformed,
      locale: (snapshot.data && (snapshot.data.locale || snapshot.data.language)) || document.documentElement.lang || "pt-BR",
      updated_at: new Date().toISOString()
    }).eq("id", experienceId).eq("owner_id", user.id).eq("status", "draft").is("public_slug", null).select("id").single();
    if (update.error) throw update.error;
    await pruneUnusedMedia(supabase, experienceId, transformed);
    return { id: experienceId, userId: user.id, savedAt: new Date().toISOString(), anonymous: !!user.is_anonymous };
  }

  async function getPublicExperience(slug) {
    if (!slug || !/^[a-zA-Z0-9_-]{6,160}$/.test(slug)) throw new Error("Link de experiência inválido.");
    var response = await fetch(SUPABASE_URL + "/functions/v1/lovena-public-experience?slug=" + encodeURIComponent(slug), {
      method: "GET",
      headers: { apikey: SUPABASE_KEY },
      cache: "no-store"
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || (response.status === 404 ? "Esta experiência não foi encontrada." : "Não foi possível carregar esta experiência."));
    return body;
  }

  async function createCheckout(experienceId, editorKey, htmlDownload) {
    var supabase = await client();
    var user = await currentUser(supabase, true);
    var session = await currentSession(supabase);
    if (!session || !session.access_token) throw new Error("Entre na Lovena para iniciar o pagamento.");
    var response = await fetch(SUPABASE_URL + "/functions/v1/lovena-create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + session.access_token },
      body: JSON.stringify({ experienceId: experienceId, plan: planFor(editorKey), htmlDownload: !!htmlDownload })
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok || !body.url) throw new Error(body.error || "Não foi possível iniciar o pagamento.");
    return body;
  }

  async function getCheckoutStatus(sessionId, experienceId) {
    var supabase = await client();
    var session = await currentSession(supabase);
    if (!session || !session.access_token) throw new Error("Entre na conta usada na compra para verificar o pagamento.");
    var response = await fetch(SUPABASE_URL + "/functions/v1/lovena-checkout-status", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + session.access_token },
      body: JSON.stringify({ sessionId: sessionId, experienceId: experienceId })
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || "Não foi possível verificar o pagamento.");
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
    heading.textContent = "Salvar e acessar sua Lovena em outros dispositivos";
    heading.style.cssText = "display:block;font-size:14px;margin-bottom:6px";
    var description = document.createElement("p");
    description.style.cssText = "font-size:12px;line-height:1.55;margin:0 0 10px;color:#82695a";
    var authStatus = document.createElement("p");
    authStatus.style.cssText = "font-size:12px;line-height:1.4;margin:0 0 10px;color:#7a5947";
    authStatus.setAttribute("role", "status");
    var email = document.createElement("input");
    email.type = "email"; email.autocomplete = "email"; email.placeholder = "Seu e-mail";
    email.setAttribute("aria-label", "E-mail da conta Lovena");
    email.style.cssText = "display:block;width:100%;box-sizing:border-box;padding:10px 11px;border:1px solid #dfc6b4;border-radius:9px;margin:7px 0;background:#fff;color:#51392f";
    var password = document.createElement("input");
    password.type = "password"; password.autocomplete = "current-password"; password.placeholder = "Senha (mínimo 8 caracteres)";
    password.setAttribute("aria-label", "Senha da conta Lovena");
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
    var createButton = makeButton("Criar conta / vincular e-mail");
    var cloudButton = makeButton("Carregar último rascunho da nuvem");
    var resetButton = makeButton("Esqueci minha senha");
    box.append(heading, description, authStatus, email, password, buttons);
    var liveGuide = scroll.querySelector(".ed-live-guide");
    if (liveGuide) scroll.insertBefore(box, liveGuide); else scroll.insertBefore(box, scroll.firstChild);

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
          description.textContent = "As alterações continuam guardadas neste navegador. Entre ou crie uma conta para recuperar rascunhos em outros dispositivos.";
          notify("Você ainda não está conectado à nuvem.", false);
          return;
        }
        if (user.is_anonymous) {
          description.textContent = "Seu rascunho pode ser sincronizado neste navegador. Vincule um e-mail e senha para recuperar sua experiência em outros dispositivos.";
          notify("Sessão temporária ativa neste navegador.", false);
          email.value = email.value || (user.email || "");
        } else {
          description.textContent = "Sua conta está conectada. Os rascunhos salvos na nuvem ficam associados a este usuário.";
          notify("Conectado como " + (user.email || "conta Lovena") + ".", false);
          email.value = user.email || email.value;
        }
      } catch (error) {
        description.textContent = "O salvamento local continua disponível enquanto a conexão é configurada.";
        notify(error.message || "Não foi possível consultar a conta.", true);
      }
    }
    async function authAction(action) {
      var address = email.value.trim();
      var secret = password.value;
      if (!address || address.indexOf("@") < 1) { notify("Digite um e-mail válido.", true); return; }
      if (action !== "reset" && secret.length < 8) { notify("Use uma senha com pelo menos 8 caracteres.", true); return; }
      loginButton.disabled = createButton.disabled = resetButton.disabled = true;
      try {
        var supabase = await client();
        var session = await currentSession(supabase);
        var user = session && session.user;
        if (action === "login") {
          var login = await supabase.auth.signInWithPassword({ email: address, password: secret });
          if (login.error) throw login.error;
          notify("Login realizado. A nuvem está conectada.", false);
        } else if (action === "create") {
          var result;
          if (user && user.is_anonymous) {
            result = await supabase.auth.updateUser({ email: address, password: secret });
          } else {
            result = await supabase.auth.signUp({ email: address, password: secret });
          }
          if (result.error) throw result.error;
          if (result.data && result.data.session) {
            notify("Conta pronta. Seu rascunho permanece vinculado a ela.", false);
          } else {
            notify("Confira seu e-mail para confirmar a conta e depois entre aqui.", false);
          }
        } else {
          var reset = await supabase.auth.resetPasswordForEmail(address, {
            redirectTo: SITE_BASE + "experience.html?edit=1"
          });
          if (reset.error) throw reset.error;
          notify("Se o e-mail estiver cadastrado, você receberá as instruções de recuperação.", false);
        }
        await refreshAuth();
        if (status && action !== "reset") status.textContent = "Conta atualizada · salvando na nuvem";
      } catch (error) {
        notify(error.message || "Não foi possível concluir a operação de conta.", true);
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
        if (local && !window.confirm("Carregar o último rascunho da nuvem substituirá o rascunho atual deste navegador. Deseja continuar?")) return;
        var remote = await loadDraft(options.editorKey);
        if (!remote) { notify("Não encontrei um rascunho remoto desta versão para esta conta.", false); return; }
        localStorage.setItem(options.editorKey, JSON.stringify(remote.snapshot));
        localStorage.setItem(remoteIdKey(options.editorKey), remote.id);
        notify("Rascunho carregado. Atualizando o editor…", false);
        location.reload();
      } catch (error) {
        notify(error.message || "Não foi possível carregar o rascunho da nuvem.", true);
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
      notify("Pagamento cancelado. Seu rascunho continua salvo.", false);
    } else if (query.get("checkout") === "success") {
      notify("Pagamento enviado. Clique em “Verificar pagamento” após a confirmação do Stripe.", false);
      var verifyButton = makeButton("Verificar pagamento");
      verifyButton.addEventListener("click", async function () {
        var sessionId = query.get("session_id");
        var experienceId = query.get("experience_id");
        if (!sessionId || !experienceId) { notify("Não encontrei os dados desta sessão de pagamento.", true); return; }
        verifyButton.disabled = true;
        try {
          var result = await getCheckoutStatus(sessionId, experienceId);
          if (result.status === "paid" && result.publicUrl) {
            notify("Pagamento confirmado! Seu link está pronto: " + result.publicUrl, false);
            var link = document.createElement("a");
            link.href = result.publicUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
            link.textContent = "Abrir experiência publicada";
            link.style.cssText = "display:block;margin-top:8px;color:#8b5541;overflow-wrap:anywhere";
            box.appendChild(link);
          } else {
            notify("O Stripe ainda não confirmou o pagamento. Aguarde um pouco e tente verificar novamente.", false);
          }
        } catch (error) { notify(error.message || "Não foi possível verificar o pagamento.", true); }
        finally { verifyButton.disabled = false; }
      });
    }

    if (options && options.setStatus) {
      window.addEventListener("lovena:cloud-saved", function (event) {
        var result = event.detail || {};
        notify(result.anonymous
          ? "Rascunho na nuvem nesta sessão temporária. Vincule um e-mail para recuperar em outros dispositivos."
          : "Rascunho sincronizado na nuvem.", false);
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