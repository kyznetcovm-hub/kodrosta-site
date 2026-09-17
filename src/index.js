// Worker-точка входа: раздаёт статику сайта, обрабатывает POST /api/submit
// (пересылка заявок в Telegram-группу через бота), отдаёт живой фид
// GET /calendar.ics для подписки на календарь (iPhone/Android) и GET /api/events
// для клиентского рендера списка мероприятий. Мероприятия хранятся в D1
// (см. events-store.js) — публикуются через Telegram-бота, см. engagement.js.
// BOT_TOKEN и CHAT_ID заданы как секреты проекта в Cloudflare (см. README).

import { handleTelegramUpdate, recordFormTouch } from "./engagement.js";
import { listUpcomingEvents } from "./events-store.js";
import { getAllContent } from "./content-store.js";
import { syncResidentsFromSheet } from "./sheets-sync.js";
import { checkExpiringSubscriptions } from "./subscriptions.js";
import { buildMetrikaDigest, fetchBlogViews } from "./metrika.js";

const SITE_URL = "https://codrosta.club";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }

    if (url.pathname === "/api/telegram-webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    if (url.pathname === "/api/events" && request.method === "GET") {
      return handleEventsApi(env);
    }

    if (url.pathname === "/api/content" && request.method === "GET") {
      return handleContentApi(env);
    }

    if (url.pathname === "/api/metrika" && request.method === "GET") {
      return handleMetrikaReport(url, env);
    }

    if (url.pathname === "/api/views" && request.method === "GET") {
      return handleBlogViews(url, env, ctx);
    }

    if (url.pathname === "/calendar.ics" && (request.method === "GET" || request.method === "HEAD")) {
      return handleCalendarFeed(env);
    }

    return env.ASSETS.fetch(request);
  },

  // См. triggers.crons в wrangler.jsonc: 03:00 UTC — синхронизация вкладки
  // «Вступившие» гугл-таблицы с базой резидентов (отчёт — всем админам);
  // 05:00 UTC — напоминание об абонементах, истекающих через неделю
  // (отчёт — только SUBSCRIPTION_ALERT_USERNAME, вручную кнопкой в меню
  // может вызвать любой админ себе, см. src/engagement.js).
  async scheduled(event, env, ctx) {
    if (event.cron === "0 5 * * *") {
      ctx.waitUntil(runScheduledSubscriptionCheck(env, event.cron));
    } else if (event.cron === "0 6 * * 1") {
      ctx.waitUntil(runScheduledMetrikaDigest(env, event.cron));
    } else {
      ctx.waitUntil(runScheduledSheetSync(env, event.cron));
    }
  }
};

// Пишем в D1 факт срабатывания cron — иначе, если Cloudflare почему-то не
// вызовет триггер (или вызовет не в то время), это невозможно будет
// обнаружить без доступа к живым логам Worker'а. Смотреть:
// SELECT * FROM cron_runs ORDER BY ran_at DESC LIMIT 20; в консоли D1.
async function logCronRun(env, cron, job, note) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("INSERT INTO cron_runs (cron, job, ran_at, note) VALUES (?, ?, ?, ?)")
      .bind(cron || "?", job, new Date().toISOString(), note ?? null)
      .run();
  } catch (err) {
    console.error("logCronRun failed", err);
  }
}

// Понедельник 06:00 UTC = 09:00 по Казани — сводка по Метрике за прошедшую
// неделю в личку всем админам (как отчёт синхронизации таблицы).
async function runScheduledMetrikaDigest(env, cron) {
  if (!env.METRIKA_TOKEN) {
    await logCronRun(env, cron, "metrika_digest", "METRIKA_TOKEN не задан — пропущено");
    return;
  }
  let report;
  try {
    const digest = await buildMetrikaDigest(env);
    report = digest.text;
  } catch (err) {
    report = "Еженедельный отчёт по Метрике упал с ошибкой: " + (err && err.message ? err.message : String(err));
  }
  await logCronRun(env, cron, "metrika_digest", "отправлено");
  const admins = String(env.ADMIN_USERNAMES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  await sendToAdminsByUsername(env, admins, report);
}

// Закрытый эндпоинт: GET /api/metrika?key=METRIKA_REPORT_KEY — те же данные
// в JSON, чтобы смотреть цифры вручную/из другого инструмента. Без ключа или
// с неверным ключом — 403, наружу ничего не отдаём.
async function handleMetrikaReport(url, env) {
  const key = url.searchParams.get("key") || "";
  if (!env.METRIKA_REPORT_KEY || key.length !== env.METRIKA_REPORT_KEY.length || key !== env.METRIKA_REPORT_KEY) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  if (!env.METRIKA_TOKEN) {
    return json({ ok: false, error: "not_configured" }, 500);
  }
  try {
    const digest = await buildMetrikaDigest(env);
    return json({ ok: true, ...digest });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) }, 502);
  }
}

