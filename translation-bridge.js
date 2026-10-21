
(function(){
  "use strict";
  window.googleTranslateElementInit=function(){
    if(!window.google||!google.translate||!google.translate.TranslateElement)return;
    new google.translate.TranslateElement({pageLanguage:"en",includedLanguages:"en,pt,es,fr,de,it,nl,sv,da,no,fi,pl,cs,sk,sl,hr,sr,bs,bg,ro,hu,el,ru,uk,tr,ar,he,fa,ur,hi,bn,ta,te,ml,mr,gu,pa,ne,si,th,vi,id,ms,tl,sw,am,ha,yo,ig,zu,xh,af,so,ps,ku,az,hy,ka,kk,uz,mn,my,km,lo,ja,ko,zh-CN,zh-TW,et,lv,lt,ga,cy,eu,gl,ca,sq,mk,be,lb,mt,fy,yi,ny,sn,sd,tg,ky,tk,tt,ug,or,as,ckb,qu,pap,co,ilo,war,bho,ace,ban,min,rom,sah,ti,oc,br,rn,rw,ak,bm,ee,kab,kri,st,tn,tiv",autoDisplay:false,multilanguagePage:true}, "google_translate_element");
    syncLanguageControl();
  };
  function normalizeLang(v){return String(v||"").split("|").pop().toLowerCase();}
  function syncLanguageControl(){
    var visible=document.querySelector(".gtranslate_wrapper select,.gt_selector");
    var hidden=document.querySelector("#google_translate_element select");
    if(!visible||!hidden)return;
    var current=normalizeLang(visible.value);
    if(current && hidden.value!==current)hidden.value=current;
  }
  function changeLanguage(lang){
    lang=normalizeLang(lang);
    if(!lang)return;
    var hidden=document.querySelector("#google_translate_element select");
    var visible=document.querySelector(".gtranslate_wrapper select,.gt_selector");
    var target=hidden||visible;
    if(!target)return;
    var match=Array.from(target.options||[]).find(function(o){return normalizeLang(o.value)===lang;});
    if(!match)return;
    target.value=match.value;
    target.dispatchEvent(new Event("change",{bubbles:true}));
    try{localStorage.setItem("lovenaPreferredLanguage",lang)}catch(e){}
  }
  document.addEventListener("change",function(e){
    if(e.target.matches(".gtranslate_wrapper select,.gt_selector"))changeLanguage(e.target.value);
  },true);
  var observer=new MutationObserver(function(){
    var select=document.querySelector(".gtranslate_wrapper select,.gt_selector");
    if(select&&!select.dataset.lovenaBound){
      select.dataset.lovenaBound="1";
      var preferred="en";try{preferred=localStorage.getItem("lovenaPreferredLanguage")||"en"}catch(e){}
      if(preferred!=="en")setTimeout(function(){changeLanguage(preferred)},250);
    }
  });
  function watchDynamicContent(){
    ["studioStepBody","studioControls","studioStepNav","studioMiniPreview","readerCard","readerProgress"].forEach(function(id){
      var el=document.getElementById(id);if(el)observer.observe(el,{childList:true,subtree:true,characterData:true});
    });
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",watchDynamicContent);else watchDynamicContent();
  var script=document.createElement("script");
  script.src="https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
  script.async=true;script.onerror=function(){console.warn("Google Translate could not be loaded; check network/ad-blocking settings.")};
  document.head.appendChild(script);
  window.addEventListener("load",function(){setTimeout(syncLanguageControl,700)});
})();
