// Напоминание об окончании абонемента резидента — за неделю до даты из
// столбца «Дата окончания» гугл-таблицы «Вступившие» (см. src/sheets-sync.js,
// который эту дату кладёт в residents.subscription_end при синхронизации).
// Вызывается и по расписанию (раз в сутки, src/index.js), и вручную —
// кнопкой «Абонементы» в админ-меню (src/engagement.js).

function isoDatePlusDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatRuDate(iso) {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

// Возвращает null, если ни у кого через неделю абонемент не заканчивается —
// вызывающий код (и по расписанию, и по кнопке) в этом случае ничего не шлёт.
export async function checkExpiringSubscriptions(env) {
  const targetDate = isoDatePlusDays(7);
  const { results } = await env.DB
    .prepare("SELECT full_name, telegram_username, subscription_end FROM residents WHERE active = 1 AND subscription_end = ? ORDER BY full_name")
    .bind(targetDate)
    .all();

  if (!results.length) return null;

  const lines = [`<b>Абонементы — истекают через неделю</b>`, ""];
  results.forEach((r, i) => {
    const username = r.telegram_username ? "@" + r.telegram_username : "—";
    lines.push(`${i + 1}. ${r.full_name} / ${username} / ${formatRuDate(r.subscription_end)}`);
  });
  return lines.join("\n");
}