// Публичный счётчик просмотров статей блога. Числа берём из Яндекс.Метрики
// (метрика ym:pv:pageviews по URL страницы), кешируем на 1 час через Cache API,
// чтобы не дёргать API Метрики на каждый заход и не упираться в её лимиты.
// GET /api/views            -> { ok, views: { "<slug>": N, ... } }
// GET /api/views?slug=<...>  -> { ok, slug, views: N }
async function handleBlogViews(url, env, ctx) {
  const slug = (url.searchParams.get("slug") || "").trim();

  if (!env.METRIKA_TOKEN) {
    return json({ ok: false, error: "not_configured", views: slug ? 0 : {} });
  }

  const cache = caches.default;
  const cacheKey = new Request("https://cache.codrosta.club/__blog_views_v1");
  let map = null;

  const hit = await cache.match(cacheKey);
  if (hit) {
    try { map = await hit.json(); } catch (e) { map = null; }
  }

  if (!map) {
    try {
      map = await fetchBlogViews(env);
    } catch (err) {
      // Метрика недоступна/лимит — тихо отдаём пусто, счётчик на странице просто не покажется
      return json({ ok: false, error: String(err && err.message ? err.message : err), views: slug ? 0 : {} });
    }
    const toCache = new Response(JSON.stringify(map), {
      headers: { "content-type": "application/json", "cache-control": "max-age=3600" },
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));
  }

  if (slug) {
    return json({ ok: true, slug, views: Number(map[slug] || 0) });
  }
  return json({ ok: true, views: map });
}

async function sendToAdminsByUsername(env, usernames, text) {
  if (!env.DB || !env.BOT_TOKEN || !usernames.length) return;
  const placeholders = usernames.map(() => "?").join(",");
  const stmt = env.DB.prepare(
    "SELECT chat_id FROM residents WHERE telegram_username IN (" + placeholders + ") AND chat_id IS NOT NULL"
  );
  const { results } = await stmt.bind.apply(stmt, usernames).all();
  for (const r of results || []) {
    await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: r.chat_id, text: text, parse_mode: "HTML" })
    });
  }
}

async function runScheduledSheetSync(env, cron) {
  let report;
  try {
    report = await syncResidentsFromSheet(env);
  } catch (err) {
    report = "Синхронизация с таблицей упала с ошибкой: " + (err && err.message ? err.message : String(err));
  }
  await logCronRun(env, cron, "sheet_sync", "отправлено");
  const admins = String(env.ADMIN_USERNAMES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  await sendToAdminsByUsername(env, admins, report);
}

async function runScheduledSubscriptionCheck(env, cron) {
  if (!env.DB) return;
  let report;
  try {
    report = await checkExpiringSubscriptions(env);
  } catch (err) {
    report = "Проверка абонементов упала с ошибкой: " + (err && err.message ? err.message : String(err));
  }
  await logCronRun(env, cron, "subscriptions", report ? "отправлено" : "никого не найдено — не отправлено");
  if (!report) return; // ни у кого через неделю абонемент не заканчивается — молчим, не спамим
  const username = String(env.SUBSCRIPTION_ALERT_USERNAME || "").trim().toLowerCase();
  await sendToAdminsByUsername(env, username ? [username] : [], report);
}

async function handleContentApi(env) {
  if (!env.DB) return json({});
  const content = await getAllContent(env.DB);
  return new Response(JSON.stringify(content), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
  });
}

async function handleEventsApi(env) {
  if (!env.DB) return json([]);
  const events = await listUpcomingEvents(env.DB);
  return new Response(JSON.stringify(events), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
  });
}

async function handleTelegramWebhook(request, env) {
  let update;
  try {
    update = await request.json();
  } catch (e) {
    return json({ ok: false }, 400);
  }
  try {
    await handleTelegramUpdate(update, env);
  } catch (err) {
    console.error("handleTelegramUpdate failed", err);
  }
  return json({ ok: true });
}

