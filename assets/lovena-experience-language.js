/* Lovena experience interface language selector.
   Uses the same translation bridge as the landing page and is editor-only:
   it is never included in shared/public or downloaded gift experiences. */
(function () {
  "use strict";

  var CONTROL_ID = "lovenaExperienceLanguageControl";
  var SELECT_ID = "lovenaExperienceLanguageSelect";
  // Keep this list aligned with the landing-page GTranslate language options.
  var LANGUAGE_CODES = ["en","pt","es","fr","de","it","nl","sv","da","no","fi","is","pl","cs","sk","sl","hr","sr","bs","bg","ro","hu","el","ru","uk","tr","ar","he","fa","ur","hi","bn","ta","te","ml","mr","gu","pa","ne","si","th","vi","id","ms","tl","sw","am","ha","yo","ig","zu","xh","af","so","ps","ku","az","hy","ka","kk","uz","mn","my","km","lo","ja","ko","zh-CN","zh-TW","jv","su","ceb","mi","sm","haw","ht","la","eo","et","lv","lt","ga","cy","gd","eu","gl","ca","sq","mk","be","lb","mt","fy","yi","ny","sn","sd","tg","ky","tk","tt","ug","or","as","doi","sat","gom","mai","lus","nso","ts","wo","kok","sa","ckb","qu","pap","co","ilo","war","bho","ace","ban","bug","min","rom","sah","ti","oc","br","rn","rw","ak","bm","ee","kab","kri","st","tn","tiv","xmf"];
  var LANGUAGE_NAMES = {
    en:"🇺🇸 English",pt:"🇧🇷 Português",es:"🇪🇸 Español",fr:"🇫🇷 Français",de:"🇩🇪 Deutsch",it:"🇮🇹 Italiano",
    nl:"🇳🇱 Nederlands",sv:"🇸🇪 Svenska",da:"🇩🇰 Dansk",no:"🇳🇴 Norsk",fi:"🇫🇮 Suomi",is:"Íslenska",
    pl:"🇵🇱 Polski",cs:"🇨🇿 Čeština",sk:"🇸🇰 Slovenčina",sl:"Slovenščina",hr:"🇭🇷 Hrvatski",sr:"🇷🇸 Српски",
    bs:"Bosanski",bg:"Български",ro:"🇷🇴 Română",hu:"Magyar",el:"🇬🇷 Ελληνικά",ru:"🇷🇺 Русский",uk:"🇺🇦 Українська",
    tr:"🇹🇷 Türkçe",ar:"🇸🇦 العربية",he:"🇮🇱 עברית",fa:"🇮🇷 فارسی",ur:"🇵🇰 اردو",hi:"🇮🇳 हिन्दी",bn:"🇧🇩 বাংলা",
    ta:"🇮🇳 தமிழ்",te:"తెలుగు",ml:"മലയാളം",mr:"मराठी",gu:"ગુજરાતી",pa:"ਪੰਜਾਬੀ",ne:"नेपाली",si:"සිංහල",
    th:"🇹🇭 ไทย",vi:"🇻🇳 Tiếng Việt",id:"🇮🇩 Bahasa Indonesia",ms:"🇲🇾 Bahasa Melayu",tl:"🇵🇭 Filipino",
    ja:"🇯🇵 日本語",ko:"🇰🇷 한국어","zh-CN":"🇨🇳 中文（简体）","zh-TW":"🇹🇼 中文（繁體）",
    af:"Afrikaans",am:"አማርኛ",ha:"Hausa",yo:"Yorùbá",ig:"Igbo",zu:"isiZulu",xh:"isiXhosa",so:"Soomaali",
    ps:"پښتو",ku:"Kurdî",az:"Azərbaycanca",hy:"Հայերեն",ka:"ქართული",kk:"Қазақша",uz:"Oʻzbekcha",
    mn:"Монгол",my:"မြန်မာ",km:"ខ្មែរ",lo:"ລາວ",jv:"Basa Jawa",su:"Basa Sunda",ceb:"Cebuano",mi:"Māori",
    sm:"Gagana Sāmoa",haw:"ʻŌlelo Hawaiʻi",ht:"Kreyòl ayisyen",la:"Latina",eo:"Esperanto",et:"Eesti",
    lv:"Latviešu",lt:"Lietuvių",ga:"Gaeilge",cy:"Cymraeg",gd:"Gàidhlig",eu:"Euskara",gl:"Galego",ca:"Català",
    sq:"Shqip",mk:"Македонски",be:"Беларуская",lb:"Lëtzebuergesch",mt:"Malti",fy:"Frysk",yi:"ייִדיש",
    ny:"Chichewa",sn:"chiShona",sd:"سنڌي",tg:"Тоҷикӣ",ky:"Кыргызча",tk:"Türkmençe",tt:"Татарча",ug:"ئۇيغۇرچە",
    or:"ଓଡ଼ିଆ",as:"অসমীয়া",doi:"डोगरी",sat:"ᱥᱟᱱᱛᱟᱲᱤ",gom:"कोंकणी",mai:"मैथिली",lus:"Mizo",nso:"Sesotho sa Leboa",
    ts:"Xitsonga",wo:"Wolof",kok:"कोंकणी",sa:"संस्कृतम्",ckb:"کوردیی ناوەندی",qu:"Runasimi",pap:"Papiamentu",
    co:"Corsu",ilo:"Ilokano",war:"Waray",bho:"भोजपुरी",ace:"Bahsa Acèh",ban:"Basa Bali",bug:"Basa Bugis",
    min:"Baso Minangkabau",rom:"Romani",sah:"Саха тыла",ti:"ትግርኛ",oc:"Occitan",br:"Brezhoneg",
    rn:"Ikirundi",rw:"Ikinyarwanda",ak:"Akan",bm:"Bamanankan",ee:"Eʋegbe",kab:"Taqbaylit",kri:"Krio",
    st:"Sesotho",tn:"Setswana",tiv:"Tiv",xmf:"მარგალური"
  };

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

  function languageLabel(code) {
    if (LANGUAGE_NAMES[code]) return LANGUAGE_NAMES[code];
    try {
      if (typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
        var displayName = new Intl.DisplayNames([code], { type: "language" }).of(code);
        if (displayName && displayName.toLowerCase() !== code.toLowerCase()) return displayName;
      }
    } catch (error) {}
    return code.toUpperCase();
  }

  function ensureOption(selector, code) {
    if (!code || Array.from(selector.options).some(function (option) {
      return canonicalLanguage(option.value) === code;
    })) return;
    var option = document.createElement("option");
    option.value = code;
    option.textContent = languageLabel(code);
    selector.appendChild(option);
  }

  function populateLanguageOptions(selector) {
    LANGUAGE_CODES.forEach(function (code) {
      var canonical = canonicalLanguage(code);
      if (!canonical || Array.from(selector.options).some(function (option) {
        return canonicalLanguage(option.value) === canonical;
      })) return;
      var option = document.createElement("option");
      option.value = code;
      option.textContent = languageLabel(code);
      selector.appendChild(option);
    });
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

    populateLanguageOptions(selector);
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
