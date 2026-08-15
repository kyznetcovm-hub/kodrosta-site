// Cloudflare Pages Function: POST /api/submit
// Принимает данные форм с сайта и пересылает их в Telegram-группу через бота.
// Требует переменные окружения в настройках проекта Cloudflare Pages:
//   BOT_TOKEN — токен бота (Settings → Environment variables, тип Secret)
//   CHAT_ID   — id группы, куда слать сообщения (например -1004298235304)

export async function onRequestPost(context) {
  const { request, env } = context;

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
  const type = data.type === "event" ? "event" : "apply";

  if (!name || !phone) {
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
      "Компания/сфера: " + (company || "—") + "\n" +
      "Комментарий: " + (comment || "—");
  } else {
    const event = String(data.event || "").trim();
    const comment = String(data.comment || "").trim();
    text =
      "📅 Запись на мероприятие\n\n" +
      "Мероприятие: " + (event || "—") + "\n" +
      "Имя: " + name + "\n" +
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

  return json({ ok: true });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json" }
  });
}
