// ============================================================================
// «Рандомайзер» — Telegram Mini App клуба (randomizer.html, css/randomizer.css).
// Внешний вид — по утверждённому макету (Obsidian: 02 Клуб/Рандомайзер/).
//
// Вход: открыть можно только из бота @KodrostaAssistant_bot — Telegram передаёт
// подписанную строку initData, она уходит на сервер (src/randomizer.js) в каждом
// запросе; сервер пускает только админов бота.
//
// Порядок: выбрать событие → список участников подгружается сам (только имя и
// @username, телефонов тут нет) → выбрать 1/2/3 победителей → «Начать розыгрыш».
// Победителей выбирает сервер и сразу пишет в историю; барабан на экране лишь
// показывает уже выбранный результат. «Отправить поздравление» открывает чат с
// победителем и готовым текстом — Михаил сам нажимает «Отправить» (в Telegram,
// где вошёл как @Kodrosta).
// ============================================================================

(function () {
  "use strict";

  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg && tg.initData ? tg.initData : "";
  var main = document.getElementById("kr-main");
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (tg) {
    try { tg.ready(); tg.expand(); } catch (e) { /* не критично */ }
  }

  var state = {
    events: null,          // [{ id, title, start, upcoming, count }]
    eventId: null,
    participants: null,    // [{ name, username }] выбранного события
    winnersCount: 1,
    busy: false,
    error: null
  };

  // ---- Вспомогательное --------------------------------------------------

  // Узел без innerHTML: имена приходят от людей, вставлять их разметкой нельзя.
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") el.className = attrs[k];
      else if (k === "text") el.textContent = attrs[k];
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) el.setAttribute(k, "");
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  function api(path, options) {
    options = options || {};
    var headers = { Authorization: "tma " + initData };
    if (options.body) headers["content-type"] = "application/json";
    return fetch(path, { method: options.method || "GET", headers: headers, body: options.body ? JSON.stringify(options.body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: "bad_response" }; }).then(function (d) {
          if (!r.ok || !d.ok) { var err = new Error(d.error || "http_" + r.status); err.code = d.error; err.status = r.status; throw err; }
          return d;
        });
      });
  }

  function errorText(e) {
    var map = {
      no_auth: "Откройте рандомайзер из бота @KodrostaAssistant_bot.",
      bad_auth: "Не удалось войти. Закройте окно и откройте рандомайзер из бота заново.",
      forbidden: "Рандомайзер доступен только менеджерам клуба.",
      not_enough: "Участников меньше, чем победителей.",
      not_found: "Событие не найдено."
    };
    return map[e && e.code] || "Не получилось. Проверьте интернет и попробуйте ещё раз.";
  }

  function initials(name) {
    var parts = String(name || "").replace(/^@/, "").trim().split(/\s+/);
    var s = (parts[0] || "?").charAt(0) + (parts.length > 1 ? parts[1].charAt(0) : "");
    return s.toUpperCase();
  }

  function shortName(p) {
    var n = String(p.name || "").trim().split(/\s+/)[0] || ("@" + p.username);
    return n.length > 11 ? n.slice(0, 10) + "…" : n;
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  function currentEvent() {
    return (state.events || []).filter(function (e) { return e.id === state.eventId; })[0] || null;
  }

  function show(nodes) {
    main.textContent = "";
    nodes.forEach(function (n) { if (n) main.appendChild(n); });
    window.scrollTo(0, 0);
  }

  function setBack(handler) {
    if (!tg || !tg.BackButton) return;
    try {
      if (setBack.prev) tg.BackButton.offClick(setBack.prev);
      setBack.prev = handler || null;
      if (handler) { tg.BackButton.onClick(handler); tg.BackButton.show(); } else tg.BackButton.hide();
    } catch (e) { /* старые клиенты Telegram */ }
  }

  var TICKET_PLANE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.9 3.3 2.6 10.8c-.9.4-.9 1.1-.2 1.3l4.9 1.5 1.9 5.7c.2.6.4.8.9.8.4 0 .6-.2.9-.5l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.3-.5-1.9-1-1.2z"/></svg>';

  // ---- Экран 1: подготовка ------------------------------------------------

  function loadParticipants() {
    state.participants = null;
    state.error = null;
    renderPrep();
    if (!state.eventId) return;
    var id = state.eventId;
    api("/api/randomizer/participants?eventId=" + encodeURIComponent(id)).then(function (d) {
      if (state.eventId !== id) return;
      state.participants = d.participants;
      var ev = currentEvent();
      if (ev) ev.count = d.participants.length;
      if (state.winnersCount > d.participants.length) state.winnersCount = Math.max(1, Math.min(d.participants.length, 3));
      renderPrep();
    }).catch(function (e) {
      state.error = errorText(e);
      renderPrep();
    });
  }

  function renderPrep() {
    setBack(null);
    var ev = currentEvent();
    var total = state.participants ? state.participants.length : null;

    var select = h("select", { class: "kr-select", id: "kr-event", "aria-label": "Мероприятие", onchange: function (e) {
      state.eventId = e.target.value;
      loadParticipants();
    } }, (state.events || []).map(function (e) {
      return h("option", { value: e.id, selected: e.id === state.eventId, text: e.title });
    }));

    var seg = h("div", { class: "kr-seg", role: "group", "aria-label": "Сколько победителей" }, [1, 2, 3].map(function (n) {
      return h("button", { type: "button", text: String(n), "aria-pressed": String(state.winnersCount === n), disabled: total == null || n > total, onclick: function () {
        state.winnersCount = n;
        renderPrep();
      } });
    }));

    var canStart = total != null && total >= 1 && !state.busy;
    var start = h("button", { class: "kr-btn", type: "button", text: "Начать розыгрыш", disabled: !canStart, onclick: startRaffle });

    var drum = buildDrum(state.participants || []);
    show([
      h("h1", { text: "Розыгрыш билета" }),
      h("label", { class: "kr-label", for: "kr-event", text: "Мероприятие" }),
      select,
      h("button", { class: "kr-link", type: "button", text: "Загрузить список", onclick: loadParticipants }),
      h("div", { class: "kr-stat" }, [
        h("div", { class: "kr-stat-num" }, [total == null ? "…" : String(total), h("small", { text: total == null ? "загружаем" : plural(total, "участник", "участника", "участников") })]),
        h("div", { class: "kr-stat-note", text: "Имя + username" })
      ]),
      h("p", { class: "kr-q", text: "Сколько победителей?" }),
      seg,
      drum.wrap,
      h("p", { class: "kr-drum-caption", text: total === 0 ? "На это событие пока никто не записался" : "Всё готово к розыгрышу" }),
      state.error ? h("p", { class: "kr-error", text: state.error }) : null,
      start,
      h("p", { class: "kr-hint", text: "Поздравление будет доступно после розыгрыша" }),
      h("div", { class: "kr-center" }, [h("button", { class: "kr-link", type: "button", text: "История розыгрышей", onclick: renderHistory })])
    ]);
    if (!ev && state.events && !state.events.length) {
      main.appendChild(h("p", { class: "kr-error", text: "В боте пока нет мероприятий." }));
    }
    drum.idle();
  }

  // ---- Барабан ----------------------------------------------------------------

  var TICKETS = 10;

  function buildDrum(participants) {
    var drum = h("div", { class: "kr-drum kr-idle" });
    var wrap = h("div", { class: "kr-drum-wrap" }, [h("div", { class: "kr-pointer" }), drum]);
    var tickets = [];
    var names = participants.length ? participants : [{ name: "Имя", username: null }];
    function randomName() { return shortName(names[Math.floor(Math.random() * names.length)]); }
    for (var i = 0; i < TICKETS; i++) {
      var t = h("div", { class: "kr-ticket" + (i % 3 === 2 ? " kr-ghost" : ""), text: randomName() });
      tickets.push({ el: t, a: (i / TICKETS) * Math.PI * 2, r: 75 + (i % 3) * 22, w: 0.6 + (i % 4) * 0.25, ph: i * 1.7, rot: (i * 37) % 60 - 30 });
      drum.appendChild(t);
    }

    function place(t, angle, r, rot, scale) {
      var c = drum.clientWidth / 2 || 122;
      var k = c / 147; // раскладка рассчитана на барабан 294px — масштабируем
      t.el.style.transform = "translate(" + (c + Math.cos(angle) * r * k).toFixed(1) + "px," + (c + Math.sin(angle) * r * k).toFixed(1) + "px) rotate(" + rot.toFixed(1) + "deg) scale(" + (scale || 1) + ")";
    }

    // Спокойная раскладка до начала: билеты лежат россыпью.
    function idle() {
      drum.classList.remove("kr-spinning");
      drum.classList.add("kr-idle");
      tickets.forEach(function (t, i) { place(t, t.a + 0.3, t.r * 0.9, t.rot, 1); });
    }

    // Розыгрыш: билеты хаотично кружатся, скорость растёт и плавно гаснет;
    // затем остаётся один билет — победитель — и выезжает в центр.
    function spin(durationMs, onTick) {
      drum.classList.remove("kr-idle");
      drum.classList.add("kr-spinning");
      var start = null;
      var lastSwap = 0;
      return new Promise(function (resolve) {
        function frame(now) {
          if (start == null) start = now;
          var p = Math.min((now - start) / durationMs, 1);
          // огибающая скорости: быстрый разгон, ровный ход, плавное торможение
          var env = p < 0.12 ? p / 0.12 : p < 0.55 ? 1 : Math.pow(1 - (p - 0.55) / 0.45, 2);
          var time = (now - start) / 1000;
          var drumAngle = 7 * time * (0.35 + env);
          tickets.forEach(function (t) {
            var chaos = env * 28;
            var angle = t.a + drumAngle * t.w + Math.sin(time * 3 + t.ph) * 0.4 * env;
            var r = t.r + Math.sin(time * 4.3 * t.w + t.ph) * chaos;
            place(t, angle, Math.max(20, r), t.rot + Math.sin(time * 6 + t.ph) * 70 * env + time * 90 * t.w * env, 1);
          });
          if (now - lastSwap > 80 + (1 - env) * 260) {
            lastSwap = now;
            tickets[Math.floor(Math.random() * TICKETS)].el.textContent = randomName();
          }
          if (onTick) onTick(p);
          if (p < 1) requestAnimationFrame(frame); else resolve();
        }
        requestAnimationFrame(frame);
      });
    }

    // Показываем победителя крупно в центре, остальные билеты гаснут.
    function reveal(winner, first) {
      var pick = tickets[0].el;
      if (first) {
        tickets.slice(1).forEach(function (t) { t.el.style.transition = "opacity .5s"; t.el.style.opacity = "0"; });
      }
      pick.style.transition = "transform .6s cubic-bezier(.2,1.3,.4,1), opacity .3s";
      pick.classList.remove("kr-ghost");
      pick.classList.add("kr-pick");
      pick.textContent = shortName(winner);
      var c = drum.clientWidth / 2 || 122;
      pick.style.transform = "translate(" + c + "px," + c + "px) rotate(0deg) scale(1.9)";
    }

    return { wrap: wrap, drum: drum, idle: idle, spin: spin, reveal: reveal };
  }

  // ---- Экран 2: розыгрыш --------------------------------------------------------

  function startRaffle() {
    var ev = currentEvent();
    if (!ev || !state.participants || state.busy) return;
    state.busy = true;
    state.error = null;
    var total = state.participants.length;
    var count = state.winnersCount;

    var drum = buildDrum(state.participants);
    var caption = h("p", { class: "kr-drum-caption", text: "1 из " + total + " " + plural(total, "участника", "участников", "участников") });
    var segDisabled = h("div", { class: "kr-seg" }, [1, 2, 3].map(function (n) {
      return h("button", { type: "button", text: String(n), disabled: true, "aria-pressed": String(n === count) });
    }));
    show([
      h("h1", { text: "Розыгрыш билета" }),
      h("label", { class: "kr-label", text: "Мероприятие" }),
      h("div", { class: "kr-select", text: ev.title, style: "display:flex;align-items:center;" }),
      h("div", { class: "kr-stat" }, [
        h("div", { class: "kr-stat-num" }, [String(total), h("small", { text: plural(total, "участник", "участника", "участников") })]),
        h("div", { class: "kr-stat-note", text: "Имя + username" })
      ]),
      h("p", { class: "kr-q", text: "Сколько победителей?" }),
      segDisabled,
      drum.wrap,
      h("p", { class: "kr-drum-title", text: count > 1 ? "Выбираем победителей…" : "Выбираем победителя…" }),
      caption,
      h("button", { class: "kr-btn", type: "button", disabled: true, text: "Барабан крутится" })
    ]);

    var duration = reduceMotion ? 900 : 5200;
    var request = api("/api/randomizer/draw", { method: "POST", body: { eventId: ev.id, winners: count } });
    var spinning = drum.spin(duration, function (p) {
      if (p < 1) caption.textContent = Math.max(1, Math.min(total, Math.round(1 + Math.random() * (total - 1)))) + " из " + total + " " + plural(total, "участника", "участников", "участников");
    });

    Promise.all([request, spinning]).then(function (res) {
      var result = res[0];
      var chain = Promise.resolve();
      result.winners.forEach(function (w, i) {
        chain = chain.then(function () {
          drum.reveal(w, i === 0);
          caption.textContent = result.winners.length > 1 ? "Победитель " + (i + 1) + ": " + w.name : w.name;
          return new Promise(function (r) { setTimeout(r, reduceMotion ? 300 : 1100); });
        });
      });
      return chain.then(function () { state.busy = false; renderWinners(result); });
    }).catch(function (e) {
      state.busy = false;
      state.error = errorText(e);
      renderPrep();
    });
  }

  // ---- Экран 3: победитель ------------------------------------------------------

  function congratsText(title) {
    return "Поздравляем с победой в розыгрыше билета на «" + title + "»!";
  }

  function sendCongrats(winner, title) {
    if (!winner.username) return;
    var url = "https://t.me/" + winner.username + "?text=" + encodeURIComponent(congratsText(title));
    if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, "_blank");
  }

  function confetti() {
    if (reduceMotion) return null;
    var box = h("div", { class: "kr-confetti" });
    var colors = ["#296ef7", "#eb344a", "#296ef7", "#eb344a", "#ffb800"];
    for (var i = 0; i < 46; i++) {
      var piece = h("i");
      piece.style.left = (Math.random() * 100).toFixed(1) + "%";
      piece.style.background = colors[i % colors.length];
      piece.style.animationDuration = (2.4 + Math.random() * 2.4).toFixed(2) + "s";
      piece.style.animationDelay = (Math.random() * 0.8).toFixed(2) + "s";
      box.appendChild(piece);
    }
    return box;
  }

  function renderWinners(result) {
    setBack(null);
    var title = result.event.title;
    var many = result.winners.length > 1;
    var nodes = [
      h("h1", { text: many ? "Победители выбраны" : "Победитель выбран" }),
      h("p", { class: "kr-win-event", text: title }),
      h("p", { class: "kr-win-sub", text: result.total + " " + plural(result.total, "участник", "участника", "участников") + " • " + result.winners.length + " " + plural(result.winners.length, "победитель", "победителя", "победителей") })
    ];
    result.winners.forEach(function (w, i) {
      var send = h("button", { class: "kr-btn", type: "button", disabled: !w.username, onclick: function () { sendCongrats(w, title); } }, [
        w.username ? h("span", { class: "kr-plane" }) : null,
        w.username ? "Отправить поздравление" : "Нет @username — напишите вручную"
      ]);
      if (w.username) send.firstChild.innerHTML = TICKET_PLANE;
      var card = h("div", { class: "kr-card", style: "animation-delay:" + (i * 0.25) + "s" }, [
        h("div", { class: "kr-badge", text: many ? "Победитель " + (i + 1) : "Победитель" }),
        h("div", { class: "kr-avatar", text: initials(w.name) }),
        h("div", { class: "kr-win-name", text: w.name }),
        w.username ? h("div", { class: "kr-win-user", text: "@" + w.username }) : null
      ]);
      if (many) card.appendChild(send);
      nodes.push(card);
      w._send = send;
    });
    nodes.push(h("p", { class: "kr-prize", text: "Твой приз — билет на мероприятие" }));
    var congrats = h("div", { class: "kr-congrats" }, [
      h("h2", { text: "Поздравление" }),
      h("small", { text: "Отправитель: @Kodrosta" }),
      h("div", { class: "kr-msg", text: congratsText(title) })
    ]);
    nodes.push(congrats);
    if (!many) nodes.push(result.winners[0]._send);
    else nodes.push(h("p", { class: "kr-hint", text: "Кнопка у каждого победителя откроет чат с готовым текстом" }));
    nodes.push(h("div", { class: "kr-center" }, [
      h("button", { class: "kr-link", type: "button", text: "Посмотреть участников", onclick: function () { renderParticipants(function () { renderWinners(result); }); } }),
      h("br"),
      h("button", { class: "kr-link", type: "button", text: "Новый розыгрыш", onclick: function () { renderPrep(); } })
    ]));
    show(nodes);
    var conf = confetti();
    if (conf) main.appendChild(conf);
  }

  // ---- Участники и история ------------------------------------------------------

  function renderParticipants(back) {
    var list = state.participants || [];
    setBack(back);
    show([
      h("button", { class: "kr-back", type: "button", text: "← Назад", onclick: back }),
      h("h1", { text: "Участники" }),
      h("p", { class: "kr-win-sub", text: (currentEvent() ? currentEvent().title + " • " : "") + list.length + " " + plural(list.length, "человек", "человека", "человек") }),
      h("ul", { class: "kr-list" }, list.map(function (p, i) {
        return h("li", {}, [h("i", { text: String(i + 1) }), h("b", { text: p.name }), p.username && p.name !== "@" + p.username ? h("span", { text: "@" + p.username }) : null]);
      }))
    ]);
  }

  var MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

  function formatWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var f = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
    var get = function (t) { return (f.filter(function (x) { return x.type === t; })[0] || {}).value || ""; };
    return get("day") + " " + MONTHS[Number(get("month")) - 1] + ", " + get("hour") + ":" + get("minute");
  }

  function renderHistory() {
    setBack(renderPrep);
    show([
      h("button", { class: "kr-back", type: "button", text: "← Назад", onclick: renderPrep }),
      h("h1", { text: "История розыгрышей" }),
      h("div", { class: "kr-state", text: "Загружаем…" })
    ]);
    api("/api/randomizer/history").then(function (d) {
      var body = d.raffles.length ? d.raffles.map(function (r) {
        return h("div", { class: "kr-hist" }, [
          h("b", { text: r.eventTitle }),
          h("small", { text: formatWhen(r.createdAt) + " • участников: " + r.total }),
          h("div", {}, r.winners.map(function (w, i) {
            return h("div", {}, [(i + 1) + ". " + w.name + " ", w.username ? h("span", { text: "@" + w.username }) : null]);
          }))
        ]);
      }) : [h("div", { class: "kr-state", text: "Розыгрышей пока не было" })];
      show([h("button", { class: "kr-back", type: "button", text: "← Назад", onclick: renderPrep }), h("h1", { text: "История розыгрышей" })].concat(body));
    }).catch(function (e) {
      show([h("button", { class: "kr-back", type: "button", text: "← Назад", onclick: renderPrep }), h("p", { class: "kr-error", text: errorText(e) })]);
    });
  }

  // ---- Старт ---------------------------------------------------------------------

  function init() {
    if (!initData) {
      show([h("h1", { text: "Рандомайзер" }), h("div", { class: "kr-state", text: errorText({ code: "no_auth" }) })]);
      return;
    }
    show([h("h1", { text: "Розыгрыш билета" }), h("div", { class: "kr-state", text: "Загружаем события…" })]);
    api("/api/randomizer/events").then(function (d) {
      state.events = d.events;
      // по умолчанию — ближайшее будущее событие, иначе самое свежее прошедшее
      state.eventId = d.events.length ? d.events[0].id : null;
      loadParticipants();
    }).catch(function (e) {
      if (window.console) console.error(e);
      show([h("h1", { text: "Рандомайзер" }), h("p", { class: "kr-error", text: errorText(e) })]);
    });
  }

  init();
})();
