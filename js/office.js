// ============================================================================
// «Офис в кармане» — Telegram Mini App клуба (office.html, css/office.css).
// Экраны «Обзор», «События», карточка события и «Деньги» перенесены из
// утверждённого макета (Obsidian: 02 Клуб/Дашборд клуба/). ТЗ — там же.
//
// Этап 1: только демо-данные из макета (demoData ниже), сервер не вызывается.
// Дальше loadData() будет брать данные с сервера в том же формате:
//   { demo, now, user: { firstName }, month: "YYYY-MM",
//     money: { factRub, planRub, sources: [{ key, label, factRub, planRub }],
//              weeks: [{ factRub, planRub, bySource: [..] }], note },
//     events: [{ id, title, format, start, end, registered, plan }],
//     registrationsNote }
// Недели месяца считаются здесь (monthWeeks): пн–вс, обрезанные границами
// месяца; все даты — по Москве.
// ============================================================================

(function () {
  "use strict";

  var TZ = "Europe/Moscow";
  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  var MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  var MONTHS_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

  var root = document.getElementById("kr-office");
  var content = document.getElementById("kr-content");

  var data = null;
  var state = { page: "home", selected: null, week: null, budget: false, loading: true, error: null };

  // ---- Демо-данные: числа и события ровно как в утверждённом макете ---------
  // «Сегодня» зафиксировано на 7 октября 2026, чтобы экран можно было сверить
  // со снимками макета один в один. В рабочую базу эти числа не попадают.
  function demoData() {
    return {
      demo: true,
      now: "2026-10-07T12:00:00+03:00",
      user: { firstName: "Михаил" },
      month: "2026-10",
      money: {
        factRub: 120000,
        planRub: 450000,
        sources: [
          { key: "new", label: "Новые абонементы", factRub: 75000, planRub: 200000 },
          { key: "renewal", label: "Продления", factRub: 30000, planRub: 150000 },
          { key: "events", label: "Платные мероприятия", factRub: 15000, planRub: 100000 }
        ],
        weeks: [
          { factRub: 85000, planRub: 90000, bySource: [50000, 25000, 10000] },
          { factRub: 35000, planRub: 110000, bySource: [25000, 5000, 5000] },
          { factRub: null, planRub: 100000 },
          { factRub: null, planRub: 90000 },
          { factRub: null, planRub: 60000 }
        ],
        note: "В этом макете факт — полученные оплаты. Расходы и прибыль пока не включены."
      },
      events: [
        { id: "profiling", title: "Профайлинг", format: "Практикум", start: "2026-10-07T19:00:00+03:00", end: "2026-10-07T21:00:00+03:00", registered: 10, plan: 15 },
        { id: "biznes-banya", title: "Бизнес-баня", format: "Встреча", start: "2026-10-08T18:00:00+03:00", end: "2026-10-08T22:00:00+03:00", registered: 8, plan: 12 },
        { id: "vyhod-iz-krizisa", title: "Выход из кризиса: 4 шага", format: "Мастер-класс", start: "2026-10-14T19:00:00+03:00", end: "2026-10-14T21:00:00+03:00", registered: 12, plan: 20 },
        { id: "rubezh", title: "РУБЕЖ", format: "Событие клуба", start: "2026-10-24T11:00:00+03:00", end: "2026-10-24T20:00:00+03:00", registered: 15, plan: 15 },
        { id: "kod-dostupa", title: "Код Доступа", format: "День открытых дверей", start: "2026-10-28T18:00:00+03:00", end: "2026-10-28T21:00:00+03:00", registered: 18, plan: 40 },
        { id: "kalorimetr-3", title: "Калориметр 3.0", format: "Марафон", start: "2026-10-01T10:00:00+03:00", end: "2026-10-01T12:00:00+03:00", registered: 24, plan: 30 }
      ],
      registrationsNote: null
    };
  }

  function loadData() {
    return Promise.resolve(demoData());
  }

  // ---- Даты по Москве -------------------------------------------------------
  var mskFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

  // "YYYY-MM-DD" календарного дня по Москве
  function mskDay(iso) {
    return mskFmt.format(new Date(iso));
  }

  function dayParts(ymd) {
    var p = ymd.split("-");
    return { y: Number(p[0]), m: Number(p[1]), d: Number(p[2]) };
  }

  function addDays(ymd, n) {
    var p = dayParts(ymd);
    var dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return dt.toISOString().slice(0, 10);
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  // Недели месяца: пн–вс, обрезанные границами месяца. month — "YYYY-MM".
  function monthWeeks(month) {
    var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
    var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var weeks = [];
    var from = 1;
    for (var d = 1; d <= last; d++) {
      var dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 — воскресенье
      if (dow === 0 || d === last) {
        weeks.push({ from: month + "-" + pad(from), to: month + "-" + pad(d), fromDay: from, toDay: d });
        from = d + 1;
      }
    }
    return weeks;
  }

  // ---- Форматирование -------------------------------------------------------
  function fmt(n) {
    return new Intl.NumberFormat("ru-RU").format(n);
  }

  // тысячи рублей: 85000 → «85», 12500 → «12,5»
  function fmtK(rub) {
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(rub / 1000);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var ICONS = {
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-left": '<path d="m15 18-6-6 6-6"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    "arrow-up-right": '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    "minus": '<path d="M5 12h14"/>',
    "plus": '<path d="M5 12h14"/><path d="M12 5v14"/>'
  };

  function icon(name) {
    return '<svg class="kr-icon" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + "</svg>";
  }

  function bar(value, plan, label) {
    var width = plan > 0 ? Math.min(100, value / plan * 100) : 0;
    return '<div class="kr-bar" role="progressbar" aria-label="' + esc(label) + '" aria-valuemin="0" aria-valuemax="' + Math.max(plan, value) +
      '" aria-valuenow="' + value + '" aria-valuetext="' + value + " из " + plan + '"><span style="width:' + width + '%"></span></div>';
  }

  // ---- Расчёты по ТЗ (раздел 5) ---------------------------------------------
  function today() { return mskDay(data.now); }

  function isPast(e) {
    return new Date(e.end || e.start).getTime() <= new Date(data.now).getTime();
  }

  function hasPlan(e) { return Number.isInteger(e.plan) && e.plan > 0; }

  function percent(value, plan) { return Math.round(value / plan * 100); }

  function remainder(e) {
    if (!hasPlan(e)) return "План не задан";
    var r = e.registered, p = e.plan;
    if (r === p) return "План выполнен";
    if (r > p) return "Сверх плана: " + (r - p);
    return isPast(e) ? "Итог: на " + (p - r) + " меньше плана" : "Ещё " + (p - r) + " до плана";
  }

  // «сегодня» / «завтра» — по календарному дню Москвы
  function dayLabel(e) {
    var d = mskDay(e.start);
    if (d === today()) return "сегодня";
    if (d === addDays(today(), 1)) return "завтра";
    return "";
  }

  function eventType(e) {
    var label = isPast(e) ? "" : dayLabel(e);
    return esc(e.format || "Событие") + (label ? " · " + label : "");
  }

  // красным — недобор у события, которое уже сегодня или завтра
  function isUrgent(e) {
    return !isPast(e) && hasPlan(e) && e.registered < e.plan && dayLabel(e) !== "";
  }

  function upcomingEvents() {
    return data.events.filter(function (e) { return !isPast(e); })
      .sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
  }

  function pastEvents() {
    return data.events.filter(isPast)
      .sort(function (a, b) { return new Date(b.start) - new Date(a.start); });
  }

  function findEvent(id) {
    for (var i = 0; i < data.events.length; i++) if (data.events[i].id === id) return data.events[i];
    return null;
  }

  function weekStatus(w) {
    var t = today();
    if (w.to < t) return "past";
    if (w.from <= t) return "current";
    return "future";
  }

  function weekLabel(w, full) {
    var m = Number(w.from.slice(5, 7)) - 1;
    var range = w.fromDay === w.toDay ? String(w.fromDay) : w.fromDay + "–" + w.toDay;
    return range + " " + (full ? MONTHS_GEN[m] : MONTHS_SHORT[m]);
  }

  function weeksWithMoney() {
    var grid = monthWeeks(data.month);
    return grid.map(function (w, i) {
      var v = data.money.weeks[i] || {};
      return {
        from: w.from, to: w.to, fromDay: w.fromDay, toDay: w.toDay,
        status: weekStatus(w),
        factRub: v.factRub == null ? null : v.factRub,
        planRub: v.planRub == null ? null : v.planRub,
        bySource: v.bySource || null
      };
    });
  }

  function monthName() {
    return MONTHS_NOM[Number(data.month.slice(5, 7)) - 1];
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ---- Экраны ---------------------------------------------------------------
  function moneyHero(home) {
    var m = data.money;
    var planSet = m.planRub > 0;
    var html = '<section class="kr-panel" aria-label="Продажи клуба за ' + monthName() + '">' +
      '<div class="kr-between"><h2>Деньги клуба</h2><span class="kr-month">' + capitalize(monthName()) + "</span></div>" +
      '<div class="kr-moneyline"><div><span class="kr-label">Факт продаж</span><div class="kr-fact">' + fmt(m.factRub) + ' <span class="kr-currency">₽</span></div></div>' +
      '<div><span class="kr-label">План месяца</span>' +
      (planSet ? '<div class="kr-plan">' + fmt(m.planRub) + ' <span class="kr-currency">₽</span></div>' : '<div class="kr-plan kr-empty">План не задан</div>') +
      "</div></div>";
    if (planSet) {
      var rest = m.planRub - m.factRub;
      html += bar(m.factRub, m.planRub, "Факт продаж к плану месяца") +
        '<div class="kr-bartext"><b>' + percent(m.factRub, m.planRub) + "% плана</b><span>" +
        (rest > 0 ? "Осталось " + fmt(rest) + " ₽" : rest === 0 ? "План выполнен" : "Сверх плана: " + fmt(-rest) + " ₽") +
        "</span></div>";
    }
    if (home) {
      var cur = weeksWithMoney().filter(function (w) { return w.status === "current"; })[0];
      if (cur) {
        html += '<div class="kr-week-preview"><div class="kr-between"><span>Эта неделя · ' + weekLabel(cur, true) + "</span><strong>" +
          (cur.factRub == null ? "—" : fmtK(cur.factRub)) + " / " + (cur.planRub == null ? "—" : fmtK(cur.planRub)) + " тыс. ₽</strong></div></div>";
      }
      html += '<div class="kr-between kr-moneylinks"><button class="kr-link" data-action="weeks">По неделям ' + icon("arrow-up-right") +
        '</button><button class="kr-link" data-action="budget">Развернуть бюджет ' + icon("chevron-right") + "</button></div>";
    }
    return html + "</section>";
  }

  function eventRow(e) {
    var d = dayParts(mskDay(e.start));
    var planSet = hasPlan(e);
    var counts = planSet
      ? "<strong>" + e.registered + "</strong> / " + e.plan + " мест"
      : "<strong>" + e.registered + "</strong> зарегистрировано";
    return '<button class="kr-event" data-event="' + esc(e.id) + '" aria-label="' + esc(e.title) + ", " + d.d + " " + MONTHS_GEN[d.m - 1] + ", " +
      e.registered + (planSet ? " из " + e.plan : "") + ' регистраций">' +
      '<div class="kr-event-top"><div class="kr-event-date">' + pad(d.d) + "<small>" + MONTHS_SHORT[d.m - 1].toUpperCase() + "</small></div>" +
      '<div><p class="kr-event-name">' + esc(e.title) + '</p><p class="kr-event-type">' + eventType(e) + "</p></div>" +
      '<span class="kr-event-arrow">' + icon("chevron-right") + "</span></div>" +
      '<div class="kr-event-progress"><div class="kr-between"><span>' + counts + '</span><em class="' + (isUrgent(e) ? "kr-alert" : "") + '">' + remainder(e) + "</em></div>" +
      (planSet ? bar(e.registered, e.plan, "Регистрации к плану") : "") + "</div></button>";
  }

  function eventList(list, emptyText) {
    if (!list.length) return '<div class="kr-empty-note">' + emptyText + "</div>";
    return '<section class="kr-event-list" aria-label="Заполняемость событий">' + list.map(eventRow).join("") + "</section>";
  }

  function renderHome() {
    return moneyHero(true) +
      '<div class="kr-section-head"><h2>Ближайшие события</h2><button class="kr-link" data-page="events">Все события ' + icon("arrow-up-right") + "</button></div>" +
      eventList(upcomingEvents().slice(0, 3), "Ближайших событий нет");
  }

  function renderEvents() {
    var up = upcomingEvents(), past = pastEvents();
    var html = '<div class="kr-section-head"><h2>Предстоящие · ' + up.length + '</h2><span class="kr-month">' + capitalize(monthName()) + "</span></div>" +
      eventList(up, "Предстоящих событий нет");
    if (past.length) html += '<div class="kr-section-head"><h2>Прошедшие · ' + past.length + "</h2></div>" + eventList(past, "");
    html += '<p class="kr-caption">В числителе — регистрации, в знаменателе — план участников.' +
      (data.registrationsNote ? " " + esc(data.registrationsNote) : "") + "</p>";
    return html;
  }

  function renderWeeks() {
    var srcs = data.money.sources;
    return '<section class="kr-weeks"><div class="kr-between"><h2>По неделям</h2><span class="kr-month">Факт / план, тыс. ₽</span></div>' +
      weeksWithMoney().map(function (w, i) {
        var future = w.status === "future";
        var fact = future || w.factRub == null ? null : w.factRub;
        var html = '<button class="kr-week' + (w.status === "current" ? " kr-current" : "") + '" data-week="' + i + '" aria-expanded="' + (state.week === i) + '">' +
          '<span class="kr-week-date">' + weekLabel(w, false) + "<small>" + (w.status === "current" ? "Текущая" : future ? "Впереди" : "Завершена") + "</small></span>" +
          bar(fact || 0, w.planRub || 0, "Продажи за " + weekLabel(w, true)) +
          '<span class="kr-week-values">' + (fact == null ? "—" : fmtK(fact)) + "<small>" + (w.planRub == null ? "план не задан" : "план " + fmtK(w.planRub)) + "</small></span></button>";
        if (state.week === i) {
          var detail;
          if (future) {
            detail = (w.planRub == null ? "План не задан." : "План: " + fmt(w.planRub) + " ₽.") + " Неделя ещё не началась.";
          } else if (w.bySource) {
            detail = srcs.map(function (s, k) { return esc(s.label) + ": " + fmt(w.bySource[k] || 0) + " ₽"; }).join("<br>");
          } else {
            detail = "Продаж за неделю: " + fmt(fact || 0) + " ₽";
          }
          html += '<div class="kr-weekdetail" role="status">' + detail + "</div>";
        }
        return html;
      }).join("") + "</section>";
  }

  function renderBudget() {
    var m = data.money;
    var rows = m.sources.map(function (s) {
      return "<tr><td>" + esc(s.label) + "</td><td>" + fmt(s.factRub) + "</td><td>" + (s.planRub == null ? "—" : fmt(s.planRub)) + "</td></tr>";
    }).join("");
    return '<details class="kr-budget"' + (state.budget ? " open" : "") + '><summary>Бюджет поступлений ' + icon("chevron-down") + "</summary>" +
      '<table aria-label="Факт и план поступлений за ' + monthName() + ' в рублях"><thead><tr><th>Источник</th><th>Факт, ₽</th><th>План, ₽</th></tr></thead><tbody>' +
      rows + "<tr><td>Всего</td><td>" + fmt(m.factRub) + "</td><td>" + (m.planRub == null ? "—" : fmt(m.planRub)) + "</td></tr></tbody></table>" +
      (m.note ? '<p class="kr-caption">' + esc(m.note) + "</p>" : "") + "</details>";
  }

  function renderMoney() {
    return moneyHero(false) + renderWeeks() + renderBudget();
  }

  function renderDetail() {
    var e = findEvent(state.selected);
    if (!e) return '<button class="kr-back" data-action="back">' + icon("chevron-left") + 'К событиям</button><div class="kr-empty-note">Событие не найдено</div>';
    var d = dayParts(mskDay(e.start));
    var planSet = hasPlan(e);
    var html = '<button class="kr-back" data-action="back">' + icon("chevron-left") + "К событиям</button>" +
      '<section class="kr-panel"><div class="kr-detail-date">' + d.d + " " + MONTHS_GEN[d.m - 1] + " " + d.y + "</div>" +
      '<h2 class="kr-detail-title">' + esc(e.title) + '</h2><p class="kr-event-type">' + eventType(e) + "</p>" +
      '<div class="kr-detail-stats"><div><strong>' + e.registered + "</strong><small>зарегистрировались</small></div>" +
      "<div>" + (planSet ? "<strong>" + e.plan + "</strong>" : '<strong class="kr-empty">План не задан</strong>') + "<small>план участников</small></div></div>";
    if (planSet) {
      html += bar(e.registered, e.plan, "Заполняемость события") +
        '<div class="kr-bartext"><b>' + percent(e.registered, e.plan) + "% плана</b><span>" + remainder(e) + "</span></div>";
      var slots = Math.max(e.plan, e.registered);
      if (slots <= 50) {
        var cells = "";
        for (var i = 0; i < slots; i++) cells += '<span class="kr-slot' + (i < e.registered ? " kr-filled" : "") + '"></span>';
        html += '<div class="kr-slot-grid" aria-label="Места: синие заняты, серые до плана">' + cells + "</div>";
      }
    }
    html += '<div class="kr-edit"><label for="kr-slot-input">План участников</label><div class="kr-stepper">' +
      '<button data-adjust="-1" aria-label="Уменьшить план">' + icon("minus") + "</button>" +
      '<input id="kr-slot-input" type="number" min="1" step="1" value="' + (planSet ? e.plan : "") + '" inputmode="numeric">' +
      '<button data-adjust="1" aria-label="Увеличить план">' + icon("plus") + '</button><span class="kr-stepper-note">человек</span></div>' +
      '<p class="kr-caption">Целевое число участников для этого события.</p>' +
      '<button class="kr-save" data-action="save-plan">Сохранить план</button><div id="kr-validation" role="status"></div></div></section>';
    if (data.demo) html += '<p class="kr-caption">Демо-режим: план меняется только на этом экране и не сохраняется.</p>';
    else if (data.registrationsNote) html += '<p class="kr-caption">' + esc(data.registrationsNote) + "</p>";
    return html;
  }

  var TITLES = { home: "Офис в кармане", events: "События клуба", money: "Деньги клуба" };

  function subtitle() {
    if (state.selected !== null) return "Регистрации и план по каждому событию.";
    if (state.page === "events") return "Регистрации и план по каждому событию.";
    if (state.page === "money") return "Продажи и поступления · " + monthName() + " " + data.month.slice(0, 4);
    return (data.user && data.user.firstName ? data.user.firstName + ", вот" : "Вот") + " что происходит в клубе.";
  }

  function render() {
    root.querySelectorAll(".kr-nav").forEach(function (b) {
      if (b.dataset.page === state.page) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (state.loading) {
      content.innerHTML = '<div class="kr-empty-note">Загружаем данные…</div>';
      return;
    }
    if (state.error) {
      content.innerHTML = '<div class="kr-empty-note">Не удалось загрузить данные.<br><button class="kr-link" data-action="retry">Попробовать ещё раз</button></div>';
      return;
    }
    var t = dayParts(today());
    document.getElementById("kr-date").innerHTML = t.d + " " + MONTHS_GEN[t.m - 1] + "<br>" + t.y;
    document.getElementById("kr-title").textContent = state.selected !== null ? "Событие" : TITLES[state.page];
    document.getElementById("kr-subtitle").textContent = subtitle();
    var demo = document.getElementById("kr-demo");
    demo.hidden = !data.demo;
    document.getElementById("kr-demo-text").textContent = "Демо-данные · суммы и регистрации условные";
    content.innerHTML = state.selected !== null ? renderDetail()
      : state.page === "home" ? renderHome()
      : state.page === "events" ? renderEvents()
      : renderMoney();
    var details = content.querySelector("details");
    if (details) details.addEventListener("toggle", function () { state.budget = details.open; });
  }

  function savePlan() {
    var e = findEvent(state.selected);
    var input = document.getElementById("kr-slot-input");
    var out = document.getElementById("kr-validation");
    var n = Number(input.value);
    if (!input.value || !Number.isInteger(n) || n < 1) {
      out.innerHTML = '<p class="kr-error" role="alert">Введите целое число больше нуля.</p>';
      return;
    }
    e.plan = n;
    render();
    document.getElementById("kr-validation").innerHTML = '<p class="kr-saved">План обновлён.</p>';
  }

  root.addEventListener("click", function (ev) {
    var b = ev.target.closest("button");
    if (!b || b.disabled) return;
    var scrollTop = true;
    if (b.dataset.page) {
      state.page = b.dataset.page;
      state.selected = null;
    } else if (b.dataset.event !== undefined) {
      state.selected = b.dataset.event;
      state.page = "events";
    } else if (b.dataset.week !== undefined) {
      var i = Number(b.dataset.week);
      state.week = state.week === i ? null : i;
      scrollTop = false;
    } else if (b.dataset.adjust) {
      var input = document.getElementById("kr-slot-input");
      var e = findEvent(state.selected);
      var base = Number(input.value) || (e && e.registered) || 1;
      input.value = Math.max(1, base + Number(b.dataset.adjust));
      return;
    } else if (b.dataset.action === "back") {
      state.selected = null;
      state.page = "events";
    } else if (b.dataset.action === "budget") {
      state.page = "money";
      state.budget = true;
    } else if (b.dataset.action === "weeks") {
      state.page = "money";
      var weeks = weeksWithMoney();
      for (var k = 0; k < weeks.length; k++) if (weeks[k].status === "current") state.week = k;
    } else if (b.dataset.action === "save-plan") {
      savePlan();
      return;
    } else if (b.dataset.action === "retry") {
      start();
      return;
    } else {
      return;
    }
    render();
    if (scrollTop) window.scrollTo(0, 0);
  });

  function start() {
    state.loading = true;
    state.error = null;
    render();
    loadData().then(function (d) {
      data = d;
      state.loading = false;
      render();
    }, function (err) {
      state.loading = false;
      state.error = err;
      render();
    });
  }

  start();
})();
