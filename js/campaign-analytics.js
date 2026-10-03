// Источник рекламного визита и цели счётчика 111842641.
// Метки хранятся в пределах вкладки; персональные данные в Метрику не передаются.
(function () {
  "use strict";
  var KEY = "kodrosta_campaign_v1";
  var keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
  var data = {};
  try { data = JSON.parse(sessionStorage.getItem(KEY) || "{}"); } catch (e) {}
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  var params = new URLSearchParams(location.search);
  var tagged = keys.some(function (key) { return !!params.get(key); });
  if (tagged) {
    data = {};
    keys.forEach(function (key) { if (params.get(key)) data[key] = params.get(key).slice(0, 200); });
    try { sessionStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
  }
  function attribution() {
    var out = {};
    keys.forEach(function (key) { if (typeof data[key] === "string") out[key] = data[key].slice(0, 200); });
    return out;
  }
  function track(goal, extra) {
    if (typeof window.ym !== "function") return;
    try { window.ym(111842641, "reachGoal", goal, Object.assign(attribution(), extra || {})); } catch (e) {}
  }
  window.kodrostaAnalytics = { attribution: attribution, track: track };
  if (tagged && data.utm_medium === "qr") track("qr_landing_open");

  // Делегирование учитывает и ссылки, добавленные на страницу позднее.
  document.addEventListener("click", function (event) {
    var link = event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    var url;
    try { url = new URL(link.href, location.href); } catch (e) { return; }
    if (url.hostname === "t.me" && /^\/Kodrosta\/?$/i.test(url.pathname)) {
      try { sessionStorage.setItem("kodrosta_contact_clicked", "1"); } catch (e) {}
      track("manager_telegram_click");
    }
  });
}());
