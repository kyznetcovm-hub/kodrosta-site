import { readResidentsSheetRows } from "./sheets-sync.js";
import { buildSubscriptionReports, moscowDate, isMonthEnd } from "./subscription-rules.js";

// Совпадает с миграцией 0009; IF NOT EXISTS позволяет обновить Worker до
// ручного применения миграции без потери утреннего отчёта.
const SCHEMA = `CREATE TABLE IF NOT EXISTS subscription_deliveries (
  report_date TEXT NOT NULL, report_kind TEXT NOT NULL, state TEXT NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0, message_id INTEGER,
  PRIMARY KEY (report_date, report_kind)
)`;

async function recipient(env) {
  if (!env.BOT_TOKEN || !env.DB) throw new Error("Не настроены BOT_TOKEN / DB");
  const username = String(env.SUBSCRIPTION_ALERT_USERNAME || "").trim().replace(/^@/, "").toLowerCase();
  if (!username) throw new Error("Не задан получатель уведомлений об абонементах");
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT chat_id FROM residents WHERE LOWER(telegram_username) = ? AND chat_id IS NOT NULL"
  ).bind(username).all();
  if (results.length !== 1) throw new Error("Не найден однозначный чат получателя уведомлений об абонементах");
  return results[0].chat_id;
}

async function sendReport(env, chatId, text, date, kind) {
  let method = "sendMessage", body, headers;
  if (text.length <= 4096) {
    headers = { "content-type": "application/json" };
    body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
  } else {
    // Telegram ограничивает длину текста: большой отчёт остаётся одним
    // сообщением с одним файлом, а не рассыпается на отдельные этапы.
    method = "sendDocument";
    body = new FormData();
    body.set("chat_id", String(chatId));
    body.set("caption", `${kind === "final" ? "ФИНАЛ" : "Абонементы"} — ${date}. Полный отчёт в файле.`);
    const plain = text.replace(/<\/?b>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    body.set("document", new Blob([plain], { type: "text/plain;charset=utf-8" }), `abonementy-${date}-${kind}.txt`);
  }
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers, body, signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok || !Number.isInteger(result.result?.message_id)) {
    throw new Error(`Telegram не подтвердил доставку (${result.error_code || response.status})`);
  }
  return result.result.message_id;
}

export async function runSubscriptionNotifications(env, now = new Date()) {
  const date = moscowDate(now);
  if (!env.DB) throw new Error("Не настроена DB");
  await env.DB.prepare(SCHEMA).run();
  const kinds = isMonthEnd(date) ? ["daily", "final"] : ["daily"];
  const { results } = await env.DB.prepare(
    "SELECT report_kind, state FROM subscription_deliveries WHERE report_date = ?"
  ).bind(date).all();
  const pending = kinds.filter((kind) => !results.some((r) => r.report_kind === kind && r.state === "sent"));
  if (!pending.length) return "уже доставлено";
  const chatId = await recipient(env);
  // Один свежий снимок для обоих отчётов; отказ и продление учитываются сразу.
  const reports = buildSubscriptionReports(await readResidentsSheetRows(env), date);
  const outcomes = [];
  const errors = [];
  for (const kind of pending) {
    const text = reports[kind];
    if (!text) { outcomes.push(`${kind}: нет уведомлений`); continue; }
    const stamp = Date.now();
    const lock = await env.DB.prepare(`
      INSERT INTO subscription_deliveries (report_date, report_kind, state, lease_until)
      VALUES (?, ?, 'sending', ?)
      ON CONFLICT(report_date, report_kind) DO UPDATE SET state = 'sending', lease_until = excluded.lease_until
      WHERE subscription_deliveries.state != 'sent' AND subscription_deliveries.lease_until < ?
    `).bind(date, kind, stamp + 300000, stamp).run();
    if (!lock.meta?.changes) { outcomes.push(`${kind}: уже отправляется/доставлено`); continue; }
    try {
      const messageId = await sendReport(env, chatId, text, date, kind);
      await env.DB.prepare(
        "UPDATE subscription_deliveries SET state = 'sent', message_id = ?, lease_until = 0 WHERE report_date = ? AND report_kind = ?"
      ).bind(messageId, date, kind).run();
      outcomes.push(`${kind}: доставлено`);
    } catch (err) {
      await env.DB.prepare(
        "UPDATE subscription_deliveries SET state = 'failed', lease_until = 0 WHERE report_date = ? AND report_kind = ?"
      ).bind(date, kind).run();
      errors.push(`${kind}: ${err.message}`);
    }
  }
  if (errors.length) throw new Error([...outcomes, ...errors].join("; "));
  return outcomes.join("; ");
}
