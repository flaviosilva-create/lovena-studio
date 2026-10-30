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
    try { var saved = localStorage.getItem(CURRENCY_KEY); if (saved === "brl" || saved === "usd" || saved === "eur") return saved; } catch (error) {}
    return "";
  }
  function updateBRLAvailability(isBrazil) {
    var allowed = isBrazil === true;
    window.LOVENA_CAN_USE_BRL = allowed;
    var selector = document.getElementById("lovenaCurrencySelect");
    var option = selector && selector.querySelector('option[value="brl"]');
    if (option) {
      option.hidden = !allowed;
      option.disabled = !allowed;
      option.style.display = allowed ? "" : "none";
      if (!allowed && selector.value === "brl") selector.value = "usd";
    }
  }
  function applyPrices(currency) {
    if (currency === "brl" && window.LOVENA_CAN_USE_BRL !== true) currency = "usd";
    var prices = {
      brl: {
        simple: "R$ 9,99",
        premium: "R$ 19,99",
        addon: "R$ 5,00",
        language: "pt-BR",
        simpleLabel: "9 reais e 99 centavos",
        premiumLabel: "19 reais e 99 centavos"
      },
      usd: {
        simple: "US$ 4.99",
        premium: "US$ 9.99",
        addon: "US$ 1.00",
        language: "en-US",
        simpleLabel: "4.99 US dollars",
        premiumLabel: "9.99 US dollars"
      },
      eur: {
        simple: "€ 4,99",
        premium: "€ 9,99",
        addon: "€ 1,00",
        language: "en-IE",
        simpleLabel: "4 euros and 99 cents",
        premiumLabel: "9 euros and 99 cents"
      }
    };
    var selected = prices[currency] ? currency : "usd";
    var config = prices[selected];
    var simple = document.querySelector("#plans .lr-plan-basic .lr-price");
    var premium = document.querySelector("#plans .lr-plan-featured .lr-price");
    if (simple) {
      simple.textContent = config.simple;
      simple.setAttribute("aria-label", config.simpleLabel);
      simple.setAttribute("lang", config.language);
    }
    if (premium) {
      premium.textContent = config.premium;
      premium.setAttribute("aria-label", config.premiumLabel);
      premium.setAttribute("lang", config.language);
    }
    document.querySelectorAll("#plans .lr-plan li span.notranslate").forEach(function (item) {
      item.textContent = config.addon;
      item.setAttribute("lang", config.language);
    });
    var selector = document.getElementById("lovenaCurrencySelect");
    if (selector && selector.value !== selected) selector.value = selected;
    window.LOVENA_CURRENCY_CODE = selected;
    window.LOVENA_IS_BRAZIL_CURRENCY = selected === "brl";
  }
  function setCurrencyPreference(currency) {
    var value = currency === "brl" || currency === "eur" || currency === "usd" ? currency : "usd";
    if (value === "brl" && window.LOVENA_CAN_USE_BRL !== true) value = "usd";
    try { localStorage.setItem(CURRENCY_KEY, value); } catch (error) {}
    applyPrices(value);
    try { window.dispatchEvent(new CustomEvent("lovena:currency-changed", { detail: { currencyCode: value } })); } catch (error) {}
  }
  function applyCountry(country, verified) {
    var code = /^[A-Z]{2}$/.test(String(country || "").toUpperCase()) ? String(country).toUpperCase() : "US";
    var isVerifiedBrazil = verified === true && code === "BR";
    window.LOVENA_REGION_VERIFIED = verified === true;
    window.LOVENA_REGION_COUNTRY = verified === true ? code : "";
    window.LOVENA_IS_BRAZIL = isVerifiedBrazil;
    updateBRLAvailability(isVerifiedBrazil);
    var manual = "";
    try { manual = sessionStorage.getItem("lovenaManualLanguage") || ""; } catch (error) {}
    // Use the detected country for automatic defaults. Old saved values may
    // have been generated automatically in a previous country or VPN session.
    var language = manual || (code === "BR" ? "pt" : "en");
    document.documentElement.setAttribute("lang", language === "pt" ? "pt-BR" : language);
    document.documentElement.setAttribute("data-lovena-language", language);
    var languageSelector = document.getElementById("lovenaLanguageSelect");
    if (languageSelector && Array.from(languageSelector.options).some(function (option) { return option.value === language; })) {
      languageSelector.value = language;
    }
    try { document.cookie = "googtrans=/en/" + language + ";path=/;max-age=31536000;SameSite=Lax"; } catch (error) {}
    var savedCurrency = getCurrencyPreference();
    var currency = isVerifiedBrazil
      ? (savedCurrency || "brl")
      : (savedCurrency === "eur" || savedCurrency === "usd" ? savedCurrency : "usd");
    applyPrices(currency);
    try {
      window.dispatchEvent(new CustomEvent("lovena:region-detected", {
        detail: {
          countryCode: verified === true ? code : "",
          isBrazil: isVerifiedBrazil,
          currencyCode: currency,
          verified: verified === true
        }
      }));
    } catch (error) {}
    return code;
  }
  // Start in English until IP geolocation confirms the visitor is in Brazil.
  // Browser locale/timezone can still be Brazilian while a VPN routes traffic elsewhere.
  var fallback = "US";
  // Fail closed: hide BRL until IP geolocation confirms the visitor is in Brazil.
  applyCountry(fallback, false);
  var selector = document.getElementById("lovenaCurrencySelect");
  if (selector) selector.addEventListener("change", function () { setCurrencyPreference(selector.value); });
  window.LOVENA_SET_CURRENCY = setCurrencyPreference;
  window.LOVENA_REGION_READY = fetch("https://ipapi.co/json/", { cache: "no-store" })
    .then(function (response) { if (!response.ok) throw new Error("region_lookup_failed"); return response.json(); })
    .then(function (data) { var country = String(data && (data.country_code || data.country) || "").toUpperCase(); if (!/^[A-Z]{2}$/.test(country)) throw new Error("invalid_country"); return applyCountry(country, true); })
    .catch(function () { return applyCountry(fallback, false); });
})();
