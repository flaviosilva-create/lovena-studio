(function () {
  "use strict";

  // GTranslate translates the static landing page. This bridge handles UI
  // rendered dynamically by the creator and recipient experience. Keeping
  // these roots separate prevents the bridge from blocking static translation.
  // User-authored content stays in the language its creator wrote it in.
  var SOURCE_LANGUAGE = "en";
  var TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
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
    var manualLanguage = readManualLanguage();
    if (manualLanguage) return manualLanguage;
    var savedLanguage = readSavedLanguage();
    if (savedLanguage) return savedLanguage;
    if (isBrazilianVisitor()) return "pt";
    var selectors = selectorElements();
    var selector = selectors.find(isElementVisible) || selectors[0];
    if (selector && String(selector.value || "").trim()) {
      var selected = canonicalLanguage(selector.value);
      if (selected) return selected;
    }
    // Experience locale belongs to the gift, not to the viewer's landing-page preference.
    var htmlLanguage = document.documentElement.getAttribute("data-lovena-language");
    if (htmlLanguage && document.getElementById("experiencia")) {
      var explicitPageLanguage = canonicalLanguage(htmlLanguage);
      if (explicitPageLanguage) return explicitPageLanguage;
    }
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
    return readSavedLanguage() || SOURCE_LANGUAGE;
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
    if (experienceRoot) allRoots.unshift(experienceRoot);
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

  function collectRecords(rootList) {
    var records = [];
    rootList.forEach(function (root) {
      if (!root || !root.isConnected) return;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.parentElement) return NodeFilter.FILTER_REJECT;
          var tag = node.parentElement.tagName;
          if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(tag) || (tag === "OPTION" && !(node.parentElement.value === "other" && node.parentElement.parentElement && node.parentElement.parentElement.id === "lovenaExperienceLanguage")) ||
              node.parentElement.closest("textarea,[contenteditable='true']") ||
              isUserAuthoredElement(node.parentElement)) return NodeFilter.FILTER_REJECT;
          var original = originalText(node);
          return meaningful(original) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      var node;
      while ((node = walker.nextNode())) records.push({ type: "text", node: node, source: originalText(node) });

      var elements = [root].concat(Array.from(root.querySelectorAll("*")));
      elements.forEach(function (element) {
        if (!element.isConnected || (element.tagName === "OPTION" && !(element.value === "other" && element.parentElement && element.parentElement.id === "lovenaExperienceLanguage")) || isUserAuthoredElement(element)) return;
        ["placeholder", "title", "aria-label", "alt"].forEach(function (name) {
          if (!element.hasAttribute(name)) return;
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

  async function translateOne(text, language) {
    var url = new URL(TRANSLATE_ENDPOINT);
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", SOURCE_LANGUAGE);
    url.searchParams.set("tl", language);
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", text);

    var lastError;
    for (var attempt = 0; attempt < 4; attempt++) {
      if (selectedLanguage() !== language) throw new Error("Language changed during translation");
      try {
        var response = await fetch(url.toString(), {
          method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
          headers: { "Accept": "application/json" }
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error("HTTP " + response.status);
          if (attempt < 3) {
            await wait(response.status === 429 ? 650 * (attempt + 1) : 350 * (attempt + 1));
            continue;
          }
          throw lastError;
        }
        if (!response.ok) throw new Error("HTTP " + response.status);
        var data = await response.json();
        var segments = data && data[0];
        var translated = Array.isArray(segments) ? segments.map(function (part) { return part && part[0] || ""; }).join("") : "";
        if (!translated) throw new Error("No translated text returned");
        return translated;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await wait(300 * Math.pow(2, attempt));
      }
    }
    throw lastError || new Error("Translation request failed");
  }

  async function requestBatch(texts, language, token) {
    var results = new Array(texts.length);
    var nextIndex = 0;
    var failures = [];
    async function worker() {
      while (true) {
        if (token !== generation || selectedLanguage() !== language) return;
        var index = nextIndex++;
        if (index >= texts.length) return;
        try {
          results[index] = await translateOne(texts[index], language);
        } catch (error) {
          results[index] = null;
          failures.push({ source: texts[index], error: error });
        }
        await wait(120);
      }
    }
    // Two concurrent requests lower bursts of HTTP 429s on mobile networks.\n    await Promise.all([worker(), worker()]);
    if (failures.length === texts.length && texts.length) {
      throw new Error("The free translation endpoint rejected every text request: " + failures[0].error.message);
    }
    return results;
  }

  async function translateSources(sources, language, token) {
    var results = new Map();
    var missing = [];
    sources.forEach(function (source) {
      var key = cacheKey(language, source);
      if (cache.has(key)) results.set(source, cache.get(key));
      else if (missing.indexOf(source) === -1) missing.push(source);
    });

    // Keep a low request rate to reduce the risk of temporary service limits.
    for (var start = 0; start < missing.length; start += 18) {
      if (token !== generation || selectedLanguage() !== language) return results;
      var batch = missing.slice(start, start + 18);
      try {
        var translations = await requestBatch(batch, language, token);
        batch.forEach(function (source, index) {
          var translated = translations[index];
          if (typeof translated === "string" && translated.trim()) {
            results.set(source, translated);
            if (translated !== source) cache.set(cacheKey(language, source), translated);
          }
        });
        persistCache();
      } catch (error) {
        console.warn("Lovena dynamic translation could not process a text batch:", language, error);
      }
      if (start + 18 < missing.length) await wait(180);
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

    // Apply each small batch immediately instead of waiting for every string
    // on the whole page. The language change begins at once and the page
    // progressively settles into the chosen language while later text loads.
    var batchSize = 18;
    for (var start = 0; start < sources.length; start += batchSize) {
      if (token !== generation || selectedLanguage() !== language) return;
      var batchSources = sources.slice(start, start + batchSize);
      var translations = await translateSources(batchSources, language, token);
      if (token !== generation || selectedLanguage() !== language) return;

      var missed = batchSources.filter(function (source) {
        return !translations.has(source);
      });
      if (missed.length) {
        await wait(350);
        if (token !== generation || selectedLanguage() !== language) return;
        var retried = await translateSources(missed, language, token);
        retried.forEach(function (value, key) { translations.set(key, value); });
      }
      if (token !== generation || selectedLanguage() !== language) return;
      applyTranslatedRecords(records, translations);
    }
    await updateExperienceMetadata(language, token);
  }
  function scheduleTranslation(delay) {
    if (scheduledTimer) window.clearTimeout(scheduledTimer);
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
        if (hasNewNodes && activeLanguage !== SOURCE_LANGUAGE) scheduleTranslation(180);
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
    if (!target || !target.matches || !target.matches(".gtranslate_wrapper select, .gtranslate_wrapper .gt_selector, .gt_selector, #lovenaLanguageSelect")) return;
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
      if (experiencePickerChanged) { scheduleTranslation(80); return; }
      returnToEnglish(); return;
    }
    scheduleTranslation(80);
  }

  window.addEventListener("lovena:region-detected", function (event) {
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
      if (addedNodes && activeLanguage !== SOURCE_LANGUAGE) scheduleTranslation(120);
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
    if (saved && saved !== active) {
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
    scheduleTranslation(400);
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
