/* Lovena experience interface language selector.
   Uses the same translation bridge as the landing page and is editor-only:
   it is never included in shared/public or downloaded gift experiences. */
(function () {
  "use strict";

  var CONTROL_ID = "lovenaExperienceLanguageControl";
  var SELECT_ID = "lovenaExperienceLanguageSelect";
  var LANGUAGES = [
    ["en", "🇺🇸 English"],
    ["pt", "🇧🇷 Português"],
    ["es", "🇪🇸 Español"],
    ["fr", "🇫🇷 Français"],
    ["de", "🇩🇪 Deutsch"],
    ["it", "🇮🇹 Italiano"],
    ["nl", "🇳🇱 Nederlands"],
    ["pl", "🇵🇱 Polski"],
    ["ru", "🇷🇺 Русский"],
    ["uk", "🇺🇦 Українська"],
    ["tr", "🇹🇷 Türkçe"],
    ["ar", "🇸🇦 العربية"],
    ["he", "🇮🇱 עברית"],
    ["hi", "🇮🇳 हिन्दी"],
    ["bn", "🇧🇩 বাংলা"],
    ["ja", "🇯🇵 日本語"],
    ["ko", "🇰🇷 한국어"],
    ["zh-CN", "🇨🇳 中文（简体）"],
    ["zh-TW", "🇹🇼 中文（繁體）"],
    ["id", "🇮🇩 Bahasa Indonesia"],
    ["vi", "🇻🇳 Tiếng Việt"],
    ["th", "🇹🇭 ไทย"],
    ["sv", "🇸🇪 Svenska"],
    ["da", "🇩🇰 Dansk"],
    ["fi", "🇫🇮 Suomi"],
    ["el", "🇬🇷 Ελληνικά"],
    ["ro", "🇷🇴 Română"],
    ["hu", "🇭🇺 Magyar"],
    ["cs", "🇨🇿 Čeština"],
    ["sk", "🇸🇰 Slovenčina"],
    ["hr", "🇭🇷 Hrvatski"],
    ["sr", "🇷🇸 Српски"],
    ["ms", "🇲🇾 Bahasa Melayu"],
    ["fa", "🇮🇷 فارسی"],
    ["sw", "🇰🇪 Kiswahili"],
    ["tl", "🇵🇭 Filipino"],
    ["ta", "🇮🇳 தமிழ்"],
    ["ur", "🇵🇰 اردو"],
    ["no", "🇳🇴 Norsk"]
  ];

  function canonicalLanguage(value) {
    var language = String(value || "").trim().split("|").pop().toLowerCase();
    if (!language) return "";
    if (language === "pt-br") return "pt";
    if (language === "zh-cn" || language === "zh-hans") return "zh-CN";
    if (language === "zh-tw" || language === "zh-hant") return "zh-TW";
    if (language === "iw") return "he";
    if (language === "jw") return "jv";
    if (language === "fil") return "tl";
    return language;
  }

  function getSavedLanguage() {
    try {
      var manual = canonicalLanguage(sessionStorage.getItem("lovenaManualLanguage"));
      if (manual) return manual;
      var saved = canonicalLanguage(localStorage.getItem("lovenaPreferredLanguage"));
      if (saved) return saved;
    } catch (error) {}
    return "";
  }

  function defaultLanguage() {
    var country = String(window.LOVENA_REGION_COUNTRY || "").toUpperCase();
    if (country === "BR") return "pt";
    try {
      var locale = String(navigator.language || "").toLowerCase();
      if (locale === "pt-br" || locale.startsWith("pt-")) return "pt";
    } catch (error) {}
    return "en";
  }

  function ensureOption(selector, code) {
    if (!code || Array.from(selector.options).some(function (option) {
      return canonicalLanguage(option.value) === code;
    })) return;
    var option = document.createElement("option");
    option.value = code;
    option.textContent = code.toUpperCase();
    selector.appendChild(option);
  }

  function init() {
    var control = document.getElementById(CONTROL_ID);
    var selector = document.getElementById(SELECT_ID);
    if (!control || !selector) return;

    var query = new URLSearchParams(window.location.search);
    var isEditing = query.get("edit") === "1" && !query.get("slug");
    control.hidden = !isEditing;
    control.dataset.languageControlReady = "true";
    if (!isEditing) return;

    var language = getSavedLanguage() || defaultLanguage();
    ensureOption(selector, language);
    selector.value = language;

    selector.addEventListener("change", function () {
      var selected = canonicalLanguage(selector.value);
      if (!selected) return;
      // This is the visitor's interface preference, not the language of the
      // personal gift text. Save it separately from the gift's own locale.
      try {
        localStorage.setItem("lovenaPreferredLanguage", selected);
        sessionStorage.setItem("lovenaManualLanguage", selected);
      } catch (error) {}
      window.dispatchEvent(new CustomEvent("lovena:interface-language-changed", {
        detail: { language: selected }
      }));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
