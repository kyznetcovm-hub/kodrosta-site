// Регламент продления: источник истины — вкладка «Вступившие».
const DAY = 86400000;
const clean = (value) => String(value ?? "").trim();
export const escapeHtml = (value) => clean(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function moscowDate(now = new Date()) {
  return new Date(new Date(now).getTime() + 3 * 3600000).toISOString().slice(0, 10);
}

export function plusDays(date, days) {
  return new Date(Date.parse(date + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10);
}

export function isMonthEnd(date) {
  return plusDays(date, 1).slice(0, 7) !== date.slice(0, 7);
}

export function parseSubscriptionDate(value) {
  if (!clean(value)) return null;
  let iso;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 1 || value > 2958465) return null;
    iso = new Date((Math.floor(value) - 25569) * DAY).toISOString().slice(0, 10);
  } else {
    const text = clean(value);
    const match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    iso = match ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}` : text;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(iso + "T00:00:00Z");
  return !isNaN(date) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

export function isRefusal(status) {
  // «отказ 22.09», «ОТКАЗ (причина)» тоже отказ; «не отказ», «отказался?» — нет.
  return /^отказ(?:$|[\s.,:;!()—–-])/iu.test(clean(status));
}

export function parseSubscriptionRows(rows) {
  const header = (rows[0] || []).map((v) => clean(v).toLowerCase().replace(/\s+/g, " "));
  const expected = ["дата начала", "дата окончания", "дата продления", "дата окончания", "статус"];
  if (!expected.every((name, i) => header[i + 1] === name)) {
    throw new Error("Изменилась структура «Вступившие»: проверьте колонки B–F (даты и статус)");
  }
  const nameCol = header.indexOf("фио");
  const tgCol = header.findIndex((v) => v.includes("телеграм"));
  if (nameCol < 0 || tgCol < 0) throw new Error("В таблице не найдены ФИО / Телеграм username");
  const residents = [], issues = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.some((v) => /^(ПОТЕНЦИАЛЬНЫЕ|ДОЛГИ)(?:\s|$)/u.test(clean(v).toUpperCase()))) break;
    const fullName = clean(row[nameCol]);
    if (!fullName) continue;
    const firstEnd = parseSubscriptionDate(row[2]);
    const renewalEnd = parseSubscriptionDate(row[4]);
    const renewalStart = parseSubscriptionDate(row[3]);
    // Заполненное, но ошибочное продление не должно оживлять старую дату C.
    let issue = null;
    if (clean(row[4]) && !renewalEnd) issue = "неверная дата окончания в E";
    else if (clean(row[3]) && !renewalEnd) issue = "заполнено продление D, но нет даты окончания E";
    else if (clean(row[3]) && !renewalStart) issue = "неверная дата продления в D";
    else if (renewalStart && renewalEnd < renewalStart) issue = "дата E раньше начала продления D";
    else if (!renewalEnd && clean(row[2]) && !firstEnd) issue = "неверная дата окончания в C";
    if (issue) { issues.push(`Строка ${i + 1}: ${issue}`); continue; }
    // Если есть два периода, действует более поздняя дата окончания.
    const subscriptionEnd = [firstEnd, renewalEnd].filter(Boolean).sort().at(-1);
    if (!subscriptionEnd) continue;
    const rawUsername = clean(row[tgCol]).replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
    const telegramUsername = /^(нет|-|—|\?|null|none)$/i.test(rawUsername) ? "" : rawUsername;
    residents.push({ fullName, telegramUsername, subscriptionEnd, refused: isRefusal(row[5]) });
  }
  return { residents, issues };
}

function residentLines(residents) {
  return [...residents].sort((a, b) => a.fullName.localeCompare(b.fullName, "ru")).map((r, i) => {
    const date = r.subscriptionEnd.split("-").reverse().join(".");
    return `${i + 1}. ${escapeHtml(r.fullName)} / ${r.telegramUsername ? "@" + escapeHtml(r.telegramUsername) : "—"} / ${date}`;
  }).join("\n");
}

export function buildSubscriptionReports(rows, date = moscowDate()) {
  const { residents, issues } = parseSubscriptionRows(rows);
  const stages = [
    [7, "НЕДЕЛЯ — истекают через неделю"],
    [1, "ДЕНЬ — истекают через сутки"],
    [-1, "СМС — прошли сутки с момента окончания"],
    [-3, "ЗВОНОК — прошло три дня с момента окончания"],
  ];
  const sections = stages.flatMap(([days, title]) => {
    const matches = residents.filter((r) => !r.refused && r.subscriptionEnd === plusDays(date, days));
    return matches.length ? [`<b>${title}</b>\n\n${residentLines(matches)}`] : [];
  });
  const warning = issues.length ? "⚠️ Проверьте даты в таблице — эти строки пропущены:\n" + issues.join("\n") : "";
  if (warning) sections.push(warning);
  const daily = sections.length ? "<b>Абонементы:</b>\n\n" + sections.join("\n\n") : null;
  let final = null;
  if (isMonthEnd(date)) {
    const refused = residents.filter((r) => r.refused && r.subscriptionEnd.slice(0, 7) === date.slice(0, 7));
    final = "<b>ФИНАЛ</b>\n\nАбонементы закончились в текущем месяце, статус — ОТКАЗ.\n\n" +
      (refused.length ? residentLines(refused) : "Таких резидентов нет.");
    if (warning) final += "\n\n" + warning;
  }
  return { daily, final };
}
