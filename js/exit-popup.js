// ============================================================================
// Exit-intent pop-up с оффером «-3000 ₽» — отдельный компонент, продолжение
// рекламного баннера с QR-кодом. Работает независимо от остального сайта:
// сам строит свою разметку и сам шлёт заявку в /api/submit (тот же Worker,
// та же Telegram-группа, что и обычные формы — см. src/index.js).
//
// Чтобы ПОЛНОСТЬЮ отключить pop-up — поставьте enabled: false ниже,
// либо уберите строку <script src="js/exit-popup.js"> из index.html.
// Остальной сайт от этого никак не пострадает.
// ============================================================================

(function () {
  "use strict";

  // ---- Конфигурация: правьте здесь -------------------------------------------
  var exitPopupConfig = {
    enabled: true,               // вкл/выкл pop-up целиком
    discount: 3000,               // размер скидки, ₽ — подставляется во все тексты
    promoCode: "KOD3000",         // промокод в экране успеха; "" — не показывать промокод
    cooldownDays: 7,              // сколько дней не показывать повторно после показа
    minTimeOnPage: 25,            // секунд на сайте, раньше которых pop-up не сработает (реком. 20-30)
    mobileFallbackSeconds: 35,    // мобильный fallback по таймауту, если сигналов ухода не было (реком. 30-45)
    successCtaTarget: "#events",  // куда ведёт кнопка "Перейти к выбору" на экране успеха
    managerTelegram: "t.me/Kodrosta", // куда отправить писать вручную, если заявка не ушла
    metrikaCounterId: 111842641   // счётчик Яндекс.Метрики, уже установленный на сайте (index.html)
  };

  if (!exitPopupConfig.enabled) return;

  // ---- Ключи хранения ---------------------------------------------------------
  var STORAGE_SHOWN = "kodrosta_exit_popup_shown_at";
  var STORAGE_CONVERTED = "kodrosta_conversion_completed";
  var STORAGE_UTM = "kodrosta_utm";
  var STORAGE_PROMO_PENDING = "kodrosta_promo_pending";

  function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function safeSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
  function safeSessionGet(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }
  function safeSessionSet(key, val) { try { sessionStorage.setItem(key, val); } catch (e) {} }

  // ---- Аналитика: используем уже установленную на сайте Яндекс.Метрику -------
  function track(goal, params) {
    if (typeof window.ym !== "function") return;
    try { window.ym(exitPopupConfig.metrikaCounterId, "reachGoal", goal, params || {}); } catch (e) {}
  }

  // ---- UTM: фиксируем источник перехода по QR-коду с баннера (first-touch) ---
  // Рекомендованный вид ссылки на баннере:
  // https://codrosta.club/?utm_source=banner&utm_medium=qr&utm_campaign=kod_rosta_3000
  function captureUtm() {
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return { landing_page: location.href }; }

    var keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
    var fresh = {};
    var hasAny = false;
    keys.forEach(function (k) {
      var v = params.get(k);
      if (v) { fresh[k] = v; hasAny = true; }
    });

    if (hasAny) {
      fresh.landing_page = location.href;
      safeSessionSet(STORAGE_UTM, JSON.stringify(fresh));
      track("qr_landing_open", fresh);
      return fresh;
    }

    var stored = safeSessionGet(STORAGE_UTM);
    if (stored) {
      try { return JSON.parse(stored); } catch (e) {}
    }
    return { landing_page: location.href };
  }

  var utmData = captureUtm();

  // ---- Гейты показа -------------------------------------------------------------
  var pageLoadTime = Date.now();
  var triggered = false;

  function hasConverted() { return safeGet(STORAGE_CONVERTED) === "1"; }

  function inCooldown() {
    var shownAt = safeGet(STORAGE_SHOWN);
    if (!shownAt) return false;
    var days = (Date.now() - Number(shownAt)) / 86400000;
    return days < exitPopupConfig.cooldownDays;
  }

  function anyOtherModalOpen() {
    return !!document.querySelector(".js-modal-overlay.is-open");
  }

  function minTimeElapsed() {
    return Date.now() - pageLoadTime >= exitPopupConfig.minTimeOnPage * 1000;
  }

  function canShow() {
    return !hasConverted() && !inCooldown() && !anyOtherModalOpen() && minTimeElapsed();
  }

  function maybeTrigger() {
    if (triggered || !canShow()) return;
    triggered = true;
    showPopup();
  }

  // ---- Маска телефона (RU) -----------------------------------------------------
  function formatRuPhone(raw) {
    if (!raw) return "";
    var digits = raw.replace(/\D/g, "");
    if (!digits) return "";
    if (digits.charAt(0) === "8") digits = "7" + digits.slice(1);
    if (digits.charAt(0) !== "7") digits = "7" + digits;
    digits = digits.slice(0, 11);
    var rest = digits.slice(1);
    var out = "+7";
    if (rest.length) out += " (" + rest.slice(0, 3);
    if (rest.length >= 3) out += ")";
    if (rest.length > 3) out += " " + rest.slice(3, 6);
    if (rest.length > 6) out += "-" + rest.slice(6, 8);
    if (rest.length > 8) out += "-" + rest.slice(8, 10);
    return out;
  }

  // ---- Разметка pop-up (строится один раз, лениво — при первом показе) --------
  var popupEl = null;

  function fmtMoney(n) { return n.toLocaleString("ru-RU") + " ₽"; }

  function buildPopup() {
    var overlay = document.createElement("div");
    overlay.className = "exit-popup-overlay js-exit-popup-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "exit-popup-title");

    var promoLine = exitPopupConfig.promoCode
      ? " Ваш промокод: <strong>" + exitPopupConfig.promoCode + "</strong>."
      : "";

    overlay.innerHTML =
      '<div class="exit-popup">' +
        '<button class="exit-popup-close js-exit-popup-close" type="button" aria-label="Закрыть">×</button>' +
        '<div class="exit-popup-grid">' +
          '<div class="exit-popup-main">' +

            '<div class="exit-popup-state js-exit-popup-form-state">' +
              '<h3 id="exit-popup-title">Не уходите без бонуса</h3>' +
              '<p class="exit-popup-sub">Дарим ' + fmtMoney(exitPopupConfig.discount) + ' на вступление в &laquo;Код Роста&raquo; или любое мероприятие клуба.</p>' +
              '<p class="exit-popup-text">Возможно, вы пока просто присматриваетесь. Оставьте контакты — сохраним за вами скидку ' + fmtMoney(exitPopupConfig.discount) + '.</p>' +
              '<div class="form-status js-exit-popup-status"></div>' +
              '<form class="js-exit-popup-form" novalidate>' +
                '<input type="text" name="website" class="form-hp" tabindex="-1" autocomplete="off">' +
                '<div class="form-field">' +
                  '<label for="exit-popup-name">Имя</label>' +
                  '<input id="exit-popup-name" name="name" type="text" required autocomplete="name" placeholder="Как к вам обращаться?">' +
                '</div>' +
                '<div class="form-field">' +
                  '<label for="exit-popup-phone">Телефон</label>' +
                  '<input id="exit-popup-phone" name="phone" type="tel" inputmode="tel" required autocomplete="tel" placeholder="+7 (___) ___-__-__">' +
                '</div>' +
                '<div class="form-field">' +
                  '<label for="exit-popup-telegram">Telegram</label>' +
                  '<input id="exit-popup-telegram" name="telegram" type="text" required placeholder="@username">' +
                '</div>' +
                '<p class="exit-popup-hint">Куда удобнее отправить информацию о скидке?</p>' +
                '<button class="btn btn--primary btn--block exit-popup-cta" type="submit">Получить скидку ' + fmtMoney(exitPopupConfig.discount) + '</button>' +
                '<p class="form-consent">Нажимая кнопку, вы соглашаетесь на <a href="/privacy" target="_blank">обработку персональных данных</a> и получение информации от «Кода Роста».</p>' +
              '</form>' +
            '</div>' +

            '<div class="exit-popup-state js-exit-popup-success-state" hidden>' +
              '<h3>Скидка за вами 🎁</h3>' +
              '<p class="exit-popup-text">Мы получили ваши контакты. Скидка ' + fmtMoney(exitPopupConfig.discount) + ' доступна для вступления в «Код Роста» или участия в любом мероприятии клуба.' + promoLine + '</p>' +
              '<button class="btn btn--primary btn--block js-exit-popup-cta-success" type="button">Перейти к выбору</button>' +
            '</div>' +

          '</div>' +
          '<div class="exit-popup-side" aria-hidden="true">' +
            '<div class="exit-popup-badge">&minus;' + fmtMoney(exitPopupConfig.discount) + '</div>' +
            '<svg class="exit-popup-vector" viewBox="0 0 200 140" xmlns="http://www.w3.org/2000/svg">' +
              '<polyline points="10,120 55,80 90,100 140,40 190,15" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>' +
              '<polygon points="190,15 163,21 186,39" fill="currentColor"/>' +
            '</svg>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    bindPopupEvents(overlay);
    return overlay;
  }

  function setStatus(overlay, type, text) {
    var status = overlay.querySelector(".js-exit-popup-status");
    if (!status) return;
    status.textContent = text;
    status.className = "form-status js-exit-popup-status is-visible " + type;
  }

  function showSuccess(overlay) {
    overlay.querySelector(".js-exit-popup-form-state").hidden = true;
    overlay.querySelector(".js-exit-popup-success-state").hidden = false;
  }

  function bindPopupEvents(overlay) {
    overlay.querySelector(".js-exit-popup-close").addEventListener("click", function () { closePopup(); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closePopup(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.classList.contains("is-open")) closePopup();
    });

    overlay.querySelector(".js-exit-popup-cta-success").addEventListener("click", function () {
      track("exit_popup_cta_clicked");
      closePopup(true);
      var target = document.querySelector(exitPopupConfig.successCtaTarget);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    var form = overlay.querySelector(".js-exit-popup-form");
    var phoneInput = form.querySelector('[name="phone"]');
    var tgInput = form.querySelector('[name="telegram"]');
    var openedAt = Date.now();
    var startedTracked = false;

    form.addEventListener("focusin", function () {
      if (startedTracked) return;
      startedTracked = true;
      track("exit_popup_form_started");
    });

    phoneInput.addEventListener("focus", function () {
      if (!phoneInput.value) phoneInput.value = "+7 (";
    });
    phoneInput.addEventListener("input", function () {
      phoneInput.value = formatRuPhone(phoneInput.value);
    });

    tgInput.addEventListener("blur", function () {
      var v = tgInput.value.trim();
      if (v && v.charAt(0) !== "@") tgInput.value = "@" + v;
    });

    function validateForm() {
      var hp = form.querySelector('[name="website"]');
      if (hp && hp.value) return "spam";
      if (Date.now() - openedAt < 2500) return "spam"; // анти-спам по времени, как и в остальных формах сайта

      if (!form.querySelector('[name="name"]').value.trim()) return "Укажите, пожалуйста, имя.";

      var phoneDigits = phoneInput.value.replace(/\D/g, "");
      if (phoneDigits.length < 11) return "Проверьте номер телефона.";

      var tg = tgInput.value.trim();
      if (!/^@[A-Za-z0-9_]{4,32}$/.test(tg)) return "Проверьте Telegram-username (например, @username).";

      return null;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var error = validateForm();

      if (error === "spam") {
        showSuccess(overlay); // тихо "успех" для ботов — не подсказываем, что сработала защита
        return;
      }
      if (error) {
        setStatus(overlay, "err", error);
        return;
      }

      var payload = {
        type: "exit_popup",
        name: form.querySelector('[name="name"]').value.trim(),
        phone: phoneInput.value.trim(),
        telegram: tgInput.value.trim(),
        website: form.querySelector('[name="website"]').value,
        source: "exit_popup",
        offer: exitPopupConfig.discount,
        promo: exitPopupConfig.promoCode,
        landing_page: utmData.landing_page || location.href,
        utm_source: utmData.utm_source || "",
        utm_medium: utmData.utm_medium || "",
        utm_campaign: utmData.utm_campaign || "",
        utm_content: utmData.utm_content || "",
        utm_term: utmData.utm_term || ""
      };

      var submitBtn = form.querySelector(".exit-popup-cta");
      if (submitBtn) submitBtn.disabled = true;

      fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          if (!res.ok) throw new Error("request_failed");
          return res.json();
        })
        .then(function (result) {
          if (!result.ok) throw new Error(result.error || "unknown");
          track("exit_popup_form_submitted");
          track("discount_3000_issued");
          safeSet(STORAGE_CONVERTED, "1");
          // Промокод "ждёт" следующую заявку на сайте (основную форму вступления/записи) —
          // см. main.js: если она уйдёт с этим флагом, засчитываем discount_3000_used.
          if (exitPopupConfig.promoCode) safeSet(STORAGE_PROMO_PENDING, exitPopupConfig.promoCode);
          showSuccess(overlay);
        })
        .catch(function () {
          setStatus(overlay, "err", "Не получилось отправить автоматически. Напишите нам в Telegram: " + exitPopupConfig.managerTelegram);
        })
        .finally(function () {
          if (submitBtn) submitBtn.disabled = false;
        });
    });
  }

  // ---- Показ / закрытие -----------------------------------------------------------
  function showPopup() {
    // Страница сейчас не видна (фон. вкладка, переход в другое приложение) — рисовать
    // pop-up сейчас бессмысленно и нечестно по отношению к куки показа: откладываем
    // попытку до следующего подходящего момента (например, возврата на вкладку).
    if (document.visibilityState !== "visible") {
      triggered = false;
      return;
    }

    if (!popupEl) popupEl = buildPopup();

    popupEl.classList.add("is-open");
    document.body.style.overflow = "hidden";
    safeSet(STORAGE_SHOWN, String(Date.now()));
    track("exit_popup_triggered");

    var firstInput = popupEl.querySelector("input:not([type=hidden])");
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 150);
  }

  function closePopup(fromSuccess) {
    if (!popupEl) return;
    popupEl.classList.remove("is-open");
    document.body.style.overflow = "";
    if (!fromSuccess) track("exit_popup_closed");
  }

  // ---- Сигналы ухода -----------------------------------------------------------------
  function isMobileViewport() {
    return window.matchMedia("(max-width: 767px), (pointer: coarse)").matches;
  }

  function setupDesktopExitIntent() {
    document.addEventListener("mouseout", function (e) {
      if (isMobileViewport()) return;
      if (e.clientY > 0) return; // курсор ушёл не через верх окна
      if (e.relatedTarget) return; // ушёл на другой элемент страницы, а не за пределы окна
      maybeTrigger();
    });
  }

  // На мобильных нет курсора — используем комбинацию сигналов ухода/возврата плюс
  // таймер-fallback. Важно: браузеры НЕ гарантируют возможность показать полноценный
  // UI в момент реального закрытия вкладки — это лучшее из доступного.
  function setupMobileSignals() {
    var hiddenAt = null;

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else if (document.visibilityState === "visible" && hiddenAt) {
        hiddenAt = null;
        maybeTrigger(); // вернулся с другой вкладки/приложения — похоже, раздумывал уходить
      }
    });

    window.addEventListener("pagehide", function () {
      maybeTrigger(); // best-effort: сработает, только если браузер успеет отрисовать до выгрузки
    });

    if (isMobileViewport()) {
      setTimeout(function () { maybeTrigger(); }, exitPopupConfig.mobileFallbackSeconds * 1000);
    }
  }

  function init() {
    setupDesktopExitIntent();
    setupMobileSignals();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