// Время события хранится как локальное для Казани/Москвы (MSK, UTC+3, без
// перехода на летнее время). Отдаём в календарь в UTC с суффиксом "Z" —
// это понимает любой клиент без VTIMEZONE-блока (плавающее время без зоны
// строгие парсеры, в т.ч. Google Календарь, разбирают непредсказуемо).
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function fmtICSUTC(d) {
  const ok = isNaN(d.getTime()) ? new Date() : d;
  return ok.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// Момент из произвольного ISO (например created_at с "Z") -> "...Z".
function toICSDateUTC(iso) {
  return fmtICSUTC(iso ? new Date(iso) : new Date());
}

// Местное MSK-время события ("2026-09-15T16:00:00" без зоны) как настоящий
// момент в UTC. Возвращает Date; NaN — если строку не разобрать.
function mskLocalToDate(iso) {
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return new Date(NaN);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - MSK_OFFSET_MS);
}

// Экранирование значения TEXT-поля iCalendar (RFC 5545 §3.3.11):
// обратный слэш, точка с запятой, запятая и перевод строки.
function icsEscapeText(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function utf8Len(ch) {
  const c = ch.codePointAt(0);
  return c <= 0x7f ? 1 : c <= 0x7ff ? 2 : c <= 0xffff ? 3 : 4;
}

// Складывание длинных строк (RFC 5545 §3.1): физическая строка — не длиннее
// 75 октетов, продолжение начинается с пробела. Считаем именно байты UTF-8
// и не разрываем многобайтовый символ (важно для кириллицы — строгие
// парсеры, в т.ч. Google Календарь, иначе молча отбрасывают событие).
function icsFoldLine(line) {
  const chars = Array.from(line);
  let segs = [], cur = "", curBytes = 0;
  for (const ch of chars) {
    const b = utf8Len(ch);
    if (curBytes + b > 73) { segs.push(cur); cur = ""; curBytes = 0; }
    cur += ch;
    curBytes += b;
  }
  segs.push(cur);
  return segs.join("\r\n ");
}

// Ссылка «записаться» для конкретного мероприятия: внешняя форма, если она
// указана при публикации, иначе — страница сайта с открытой формой записи.
function eventRegisterLink(e) {
  if (e.registerUrl && /^https?:\/\//.test(e.registerUrl)) return e.registerUrl;
  return SITE_URL + "/?e=" + e.id;
}

async function handleCalendarFeed(env) {
  const events = env.DB ? await listUpcomingEvents(env.DB) : [];

  const props = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Код Роста//Calendar//RU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Код Роста — мероприятия",
    "X-WR-TIMEZONE:Europe/Moscow",
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    "X-PUBLISHED-TTL:PT12H"
  ];

  for (const e of events) {
    const regLink = eventRegisterLink(e);
    const startDate = mskLocalToDate(e.start);
    let endDate = mskLocalToDate(e.end);
    // Часть событий в базе сохранена с одинаковым началом и концом (в тексте
    // было одно время, не диапазон) — событие нулевой длительности некоторые
    // клиенты не показывают. Даём таким два часа по умолчанию.
    if (isNaN(endDate.getTime()) || endDate.getTime() <= startDate.getTime()) {
      endDate = new Date(startDate.getTime() + 2 * 3600000);
    }

    const body = (e.fullDescription && e.fullDescription.length
      ? e.fullDescription.join("\n\n")
      : e.description) || "";
    // Ссылка на запись — прямо в описании: попав в календарь человека,
    // событие само ведёт на регистрацию, не нужно вспоминать и искать сайт.
    const description = body
      + "\n\nЗаписаться на мероприятие: " + regLink
      + "\nО клубе: " + SITE_URL;

    props.push(
      "BEGIN:VEVENT",
      "UID:" + e.id + "@codrosta.club",
      "DTSTAMP:" + toICSDateUTC(e.createdAt),
      "DTSTART:" + fmtICSUTC(startDate),
      "DTEND:" + fmtICSUTC(endDate),
      "SUMMARY:" + icsEscapeText(e.title),
      "LOCATION:" + icsEscapeText(e.place),
      "DESCRIPTION:" + icsEscapeText(description),
      "URL:" + regLink,
      "STATUS:CONFIRMED",
      "SEQUENCE:0",
      "END:VEVENT"
    );
  }
  props.push("END:VCALENDAR");

  const ics = props.map(icsFoldLine).join("\r\n") + "\r\n";

  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="kodrosta-events.ics"',
      "cache-control": "public, max-age=1800"
    }
  });
}

