(function () {
  "use strict";

  // Static landing-page content is handled by GTranslate. Lovena renders its
  // creator and recipient experience with JavaScript, so those roots use this
  // small batched translator and are excluded from the widget to avoid races.
  var SOURCE_LANGUAGE = "en";
  var TRANSLATE_ENDPOINT = "https://translate-pa.googleapis.com/v1/translateHtml";
  // Public key used by Google's web translation widget (not a private project key).
  var TRANSLATE_KEY = "AIzaSyBWDj0QJvVIx8XOhRegXX5_SrRWxhT5Hs4";
  var CACHE_KEY = "lovenaDynamicTranslationCacheV1";
  var ROOT_IDS = [
    "studioStepBody", "studioControls", "studioStepNav", "studioMiniPreview",
    "readerCard", "readerProgress", "studioToast", "readerModalCaption"
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
    var parts = String(value || "").split("|");
    var lang = (parts[parts.length - 1] || SOURCE_LANGUAGE).trim();
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

  function selectorElement() {
    return document.querySelector(".gtranslate_wrapper select, .gtranslate_wrapper .gt_selector, .gt_selector");
  }

  function selectedLanguage() {
    var selector = selectorElement();
    if (selector && selector.value) return canonicalLanguage(selector.value);
    var cookieMatch = document.cookie.match(/(?:^|;\s*)googtrans=([^;]+)/);
    if (cookieMatch) {
      var parts = decodeURIComponent(cookieMatch[1]).split("/");
      if (parts.length) return canonicalLanguage(parts[parts.length - 1]);
    }
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
      var tail = Array.from(cache.entries()).slice(-500);
      localStorage.setItem(CACHE_KEY, JSON.stringify(tail));
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

  function collectRecords(rootList) {
    var records = [];
    var seen = new Set();
    var walker;
    rootList.forEach(function (root) {
      if (!root || !root.isConnected) return;
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.parentElement) return NodeFilter.FILTER_REJECT;
          var tag = node.parentElement.tagName;
          if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(tag) ||
              node.parentElement.closest("textarea,[contenteditable='true']")) return NodeFilter.FILTER_REJECT;
          var original = originalText(node);
          return meaningful(original) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      var node;
      while ((node = walker.nextNode())) {
        var source = originalText(node);
        var key = "text\u0000" + source;
        if (!seen.has(key)) { seen.add(key); records.push({ type: "text", node: node, source: source }); }
        else records.push({ type: "text", node: node, source: source });
      }

      var elements = [root].concat(Array.from(root.querySelectorAll("*")));
      elements.forEach(function (element) {
        if (!element.isConnected) return;
        ["placeholder", "title", "aria-label", "alt"].forEach(function (name) {
          if (!element.hasAttribute(name)) return;
          if (element.matches("input,textarea") && name === "value") return;
          var source = rememberAttribute(element, name);
          if (!meaningful(source)) return;
          records.push({ type: "attr", node: element, attribute: name, source: source });
        });
      });
    });
    return records;
  }

  function restoreEnglish(records) {
    records.forEach(function (record) {
      if (record.type === "text") {
        if (record.node && record.node.isConnected) record.node.nodeValue = record.source;
      } else if (record.node && record.node.isConnected) {
        record.node.setAttribute(record.attribute, record.source);
      }
    });
  }

  async function requestBatch(texts, language) {
    var response = await fetch(TRANSLATE_ENDPOINT, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json+protobuf",
        "X-Goog-API-Key": TRANSLATE_KEY
      },
      body: JSON.stringify([[texts, SOURCE_LANGUAGE, language], "wt_lib"])
    });
    if (!response.ok) throw new Error("Translation service returned HTTP " + response.status);
    var data = await response.json();
    var translated = data && data[0];
    if (!Array.isArray(translated) || translated.length !== texts.length) {
      throw new Error("Unexpected translation response");
    }
    return translated.map(function (value, index) {
      return typeof value === "string" && value.trim() ? value : texts[index];
    });
  }

  async function translateSources(sources, language, token) {
    var results = new Map();
    var missing = [];
    sources.forEach(function (source) {
      var key = cacheKey(language, source);
      if (cache.has(key)) results.set(source, cache.get(key));
      else if (!results.has(source)) missing.push(source);
    });

    // Batch a small number of UI strings per request and cap payload size.
    var batches = [];
    var batch = [], batchChars = 0;
    missing.forEach(function (source) {
      var size = source.length;
      if (batch.length >= 25 || (batch.length && batchChars + size > 4200)) {
        batches.push(batch); batch = []; batchChars = 0;
      }
      batch.push(source); batchChars += size;
    });
    if (batch.length) batches.push(batch);

    for (var i = 0; i < batches.length; i++) {
      if (token !== generation || selectedLanguage() !== language) return results;
      try {
        var translations = await requestBatch(batches[i], language);
        batches[i].forEach(function (source, index) {
          var translated = translations[index] || source;
          cache.set(cacheKey(language, source), translated);
          results.set(source, translated);
        });
        persistCache();
      } catch (error) {
        // A second, keyless endpoint is only a best-effort fallback. The
        // GTranslate widget still handles ordinary static page text.
        for (var j = 0; j < batches[i].length; j++) {
          if (token !== generation || selectedLanguage() !== language) return results;
          var fallbackSource = batches[i][j];
          try {
            var url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=" +
              encodeURIComponent(language) + "&dt=t&q=" + encodeURIComponent(fallbackSource);
            var fallbackResponse = await fetch(url, { mode: "cors", credentials: "omit" });
            if (!fallbackResponse.ok) continue;
            var fallbackData = await fallbackResponse.json();
            var segments = fallbackData && fallbackData[0];
            var fallbackText = Array.isArray(segments) ? segments.map(function (item) { return item[0] || ""; }).join("") : "";
            if (fallbackText) {
              cache.set(cacheKey(language, fallbackSource), fallbackText);
              results.set(fallbackSource, fallbackText);
            }
          } catch (fallbackError) {}
        }
        persistCache();
      }
      if (i < batches.length - 1) await new Promise(function (resolve) { window.setTimeout(resolve, 180); });
    }
    return results;
  }

  async function applyLanguage(language, token) {
    var rootList = getRoots();
    var records = collectRecords(rootList);
    if (language === SOURCE_LANGUAGE) {
      restoreEnglish(records);
      return;
    }
    var sourceList = Array.from(new Set(records.map(function (record) { return record.source; }).filter(meaningful)));
    if (!sourceList.length) return;
    var translations = await translateSources(sourceList, language, token);
    if (token !== generation || selectedLanguage() !== language) return;
    records.forEach(function (record) {
      if (!record.node || !record.node.isConnected) return;
      var translated = translations.get(record.source);
      if (!translated) return;
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
        var rootsNow = getRoots();
        restoreEnglish(collectRecords(rootsNow));
        return;
      }
      if (running) { pending = true; return; }
      running = true;
      applyLanguage(activeLanguage, token).catch(function (error) {
        console.warn("Lovena dynamic translation could not be completed:", error);
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
        // Ignore attribute and character-data changes made by this translator.
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

  document.addEventListener("change", function (event) {
    var target = event.target;
    if (!target || !target.matches || !target.matches(".gtranslate_wrapper select, .gtranslate_wrapper .gt_selector, .gt_selector")) return;
    var language = canonicalLanguage(target.value);
    saveLanguage(language);
    scheduleTranslation(100);
  }, true);

  function initializeWidget() {
    observeRoots();
    var selector = selectorElement();
    if (!selector) {
      attempts++;
      if (attempts < 60) window.setTimeout(initializeWidget, 250);
      else if (readSavedLanguage() !== SOURCE_LANGUAGE) scheduleTranslation(200);
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
    language: function () { return activeLanguage || selectedLanguage(); }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeWidget, { once: true });
  } else initializeWidget();
})();
