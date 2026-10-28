/* Lovena regional defaults with independent, user-selectable language and currency. */
(function () {
  "use strict";
  var CURRENCY_KEY = "lovenaPreferredCurrency";
  function browserFallbackCountry() {
    try {
      var locale = String(navigator.language || "").toLowerCase();
      var languages = Array.isArray(navigator.languages) ? navigator.languages.map(function (item) { return String(item).toLowerCase(); }) : [];
      var timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      var zones = "|America/Sao_Paulo|America/Fortaleza|America/Recife|America/Manaus|America/Belem|America/Bahia|America/Campo_Grande|America/Cuiaba|America/Porto_Velho|America/Boa_Vista|America/Rio_Branco|America/Noronha|America/Maceio|America/Araguaina|America/Santarem|";
      return locale === "pt-br" || languages.indexOf("pt-br") !== -1 || zones.indexOf("|" + timezone + "|") !== -1 ? "BR" : "US";
    } catch (error) { return String(navigator.language || "").toLowerCase() === "pt-br" ? "BR" : "US"; }
  }
  function getCurrencyPreference() {
    try { var saved = localStorage.getItem(CURRENCY_KEY); if (saved === "brl" || saved === "usd") return saved; } catch (error) {}
    return "";
  }
  function applyPrices(currency) {
    var isBRL = currency === "brl";
    var simple = document.querySelector("#plans .lr-plan-basic .lr-price");
    var premium = document.querySelector("#plans .lr-plan-featured .lr-price");
    if (simple) { simple.textContent = isBRL ? "R$ 9,99" : "US$ 4.99"; simple.setAttribute("aria-label", isBRL ? "9 reais e 99 centavos" : "4.99 US dollars"); simple.setAttribute("lang", isBRL ? "pt-BR" : "en-US"); }
    if (premium) { premium.textContent = isBRL ? "R$ 19,99" : "US$ 9.99"; premium.setAttribute("aria-label", isBRL ? "19 reais e 99 centavos" : "9.99 US dollars"); premium.setAttribute("lang", isBRL ? "pt-BR" : "en-US"); }
    document.querySelectorAll("#plans .lr-plan li span.notranslate").forEach(function (item) { item.textContent = isBRL ? "R$ 5,00" : "US$ 1.00"; item.setAttribute("lang", isBRL ? "pt-BR" : "en-US"); });
    var selector = document.getElementById("lovenaCurrencySelect");
    if (selector && selector.value !== currency) selector.value = currency;
    window.LOVENA_CURRENCY_CODE = currency;
    window.LOVENA_IS_BRAZIL_CURRENCY = isBRL;
  }
  function setCurrencyPreference(currency) {
    var value = currency === "brl" ? "brl" : "usd";
    try { localStorage.setItem(CURRENCY_KEY, value); } catch (error) {}
    applyPrices(value);
    try { window.dispatchEvent(new CustomEvent("lovena:currency-changed", { detail: { currencyCode: value } })); } catch (error) {}
  }
  function applyCountry(country) {
    var code = /^[A-Z]{2}$/.test(String(country || "").toUpperCase()) ? String(country).toUpperCase() : "US";
    window.LOVENA_REGION_COUNTRY = code;
    window.LOVENA_IS_BRAZIL = code === "BR";
    var manual = "";
    try { manual = sessionStorage.getItem("lovenaManualLanguage") || ""; } catch (error) {}
    var language = manual || (code === "BR" ? "pt" : "en");
    document.documentElement.setAttribute("lang", language === "pt" ? "pt-BR" : language);
    document.documentElement.setAttribute("data-lovena-language", language);
    try { document.cookie = "googtrans=/en/" + language + ";path=/;max-age=31536000;SameSite=Lax"; } catch (error) {}
    var currency = getCurrencyPreference() || (code === "BR" ? "brl" : "usd");
    applyPrices(currency);
    try { window.dispatchEvent(new CustomEvent("lovena:region-detected", { detail: { countryCode: code, isBrazil: code === "BR", currencyCode: currency } })); } catch (error) {}
    return code;
  }
  var fallback = browserFallbackCountry();
  applyCountry(fallback);
  var selector = document.getElementById("lovenaCurrencySelect");
  if (selector) selector.addEventListener("change", function () { setCurrencyPreference(selector.value); });
  window.LOVENA_SET_CURRENCY = setCurrencyPreference;
  window.LOVENA_REGION_READY = fetch("https://ipapi.co/json/", { cache: "no-store" })
    .then(function (response) { if (!response.ok) throw new Error("region_lookup_failed"); return response.json(); })
    .then(function (data) { var country = String(data && (data.country_code || data.country) || "").toUpperCase(); if (!/^[A-Z]{2}$/.test(country)) throw new Error("invalid_country"); return applyCountry(country); })
    .catch(function () { return applyCountry(fallback); });
})();
