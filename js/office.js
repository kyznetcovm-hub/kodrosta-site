// ============================================================================
// «Офис в кармане» — Telegram Mini App клуба (office.html, css/office.css).
// Экраны «Обзор», «События», карточка события и «Деньги» перенесены из
// утверждённого макета (Obsidian: 02 Клуб/Дашборд клуба/). ТЗ — там же.
//
// Вход: открыть можно только из бота @KodrostaAssistant_bot — Telegram передаёт
// подписанную строку initData, она уходит на сервер (src/office.js) в каждом
// запросе. Сервер пускает только админов бота; иначе — экран «нет доступа».
// На localhost без Telegram показываются демо-данные — для проверки дизайна.
//
// Всё с сервера (src/office.js, src/office-money.js): события и регистрации,
// план участников, продажи (ввод вручную, отмена без удаления) и план продаж.
// Формат данных экранов:
//   { demo, now, loadedAt, user: { firstName }, month: "YYYY-MM",
//     money: { month, factRub, planRub, sources: [{ key, label, factRub, planRub }],
//              weeks: [{ factRub, planRub, bySource: [..] }], sales: [..], note },
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

  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg && tg.initData ? tg.initData : "";
  var isLocalPreview = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  var root = document.getElementById("kr-office");
  var content = document.getElementById("kr-content");

  var data = null;
  var state = {
    page: "home", selected: null, week: null, budget: false, loading: true, error: null, denied: null,
    form: null,        // null | "sale" | "plan" — экраны ввода внутри «Денег»
    values: {},        // введённое в форме — переживает перерисовку и ошибки сети
    notice: null       // строка «Продажа сохранена…» на экране денег
  };

  // ---- Демо-данные: числа и события ровно как в утверждённом макете ---------
  // «Сегодня» зафиксировано на 7 октября 2026, чтобы экран можно было сверить
  // со снимками макета один в один. В рабочую базу эти числа не попадают.
  function demoData() {
    return {
      demo: true,
      now: "2026-10-07T12:00:00+03:00",
      user: { firstName: "Михаил" },
      month: "2026-10",
      money: demoMoney(),
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

  // Деньги из макета — условные, в базу не попадают.
  function demoMoney() {
    return {
      month: "2026-10",
      sales: [],
      expenses: {
        totalRub: 0,
        categories: [{ key: "commission", label: "Комиссия менеджерам", factRub: 0 }, { key: "event_cost", label: "Себестоимость мероприятий", factRub: 0 }],
        byEvent: [],
        list: []
      },
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
        note: "Демо-режим: суммы условные, из макета."
    };
  }

  var MONEY_NOTE = "Факт — полученные деньги по дню поступления, расходы — по дню оплаты.";

  // ответ сервера (копейки) → формат экранов (рубли)
  function mapMoney(m) {
    function rub(kop) { return kop == null ? null : kop / 100; }
    return {
      month: m.month,
      factRub: rub(m.factKop),
      planRub: rub(m.planKop),
      sources: m.sources.map(function (x) {
        return { key: x.key, label: x.label, factRub: rub(x.factKop), planRub: rub(x.planKop),
          items: (x.items || []).map(function (it) {
            return { title: it.title, eventId: it.eventId, eventTitle: it.eventTitle, qty: it.qty, priceRub: rub(it.priceKop), totalRub: rub(it.totalKop) };
          }) };
      }),
      weeks: m.weeks.map(function (w) { return { factRub: rub(w.factKop), planRub: rub(w.planKop), bySource: w.bySource.map(rub) }; }),
      sales: m.sales.map(function (x) {
        return { id: x.id, date: x.date, amountRub: rub(x.amountKop), source: x.source, eventId: x.eventId, eventTitle: x.eventTitle,
          comment: x.comment, createdAt: x.createdAt, createdBy: x.createdBy, voided: x.voided, voidedBy: x.voidedBy };
      }),
      expenses: {
        totalRub: rub(m.expenses.totalKop),
        categories: m.expenses.categories.map(function (c) { return { key: c.key, label: c.label, factRub: rub(c.factKop) }; }),
        byEvent: m.expenses.byEvent.map(function (e) { return { eventId: e.eventId, eventTitle: e.eventTitle, factRub: rub(e.factKop) }; }),
        list: m.expenses.list.map(function (x) {
          return { id: x.id, date: x.date, amountRub: rub(x.amountKop), category: x.category, eventId: x.eventId, eventTitle: x.eventTitle,
            comment: x.comment, createdAt: x.createdAt, createdBy: x.createdBy, voided: x.voided, voidedBy: x.voidedBy };
        })
      },
      note: MONEY_NOTE
    };
  }

  // Ответ /api/office/money: показываем его на экране «Деньги» и запоминаем
  // по месяцу — «Обзор» всегда берёт текущий месяц, даже если в «Деньгах»
  // открыт другой.
  function showMoney(m) {
    var mm = mapMoney(m);
    data.moneyByMonth[mm.month] = mm;
    data.money = mm;
  }

  var REGISTRATIONS_NOTE = "Учтены записи через бота, с сайта и добавленные в боте вручную; прежние ручные записи, которых нет в боте, не учтены.";

  // Запрос к /api/office/* с подписью Telegram. Ошибка доступа — err.denied.
  function api(path, body) {
    var opts = { headers: { authorization: "tma " + initData } };
    if (body !== undefined) {
      opts.method = "POST";
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (resp) {
      if (resp.status === 401 || resp.status === 403) {
        var err = new Error("denied");
        err.denied = resp.status === 403 ? "forbidden" : "expired";
        throw err;
      }
      if (!resp.ok) {
        return resp.json().catch(function () { return {}; }).then(function (b) {
          var e = new Error("HTTP " + resp.status);
          e.code = b && b.error;
          throw e;
        });
      }
      return resp.json();
    });
  }

  function loadData() {
    if (!initData) {
      if (isLocalPreview) return Promise.resolve(demoData());
      var err = new Error("outside");
      err.denied = "outside";
      return Promise.reject(err);
    }
    return api("/api/office/data").then(function (d) {
      var money = mapMoney(d.money);
      var byMonth = {};
      byMonth[money.month] = money;
      return {
        demo: false,
        now: d.now,
        loadedAt: new Date().toISOString(),
        user: d.user,
        month: d.month,
        money: money,
        moneyByMonth: byMonth,
        events: d.events,
        registrationsNote: REGISTRATIONS_NOTE
      };
    });
  }

  var DENIED_TEXT = {
    outside: "Офис открывается только из Telegram — в боте @KodrostaAssistant_bot.",
    forbidden: "У этого аккаунта нет доступа к офису клуба.",
    expired: "Не удалось подтвердить вход. Закройте офис и откройте его заново из бота."
  };

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

  // рубли с копейками, если они есть: 12500 → «12 500», 12500.5 → «12 500,50»
  function fmtRub(n) {
    var whole = Math.round(n * 100) % 100 === 0;
    return new Intl.NumberFormat("ru-RU", whole ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  }

  // «12 500», «12500,50», «12 500 ₽» → копейки; пусто → null; ошибка → NaN
  function parseRubToKop(text) {
    var t = String(text == null ? "" : text).replace(/[\s\u00a0₽]/g, "").replace(",", ".");
    if (!t) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
    return Math.round(parseFloat(t) * 100);
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
    "plus": '<path d="M5 12h14"/><path d="M12 5v14"/>',
    "pencil": '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>'
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

  // формат (категория) · сегодня/завтра; категорию, совпадающую с названием
  // («Бизнес-баня» / «Бизнес-баня»), не повторяем
  function eventType(e) {
    var label = isPast(e) ? "" : dayLabel(e);
    var format = e.format && e.format.trim().toLowerCase() !== String(e.title).trim().toLowerCase() ? e.format : "";
    return esc([format, label].filter(Boolean).join(" · ") || "Событие");
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
    var grid = monthWeeks(data.money.month);
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

  // месяц, выбранный на экране «Деньги» (может отличаться от текущего)
  function moneyMonthName() {
    return MONTHS_NOM[Number(data.money.month.slice(5, 7)) - 1];
  }

  function monthLabel(month) {
    return capitalize(MONTHS_NOM[Number(month.slice(5, 7)) - 1]) + " " + month.slice(0, 4);
  }

  // выбор месяца: полгода назад — два вперёд (план на следующий месяц)
  function monthOptions() {
    var y = Number(data.month.slice(0, 4)), m = Number(data.month.slice(5, 7));
    var out = [];
    for (var k = -6; k <= 2; k++) {
      var d = new Date(Date.UTC(y, m - 1 + k, 1));
      out.push(d.toISOString().slice(0, 7));
    }
    return out;
  }

  function sourceLabel(key) {
    for (var i = 0; i < data.money.sources.length; i++) if (data.money.sources[i].key === key) return data.money.sources[i].label;
    return key;
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ---- Экраны ---------------------------------------------------------------
  function moneyHero(home) {
    var m = data.money;
    var planSet = m.planRub > 0;
    // на экране «Деньги» месяц выбирается нажатием на его название
    var monthCtl = home || data.demo
      ? '<span class="kr-month">' + capitalize(moneyMonthName()) + "</span>"
      : '<label class="kr-month-pick"><span class="kr-visually-hidden">Месяц</span><select data-control="month"' + (state.moneyLoading ? " disabled" : "") + ">" +
        monthOptions().map(function (mo) {
          return '<option value="' + mo + '"' + (mo === m.month ? " selected" : "") + ">" + monthLabel(mo) + "</option>";
        }).join("") + "</select>" + icon("chevron-down") + "</label>";
    var html = '<section class="kr-panel" aria-label="Продажи клуба за ' + moneyMonthName() + '">' +
      '<div class="kr-between"><h2>Деньги клуба</h2>' + monthCtl + "</div>" +
      // доход — главная цифра; длинная сумма чуть мельче, чтобы влезала в строку
      '<div class="kr-moneyline"><div><span class="kr-label">Факт продаж</span><div class="kr-fact' + (fmtRub(m.factRub).length > 9 ? " kr-fact-long" : "") + '">' +
      fmtRub(m.factRub) + ' <span class="kr-currency">₽</span></div></div>' +
      '<div><span class="kr-label">План месяца</span>' +
      (planSet ? '<div class="kr-plan">' + fmtRub(m.planRub) + ' <span class="kr-currency">₽</span></div>' : '<div class="kr-plan kr-empty">План не задан</div>') +
      "</div></div>";
    if (planSet) {
      var rest = m.planRub - m.factRub;
      html += bar(m.factRub, m.planRub, "Факт продаж к плану месяца") +
        '<div class="kr-bartext"><b>' + percent(m.factRub, m.planRub) + "% плана</b><span>" +
        (rest > 0 ? "Осталось " + fmtRub(rest) + " ₽" : rest === 0 ? "План выполнен" : "Сверх плана: " + fmtRub(-rest) + " ₽") +
        "</span></div>";
    }
    // прибыль = доход − расходы месяца; строкой, не выделяя — главное доход
    var expRub = m.expenses ? m.expenses.totalRub || 0 : 0;
    var profit = m.factRub - expRub;
    html += '<div class="kr-profit"><span>Прибыль<small>доход − расходы ' + fmtRub(expRub) + " ₽</small></span><strong>" +
      (profit < 0 ? "−" : "") + fmtRub(Math.abs(profit)) + " ₽</strong></div>";
    if (!home && !data.demo) {
      html += '<div class="kr-between kr-moneylinks"><button class="kr-link" data-action="open-plan">' + icon("pencil") +
        (planSet ? "Изменить план" : "Задать план") + "</button></div>";
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
    // карточка денег на «Обзоре» — всегда текущий месяц
    var shown = data.money;
    var current = data.money.month === data.month ? data.money : data.moneyByMonth && data.moneyByMonth[data.month];
    data.money = current || shown;
    var hero = moneyHero(true);
    data.money = shown;
    return hero +
      '<div class="kr-section-head"><h2>Ближайшие события</h2><button class="kr-link" data-page="events">Все события ' + icon("arrow-up-right") + "</button></div>" +
      eventList(upcomingEvents().slice(0, 3), "Ближайших событий нет");
  }

  function renderEvents() {
    var up = upcomingEvents(), past = pastEvents();
    // предстоящие — все будущие, в том числе следующих месяцев; прошедшие — этого месяца
    var html = '<div class="kr-section-head"><h2>Предстоящие · ' + up.length + "</h2></div>" +
      eventList(up, "Предстоящих событий нет");
    if (past.length) html += '<div class="kr-section-head"><h2>Прошедшие · ' + past.length + '</h2><span class="kr-month">' + capitalize(monthName()) + "</span></div>" + eventList(past, "");
    html += '<p class="kr-caption">В числителе — регистрации, в знаменателе — план участников.' +
      (data.registrationsNote ? " " + esc(data.registrationsNote) : "") + "</p>";
    return html;
  }

  // ---- Бюджет месяца (раскрывается кнопкой «Развернуть бюджет») -------------
  // Порядок по просьбе Михаила (9 октября): круговая диаграмма дохода по
  // статьям → поступления по статьям (план/факт, из чего сложен план) →
  // расходы → в самом конце, приглушённо, недели.

  // Диаграмма — из чего доход месяца: сектора по статьям поступлений.
  // Пока поступлений нет, показываем структуру плана, чтобы круг не был пустым.
  // Цвета проверены валидатором палитры: в порядке по кругу синий → красный →
  // янтарный → бирюзовый соседние сектора различимы и при дальтонизме.
  var DONUT_COLORS = { "new": "#296EF7", renewal: "#EB344A", events: "#EDA100", ads: "#1BAF7A" };

  function renderDonut() {
    var m = data.money;
    var byPlan = !(m.factRub > 0) && m.planRub > 0;
    var segs = m.sources.map(function (s) {
      return { key: s.key, label: s.label, value: (byPlan ? s.planRub : s.factRub) || 0 };
    });
    var total = segs.reduce(function (a, s) { return a + s.value; }, 0);
    var R = 62, C = 2 * Math.PI * R, GAP = 2; // 2px — зазор между секторами
    var arcs = "", offset = 0;
    segs.forEach(function (s) {
      if (s.value <= 0) return;
      var len = s.value / total * C;
      var visible = Math.max(len - (len > GAP * 2 ? GAP : 0), 0.5);
      arcs += '<circle class="kr-donut-seg" cx="80" cy="80" r="' + R + '" stroke="' + (DONUT_COLORS[s.key] || "#6b7080") + '" stroke-dasharray="' + visible.toFixed(2) + " " + (C - visible).toFixed(2) +
        '" stroke-dashoffset="' + (-offset).toFixed(2) + '"><title>' + esc(s.label) + ": " + fmtRub(s.value) + " ₽</title></circle>";
      offset += len;
    });
    var center = '<text x="80" y="76" class="kr-donut-label">' + (byPlan ? "план месяца" : "поступило") + '</text><text x="80" y="96" class="kr-donut-value">' +
      fmtK(byPlan ? m.planRub : m.factRub) + " тыс. ₽</text>";
    var legend = segs.map(function (s) {
      var pct = total > 0 ? Math.round(s.value / total * 100) + "%" : "—";
      return '<li><span class="kr-swatch" style="background:' + (DONUT_COLORS[s.key] || "#6b7080") + '"></span><span class="kr-legend-name">' + esc(s.label) +
        '</span><span class="kr-legend-val">' + fmtRub(s.value) + ' ₽</span><span class="kr-legend-pct">' + pct + "</span></li>";
    }).join("");
    var note = total === 0 ? '<p class="kr-caption">В этом месяце пока нет ни поступлений, ни плана.</p>'
      : byPlan ? '<p class="kr-caption">Поступлений пока нет — показана структура плана.</p>' : "";
    return '<div class="kr-budget-block"><h3 class="kr-budget-h">' + (byPlan ? "Из чего план дохода" : "Из чего доход") + "</h3>" +
      '<div class="kr-donut-wrap"><svg class="kr-donut" viewBox="0 0 160 160" role="img" aria-label="Доход месяца по статьям">' +
      '<circle cx="80" cy="80" r="' + R + '" class="kr-donut-track"></circle><g transform="rotate(-90 80 80)">' + arcs + "</g>" + center + "</svg>" +
      '<ul class="kr-legend">' + legend + "</ul></div>" + note + "</div>";
  }

  function planItemText(it) {
    var name = it.eventTitle || it.title || "";
    return (name ? esc(name) + " · " : "") + fmt(it.qty) + " × " + fmtRub(it.priceRub) + " = " + fmtRub(it.totalRub) + " ₽";
  }

  function renderIncomeTable() {
    var m = data.money;
    var rows = m.sources.map(function (s) {
      var items = s.items && s.items.length
        ? '<tr class="kr-subrow"><td colspan="3">' + s.items.map(planItemText).join("<br>") + "</td></tr>" : "";
      return "<tr><td>" + esc(s.label) + "</td><td>" + fmtRub(s.factRub) + "</td><td>" + (s.planRub == null ? "—" : fmtRub(s.planRub)) + "</td></tr>" + items;
    }).join("");
    return '<div class="kr-budget-block"><h3 class="kr-budget-h">Поступления</h3>' +
      '<table aria-label="Факт и план поступлений за ' + moneyMonthName() + ' в рублях"><thead><tr><th>Статья</th><th>Факт, ₽</th><th>План, ₽</th></tr></thead><tbody>' +
      rows + '<tr class="kr-total"><td>Всего</td><td>' + fmtRub(m.factRub) + "</td><td>" + (m.planRub == null ? "—" : fmtRub(m.planRub)) + "</td></tr></tbody></table></div>";
  }

  function renderExpenseTable() {
    var ex = data.money.expenses;
    var rows = ex.categories.map(function (c) {
      var sub = c.key === "event_cost" && ex.byEvent.length
        ? '<tr class="kr-subrow"><td colspan="2">' + ex.byEvent.map(function (e) { return esc(e.eventTitle) + " — " + fmtRub(e.factRub) + " ₽"; }).join("<br>") + "</td></tr>" : "";
      return "<tr><td>" + esc(c.label) + "</td><td>" + fmtRub(c.factRub) + "</td></tr>" + sub;
    }).join("");
    var rest = data.money.factRub - ex.totalRub;
    return '<div class="kr-budget-block"><h3 class="kr-budget-h">Расходы</h3>' +
      '<table class="kr-table-2" aria-label="Расходы за ' + moneyMonthName() + ' в рублях"><thead><tr><th>Статья</th><th>Факт, ₽</th></tr></thead><tbody>' +
      rows + '<tr class="kr-total"><td>Всего расходов</td><td>' + fmtRub(ex.totalRub) + "</td></tr>" +
      '<tr class="kr-total"><td>Остаётся клубу</td><td>' + (rest < 0 ? "−" : "") + fmtRub(Math.abs(rest)) + "</td></tr></tbody></table></div>";
  }

  // недели — в конце бюджета и приглушённо: главное — план месяца
  function renderWeeks() {
    var srcs = data.money.sources;
    return '<div class="kr-budget-block kr-weeks" id="kr-weeks"><div class="kr-between"><h3 class="kr-budget-h">По неделям</h3><span class="kr-month">Факт / план, тыс. ₽</span></div>' +
      weeksWithMoney().map(function (w, i) {
        var future = w.status === "future";
        var fact = future || w.factRub == null ? null : w.factRub;
        var html = '<button class="kr-week' + (w.status === "current" ? " kr-current" : "") + '" data-week="' + i + '" aria-expanded="' + (state.week === i) + '">' +
          '<span class="kr-week-date">' + weekLabel(w, false) + "<small>" + (w.status === "current" ? "Текущая" : future ? "Впереди" : "Завершена") + "</small></span>" +
          bar(fact || 0, w.planRub || 0, "Продажи за " + weekLabel(w, true)) +
          '<span class="kr-week-values">' + (fact == null ? "—" : fmtK(fact)) + "<small>" + (w.planRub == null ? "план —" : "план " + fmtK(w.planRub)) + "</small></span></button>";
        if (state.week === i) {
          var detail;
          if (future) {
            detail = (w.planRub == null ? "План не задан." : "План: " + fmtRub(w.planRub) + " ₽.") + " Неделя ещё не началась.";
          } else if (w.bySource) {
            detail = srcs.map(function (s, k) { return esc(s.label) + ": " + fmtRub(w.bySource[k] || 0) + " ₽"; }).join("<br>");
          } else {
            detail = "Продаж за неделю: " + fmtRub(fact || 0) + " ₽";
          }
          html += '<div class="kr-weekdetail" role="status">' + detail + "</div>";
        }
        return html;
      }).join("") + "</div>";
  }

  function renderBudget() {
    var m = data.money;
    return '<details class="kr-budget"' + (state.budget ? " open" : "") + '><summary>Бюджет месяца ' + icon("chevron-down") + "</summary>" +
      renderDonut() + renderIncomeTable() + renderExpenseTable() + renderWeeks() +
      (m.note ? '<p class="kr-caption">' + esc(m.note) + "</p>" : "") + "</details>";
  }

  function renderMoney() {
    if (state.form === "sale") return renderEntryForm("sale");
    if (state.form === "expense") return renderEntryForm("expense");
    if (state.form === "plan") return renderPlanForm();
    var html = moneyHero(false);
    if (!data.demo) {
      html += '<div class="kr-actions"><button class="kr-save" data-action="open-sale">' + icon("plus") + "Продажа</button>" +
        '<button class="kr-save kr-secondary" data-action="open-expense">' + icon("minus") + "Расход</button></div>";
      if (state.notice) html += '<p class="kr-saved kr-notice" role="status">' + esc(state.notice) + "</p>";
      if (state.moneyError) html += '<p class="kr-error" role="alert">' + esc(state.moneyError) + "</p>";
    }
    html += renderBudget();
    if (!data.demo) html += renderJournal();
    return html;
  }

  // ---- Журнал операций месяца: поступления и расходы вместе ----------------
  function expenseLabel(key) {
    for (var i = 0; i < data.money.expenses.categories.length; i++) {
      if (data.money.expenses.categories[i].key === key) return data.money.expenses.categories[i].label;
    }
    return key;
  }

  function journalEntries() {
    // по дню операции, внутри дня — сначала внесённые последними
    var list = data.money.sales.map(function (x) { return { kind: "sale", x: x, date: x.date, at: x.createdAt || "" }; })
      .concat(data.money.expenses.list.map(function (x) { return { kind: "expense", x: x, date: x.date, at: x.createdAt || "" }; }));
    return list.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  }

  function renderJournal() {
    var list = journalEntries();
    var live = list.filter(function (r) { return !r.x.voided; }).length;
    var html = '<div class="kr-section-head"><h2>Операции · ' + live + '</h2><span class="kr-month">' + capitalize(moneyMonthName()) + "</span></div>";
    if (!list.length) return html + '<div class="kr-empty-note">В этом месяце операций пока нет</div>';
    return html + '<section class="kr-event-list" aria-label="Поступления и расходы за месяц">' + list.map(function (r) {
      var x = r.x, d = dayParts(x.date), isExp = r.kind === "expense";
      var title = isExp ? expenseLabel(x.category) : sourceLabel(x.source);
      var meta = [x.eventTitle || "", x.comment || "", x.createdBy ? "внёс @" + x.createdBy : ""].filter(Boolean);
      return '<div class="kr-sale' + (x.voided ? " kr-voided" : "") + (isExp ? " kr-expense" : "") + '">' +
        '<div class="kr-event-date">' + pad(d.d) + "<small>" + MONTHS_SHORT[d.m - 1].toUpperCase() + "</small></div>" +
        '<div class="kr-sale-main"><p class="kr-event-name">' + esc(title) + "</p>" +
        (meta.length ? '<p class="kr-event-type">' + esc(meta.join(" · ")) + "</p>" : "") +
        (x.voided ? '<p class="kr-event-type">Отменена' + (x.voidedBy ? " · @" + esc(x.voidedBy) : "") + "</p>"
          : '<button class="kr-link kr-void" data-void="' + r.kind + ":" + x.id + '">Отменить</button>') + "</div>" +
        '<div class="kr-sale-amount">' + (isExp ? "−" : "") + fmtRub(x.amountRub) + " ₽</div></div>";
    }).join("") + "</section>";
  }

  // ---- Формы продажи и расхода ----------------------------------------------
  function newClientId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function openEntryForm(kind) {
    var t = today();
    // по умолчанию — сегодня, а если смотрим прошлый месяц — его последний день
    var date = data.money.month < t.slice(0, 7) ? monthWeeks(data.money.month).slice(-1)[0].to : t;
    state.form = kind;
    state.values = { clientId: newClientId(), amount: "", source: "", category: "", eventId: "", date: date, comment: "" };
    state.formError = null;
    state.notice = null;
  }

  function eventOptions(selected, emptyLabel) {
    // мероприятия этого месяца и будущие
    return '<option value="">' + emptyLabel + "</option>" +
      data.events.slice().sort(function (a, b) { return new Date(a.start) - new Date(b.start); }).map(function (e) {
        var d = dayParts(mskDay(e.start));
        return '<option value="' + esc(e.id) + '"' + (selected === e.id ? " selected" : "") + ">" + d.d + " " + MONTHS_SHORT[d.m - 1] + " · " + esc(e.title) + "</option>";
      }).join("");
  }

  var ENTRY = {
    sale: {
      title: "Новая продажа", subtitle: "Поступление денег · вносится вручную", save: "Сохранить продажу",
      dateLabel: "Дата поступления", chipsLabel: "Статья", field: "source",
      chips: function () { return data.money.sources; },
      needEvent: function (v) { return v.source === "events" ? "optional" : null; },
      note: "Каждое поступление — отдельной записью в день, когда пришли деньги; частичная оплата — тоже отдельно.",
      placeholder: "Например: продление на 3 месяца",
      url: "/api/office/sales", done: "Продажа сохранена"
    },
    expense: {
      title: "Новый расход", subtitle: "Оплата · вносится вручную", save: "Сохранить расход",
      dateLabel: "Дата оплаты", chipsLabel: "Статья расхода", field: "category",
      chips: function () { return data.money.expenses.categories; },
      needEvent: function (v) { return v.category === "event_cost" ? "required" : v.category === "commission" ? "optional" : null; },
      note: "Себестоимость — всегда с мероприятием: так видно, во что обошлось каждое. Комиссию можно привязать к мероприятию, если она за его продажи.",
      placeholder: "Например: Анна, 10% с продлений",
      url: "/api/office/expenses", done: "Расход сохранён"
    }
  };

  function renderEntryForm(kind) {
    var cfg = ENTRY[kind], v = state.values;
    var ev = cfg.needEvent(v);
    var html = '<button class="kr-back" data-action="close-form">' + icon("chevron-left") + "К деньгам</button>" +
      '<section class="kr-panel kr-form">' +
      '<label class="kr-field"><span class="kr-label">Сумма, ₽</span>' +
      '<input class="kr-input kr-input-big" data-field="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="' + esc(v.amount) + '"></label>' +
      '<div class="kr-field"><span class="kr-label">' + cfg.chipsLabel + '</span><div class="kr-chips" role="radiogroup" aria-label="' + cfg.chipsLabel + '">' +
      cfg.chips().map(function (c) {
        var on = v[cfg.field] === c.key;
        return '<button class="kr-chip' + (on ? " kr-on" : "") + '" role="radio" aria-checked="' + on + '" data-chip="' + cfg.field + ":" + c.key + '">' + esc(c.label) + "</button>";
      }).join("") + "</div></div>";
    if (ev) {
      html += '<label class="kr-field"><span class="kr-label">Мероприятие' + (ev === "required" ? "" : " — необязательно") + '</span><select class="kr-input" data-field="eventId">' +
        eventOptions(v.eventId, ev === "required" ? "Выберите мероприятие" : "Не указывать") + "</select></label>";
    }
    html += '<label class="kr-field"><span class="kr-label">' + cfg.dateLabel + '</span>' +
      '<input class="kr-input" type="date" data-field="date" max="' + today() + '" value="' + esc(v.date) + '"></label>' +
      '<label class="kr-field"><span class="kr-label">Комментарий — необязательно</span>' +
      '<input class="kr-input" data-field="comment" maxlength="300" autocomplete="off" placeholder="' + cfg.placeholder + '" value="' + esc(v.comment) + '"></label>' +
      '<button class="kr-save" data-action="save-entry"' + (state.saving ? " disabled" : "") + ">" + (state.saving ? "Сохраняем…" : cfg.save) + "</button>" +
      (state.formError ? '<p class="kr-error" role="alert">' + esc(state.formError) + "</p>" : "") +
      "</section>" +
      '<p class="kr-caption">' + cfg.note + " Ошибочную запись можно отменить в списке операций.</p>";
    return html;
  }

  var SAVE_ERRORS = {
    bad_amount: "Проверьте сумму.",
    bad_source: "Выберите статью.",
    bad_category: "Выберите статью расхода.",
    need_event: "Выберите мероприятие.",
    bad_date: "Проверьте дату.",
    future_date: "Дата не может быть позже сегодняшней."
  };

  function saveEntry() {
    if (state.saving) return; // двойное нажатие — один запрос
    var kind = state.form, cfg = ENTRY[kind], v = state.values;
    var kop = parseRubToKop(v.amount);
    var ev = cfg.needEvent(v);
    var err = kop === null || isNaN(kop) || kop <= 0 ? "Введите сумму, например 12 500."
      : !v[cfg.field] ? (kind === "sale" ? SAVE_ERRORS.bad_source : SAVE_ERRORS.bad_category)
      : ev === "required" && !v.eventId ? SAVE_ERRORS.need_event
      : !v.date ? "Укажите дату."
      : v.date > today() ? SAVE_ERRORS.future_date
      : null;
    if (err) {
      state.formError = err;
      render();
      return;
    }
    state.saving = true;
    state.formError = null;
    render();
    var body = { clientId: v.clientId, date: v.date, amountKop: kop, eventId: ev ? v.eventId || null : null, comment: v.comment };
    body[cfg.field] = v[cfg.field];
    var label = kind === "sale" ? sourceLabel(v.source) : expenseLabel(v.category);
    // тот же clientId при повторе после ошибки — сервер не создаст дубль
    api(cfg.url, body).then(function () {
      return api("/api/office/money?month=" + v.date.slice(0, 7)).then(function (res) {
        state.saving = false;
        showMoney(res.money);
        state.form = null;
        state.values = {};
        state.notice = cfg.done + ": " + fmtRub(kop / 100) + " ₽ · " + label + ".";
        render();
        window.scrollTo(0, 0);
      });
    }).catch(function (e) {
      state.saving = false;
      state.formError = e && e.denied ? DENIED_TEXT[e.denied]
        : e && e.code && SAVE_ERRORS[e.code] ? SAVE_ERRORS[e.code]
        : "Не удалось сохранить — проверьте связь и нажмите ещё раз. Введённое не потеряется.";
      render();
    });
  }

  function confirmAction(text) {
    return new Promise(function (resolve) {
      if (tg && tg.showConfirm && tg.initData) tg.showConfirm(text, resolve);
      else resolve(window.confirm(text));
    });
  }

  function voidEntry(ref) {
    var kind = ref.split(":")[0], id = Number(ref.split(":")[1]);
    var list = kind === "sale" ? data.money.sales : data.money.expenses.list;
    var x = null;
    list.forEach(function (s) { if (s.id === id) x = s; });
    if (!x || state.voiding) return;
    var what = kind === "sale" ? "поступление " + fmtRub(x.amountRub) + " ₽ (" + sourceLabel(x.source) + ")"
      : "расход " + fmtRub(x.amountRub) + " ₽ (" + expenseLabel(x.category) + ")";
    confirmAction("Отменить " + what + "? Запись останется в списке с пометкой «Отменена» и не войдёт в итоги.").then(function (yes) {
      if (!yes) return;
      state.voiding = true;
      api(kind === "sale" ? "/api/office/sales/void" : "/api/office/expenses/void", { id: id }).then(function () {
        return api("/api/office/money?month=" + data.money.month);
      }).then(function (res) {
        state.voiding = false;
        showMoney(res.money);
        state.notice = kind === "sale" ? "Поступление отменено." : "Расход отменён.";
        state.moneyError = null;
        render();
      }, function () {
        state.voiding = false;
        state.moneyError = "Не удалось отменить — проверьте связь и попробуйте ещё раз.";
        render();
      });
    });
  }

  // ---- Форма плана продаж: из чего он складывается --------------------------
  // По статьям — строки «что · сколько × почём»; план статьи = сумма строк,
  // план месяца = сумма статей. Недели — свёрнуты, необязательны.
  function numToInput(n) {
    return n == null ? "" : String(n).replace(".", ",");
  }

  function openPlanForm() {
    var m = data.money;
    state.form = "plan";
    state.values = { items: {}, weeks: [] };
    m.sources.forEach(function (src) {
      var rows = (src.items || []).map(function (it) {
        return { title: it.eventTitle || it.title || "", qty: String(it.qty), price: numToInput(it.priceRub) };
      });
      // план, введённый раньше одной суммой, — одной строкой «1 × сумма»
      if (!rows.length && src.planRub != null) rows.push({ title: "", qty: "1", price: numToInput(src.planRub) });
      if (!rows.length) rows.push({ title: "", qty: "", price: "" });
      state.values.items[src.key] = rows;
    });
    m.weeks.forEach(function (w, i) { state.values.weeks[i] = numToInput(w.planRub); });
    state.formError = null;
    state.notice = null;
  }

  // строка плана → { kop, empty, bad }
  function itemValue(it) {
    var qtyText = String(it.qty || "").trim();
    var priceKop = parseRubToKop(it.price);
    if (!qtyText && priceKop === null && !String(it.title || "").trim()) return { empty: true, kop: 0 };
    var qty = /^\d+$/.test(qtyText) ? parseInt(qtyText, 10) : NaN;
    if (!(qty > 0) || priceKop === null || isNaN(priceKop) || priceKop <= 0) return { bad: true, kop: 0 };
    return { kop: qty * priceKop, qty: qty, priceKop: priceKop };
  }

  function sourcePlanKop(key) {
    var sum = 0, bad = false;
    (state.values.items[key] || []).forEach(function (it) {
      var r = itemValue(it);
      if (r.bad) bad = true; else sum += r.kop;
    });
    return { kop: sum, bad: bad };
  }

  function planTotals() {
    var v = state.values, month = 0, weeks = 0, bad = false;
    Object.keys(v.items).forEach(function (k) {
      var r = sourcePlanKop(k);
      if (r.bad) bad = true;
      month += r.kop;
    });
    v.weeks.forEach(function (x) {
      var kop = parseRubToKop(x);
      if (isNaN(kop)) bad = true; else weeks += kop || 0;
    });
    return { monthKop: month, weeksKop: weeks, bad: bad };
  }

  function planBalanceText() {
    var t = planTotals();
    var diff = t.monthKop - t.weeksKop;
    if (!t.weeksKop) return "По неделям можно не распределять — главное план месяца.";
    if (diff === 0) return "Недели сходятся с планом месяца.";
    return diff > 0 ? "Не распределено по неделям: " + fmtRub(diff / 100) + " ₽."
      : "Недели больше плана месяца на " + fmtRub(-diff / 100) + " ₽.";
  }

  function itemTotalText(it) {
    var r = itemValue(it);
    return r.empty ? "" : r.bad ? "проверьте" : "= " + fmtRub(r.kop / 100) + " ₽";
  }

  function renderPlanForm() {
    var v = state.values, m = data.money;
    var t = planTotals();
    var titles = '<datalist id="kr-event-titles">' + data.events.map(function (e) { return '<option value="' + esc(e.title) + '">'; }).join("") + "</datalist>";
    var html = '<button class="kr-back" data-action="close-form">' + icon("chevron-left") + "К деньгам</button>" + titles;
    m.sources.forEach(function (src) {
      var st = sourcePlanKop(src.key);
      html += '<section class="kr-panel kr-form kr-plan-src"><div class="kr-between"><h2>' + esc(src.label) + '</h2><strong class="kr-src-total" id="kr-src-' + src.key + '">' +
        (st.bad ? "—" : fmtRub(st.kop / 100) + " ₽") + "</strong></div>" +
        v.items[src.key].map(function (it, i) {
          var ref = src.key + ":" + i;
          return '<div class="kr-item"><div class="kr-item-top"><input class="kr-input" data-item="' + ref + ':title" autocomplete="off" placeholder="' +
            (src.key === "events" ? "Мероприятие" : "Что продаём — необязательно") + '"' + (src.key === "events" ? ' list="kr-event-titles"' : "") + ' value="' + esc(it.title) + '">' +
            '<button class="kr-item-del" data-del-item="' + ref + '" aria-label="Удалить строку">×</button></div>' +
            '<div class="kr-item-calc"><input class="kr-input kr-qty" data-item="' + ref + ':qty" inputmode="numeric" placeholder="кол-во" value="' + esc(it.qty) + '">' +
            '<span class="kr-times">×</span><input class="kr-input" data-item="' + ref + ':price" inputmode="decimal" placeholder="цена, ₽" value="' + esc(it.price) + '">' +
            '<span class="kr-item-total" id="kr-it-' + src.key + "-" + i + '">' + itemTotalText(it) + "</span></div></div>";
        }).join("") +
        '<button class="kr-link" data-add-item="' + src.key + '">' + icon("plus") + "Добавить строку</button></section>";
    });
    html += '<section class="kr-panel kr-plan-sum"><div class="kr-plan-total"><span>План месяца</span><strong id="kr-plan-month">' + fmtRub(t.monthKop / 100) + " ₽</strong></div></section>" +
      '<details class="kr-budget kr-plan-weeks"' + (state.planWeeksOpen ? " open" : "") + '><summary>По неделям — необязательно ' + icon("chevron-down") + '</summary><div class="kr-form">' +
      monthWeeks(m.month).map(function (w, i) {
        return '<label class="kr-plan-row"><span>' + weekLabel(w, false) + '</span><input class="kr-input" data-plan-week="' + i +
          '" inputmode="decimal" autocomplete="off" placeholder="не задан" value="' + esc(v.weeks[i]) + '"></label>';
      }).join("") +
      '<p class="kr-caption" id="kr-plan-balance">' + planBalanceText() + "</p></div></details>" +
      '<button class="kr-save kr-plan-save" data-action="save-plans"' + (state.saving ? " disabled" : "") + ">" + (state.saving ? "Сохраняем…" : "Сохранить план") + "</button>" +
      (state.formError ? '<p class="kr-error" role="alert">' + esc(state.formError) + "</p>" : "") +
      '<p class="kr-caption">План статьи — сумма её строк, план месяца — сумма статей. Пустые строки не сохраняются. Виден обоим аккаунтам офиса.</p>';
    return html;
  }

  function eventIdByTitle(title) {
    var t = String(title || "").trim().toLowerCase();
    if (!t) return null;
    for (var i = 0; i < data.events.length; i++) if (data.events[i].title.trim().toLowerCase() === t) return data.events[i].id;
    return null;
  }

  function savePlans() {
    if (state.saving) return;
    var v = state.values, t = planTotals();
    if (t.bad) {
      state.formError = "Проверьте строки: нужно количество (целое число) и цена, например 8 × 15 000.";
      render();
      return;
    }
    var body = { month: data.money.month, items: {}, weeks: [] };
    Object.keys(v.items).forEach(function (k) {
      body.items[k] = [];
      v.items[k].forEach(function (it) {
        var r = itemValue(it);
        if (r.empty) return;
        var title = String(it.title || "").trim();
        body.items[k].push({ title: title || null, eventId: k === "events" ? eventIdByTitle(title) : null, qty: r.qty, priceKop: r.priceKop });
      });
    });
    v.weeks.forEach(function (x, i) { body.weeks[i] = parseRubToKop(x); });
    state.saving = true;
    state.formError = null;
    render();
    api("/api/office/plans", body).then(function () {
      return api("/api/office/money?month=" + body.month);
    }).then(function (res) {
      state.saving = false;
      showMoney(res.money);
      state.form = null;
      state.values = {};
      state.notice = "План сохранён.";
      render();
      window.scrollTo(0, 0);
    }, function (e) {
      state.saving = false;
      state.formError = e && e.denied ? DENIED_TEXT[e.denied] : "Не удалось сохранить — проверьте связь и нажмите ещё раз. Введённое не потеряется.";
      render();
    });
  }

  // переход с «Обзора» к деньгам — к текущему месяцу, как на карточке
  function backToCurrentMonth() {
    if (data.demo || data.money.month === data.month || !data.moneyByMonth[data.month]) return;
    data.money = data.moneyByMonth[data.month];
  }

  // смена месяца на экране «Деньги»; при ошибке остаётся прежний месяц
  function switchMonth(month) {
    state.moneyLoading = true;
    state.moneyError = null;
    state.notice = null;
    state.week = null;
    render();
    api("/api/office/money?month=" + month).then(function (res) {
      state.moneyLoading = false;
      showMoney(res.money);
      render();
    }, function () {
      state.moneyLoading = false;
      state.moneyError = "Не удалось загрузить " + monthLabel(month).toLowerCase() + " — проверьте связь.";
      render();
    });
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
    else html += '<p class="kr-caption">План виден обоим аккаунтам офиса. Это цель, а не лимит: запись после него не закрывается.' +
      (data.registrationsNote ? " " + esc(data.registrationsNote) : "") + "</p>";
    return html;
  }

  var TITLES = { home: "Офис в кармане", events: "События клуба", money: "Деньги клуба" };

  function subtitle() {
    if (state.selected !== null) return "Регистрации и план по каждому событию.";
    if (state.page === "events") return "Регистрации и план по каждому событию.";
    if (state.page === "money" && (state.form === "sale" || state.form === "expense")) return ENTRY[state.form].subtitle;
    if (state.page === "money" && state.form === "plan") return monthLabel(data.money.month);
    if (state.page === "money") return "Продажи и поступления · " + moneyMonthName() + " " + data.money.month.slice(0, 4);
    return ""; // на «Обзоре» подзаголовка нет — Михаил попросил убрать приветствие
  }

  function render() {
    syncTelegramBackButton();
    root.querySelector(".kr-footer").hidden = !!state.denied;
    if (state.denied) {
      document.getElementById("kr-date").innerHTML = "";
      document.getElementById("kr-title").textContent = "Офис в кармане";
      document.getElementById("kr-subtitle").textContent = "";
      content.innerHTML = '<div class="kr-empty-note">' + DENIED_TEXT[state.denied] + "</div>";
      return;
    }
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
    document.getElementById("kr-title").textContent = state.selected !== null ? "Событие"
      : state.form === "sale" || state.form === "expense" ? ENTRY[state.form].title : state.form === "plan" ? "План продаж" : TITLES[state.page];
    var sub = subtitle();
    document.getElementById("kr-subtitle").textContent = sub;
    document.getElementById("kr-subtitle").hidden = !sub;
    var badge = data.demo ? "Демо-данные · суммы и регистрации условные"
      : "Обновлено в " + timeHM(data.loadedAt);
    document.getElementById("kr-demo").hidden = false;
    document.getElementById("kr-demo-text").textContent = badge;
    content.innerHTML = state.selected !== null ? renderDetail()
      : state.page === "home" ? renderHome()
      : state.page === "events" ? renderEvents()
      : renderMoney();
    var details = content.querySelector("details.kr-budget:not(.kr-plan-weeks)");
    if (details) details.addEventListener("toggle", function () { state.budget = details.open; });
    var pw = content.querySelector("details.kr-plan-weeks");
    if (pw) pw.addEventListener("toggle", function () { state.planWeeksOpen = pw.open; });
  }

  function timeHM(iso) {
    return new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  }

  var savingPlan = false;

  function savePlan() {
    if (savingPlan) return; // двойное нажатие не шлёт второй запрос
    var e = findEvent(state.selected);
    var input = document.getElementById("kr-slot-input");
    var out = document.getElementById("kr-validation");
    var n = Number(input.value);
    if (!input.value || !Number.isInteger(n) || n < 1) {
      out.innerHTML = '<p class="kr-error" role="alert">Введите целое число больше нуля.</p>';
      return;
    }
    if (data.demo) {
      e.plan = n;
      render();
      document.getElementById("kr-validation").innerHTML = '<p class="kr-saved">План обновлён.</p>';
      return;
    }
    var button = root.querySelector("[data-action=save-plan]");
    savingPlan = true;
    button.disabled = true;
    button.textContent = "Сохраняем…";
    out.innerHTML = "";
    api("/api/office/event-plan", { eventId: e.id, plan: n }).then(function (res) {
      savingPlan = false;
      e.plan = res.plan;
      render();
      document.getElementById("kr-validation").innerHTML = '<p class="kr-saved">План сохранён.</p>';
    }, function (err) {
      savingPlan = false;
      // введённое число остаётся в поле — можно нажать ещё раз
      button.disabled = false;
      button.textContent = "Сохранить план";
      out.innerHTML = '<p class="kr-error" role="alert">' +
        (err && err.denied ? DENIED_TEXT[err.denied] : "Не удалось сохранить — проверьте связь и нажмите ещё раз.") + "</p>";
    });
  }

  // ---- Telegram: кнопка «Назад» в шапке, цвета оболочки ---------------------
  function goBack() {
    if (state.form) {
      state.form = null;
      state.formError = null;
    } else if (state.selected !== null) {
      state.selected = null;
      state.page = "events";
    } else {
      state.page = "home";
    }
    render();
    window.scrollTo(0, 0);
  }

  function syncTelegramBackButton() {
    if (!tg || !tg.BackButton) return;
    if (!state.denied && !state.loading && (state.selected !== null || state.page !== "home")) tg.BackButton.show();
    else tg.BackButton.hide();
  }

  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor("#ffffff");
    if (tg.setBackgroundColor) tg.setBackgroundColor("#f6f7fb");
    // чтобы прокрутка списка вниз не сворачивала приложение
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    if (tg.BackButton) tg.BackButton.onClick(goBack);
  }

  root.addEventListener("click", function (ev) {
    var b = ev.target.closest("button");
    if (!b || b.disabled) return;
    var scrollTop = true;
    if (b.dataset.page) {
      state.page = b.dataset.page;
      state.selected = null;
      state.form = null;
      state.notice = null;
    } else if (b.dataset.chip) {
      state.values[b.dataset.chip.split(":")[0]] = b.dataset.chip.split(":")[1];
      scrollTop = false;
    } else if (b.dataset.void) {
      voidEntry(b.dataset.void);
      return;
    } else if (b.dataset.addItem) {
      state.values.items[b.dataset.addItem].push({ title: "", qty: "", price: "" });
      scrollTop = false;
    } else if (b.dataset.delItem) {
      var ref = b.dataset.delItem.split(":");
      var rows = state.values.items[ref[0]];
      rows.splice(Number(ref[1]), 1);
      if (!rows.length) rows.push({ title: "", qty: "", price: "" });
      scrollTop = false;
    } else if (b.dataset.action === "open-sale") {
      openEntryForm("sale");
    } else if (b.dataset.action === "open-expense") {
      openEntryForm("expense");
    } else if (b.dataset.action === "open-plan") {
      openPlanForm();
    } else if (b.dataset.action === "close-form") {
      state.form = null;
      state.formError = null;
    } else if (b.dataset.action === "save-entry") {
      saveEntry();
      return;
    } else if (b.dataset.action === "save-plans") {
      savePlans();
      return;
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
      backToCurrentMonth();
    } else if (b.dataset.action === "weeks") {
      // недели теперь внутри бюджета, в конце — раскрываем его и листаем к ним
      state.page = "money";
      state.budget = true;
      backToCurrentMonth();
      var weeks = weeksWithMoney();
      for (var k = 0; k < weeks.length; k++) if (weeks[k].status === "current") state.week = k;
      render();
      var wk = document.getElementById("kr-weeks");
      if (wk) wk.scrollIntoView({ block: "start" });
      return;
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

  // ввод в формах — запоминаем в state, чтобы перерисовка не стирала введённое
  root.addEventListener("input", function (ev) {
    var el = ev.target;
    if (el.dataset.field) state.values[el.dataset.field] = el.value;
    else if (el.dataset.item) {
      var p = el.dataset.item.split(":");
      state.values.items[p[0]][Number(p[1])][p[2]] = el.value;
      var it = state.values.items[p[0]][Number(p[1])];
      document.getElementById("kr-it-" + p[0] + "-" + p[1]).textContent = itemTotalText(it);
      var st = sourcePlanKop(p[0]);
      document.getElementById("kr-src-" + p[0]).textContent = st.bad ? "—" : fmtRub(st.kop / 100) + " ₽";
    }
    else if (el.dataset.planWeek !== undefined) state.values.weeks[Number(el.dataset.planWeek)] = el.value;
    else return;
    if (state.form === "plan") {
      // итоги плана — без перерисовки, чтобы не сбивать курсор
      document.getElementById("kr-plan-month").textContent = fmtRub(planTotals().monthKop / 100) + " ₽";
      document.getElementById("kr-plan-balance").textContent = planBalanceText();
    }
  });

  root.addEventListener("change", function (ev) {
    var el = ev.target;
    if (el.dataset.control === "month") switchMonth(el.value);
    else if (el.dataset.field) state.values[el.dataset.field] = el.value;
  });

  function start() {
    state.loading = true;
    state.error = null;
    state.denied = null;
    render();
    loadData().then(function (d) {
      data = d;
      state.loading = false;
      render();
    }, function (err) {
      state.loading = false;
      if (err && err.denied) state.denied = err.denied;
      else state.error = err;
      render();
    });
  }

  // Вернулись в офис (свернули Telegram и открыли снова) — тихо обновляем данные,
  // не сбрасывая открытый экран. При ошибке остаются прежние данные, не нули.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !data || data.demo || state.loading || state.denied || state.form) return;
    if (Date.now() - new Date(data.loadedAt).getTime() < 60000) return;
    var month = data.money.month;
    loadData().then(function (d) {
      if (month === d.month) return d;
      // на экране денег выбран другой месяц — остаёмся на нём
      return api("/api/office/money?month=" + month).then(function (res) {
        d.money = mapMoney(res.money);
        d.moneyByMonth[month] = d.money;
        return d;
      });
    }).then(function (d) {
      data = d;
      if (state.selected !== null && !findEvent(state.selected)) state.selected = null;
      render();
    }, function () {});
  });

  start();
})();
