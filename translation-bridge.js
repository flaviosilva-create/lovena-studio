(function () {
  "use strict";

  // GTranslate translates the static landing page. The creator and recipient
  // experience is rendered by JavaScript, so this bridge translates those
  // specific DOM roots separately and leaves the rest of the page to GTranslate.
  var SOURCE_LANGUAGE = "en";
  var TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
  var CACHE_KEY = "lovenaDynamicTranslationCacheV3";
  var ROOT_IDS = [
    // Cover the complete creation and preview overlays, including all chrome
    // outside the changing step body: top bar, progress, step navigation,
    // helper copy, side panel, controls, preview modals and generated steps.
    "studioOverlay", "readerOverlay", "studioToast", "loveWorldHeadingCopy"
  ];
  var textOriginals = new WeakMap();
  var attrOriginals = new WeakMap();
  var cache = new Map();
  var observer = null;
  var scheduledTimer = 0;
  var generation = 0;
  var running = false;
  var pending = false;
  var activeLanguage = SOURCE_LANGUAGE;
  var attempts = 0;
  var roots = [];

  function canonicalLanguage(value) {
    // GTranslate dropdown values use "source|target" (e.g. "en|pt").
    // Some variants can provide the reverse order, so detect the configured
    // source language instead of blindly reading the first or last segment.
    var parts = String(value || "").split("|").map(function (part) { return part.trim(); }).filter(Boolean);
    var lang = SOURCE_LANGUAGE;
    if (parts.length > 1) {
      var first = parts[0].toLowerCase();
      var last = parts[parts.length - 1].toLowerCase();
      if (first === SOURCE_LANGUAGE.toLowerCase()) lang = parts[parts.length - 1];
      else if (last === SOURCE_LANGUAGE.toLowerCase()) lang = parts[0];
      else lang = parts[parts.length - 1];
    } else if (parts.length === 1) {
      lang = parts[0];
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

  function readSavedLanguage() {
    try { return canonicalLanguage(localStorage.getItem("lovenaPreferredLanguage") || SOURCE_LANGUAGE); }
    catch (error) { return SOURCE_LANGUAGE; }
  }

  function selectorElements() {
    return Array.from(document.querySelectorAll(".gtranslate_wrapper select, .gtranslate_wrapper .gt_selector, .gt_selector"));
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
    var selectors = selectorElements();
    var selector = selectors.find(isElementVisible) || selectors[0];
    if (selector && selector.value) return canonicalLanguage(selector.value);
    try {
      var cookieMatch = document.cookie.match(/(?:^|;\\s*)googtrans=([^;]+)/);
      if (cookieMatch) {
        var parts = decodeURIComponent(cookieMatch[1]).split("/");
        if (parts.length) return canonicalLanguage(parts[parts.length - 1]);
      }
    } catch (error) {}
    var htmlLanguage = document.documentElement.getAttribute("data-lovena-language");
    if (htmlLanguage) return canonicalLanguage(htmlLanguage);
    return readSavedLanguage();
  }

  function saveLanguage(language) {
    activeLanguage = canonicalLanguage(language);
    try { localStorage.setItem("lovenaPreferredLanguage", activeLanguage); } catch (error) {}
    document.documentElement.setAttribute("lang", activeLanguage);
    document.documentElement.setAttribute("data-lovena-language", activeLanguage);
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
    roots = ROOT_IDS.map(function (id) { return document.getElementById(id); }).filter(Boolean);
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
          if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(tag) ||
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
        if (!element.isConnected || isUserAuthoredElement(element)) return;
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

  async function applyLanguage(language, token) {
    var allRoots = getRoots();
    // Translate only what is actually open; a cold mobile visit should not
    // request strings from hidden creator and reader overlays at the same time.
    var rootList = language === SOURCE_LANGUAGE ? allRoots : allRoots.filter(isElementVisible);
    var records = collectRecords(rootList);
    if (language === SOURCE_LANGUAGE) {
      restoreEnglish(records);
      return;
    }
    var sources = Array.from(new Set(records.map(function (record) { return record.source; }).filter(meaningful)));
    if (!sources.length) return;
    var translations = await translateSources(sources, language, token);
    if (token !== generation || selectedLanguage() !== language) return;
    var missed = sources.filter(function (source) { return !translations.has(source); }).slice(0, 36);
    if (missed.length) {
      await wait(500);
      if (token === generation && selectedLanguage() === language) {
        var retried = await translateSources(missed, language, token);
        retried.forEach(function (value, key) { translations.set(key, value); });
      }
    }
    if (token !== generation || selectedLanguage() !== language) return;
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

  function handleLanguageSelection(event) {
    var target = event && event.target;
    if (!target || !target.matches || !target.matches(".gtranslate_wrapper select, .gtranslate_wrapper .gt_selector, .gt_selector")) return;
    var language = canonicalLanguage(target.value);
    saveLanguage(language);
    scheduleTranslation(80);
  }
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

  function initializeWidget() {
    observeRoots();
    var selector = selectorElement();
    if (!selector) {
      attempts++;
      if (attempts < 80) window.setTimeout(initializeWidget, 250);
      else if (readSavedLanguage() !== SOURCE_LANGUAGE) {
        saveLanguage(readSavedLanguage());
        scheduleTranslation(200);
      }
      return;
    }
    var saved = readSavedLanguage();
    var active = canonicalLanguage(selector.value || SOURCE_LANGUAGE);
    if (saved !== SOURCE_LANGUAGE && saved !== active) {
      var match = Array.from(selector.options || []).find(function (option) {
        return canonicalLanguage(option.value) === saved;
      });
      if (match) {
        selector.value = match.value;
        selector.dispatchEvent(new Event("change", { bubbles: true }));
        saveLanguage(saved);
        scheduleTranslation(300);
        return;
      }
    }
    saveLanguage(active);
    scheduleTranslation(400);
  }

  loadCache();
  window.LovenaTranslationBridge = {
    refresh: function () { observeRoots(); scheduleTranslation(180); },
    language: function () { return activeLanguage || selectedLanguage(); },
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
    isUserAuthored: isUserAuthoredElement
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeWidget, { once: true });
  } else initializeWidget();
})();
