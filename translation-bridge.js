(function(){
  "use strict";
  /*
   * Lovena Studio uses GTranslate as its single translation engine.
   * The source language is English. Do not load the retired Google Website
   * Translator in parallel; two engines were competing for the same page.
   */
  var SOURCE_LANGUAGE = "en";
  var refreshTimer = 0;
  var refreshing = false;
  var initialized = false;
  var startupAttempts = 0;

  function normalizeLanguage(value) {
    var parts = String(value || "").split("|");
    return (parts[parts.length - 1] || SOURCE_LANGUAGE).trim().toLowerCase();
  }
  function getSelector() {
    return document.querySelector(".gtranslate_wrapper select, .gtranslate_wrapper .gt_selector, .gt_selector");
  }
  function findOption(selector, language) {
    if (!selector || !selector.options) return null;
    language = normalizeLanguage(language);
    for (var i = 0; i < selector.options.length; i++) {
      if (normalizeLanguage(selector.options[i].value) === language) return selector.options[i];
    }
    return null;
  }
  function readSavedLanguage() {
    try { return normalizeLanguage(localStorage.getItem("lovenaPreferredLanguage") || SOURCE_LANGUAGE); }
    catch (error) { return SOURCE_LANGUAGE; }
  }
  function saveLanguage(language) {
    language = normalizeLanguage(language);
    try { localStorage.setItem("lovenaPreferredLanguage", language); } catch (error) {}
    document.documentElement.setAttribute("lang", language);
    document.documentElement.setAttribute("data-lovena-language", language);
  }
  function currentLanguage() {
    var selector = getSelector();
    if (selector && selector.value) return normalizeLanguage(selector.value);
    return readSavedLanguage();
  }

  /* Ask the existing GTranslate widget to translate newly-rendered app UI. */
  function refreshDynamicContent(delay) {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(function() {
      refreshTimer = 0;
      var selector = getSelector();
      if (!selector) return;
      if (refreshing) { refreshDynamicContent(400); return; }
      var language = currentLanguage();
      if (!language || language === SOURCE_LANGUAGE) {
        saveLanguage(SOURCE_LANGUAGE);
        return;
      }
      var option = findOption(selector, language);
      if (!option) return;
      refreshing = true;
      selector.value = option.value;
      selector.dispatchEvent(new Event("change", { bubbles: true }));
      window.setTimeout(function() { refreshing = false; }, 1200);
    }, typeof delay === "number" ? delay : 350);
  }

  document.addEventListener("change", function(event) {
    var target = event.target;
    if (!target || !target.matches || !target.matches(".gtranslate_wrapper select, .gtranslate_wrapper .gt_selector, .gt_selector")) return;
    if (refreshing) return;
    saveLanguage(normalizeLanguage(target.value));
  }, true);

  function initializeWidget() {
    if (initialized) return;
    var selector = getSelector();
    if (!selector) {
      startupAttempts++;
      if (startupAttempts < 48) window.setTimeout(initializeWidget, 250);
      return;
    }
    initialized = true;
    window.setTimeout(function() {
      var latestSelector = getSelector();
      if (!latestSelector) { initialized = false; initializeWidget(); return; }
      var saved = readSavedLanguage();
      var active = normalizeLanguage(latestSelector.value || SOURCE_LANGUAGE);
      if (saved !== SOURCE_LANGUAGE && saved !== active) {
        var option = findOption(latestSelector, saved);
        if (option) {
          latestSelector.value = option.value;
          latestSelector.dispatchEvent(new Event("change", { bubbles: true }));
          saveLanguage(saved);
          return;
        }
      }
      saveLanguage(active);
      if (active !== SOURCE_LANGUAGE) refreshDynamicContent(250);
    }, 500);
  }

  window.LovenaTranslationBridge = {
    refresh: function() { refreshDynamicContent(450); },
    language: currentLanguage
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeWidget, { once: true });
  } else {
    initializeWidget();
  }
})();
