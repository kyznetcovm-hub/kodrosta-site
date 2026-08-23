// ============================================================================
// Код Роста — логика одностраничника
// Заявки/записи отправляются на /api/submit (обрабатывается Worker'ом),
// который пересылает их в Telegram-группу через бота. См. src/index.js.
// Мероприятия — из /api/events (Worker читает их из D1, публикуются через
// Telegram-бота — см. src/events-store.js и src/engagement.js).
// ============================================================================

(function () {
  "use strict";

  var EVENTS = [];

  // ---- Настройки ------------------------------------------------------------
  var MANAGER_TELEGRAM = "https://t.me/Kodrosta";

  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  var MONTHS_FULL = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

  function fmtDate(iso) {
    var d = new Date(iso);
    return { day: d.getDate(), month: MONTHS_SHORT[d.getMonth()] };
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    var h = String(d.getHours()).padStart(2, "0");
    var m = String(d.getMinutes()).padStart(2, "0");
    return h + ":" + m;
  }

  function fmtFull(iso) {
    var d = new Date(iso);
    return d.getDate() + " " + MONTHS_FULL[d.getMonth()] + ", " + fmtTime(iso);
  }

  // ---- Рендер списка мероприятий ------------------------------------------
  function renderEvents() {
    var list = document.querySelector(".js-events-list");
    if (!list) return;

    fetch("/api/events")
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (data) {
        EVENTS = Array.isArray(data) ? data : [];
        renderEventsList(list, EVENTS);
      })
      .catch(function () {
        renderEventsList(list, []);
      });
  }

  function renderEventsList(list, upcoming) {
    if (!upcoming.length) {
      list.innerHTML = '<p style="color:var(--gray-500)">Новые мероприятия скоро появятся — следите за <a href="' + 'https://t.me/codrosta' + '" target="_blank" rel="noopener" style="color:var(--blue)">Telegram-каналом</a>.</p>';
      return;
    }

    list.innerHTML = upcoming.map(function (e) {
      var d = fmtDate(e.start);
      var hasFull = Array.isArray(e.fullDescription) && e.fullDescription.length > 0;
      return (
        '<article class="event-card">' +
          '<div class="event-date"><span class="d">' + d.day + '</span><span class="m">' + d.month + '</span></div>' +
          '<div class="event-info">' +
            '<span class="tag">' + e.tag + '</span>' +
            '<h3>' + e.title + '</h3>' +
            '<div class="meta">' + fmtFull(e.start) + ' · ' + e.place + '</div>' +
            '<p class="event-desc-short">' + e.description + '</p>' +
            (hasFull
              ? '<div class="event-desc-full" hidden>' + e.fullDescription.map(function (p) { return '<p>' + p + '</p>'; }).join("") + '</div>' +
                '<button class="event-desc-toggle js-desc-toggle" type="button">Читать полностью</button>'
              : '') +
          '</div>' +
          '<div class="event-actions">' +
            (e.registerUrl
              ? '<a class="btn btn--primary btn--sm" target="_blank" rel="noopener" href="' + e.registerUrl + '">Записаться</a>'
              : '<button class="btn btn--primary btn--sm js-open-event" type="button" data-event-id="' + e.id + '">Записаться</button>') +
          '</div>' +
        '</article>'
      );
    }).join("");

    injectEventsSchema(upcoming);

    // Разворачивание полного описания мероприятия
    list.querySelectorAll(".js-desc-toggle").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var info = btn.closest(".event-info");
        var short = info.querySelector(".event-desc-short");
        var full = info.querySelector(".event-desc-full");
        var expanding = full.hidden;
        full.hidden = !expanding;
        short.hidden = expanding;
        btn.textContent = expanding ? "Свернуть" : "Читать полностью";
      });
    });

    // Кнопки записи на конкретное событие
    list.querySelectorAll(".js-open-event").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var ev = EVENTS.find(function (e) { return e.id === btn.getAttribute("data-event-id"); });
        openEventModal(ev);
      });
    });
  }

  // JSON-LD для ближайших мероприятий — собирается из EVENTS, чтобы не расходиться со списком
  function injectEventsSchema(upcoming) {
    var schema = upcoming.map(function (e) {
      return {
        "@context": "https://schema.org",
        "@type": "Event",
        "name": e.title,
        "startDate": e.start,
        "endDate": e.end,
        "eventStatus": "https://schema.org/EventScheduled",
        "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
        "location": { "@type": "Place", "name": e.place },
        "description": e.description,
        "organizer": { "@type": "Organization", "name": "Код Роста", "url": "https://codrosta.club/" }
      };
    });
    var existing = document.getElementById("events-schema");
    if (existing) existing.remove();
    var script = document.createElement("script");
    script.type = "application/ld+json";
    script.id = "events-schema";
    script.textContent = JSON.stringify(schema);
    document.head.appendChild(script);
  }

  // Подписка на весь календарь клуба — единый живой фид /calendar.ics
  // (отдаёт Worker, см. src/index.js), а не разовый снимок событий.
  function setupCalendarSub() {
    var feedUrl = location.origin + "/calendar.ics";

    var iosLink = document.getElementById("js-ios-cal-link");
    if (iosLink) iosLink.href = feedUrl.replace(/^https?:/, "webcal:");

    var androidLink = document.getElementById("js-android-cal-link");
    if (androidLink) androidLink.href = "https://calendar.google.com/calendar/render?cid=" + encodeURIComponent(feedUrl);
  }

  // ---- Модалки ---------------------------------------------------------------
  var overlays = {};
  document.querySelectorAll(".js-modal-overlay").forEach(function (el) { overlays[el.id] = el; });

  function openModal(id) {
    var el = overlays[id];
    if (!el) return;
    el.classList.add("is-open");
    document.body.style.overflow = "hidden";
    // фиксируем время открытия — анти-спам таймер
    var form = el.querySelector("form");
    if (form) form.dataset.openedAt = String(Date.now());
    var firstInput = el.querySelector("input:not([type=hidden])");
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 100);
  }

  function closeModal(el) {
    el.classList.remove("is-open");
    document.body.style.overflow = "";
  }

  document.querySelectorAll(".js-open-apply").forEach(function (btn) {
    btn.addEventListener("click", function () { openModal("modal-apply"); });
  });

  function openEventModal(event) {
    var overlay = overlays["modal-event"];
    if (!overlay || !event) return;
    overlay.querySelector(".js-modal-event-sub").textContent = event.title + " · " + fmtFull(event.start);
    overlay.querySelector(".js-event-title").value = event.title;
    openModal("modal-event");
  }

  document.querySelectorAll(".js-modal-close").forEach(function (btn) {
    btn.addEventListener("click", function () { closeModal(btn.closest(".modal-overlay")); });
  });
  document.querySelectorAll(".js-modal-overlay").forEach(function (overlay) {
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeModal(overlay);
    });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      document.querySelectorAll(".js-modal-overlay.is-open").forEach(closeModal);
    }
  });

  // ---- Бургер-меню (мобильная навигация) -------------------------------------
  var burger = document.querySelector(".js-burger");
  if (burger) {
    burger.addEventListener("click", function () {
      var nav = document.querySelector(".nav-links");
      if (!nav) return;
      var isOpen = nav.style.display === "flex";
      nav.style.cssText = isOpen
        ? ""
        : "display:flex; position:fixed; top:76px; left:0; right:0; background:#fff; flex-direction:column; padding:20px 24px; gap:18px; box-shadow:0 12px 24px -12px rgba(0,0,0,.15); border-bottom:1px solid var(--gray-100);";
    });
  }

  // ---- Формы: валидация, анти-спам, отправка в Telegram через /api/submit ----
  var PHONE_RE = /^[\d\s()+-]{7,20}$/;
  var MIN_FILL_MS = 2500; // анти-спам: минимальное время заполнения формы

  function showStatus(form, type, text) {
    var status = form.parentElement.querySelector(".js-form-status");
    if (!status) return;
    status.textContent = text;
    status.className = "form-status js-form-status is-visible " + type;
  }

  function validate(form) {
    var name = form.querySelector('[name="name"]');
    var phone = form.querySelector('[name="phone"]');

    if (!name.value.trim()) return "Укажите, пожалуйста, имя.";
    if (!PHONE_RE.test(phone.value.trim())) return "Проверьте номер телефона.";

    var telegram = form.querySelector('[name="telegram"]');
    if (!telegram.value.trim()) return "Укажите ваш Telegram.";

    var companyField = form.querySelector('[name="company"]');
    if (companyField && !companyField.value.trim()) return "Укажите компанию или сферу деятельности.";

    // honeypot
    var hp = form.querySelector('[name="website"]');
    if (hp && hp.value) return "spam";

    // анти-спам по времени заполнения
    var openedAt = Number(form.dataset.openedAt || 0);
    if (openedAt && Date.now() - openedAt < MIN_FILL_MS) return "spam";

    return null;
  }

  document.querySelectorAll(".js-form").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var error = validate(form);

      if (error === "spam") {
        // Тихо "успешно" для ботов — не подсказываем, что сработала защита.
        showStatus(form, "ok", "Спасибо! Заявка отправлена.");
        form.reset();
        return;
      }
      if (error) {
        showStatus(form, "err", error);
        return;
      }

      var type = form.getAttribute("data-form-type");
      var data = {
        type: type,
        name: form.querySelector('[name="name"]').value.trim(),
        phone: form.querySelector('[name="phone"]').value.trim(),
        telegram: form.querySelector('[name="telegram"]').value.trim(),
        comment: form.querySelector('[name="comment"]') ? form.querySelector('[name="comment"]').value.trim() : "",
        company: form.querySelector('[name="company"]') ? form.querySelector('[name="company"]').value.trim() : "",
        event: form.querySelector('[name="event"]') ? form.querySelector('[name="event"]').value : "",
        website: form.querySelector('[name="website"]') ? form.querySelector('[name="website"]').value : ""
      };

      var submitBtn = form.querySelector('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data)
      })
        .then(function (res) {
          if (!res.ok) throw new Error("request_failed");
          return res.json();
        })
        .then(function (result) {
          if (!result.ok) throw new Error(result.error || "unknown");
          showStatus(form, "ok", "Спасибо! Заявка отправлена, менеджер скоро свяжется с вами.");
          form.reset();
          if (typeof ym === "function") ym(111842641, "reachGoal", "form_submit", { type: type });
        })
        .catch(function () {
          showStatus(
            form,
            "err",
            "Не получилось отправить автоматически. Напишите нам в Telegram: " + MANAGER_TELEGRAM.replace("https://", "")
          );
        })
        .finally(function () {
          if (submitBtn) submitBtn.disabled = false;
        });
    });
  });

  // ---- Анимация счётчиков в блоке «Цифры клуба» -------------------------------
  function animateCounters() {
    var counters = document.querySelectorAll("[data-count]");
    if (!counters.length) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        var target = parseInt(el.getAttribute("data-count"), 10);
        var duration = 1200;
        var start = performance.now();

        function tick(now) {
          var progress = Math.min((now - start) / duration, 1);
          var eased = 1 - Math.pow(1 - progress, 3);
          el.textContent = Math.round(eased * target);
          if (progress < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
        observer.unobserve(el);
      });
    }, { threshold: 0.4 });

    counters.forEach(function (el) { observer.observe(el); });
  }

  // ---- Footer year ------------------------------------------------------------
  var yearEl = document.getElementById("js-year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // ---- Cookie consent -----------------------------------------------------------
  function setupCookieBanner() {
    var banner = document.getElementById("cookie-banner");
    if (!banner) return;
    if (localStorage.getItem("cookieConsent") === "1") return;
    banner.classList.add("is-visible");
    var acceptBtn = banner.querySelector(".js-cookie-accept");
    acceptBtn.addEventListener("click", function () {
      localStorage.setItem("cookieConsent", "1");
      banner.classList.remove("is-visible");
    });
  }

  // ---- Анимация появления шагов «Как вступить» -------------------------------------
  function setupStepsFlowReveal() {
    var flow = document.querySelector(".js-steps-flow");
    if (!flow) return;
    var observer = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        flow.classList.add("is-visible");
        obs.unobserve(flow);
      });
    }, { threshold: 0.35 });
    observer.observe(flow);
  }

  // ---- FAQ аккордеон -------------------------------------------------------------
  function setupFaq() {
    document.querySelectorAll(".js-faq-toggle").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var item = btn.closest(".faq-item");
        var answer = item.querySelector(".faq-answer");
        var expanding = answer.hidden;
        answer.hidden = !expanding;
        btn.setAttribute("aria-expanded", String(expanding));
      });
    });
  }

  // ---- Init ---------------------------------------------------------------------
  renderEvents();
  setupCalendarSub();
  animateCounters();
  setupCookieBanner();
  setupFaq();
  setupStepsFlowReveal();
})();