async function handleSubmit(request, env) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  // honeypot — боты заполняют скрытое поле, людям оно не видно
  if (data.website) {
    return json({ ok: true });
  }

  const name = String(data.name || "").trim();
  const phone = String(data.phone || "").trim();
  const telegram = String(data.telegram || "").trim();
  const type = data.type === "event" ? "event" : data.type === "exit_popup" ? "exit_popup" : "apply";

  // exit_popup даёт выбор канала связи (Telegram/MAX/WhatsApp) — Telegram-username
  // обязателен, только если выбран сам Telegram; для MAX/WhatsApp достаточно телефона.
  const CHANNELS = { telegram: "Telegram", max: "MAX", whatsapp: "WhatsApp" };
  const channel = type === "exit_popup" && CHANNELS[data.channel] ? data.channel : "telegram";

  if (!name || !phone || (channel === "telegram" && !telegram)) {
    return json({ ok: false, error: "validation" }, 400);
  }

  // Промокод из exit-popup "долетает" сюда с СЛЕДУЮЩЕЙ заявкой (apply/event), если
  // пользователь сначала получил скидку в pop-up, а потом отправил основную форму —
  // см. STORAGE_PROMO_PENDING в js/exit-popup.js и main.js.
  const promo = String(data.promo || "").trim();
  const promoLine = promo ? "\nПромокод: " + promo : "";

  let text;
  let touchNote;
  if (type === "apply") {
    const company = String(data.company || "").trim();
    const comment = String(data.comment || "").trim();
    // objectType/city — поля формы вступления на странице направления «Туризм»
    // (codrosta.club/turizm), на основной форме вступления их нет.
    const objectType = String(data.objectType || "").trim();
    const city = String(data.city || "").trim();
    text =
      "📝 Заявка на вступление\n\n" +
      "Имя: " + name + "\n" +
      "Телефон: " + phone + "\n" +
      "Telegram: " + telegram + "\n" +
      (objectType ? "Тип объекта: " + objectType + "\n" : "") +
      (city ? "Город: " + city + "\n" : "") +
      "Компания/сфера: " + (company || "—") + "\n" +
      "Комментарий: " + (comment || "—") + promoLine;
    touchNote = promo || null;
  } else if (type === "event") {
    const event = String(data.event || "").trim();
    const comment = String(data.comment || "").trim();
    text =
      "📅 Запись на мероприятие\n\n" +
      "Мероприятие: " + (event || "—") + "\n" +
      "Имя: " + name + "\n" +
      "Telegram: " + telegram + "\n" +
      "Телефон: " + phone + "\n" +
      "Комментарий: " + (comment || "—") + promoLine;
    touchNote = event || promo || null;
  } else {
    // exit_popup — заявка со скидкой из exit-intent pop-up (см. js/exit-popup.js).
    // Источник перехода важен: пользователь приходит по QR с рекламного баннера.
    const source = String(data.source || "").trim();
    const utmSource = String(data.utm_source || "").trim();
    const utmMedium = String(data.utm_medium || "").trim();
    const utmCampaign = String(data.utm_campaign || "").trim();
    const utmContent = String(data.utm_content || "").trim();
    const utmTerm = String(data.utm_term || "").trim();
    const landingPage = String(data.landing_page || "").trim();
    const offer = String(data.offer || "").trim();
    const channelLabel = CHANNELS[channel];
    text =
      "🎁 Заявка со скидкой (exit pop-up)\n\n" +
      "Имя: " + name + "\n" +
      "Телефон: " + phone + "\n" +
      "Канал связи: " + channelLabel + (channel === "telegram" && telegram ? " (" + telegram + ")" : "") + "\n" +
      "Скидка: " + (offer ? offer + " ₽" : "—") + promoLine + "\n" +
      "Источник: " + (source || "—") + "\n" +
      "UTM: source=" + (utmSource || "—") + " medium=" + (utmMedium || "—") + " campaign=" + (utmCampaign || "—") +
        " content=" + (utmContent || "—") + " term=" + (utmTerm || "—") + "\n" +
      "Страница: " + (landingPage || "—");
    touchNote =
      "channel=" + channel + "; utm_source=" + (utmSource || "-") + "; utm_medium=" + (utmMedium || "-") +
      "; utm_campaign=" + (utmCampaign || "-") + (promo ? "; promo=" + promo : "");
  }

  if (!env.BOT_TOKEN || !env.CHAT_ID) {
    return json({ ok: false, error: "not_configured" }, 500);
  }

  const tgResp = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.CHAT_ID, text: text })
  });

  if (!tgResp.ok) {
    return json({ ok: false, error: "telegram_failed" }, 502);
  }

  await recordFormTouch(env, {
    phone,
    telegramHandle: telegram,
    kind: type === "apply" ? "apply" : type === "event" ? "event_signup" : "exit_popup",
    note: touchNote,
    name,
  });

  return json({ ok: true });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json" }
  });
}
