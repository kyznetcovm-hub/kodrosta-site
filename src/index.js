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
      ctx.waitUntil(runScheduledSubscriptionCheck(env));
    } else {
      ctx.waitUntil(runScheduledSheetSync(env));
    }
  }
};

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

async function runScheduledSheetSync(env) {
  let report;
  try {
    report = await syncResidentsFromSheet(env);
  } catch (err) {
    report = "Синхронизация с таблицей упала с ошибкой: " + (err && err.message ? err.message : String(err));
  }
  const admins = String(env.ADMIN_USERNAMES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  await sendToAdminsByUsername(env, admins, report);
}

async function runScheduledSubscriptionCheck(env) {
  if (!env.DB) return;
  let report;
  try {
    report = await checkExpiringSubscriptions(env);
  } catch (err) {
    report = "Проверка абонементов упала с ошибкой: " + (err && err.message ? err.message : String(err));
  }
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

function toICSDate(iso) {
  return iso.replace(/[-:]/g, "").split(".")[0];
}

async function handleCalendarFeed(env) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Код Роста//Calendar//RU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Код Роста — мероприятия",
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H"
  ];
  const events = env.DB ? await listUpcomingEvents(env.DB) : [];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + e.id + "@codrosta.club",
      "DTSTART:" + toICSDate(e.start),
      "DTEND:" + toICSDate(e.end),
      "SUMMARY:" + e.title,
      "LOCATION:" + e.place,
      "DESCRIPTION:" + e.description.replace(/,/g, "\\,"),
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n"), {
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
  const type = data.type === "event" ? "event" : "apply";

  if (!name || !phone || !telegram) {
    return json({ ok: false, error: "validation" }, 400);
  }

  let text;
  if (type === "apply") {
    const company = String(data.company || "").trim();
    const comment = String(data.comment || "").trim();
    text =
      "📝 Заявка на вступление\n\n" +
      "Имя: " + name + "\n" +
      "Телефон: " + phone + "\n" +
      "Telegram: " + telegram + "\n" +
      "Компания/сфера: " + (company || "—") + "\n" +
      "Комментарий: " + (comment || "—");
  } else {
    const event = String(data.event || "").trim();
    const comment = String(data.comment || "").trim();
    text =
      "📅 Запись на мероприятие\n\n" +
      "Мероприятие: " + (event || "—") + "\n" +
      "Имя: " + name + "\n" +
      "Telegram: " + telegram + "\n" +
      "Телефон: " + phone + "\n" +
      "Комментарий: " + (comment || "—");
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
    kind: type === "apply" ? "apply" : "event_signup",
    note: type === "apply" ? null : String(data.event || "").trim() || null,
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
