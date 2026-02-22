(function () {
  'use strict';

  var startBtn = document.getElementById('btn-start');
  var rewardCta = document.getElementById('reward-cta');
  var rewardBtn = document.getElementById('btn-reward');

  if (startBtn) {
    startBtn.addEventListener('click', function () {
      try {
        if (window.BakenekoAnalytics) window.BakenekoAnalytics.event('game_start');
      } catch (e) {}
      startBtn.textContent = '開始しました';
      if (rewardCta && window.BakenekoAds && window.BakenekoAds.isRewardedAvailable && window.BakenekoAds.isRewardedAvailable()) {
        rewardCta.style.display = 'block';
      }
    });
  }

  if (rewardBtn) {
    rewardBtn.addEventListener('click', function () {
      if (!window.BakenekoAds || !window.BakenekoAds.showRewarded) return;
      rewardBtn.disabled = true;
      window.BakenekoAds.showRewarded()
        .then(function (r) {
          if (r.granted) {
            try { if (window.BakenekoAnalytics) window.BakenekoAnalytics.event('reward_granted'); } catch (e) {}
            alert('リワードを付与しました');
          }
          rewardBtn.disabled = false;
        })
        .catch(function () { rewardBtn.disabled = false; });
    });
  }
})();
