(function () {
  "use strict";

  // GTranslate translates the static landing page. This bridge handles UI
  // rendered dynamically by the creator and recipient experience. Keeping
  // these roots separate prevents the bridge from blocking static translation.
  // User-authored content stays in the language its creator wrote it in.
  var SOURCE_LANGUAGE = "en";
  var TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/t";
  var TRANSLATE_FALLBACK_ENDPOINT = "https://clients5.google.com/translate_a/t";
  var CACHE_KEY = "lovenaDynamicTranslationCacheV3";
  var ROOT_IDS = ["studioOverlay", "readerOverlay", "studioToast", "loveWorldHeadingCopy", "lovenaEditor", "lovenaEditHint", "lovenaEditorTrigger", "detailModal", "lovenaExperienceLanguageControl", "lovenaPublicationPanel", "lovenaPublishExportTrigger"];
  var textOriginals = new WeakMap();
  var attrOriginals = new WeakMap();
  var cache = new Map();
  var observer = null;
  var selectorObserver = null;
  var englishResetPending = false;
  var scheduledTimer = 0;
  var generation = 0;
  var running = false;
  var pending = false;
  var activeLanguage = SOURCE_LANGUAGE;
  var attempts = 0;
  var roots = [];
  var originalExperienceMetadata = null;

  function canonicalLanguage(value) {
    // Empty widget values are placeholders, not English.
    var parts = String(value || "").split("|").map(function (part) { return part.trim(); }).filter(Boolean);
    if (!parts.length) return "";
    var lang = parts[0];
    if (parts.length > 1) {
      var first = parts[0].toLowerCase();
      var last = parts[parts.length - 1].toLowerCase();
      if (first === SOURCE_LANGUAGE.toLowerCase()) lang = parts[parts.length - 1];
      else if (last === SOURCE_LANGUAGE.toLowerCase()) lang = parts[0];
      else lang = parts[parts.length - 1];
    }
    var low = lang.toLowerCase();
    if (low === "zh-cn" || low === "zh-hans") return "zh-CN";
    if (low === "zh-tw" || low === "zh-hant") return "zh-TW";
    if (low === "pt-br") return "pt";
    if (low === "iw") return "he";
    if (low === "jw") return "jv";
    if (low === "fil") return "tl";
    return low;
  }

  function isBrazilianVisitor() {
    if (window.LOVENA_REGION_COUNTRY) return window.LOVENA_REGION_COUNTRY === "BR";
    try {
      var locale = String(navigator.language || "").toLowerCase();
      var languages = Array.isArray(navigator.languages) ? navigator.languages.map(function (item) { return String(item).toLowerCase(); }) : [];
      var timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      var brazilianTimezones = "|America/Sao_Paulo|America/Fortaleza|America/Recife|America/Manaus|America/Belem|America/Bahia|America/Campo_Grande|America/Cuiaba|America/Porto_Velho|America/Boa_Vista|America/Rio_Branco|America/Noronha|America/Maceio|America/Araguaina|America/Santarem|";
      return locale === "pt-br" || languages.indexOf("pt-br") !== -1 || brazilianTimezones.indexOf("|" + timezone + "|") !== -1;
    } catch (error) { return String(navigator.language || "").toLowerCase() === "pt-br"; }
  }

  function readManualLanguage() {
    try { return canonicalLanguage(sessionStorage.getItem("lovenaManualLanguage") || ""); }
    catch (error) { return ""; }
  }

  function readSavedLanguage() {
    try { return canonicalLanguage(localStorage.getItem("lovenaPreferredLanguage") || ""); }
    catch (error) { return ""; }
  }

  function optionLanguage(option) {
    if (!option) return "";
    var value = String(option.value || "").trim();
    // Empty values are placeholders like "Select language", never a language code.
    if (!value) return "";
    return canonicalLanguage(value);
  }

  function ensureEnglishOption(selector) {
    if (!selector || selector.tagName !== "SELECT" || !selector.options) return;
    var hasEnglish = Array.from(selector.options).some(function (option) {
      return String(option.value || "").trim() && optionLanguage(option) === SOURCE_LANGUAGE;
    });
    if (hasEnglish) return;
    var previousValue = selector.value;
    var english = document.createElement("option");
    english.value = SOURCE_LANGUAGE + "|" + SOURCE_LANGUAGE;
    english.textContent = "English";
    english.setAttribute("data-lovena-source-language", "true");
    var placeholder = Array.from(selector.options).find(function (option) { return !String(option.value || "").trim(); });
    if (placeholder) selector.insertBefore(english, placeholder.nextSibling);
    else selector.insertBefore(english, selector.firstChild);
    if (previousValue) selector.value = previousValue;
  }

  function widgetSelectorElements() {
    return Array.from(document.querySelectorAll(".gtranslate_wrapper select, .gtranslate_wrapper .gt_selector, .gt_selector"))
      .filter(function (selector) { return selector.id !== "lovenaLanguageSelect"; });
  }

  function syncNativeLanguageOptions() {
    var nativeSelector = document.getElementById("lovenaLanguageSelect");
    if (!nativeSelector) return;
    var source = widgetSelectorElements().find(function (selector) {
      return selector && selector.options && selector.options.length > 2;
    });
    if (!source) return;

    var wantedLanguage = readManualLanguage() || readSavedLanguage() || canonicalLanguage(nativeSelector.value) || (isBrazilianVisitor() ? "pt" : SOURCE_LANGUAGE);
    var options = [];
    var seen = new Set();
    Array.from(source.options).forEach(function (sourceOption) {
      var language = optionLanguage(sourceOption);
      if (!language || seen.has(language)) return;
      seen.add(language);
      options.push({ value: language, label: String(sourceOption.textContent || language).trim() || language });
    });
    if (!seen.has("en")) options.unshift({ value: "en", label: "English" });
    if (!seen.has("pt")) options.push({ value: "pt", label: "Português" });

    var unchanged = nativeSelector.options.length === options.length && options.every(function (item, index) {
      return nativeSelector.options[index] &&
        nativeSelector.options[index].value === item.value &&
        nativeSelector.options[index].textContent === item.label;
    });
    if (unchanged) return;

    nativeSelector.textContent = "";
    options.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      nativeSelector.appendChild(option);
    });
    nativeSelector.value = options.some(function (item) { return item.value === wantedLanguage; })
      ? wantedLanguage
      : (isBrazilianVisitor() ? "pt" : SOURCE_LANGUAGE);
  }

  function selectorElements() {
    var selectors = Array.from(document.querySelectorAll(".gtranslate_wrapper select, .gtranslate_wrapper .gt_selector, .gt_selector, #lovenaLanguageSelect, #lovenaExperienceLanguageSelect"));
    selectors.forEach(ensureEnglishOption);
    syncNativeLanguageOptions();
    return selectors;
  }

  function isElementVisible(element) {
    if (!element || !element.isConnected) return false;
    var current = element;
    while (current && current !== document.documentElement) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      try {
        var style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") return false;
      } catch (error) {}
      current = current.parentElement;
    }
    return true;
  }

  function selectorElement() {
    var selectors = selectorElements();
    return selectors.find(isElementVisible) || selectors[0] || null;
  }

  function selectedLanguage() {
    // A published gift must always use the locale saved with that gift.
    // The recipient's browser language, localStorage preference, and Google
    // Translate cookie must never override the creator's chosen experience locale.
    var isExperiencePage = !!document.getElementById("experiencia");
    var htmlLanguage = document.documentElement.getAttribute("data-lovena-language");
    if (isExperiencePage && htmlLanguage) {
      var explicitPageLanguage = canonicalLanguage(htmlLanguage);
      if (explicitPageLanguage) return explicitPageLanguage;
    }

    var manualLanguage = readManualLanguage();
    if (manualLanguage) return manualLanguage;
    var savedLanguage = readSavedLanguage();
    if (savedLanguage) return savedLanguage;

    var selectors = selectorElements();
    var selector = selectors.find(isElementVisible) || selectors[0];
    if (selector && String(selector.value || "").trim()) {
      var selected = canonicalLanguage(selector.value);
      if (selected) return selected;
    }
    if (isBrazilianVisitor()) return "pt";
    try {
      var cookie = document.cookie.split(";").map(function (item) { return item.trim(); })
        .find(function (item) { return item.indexOf("googtrans=") === 0; });
      if (cookie) {
        var cookieValue = decodeURIComponent(cookie.slice("googtrans=".length));
        var parts = cookieValue.split("/").filter(Boolean);
        if (parts.length > 1) return canonicalLanguage(parts[parts.length - 1]);
      }
    } catch (error) {}
    if (htmlLanguage) { var htmlLang = canonicalLanguage(htmlLanguage); if (htmlLang) return htmlLang; }
    return SOURCE_LANGUAGE;
  }

  function saveLanguage(language) {
    activeLanguage = canonicalLanguage(language) || SOURCE_LANGUAGE;
    // Do not leak a gift's language into the visitor's preferred landing-page language.
    if (!document.getElementById("experiencia")) {
      try { localStorage.setItem("lovenaPreferredLanguage", activeLanguage); } catch (error) {}
    }
    if (document.documentElement.getAttribute("lang") !== activeLanguage) document.documentElement.setAttribute("lang", activeLanguage);
    if (document.documentElement.getAttribute("data-lovena-language") !== activeLanguage) document.documentElement.setAttribute("data-lovena-language", activeLanguage);
  }

  function loadCache() {
    try {
      var saved = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
      if (Array.isArray(saved)) saved.slice(-500).forEach(function (pair) {
        if (Array.isArray(pair) && pair.length === 2) cache.set(pair[0], pair[1]);
      });
    } catch (error) {}
  }

  function persistCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(Array.from(cache.entries()).slice(-500)));
    } catch (error) {}
  }

  function cacheKey(language, source) {
    return language + "\u0000" + source;
  }

  function getRoots() {
    var experienceRoot = document.getElementById("experiencia");
    var allRoots = ROOT_IDS.map(function (id) { return document.getElementById(id); }).filter(Boolean);
    if (experienceRoot) {
      allRoots.unshift(experienceRoot);
      // The body catches labels, dialogs, publish controls and any visible
      // elements not nested inside the main experience container.
      if (document.body) allRoots.push(document.body);
    }
    roots = Array.from(new Set(allRoots));
    roots.forEach(function (root) {
      root.classList.add("notranslate");
      root.setAttribute("translate", "no");
    });
    return roots;
  }

  function meaningful(text) {
    return typeof text === "string" && /[\p{L}\p{N}]/u.test(text) && text.trim().length > 1;
  }

  function rememberAttribute(element, name) {
    var map = attrOriginals.get(element);
    if (!map) { map = Object.create(null); attrOriginals.set(element, map); }
    if (!(name in map)) map[name] = element.getAttribute(name) || "";
    return map[name];
  }

  function originalText(node) {
    if (!textOriginals.has(node)) textOriginals.set(node, node.nodeValue || "");
    return textOriginals.get(node);
  }

  function isUserAuthoredElement(element) {
    return !!(element && element.closest && element.closest('[data-lovena-user-content="true"]'));
  }

  function isProtectedLanguageOption(option) {
    if (!option || option.tagName !== "OPTION") return false;
    var select = option.closest ? option.closest("select") : option.parentElement;
    if (!select) return false;
    return ["lovenaExperienceLanguageSelect", "lovenaLanguageSelect", "lovenaExperienceLanguage"].includes(select.id) ||
      select.classList.contains("gt_selector") || !!select.closest(".gtranslate_wrapper");
  }

  function collectRecords(rootList) {
    var records = [];
    var seenTextNodes = new Set();
    var seenAttributes = new WeakMap();
    rootList.forEach(function (root) {
      if (!root || !root.isConnected) return;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.parentElement) return NodeFilter.FILTER_REJECT;
          var tag = node.parentElement.tagName;
          if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(tag) || (tag === "OPTION" && isProtectedLanguageOption(node.parentElement)) ||
              node.parentElement.closest("textarea,[contenteditable='true']") ||
              isUserAuthoredElement(node.parentElement)) return NodeFilter.FILTER_REJECT;
          var original = originalText(node);
          return meaningful(original) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      var node;
      while ((node = walker.nextNode())) {
        if (seenTextNodes.has(node)) continue;
        seenTextNodes.add(node);
        records.push({ type: "text", node: node, source: originalText(node) });
      }

      var elements = [root].concat(Array.from(root.querySelectorAll("*")));
      elements.forEach(function (element) {
        if (!element.isConnected || (element.tagName === "OPTION" && isProtectedLanguageOption(element)) || isUserAuthoredElement(element)) return;
        var attributeNames = ["placeholder", "title", "aria-label", "aria-description", "alt"];
        if (element.tagName === "INPUT" && /^(button|submit|reset)$/i.test(element.type || "")) attributeNames.push("value");
        attributeNames.forEach(function (name) {
          if (!element.hasAttribute(name)) return;
          var seenNames = seenAttributes.get(element);
          if (!seenNames) { seenNames = new Set(); seenAttributes.set(element, seenNames); }
          if (seenNames.has(name)) return;
          seenNames.add(name);
          var source = rememberAttribute(element, name);
          if (meaningful(source)) records.push({ type: "attr", node: element, attribute: name, source: source });
        });
      });
    });
    return records;
  }

  function restoreEnglish(records) {
    records.forEach(function (record) {
      if (!record.node || !record.node.isConnected) return;
      if (record.type === "text") record.node.nodeValue = record.source;
      else record.node.setAttribute(record.attribute, record.source);
    });
  }

  function wait(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function parseTranslationEntry(entry) {
    if (typeof entry === "string") return entry;
    if (!Array.isArray(entry)) return "";
    if (typeof entry[0] === "string") return entry[0];
    if (Array.isArray(entry[0])) {
      return entry.map(function (part) {
        return Array.isArray(part) && typeof part[0] === "string" ? part[0] : "";
      }).join("");
    }
    return "";
  }

  function parseBatchTranslationResponse(data, expectedCount) {
    if (!Array.isArray(data)) throw new Error("Unexpected translation response format.");
    if (data.length === expectedCount) {
      var direct = data.map(parseTranslationEntry);
      if (direct.every(function (item) { return typeof item === "string" && item.trim(); })) return direct;
    }
    // Compatibility with the nested response returned by /translate_a/single.
    if (expectedCount === 1 && Array.isArray(data[0])) {
      var segments = data[0].map(function (part) {
        if (Array.isArray(part)) return typeof part[0] === "string" ? part[0] : "";
        return typeof part === "string" ? part : "";
      }).join("");
      if (segments.trim()) return [segments];
    }
    throw new Error("The translation service returned " + data.length + " result(s) for " + expectedCount + " text(s).");
  }

  async function translateBatchTexts(texts, language) {
    if (!texts.length) return [];
    var endpoints = [
      { url: TRANSLATE_ENDPOINT, client: "gtx" },
      { url: TRANSLATE_FALLBACK_ENDPOINT, client: "dict-chrome-ex" }
    ];
    var lastError = null;

    for (var endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex++) {
      var endpoint = endpoints[endpointIndex];
      for (var attempt = 0; attempt < 2; attempt++) {
        if (selectedLanguage() !== language) throw new Error("Language changed during translation");
        var url = new URL(endpoint.url);
        url.searchParams.set("client", endpoint.client);
        url.searchParams.set("sl", SOURCE_LANGUAGE);
        url.searchParams.set("tl", language);
        texts.forEach(function (text) { url.searchParams.append("q", text); });

        try {
          var response = await fetch(url.toString(), {
            method: "GET",
            mode: "cors",
            credentials: "omit",
            cache: "no-store",
            headers: { "Accept": "application/json" }
          });
          if (!response.ok) {
            lastError = new Error("HTTP " + response.status + " from translation endpoint");
            if (response.status === 403 || response.status === 429 || response.status < 500) break;
            if (attempt < 1) await wait(180 * (attempt + 1));
            continue;
          }
          var data = await response.json();
          return parseBatchTranslationResponse(data, texts.length);
        } catch (error) {
          lastError = error;
          if (attempt < 1) await wait(180 * (attempt + 1));
        }
      }
    }
    throw lastError || new Error("All batch translation endpoints failed.");
  }

  async function translateOne(text, language) {
    var translations = await translateBatchTexts([text], language);
    if (!translations.length || !translations[0]) throw new Error("No translated text returned");
    return translations[0];
  }

  async function requestBatch(texts, language, token) {
    if (token !== generation || selectedLanguage() !== language) return new Array(texts.length).fill(null);
    var translations = await translateBatchTexts(texts, language);
    if (token !== generation || selectedLanguage() !== language) return new Array(texts.length).fill(null);
    return translations;
  }

  function createTranslationBatches(sources) {
    var batches = [];
    var batch = [];
    var characterCount = 0;
    sources.forEach(function (source) {
      var length = String(source).length;
      if (batch.length && (batch.length >= 24 || characterCount + length > 1400)) {
        batches.push(batch);
        batch = [];
        characterCount = 0;
      }
      batch.push(source);
      characterCount += length;
    });
    if (batch.length) batches.push(batch);
    return batches;
  }

  async function translateSources(sources, language, token) {
    var results = new Map();
    var missing = [];
    sources.forEach(function (source) {
      var key = cacheKey(language, source);
      if (cache.has(key)) results.set(source, cache.get(key));
      else if (missing.indexOf(source) === -1) missing.push(source);
    });
    var batches = createTranslationBatches(missing);
    var nextBatch = 0;

    async function worker() {
      while (true) {
        if (token !== generation || selectedLanguage() !== language) return;
        var index = nextBatch++;
        if (index >= batches.length) return;
        var batch = batches[index];
        try {
          var translations = await requestBatch(batch, language, token);
          if (token !== generation || selectedLanguage() !== language) return;
          batch.forEach(function (source, itemIndex) {
            var translated = translations[itemIndex];
            if (typeof translated === "string" && translated.trim()) {
              results.set(source, translated);
              if (translated !== source) cache.set(cacheKey(language, source), translated);
            }
          });
          persistCache();
        } catch (error) {
          console.warn("Lovena dynamic translation could not process a batch:", language, error);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(3, batches.length) }, worker));

    // Keep Lovena's Portuguese hero headline precise and consistent.
    // The headline is split into two text nodes by its intentional line break.
    if (language === "pt") {
      var portugueseOverrides = {
        "You make": "Você torna",
        "everything more beautiful": "tudo mais bonito",
        "You make everything more beautiful": "Você torna tudo mais bonito",
        "My love, ❤️": "Meu amor, ❤️",
        "Sometimes words fall short of explaining how special you are to me. You have a unique way of making everything more beautiful: your smile lights up my days, your presence warms my heart, and even simple moments become unforgettable when you're close.": "Às vezes faltam palavras para explicar o quanto você é especial para mim. Você tem um jeito único de deixar tudo mais bonito: seu sorriso ilumina meus dias, sua presença aquece meu coração e até mesmo os momentos simples se tornam inesquecíveis quando você está por perto.",
        "I wish you could see yourself through my eyes, to recognize the beauty you carry in your soul and the good you bring to those lucky enough to know you. Never doubt your worth. You deserve a love that is gentle, sincere, and full of care. I am grateful to have you in my life and hope to always remind you, through words and actions, how rare, important, and loved you are. You are one of the most beautiful chapters of my story.": "Queria que pudesse se enxergar pelos meus olhos, para perceber a beleza que carrega na alma e o bem que faz a quem tem a sorte de conhecer você. Nunca duvide do seu valor. Você merece um amor leve, sincero e cheio de cuidado. Sou grato por ter você na minha vida e espero sempre lembrar, em palavras e atitudes, o quanto você é raro, importante e amado. Você é um dos capítulos mais bonitos da minha história."
      };
      sources.forEach(function (source) {
        var key = String(source || "").trim();
        if (!Object.prototype.hasOwnProperty.call(portugueseOverrides, key)) return;
        var translated = portugueseOverrides[key];
        results.set(source, translated);
        cache.set(cacheKey(language, source), translated);
      });
      persistCache();
    }
    return results;
  }
  function applyTranslatedRecords(records, translations) {
    records.forEach(function (record) {
      if (!record.node || !record.node.isConnected) return;
      var element = record.type === "text" ? record.node.parentElement : record.node;
      if (isUserAuthoredElement(element)) return;
      var translated = translations.get(record.source);
      if (typeof translated !== "string") return;
      if (record.type === "text") record.node.nodeValue = translated;
      else record.node.setAttribute(record.attribute, translated);
    });
  }

  async function updateExperienceMetadata(language, token) {
    if (!document.getElementById("experiencia")) return;
    if (!originalExperienceMetadata) {
      var descriptionMeta = document.querySelector('meta[name="description"]');
      originalExperienceMetadata = {
        title: document.title || "",
        description: descriptionMeta ? descriptionMeta.getAttribute("content") || "" : "",
        hasDescription: !!descriptionMeta
      };
    }
    var descriptionNode = document.querySelector('meta[name="description"]');
    if (language === SOURCE_LANGUAGE) {
      document.title = originalExperienceMetadata.title;
      if (originalExperienceMetadata.hasDescription && descriptionNode) descriptionNode.setAttribute("content", originalExperienceMetadata.description);
      return;
    }
    var sources = [originalExperienceMetadata.title];
    if (originalExperienceMetadata.hasDescription) sources.push(originalExperienceMetadata.description);
    var translations = await translateSources(sources, language, token);
    if (token !== generation || selectedLanguage() !== language) return;
    var translatedTitle = translations.get(originalExperienceMetadata.title);
    if (typeof translatedTitle === "string" && translatedTitle.trim()) document.title = translatedTitle;
    if (originalExperienceMetadata.hasDescription && descriptionNode) {
      var translatedDescription = translations.get(originalExperienceMetadata.description);
      if (typeof translatedDescription === "string" && translatedDescription.trim()) descriptionNode.setAttribute("content", translatedDescription);
    }
  }

  async function applyLanguage(language, token) {
    var allRoots = getRoots();
    // Closed creator/reader overlays are skipped. If an overlay is open, its
    // text is deliberately collected first so the most relevant UI translates
    // before the rest of the landing page.
    // Translate editor controls even while their drawer is closed so the UI is ready when opened.
    var persistentUiRoots = new Set(["lovenaEditor", "lovenaExperienceLanguageControl", "lovenaPublicationPanel", "lovenaPublishExportTrigger"]);
    var rootList = language === SOURCE_LANGUAGE ? allRoots : allRoots.filter(function (root) {
      return isElementVisible(root) || persistentUiRoots.has(root.id);
    });
    // Apply translations to the selector and editor controls first so the interface
    // reacts immediately; translate the gift's decorative/story content afterward.
    var uiPriority = ["lovenaExperienceLanguageControl", "lovenaEditor", "lovenaPublicationPanel", "lovenaPublishExportTrigger", "lovenaEditHint", "lovenaEditorTrigger"];
    rootList.sort(function (a, b) {
      var ai = uiPriority.indexOf(a.id);
      var bi = uiPriority.indexOf(b.id);
      if (ai < 0) ai = uiPriority.length;
      if (bi < 0) bi = uiPriority.length;
      return ai - bi;
    });
    var records = collectRecords(rootList);
    if (language === SOURCE_LANGUAGE) {
      restoreEnglish(records);
      await updateExperienceMetadata(language, token);
      return;
    }
    var sources = Array.from(new Set(records.map(function (record) {
      return record.source;
    }).filter(meaningful)));
    if (!sources.length) { await updateExperienceMetadata(language, token); return; }

    // Translate the interface controls first so the user's selection feels immediate.
    var batchSize = 24;
    async function translateAndApply(batchSources) {
      if (!batchSources.length || token !== generation || selectedLanguage() !== language) return;
      var translations = await translateSources(batchSources, language, token);
      if (token !== generation || selectedLanguage() !== language) return;
      var missed = batchSources.filter(function (source) { return !translations.has(source); });
      if (missed.length) {
        var retried = await translateSources(missed, language, token);
        if (token !== generation || selectedLanguage() !== language) return;
        retried.forEach(function (value, key) { translations.set(key, value); });
      }
      applyTranslatedRecords(records, translations);
    }

    await translateAndApply(sources.slice(0, batchSize));
    if (token !== generation || selectedLanguage() !== language) return;

    // After the first visible UI batch, translate the remaining page in parallel.
    var remainingBatches = createTranslationBatches(sources.slice(batchSize));
    var nextBatch = 0;
    async function pageWorker() {
      while (true) {
        if (token !== generation || selectedLanguage() !== language) return;
        var index = nextBatch++;
        if (index >= remainingBatches.length) return;
        await translateAndApply(remainingBatches[index]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, remainingBatches.length) }, pageWorker));
    await updateExperienceMetadata(language, token);
  }
  function scheduleTranslation(delay, keepExisting) {
    // DOM observers can fire repeatedly while the editor is rendering. Keep the
    // first pending timer instead of postponing translation forever.
    if (scheduledTimer) {
      if (keepExisting) return;
      window.clearTimeout(scheduledTimer);
    }
    scheduledTimer = window.setTimeout(function () {
      scheduledTimer = 0;
      generation++;
      var token = generation;
      activeLanguage = selectedLanguage();
      saveLanguage(activeLanguage);
      if (activeLanguage === SOURCE_LANGUAGE) {
        restoreEnglish(collectRecords(getRoots()));
        updateExperienceMetadata(activeLanguage, token).catch(function (error) { console.warn("Lovena metadata language reset failed:", error); });
        return;
      }
      if (running) { pending = true; return; }
      running = true;
      applyLanguage(activeLanguage, token).catch(function (error) {
        console.warn("Lovena dynamic translation is currently unavailable:", error);
      }).finally(function () {
        running = false;
        if (pending) { pending = false; scheduleTranslation(100); }
      });
    }, typeof delay === "number" ? delay : 250);
  }

  function observeRoots() {
    getRoots();
    if (!observer) {
      observer = new MutationObserver(function (mutations) {
        var hasNewNodes = mutations.some(function (mutation) {
          return mutation.type === "childList" && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0);
        });
        if (hasNewNodes && activeLanguage !== SOURCE_LANGUAGE) {
          if (running) pending = true;
          else scheduleTranslation(180, true);
        }
      });
    }
    roots.forEach(function (root) {
      try { observer.observe(root, { childList: true, subtree: true }); } catch (error) {}
    });
  }

  function clearGoogleTranslateCookies() {
    var paths = ["/", "/lovena-studio", "/lovena-studio/"];
    var host = window.location.hostname;
    var domains = ["", host, "." + host];
    paths.forEach(function (path) {
      domains.forEach(function (domain) {
        var cookie = "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; path=" + path;
        if (domain) cookie += "; domain=" + domain;
        document.cookie = cookie;
      });
    });
    try {
      ["googtrans", "gtranslate", "gtranslate_language"].forEach(function (key) {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      });
    } catch (error) {}
  }

  function returnToEnglish() {
    if (englishResetPending) return;
    englishResetPending = true;
    saveLanguage(SOURCE_LANGUAGE);
    // If the picker is inside the creator, save its current edits before
    // reloading. The source-language reset must never discard an in-progress gift.
    var studio = document.getElementById("studioOverlay");
    if (isElementVisible(studio)) {
      var saveButton = studio.querySelector('[data-action="save-draft"]');
      if (saveButton) saveButton.click();
    }
    // Let GTranslate's own change handler finish first, then remove its state
    // and reload the original source HTML. This reliably reverses translated
    // static text as well as the creator/reader UI.
    window.setTimeout(function () {
      clearGoogleTranslateCookies();
      window.location.reload();
    }, 100);
  }

  function handleLanguageSelection(event) {
    var target = event && event.target;
    if (!target || !target.matches || !target.matches(".gtranslate_wrapper select, .gtranslate_wrapper .gt_selector, .gt_selector, #lovenaLanguageSelect, #lovenaExperienceLanguageSelect")) return;
    var nativePickerChanged = target.id === "lovenaLanguageSelect";
    var experiencePickerChanged = target.id === "lovenaExperienceLanguageSelect";
    var language = canonicalLanguage(target.value);
    if (!language && target.options) language = optionLanguage(target.options[target.selectedIndex]);
    if (!language) return;

    selectorElements().forEach(function (selector) {
      var match = Array.from(selector.options || []).find(function (option) { return optionLanguage(option) === language; });
      if (match && selector.value !== match.value) selector.value = match.value;
    });
    saveLanguage(language);
    try { sessionStorage.setItem("lovenaManualLanguage", language); } catch (error) {}
    // The experience selector changes the interface preference, not the personalized gift language.
    if (experiencePickerChanged) {
      try { localStorage.setItem("lovenaPreferredLanguage", language); } catch (error) {}
      window.LOVENA_INTERFACE_LANGUAGE_MANUAL = true;
    }
    try { document.cookie = "googtrans=/en/" + language + ";path=/;max-age=31536000;SameSite=Lax"; } catch (error) {}

    // The visible native picker stays usable even when the GTranslate widget is delayed.
    // When its hidden engine is ready, forward the same choice to trigger static-page translation.
    if (nativePickerChanged) {
      var widget = widgetSelectorElements().find(function (selector) {
        return Array.from(selector.options || []).some(function (option) { return optionLanguage(option) === language; });
      });
      if (widget) {
        var widgetOption = Array.from(widget.options || []).find(function (option) { return optionLanguage(option) === language; });
        if (widgetOption) {
          widget.value = widgetOption.value;
          widget.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    }

    if (language === SOURCE_LANGUAGE) {
      if (experiencePickerChanged) { scheduleTranslation(20); return; }
      returnToEnglish(); return;
    }
    scheduleTranslation(20);
  }

  window.addEventListener("lovena:region-detected", function (event) {
    // Region-based defaults apply to the storefront only, never to a personalized gift.
    if (document.getElementById("experiencia")) return;
    if (!event || !event.detail || !event.detail.countryCode) return;
    var manualLanguage = readManualLanguage();
    var savedLanguage = readSavedLanguage();
    var chosenLanguage = manualLanguage || savedLanguage;
    if (!chosenLanguage) {
      chosenLanguage = event.detail.countryCode === "BR" ? "pt" : SOURCE_LANGUAGE;
      saveLanguage(chosenLanguage);
      scheduleTranslation(80);
    }
    // Keep the visible experience picker synchronized with the retained user preference.
    selectorElements().forEach(function (selector) {
      var match = Array.from(selector.options || []).find(function (option) {
        return optionLanguage(option) === chosenLanguage;
      });
      if (match && selector.value !== match.value) selector.value = match.value;
    });
  });

  // The gift content locale is independent from the interface language. Only the
  // visible interface-language selector changes the UI translation on experience pages.
  document.addEventListener("change", handleLanguageSelection, true);
  document.addEventListener("input", handleLanguageSelection, true);

  function syncLanguageFromWidget() {
    var language = selectedLanguage();
    if (language !== activeLanguage) {
      saveLanguage(language);
      scheduleTranslation(120);
    } else if (language !== SOURCE_LANGUAGE) {
      scheduleTranslation(450);
    }
  }
  window.addEventListener("pageshow", syncLanguageFromWidget);
  window.addEventListener("focus", syncLanguageFromWidget);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) syncLanguageFromWidget();
  });

  function observeSelectorWidgets() {
    if (selectorObserver || !document.documentElement) return;
    selectorObserver = new MutationObserver(function (mutations) {
      selectorElements();
      syncNativeLanguageOptions();
      // Runtime-created editor and checkout panels must join the translation roots.
      observeRoots();
      var addedNodes = mutations.some(function (mutation) {
        return mutation.type === "childList" && mutation.addedNodes && mutation.addedNodes.length > 0;
      });
      if (addedNodes && activeLanguage !== SOURCE_LANGUAGE) {
        if (running) pending = true;
        else scheduleTranslation(120, true);
      }
    });
    selectorObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function initializeWidget() {
    observeRoots();
    observeSelectorWidgets();
    var selector = selectorElement();
    if (!selector && document.getElementById("experiencia")) {
      var pageLanguage = canonicalLanguage(document.documentElement.getAttribute("data-lovena-language") || document.documentElement.lang || SOURCE_LANGUAGE) || SOURCE_LANGUAGE;
      saveLanguage(pageLanguage);
      scheduleTranslation(80);
      window.dispatchEvent(new CustomEvent("lovena:translation-bridge-ready", { detail: { language: pageLanguage } }));
      return;
    }
    if (!selector) {
      attempts++;
      if (attempts < 80) window.setTimeout(initializeWidget, 250);
      else if (readSavedLanguage() && readSavedLanguage() !== SOURCE_LANGUAGE) { saveLanguage(readSavedLanguage()); scheduleTranslation(200); }
      return;
    }
    var saved = readSavedLanguage();
    var active = selectedLanguage() || canonicalLanguage(selector.value) || saved || SOURCE_LANGUAGE;
    if (!document.getElementById("experiencia") && saved && saved !== active) {
      var savedMatch = Array.from(selector.options || []).find(function (option) { return optionLanguage(option) === saved; });
      if (savedMatch) {
        selector.value = savedMatch.value;
        selector.dispatchEvent(new Event("change", { bubbles: true }));
        saveLanguage(saved); scheduleTranslation(300); return;
      }
    }
    saveLanguage(active);
    selectorElements().forEach(function (item) {
      var match = Array.from(item.options || []).find(function (option) { return optionLanguage(option) === active; });
      if (match && item.value !== match.value) item.value = match.value;
    });
    scheduleTranslation(40);
  }

  loadCache();
  window.LovenaTranslationBridge = {
    refresh: function () { observeRoots(); scheduleTranslation(180); },
    language: function () { return selectedLanguage() || activeLanguage; },
    translateText: function (text, language) {
      var target = canonicalLanguage(language || activeLanguage || selectedLanguage());
      if (!meaningful(text) || target === SOURCE_LANGUAGE) return Promise.resolve(text);
      var key = cacheKey(target, text);
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      return translateOne(text, target).then(function (translated) {
        cache.set(key, translated);
        persistCache();
        return translated;
      });
    },
    translateMarkup: async function (markup, language) {
      var target = canonicalLanguage(language || activeLanguage || selectedLanguage());
      if (target === SOURCE_LANGUAGE) return String(markup || "");
      var staging = document.createElement("div");
      staging.className = "notranslate";
      staging.setAttribute("translate", "no");
      staging.setAttribute("aria-hidden", "true");
      staging.style.cssText = "position:fixed;left:-100000px;top:0;width:min(980px,100vw);max-height:90vh;overflow:hidden;opacity:.01;pointer-events:none;z-index:-1;";
      staging.innerHTML = String(markup || "");
      document.body.appendChild(staging);
      try {
        var records = collectRecords([staging]);
        var sources = Array.from(new Set(records.map(function (record) { return record.source; }).filter(meaningful)));
        var translations = new Map();
        var nextIndex = 0;
        async function worker() {
          while (nextIndex < sources.length) {
            if (selectedLanguage() !== target) throw new Error("Language changed while preparing the exported story");
            var source = sources[nextIndex++];
            try {
              var translated = await window.LovenaTranslationBridge.translateText(source, target);
              translations.set(source, translated);
            } catch (error) {}
            await wait(90);
          }
        }
        await Promise.all([worker(), worker()]);
        records.forEach(function (record) {
          if (!record.node || !record.node.isConnected) return;
          var element = record.type === "text" ? record.node.parentElement : record.node;
          if (isUserAuthoredElement(element)) return;
          var translated = translations.get(record.source);
          if (typeof translated !== "string") return;
          if (record.type === "text") record.node.nodeValue = translated;
          else record.node.setAttribute(record.attribute, translated);
        });
        return staging.innerHTML;
      } finally {
        if (staging.parentNode) staging.parentNode.removeChild(staging);
      }
    },
    isUserAuthored: isUserAuthoredElement
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeWidget, { once: true });
  } else initializeWidget();
})();
