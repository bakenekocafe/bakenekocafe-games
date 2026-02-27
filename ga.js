// GA4 — 測定ID は GA_MEASUREMENT_ID を置換してください
// Google Analytics 管理画面 → データストリーム → 測定ID（G-XXXXXXXXXX 形式）
(function(){
  var GA_ID = 'G-XXXXXXXXXX'; // ← ここに実際の測定IDを入れる
  if (GA_ID === 'G-XXXXXXXXXX') return; // 未設定時はスキップ

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', GA_ID);
})();
