// ============================================================================
// Код Роста — логика одностраничника
// Заявки/записи отправляются на /api/submit (Cloudflare Pages Function),
// которая пересылает их в Telegram-группу через бота. См. functions/api/submit.js.
// ============================================================================

(function () {
  "use strict";

  // ---- Настройки ------------------------------------------------------------
  var MANAGER_TELEGRAM = "https://t.me/Kodrosta";

  // ---- Мероприятия. На старте ведутся вручную — обновляйте этот массив. ---
  // TODO: подключить синхронизацию с ботом/таблицей events, когда он будет готов.
  var EVENTS = [
    {
      id: "business-banya-august",
      title: "Мужская Бизнес-баня",
      tag: "Нетворкинг",
      start: "2026-08-06T18:00:00",
      end: "2026-08-06T22:00:00",
      place: "Баня на дровах, адрес уточняется при записи",
      description: "Баня на дровах с индивидуальным парением и разговор за столом про семейные форматы мероприятий для сообщества Код Роста."
    },
    {
      id: "business-review-shargorodsky",
      title: "Бизнес-разборы с Максимом Шаргородским",
      tag: "Экспертиза резидентов",
      start: "2026-08-11T14:00:00",
      end: "2026-08-11T18:00:00",
      place: "Место уточняется при записи",
      description: "Не лекция и не тренинг — метод построен на 1500 часах разборов с предпринимателями из 18 городов России, Беларуси и Казахстана. Участие бесплатное. Для участия — вступите в чат мероприятия."
    },
    {
      id: "fire-safety-training",
      title: "Обучение по пожарной безопасности для руководителей и ответственных лиц",
      tag: "Обучение",
      start: "2026-08-19T16:00:00",
      end: "2026-08-19T18:00:00",
      place: "Место уточняется при записи",
      description: "С 1 сентября 2025 года действует приказ МЧС № 1120 вместо прежнего 806-го. Штраф за необученного ответственного — от 20 000 ₽ на должностное лицо и от 300 000 ₽ на юрлицо, одна проверка может дать оба сразу. Проводит учебный центр «Эко Старт» Альбины Хамитовой, резидента клуба. По итогам — удостоверение на 5 лет. Мест ограниченное количество."
    },
    {
      id: "family-day",
      title: "Семейный день Клуба",
      tag: "Семейный формат",
      start: "2026-08-29T10:00:00",
      end: "2026-08-29T15:00:00",
      place: "У воды, адрес уточняется при записи",
      description: "Новый формат, придуманный самими резидентами: выезд на полдня к воде без ночёвки. Для взрослых — мангальная зона, пляжный волейбол, бизнес-игра и мастер-классы. Для детей — няня и мастер-классы. В заявке укажите, сколько взрослых и детей и какого возраста дети."
    }
  ];

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
    var now = new Date();
    var upcoming = EVENTS
      .filter(function (e) { return new Date(e.start) >= now; })
      .sort(function (a, b) { return new Date(a.start) - new Date(b.start); });

    if (!upcoming.length) {
      list.innerHTML = '<p style="color:var(--gray-500)">Новые мероприятия скоро появятся — следите за <a href="' + 'https://t.me/codrosta' + '" target="_blank" rel="noopener" style="color:var(--blue)">Telegram-каналом</a>.</p>';
      return;
    }

    list.innerHTML = upcoming.map(function (e) {
      var d = fmtDate(e.start);
      return (
        '<article class="event-card">' +
          '<div class="event-date"><span class="d">' + d.day + '</span><span class="m">' + d.month + '</span></div>' +
          '<div class="event-info">' +
            '<span class="tag">' + e.tag + '</span>' +
            '<h3>' + e.title + '</h3>' +
            '<div class="meta">' + fmtFull(e.start) + ' · ' + e.place + '</div>' +
            '<p>' + e.description + '</p>' +
          '</div>' +
          '<div class="event-actions">' +
            '<button class="btn btn--primary btn--sm js-open-event" type="button" data-event-id="' + e.id + '">Записаться</button>' +
            '<a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="' + googleCalUrl(e) + '">В Google Calendar</a>' +
          '</div>' +
        '</article>'
      );
    }).join("");

    // Кнопки записи на конкретное событие
    list.querySelectorAll(".js-open-event").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var ev = EVENTS.find(function (e) { return e.id === btn.getAttribute("data-event-id"); });
        openEventModal(ev);
      });
    });
  }

  // ---- ICS / Google Calendar ------------------------------------------------
  function toICSDate(iso) {
    return iso.replace(/[-:]/g, "").split(".")[0];
  }

  function buildICS() {
    var lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Код Роста//Calendar//RU",
      "CALSCALE:GREGORIAN",
      "X-WR-CALNAME:Код Роста — мероприятия"
    ];
    EVENTS.forEach(function (e) {
      lines.push(
        "BEGIN:VEVENT",
        "UID:" + e.id + "@kodrosta.ru",
        "DTSTART:" + toICSDate(e.start),
        "DTEND:" + toICSDate(e.end),
        "SUMMARY:" + e.title,
        "LOCATION:" + e.place,
        "DESCRIPTION:" + e.description.replace(/,/g, "\\,"),
        "END:VEVENT"
      );
    });
    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  }

  function downloadICS() {
    var blob = new Blob([buildICS()], { type: "text/calendar;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "kodrosta-events.ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function googleCalUrl(e) {
    var params = new URLSearchParams({
      action: "TEMPLATE",
      text: e.title,
      dates: toICSDate(e.start) + "/" + toICSDate(e.end),
      details: e.description,
      location: e.place
    });
    return "https://calendar.google.com/calendar/render?" + params.toString();
  }

  function setupCalendarSub() {
    var btn = document.querySelector(".js-download-ics");
    if (btn) btn.addEventListener("click", downloadICS);

    var link = document.getElementById("js-google-cal-link");
    if (link && EVENTS.length) {
      var next = EVENTS.slice().sort(function (a, b) { return new Date(a.start) - new Date(b.start); })[0];
      link.href = googleCalUrl(next);
    }
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

  // ---- Init ---------------------------------------------------------------------
  renderEvents();
  setupCalendarSub();
  animateCounters();
})();
