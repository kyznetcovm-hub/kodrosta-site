// Всё, что связано с датой окончания абонемента резидента (столбец «Дата
// окончания» гугл-таблицы «Вступившие» — см. src/sheets-sync.js, который
// эту дату кладёт в residents.subscription_end при синхронизации).
//
// Два независимых сценария:
// - по расписанию раз в сутки (src/index.js) — ровно за неделю до даты
//   окончания, только @Kodrosta;
// - кнопка «Абонементы» в админ-меню (src/engagement.js) — список всех,
//   у кого абонемент заканчивается от сегодня и в течение месяца вперёд,
//   чтобы видеть потенциал продлений на месяц; вызвать может любой админ,
//   отвечает тому, кто нажал.

function isoDatePlusDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatRuDate(iso) {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

function formatSubscriptionList(title, results) {
  const lines = [`<b>${title}</b>`, ""];
  results.forEach((r, i) => {
    const username = r.telegram_username ? "@" + r.telegram_username : "—";
    lines.push(`${i + 1}. ${r.full_name} / ${username} / ${formatRuDate(r.subscription_end)}`);
  });
  return lines.join("\n");
}

// Для рассылки по расписанию — ровно за неделю. Возвращает null, если ни у
// кого абонемент не заканчивается ровно через неделю: вызывающий код в этом
// случае ничего не шлёт (см. runScheduledSubscriptionCheck в src/index.js).
export async function checkExpiringSubscriptions(env) {
  const targetDate = isoDatePlusDays(7);
  const { results } = await env.DB
    .prepare("SELECT full_name, telegram_username, subscription_end FROM residents WHERE active = 1 AND subscription_end = ? ORDER BY full_name")
    .bind(targetDate)
    .all();

  if (!results.length) return null;
  return formatSubscriptionList("Абонементы — истекают через неделю", results);
}

// Для кнопки «Абонементы» — от сегодня и на месяц вперёд, отсортировано по
// дате окончания (ближайшие продления — первые). Возвращает null, если за
// этот месяц ни у кого абонемент не заканчивается.
export async function listSubscriptionsDueThisMonth(env) {
  const today = isoDatePlusDays(0);
  const monthAhead = isoDatePlusDays(30);
  const { results } = await env.DB
    .prepare(
      "SELECT full_name, telegram_username, subscription_end FROM residents " +
      "WHERE active = 1 AND subscription_end BETWEEN ? AND ? ORDER BY subscription_end"
    )
    .bind(today, monthAhead)
    .all();

  if (!results.length) return null;
  return formatSubscriptionList("Абонементы — заканчиваются в течение месяца", results);
}
