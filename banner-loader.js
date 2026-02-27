/**
 * バナーローダー（クリック計測付き）
 * banners.config.js の設定に従い、data-banner 属性の要素にバナーを挿入する。
 * クリック時は analytics/event に banner_click を送信（送信失敗は握りつぶし）。
 */
(function () {
  function getConfig() {
    var gameId = (typeof window.GAME_ID !== "undefined") ? window.GAME_ID : null;
    var base = window.BANNERS_CONFIG;
    if (!base || !base.placements) return null;
    var placements = base.placements;
    if (gameId && base.gameOverrides && base.gameOverrides[gameId]) {
      placements = Object.assign({}, placements, base.gameOverrides[gameId]);
    }
    return { placements: placements };
  }

  function trackClick(bannerName, url) {
    try {
      var apiBase = (typeof window.BAKENEKO_API_BASE === "string") ? window.BAKENEKO_API_BASE.replace(/\/+$/, "") : "";
      var gameId = (typeof window.BAKENEKO_GAME_ID === "string") ? window.BAKENEKO_GAME_ID : "kohada";
      if (apiBase) {
        var body = JSON.stringify({
          game_id: gameId,
          event_name: "banner_click",
          props: { banner: bannerName, url: url }
        });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(apiBase + "/api/analytics/event", new Blob([body], { type: "application/json" }));
        } else {
          fetch(apiBase + "/api/analytics/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body,
            keepalive: true
          }).catch(function () {});
        }
      }
      if (typeof window.gtag === "function") {
        window.gtag("event", "banner_click", { banner_name: bannerName, link_url: url });
      }
    } catch (_) {}
  }

  function injectImage(parent, name, opt) {
    var url = opt.url || "#";
    var imgSrc = opt.imgSrc || opt.imgUrl || "";
    var alt = opt.alt || "";
    var w = opt.width || 320;
    var h = opt.height || 50;

    var a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "banner-link";
    a.addEventListener("click", function () { trackClick(name, url); });

    var img = document.createElement("img");
    img.src = imgSrc;
    img.alt = alt;
    img.style.width = "100%";
    img.style.height = "auto";
    img.style.display = "block";
    img.style.borderRadius = "6px";
    a.appendChild(img);
    parent.appendChild(a);
  }

  function injectAdSense(parent, name, opt) {
    var c = opt.client, s = opt.slot, w = opt.width || 320, h = opt.height || 50;
    if (!c || !s) return;

    var script = document.createElement("script");
    script.async = true;
    script.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + c;
    script.crossOrigin = "anonymous";
    document.head.appendChild(script);

    var ins = document.createElement("ins");
    ins.className = "adsbygoogle";
    ins.style.display = "inline-block";
    ins.style.width = w + "px";
    ins.style.height = h + "px";
    ins.setAttribute("data-ad-client", c);
    ins.setAttribute("data-ad-slot", s);
    parent.appendChild(ins);

    script.onload = function () {
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
    };
  }

  function run() {
    var config = getConfig();
    if (!config) return;

    document.querySelectorAll("[data-banner]").forEach(function (el) {
      var name = el.getAttribute("data-banner");
      var opt = config.placements[name];
      if (!opt) return;
      el.innerHTML = "";
      if (opt.type === "image") {
        injectImage(el, name, opt);
      } else if (opt.type === "adsense") {
        injectAdSense(el, name, opt);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
