// Всё, что связано с датой окончания абонемента резидента (столбец «Дата
// окончания» гугл-таблицы «Вступившие» — см. src/sheets-sync.js, который
// эту дату кладёт в residents.subscription_end при синхронизации).
//
// Сценарии:
// - по расписанию раз в сутки (src/index.js) — ровно за неделю до даты
//   окончания, только @Kodrosta;
// - кнопка «Продление» в админ-меню (src/engagement.js) — список всех,
//   у кого абонемент заканчивается от сегодня и в течение месяца вперёд,
//   чтобы видеть потенциал продлений на месяц; вызвать может любой админ,
//   отвечает тому, кто нажал;
// - кнопки «Новые» и «Ушли» — за текущий календарный месяц (с 1-го числа
//   по сегодня), читают вкладку «Вступившие» напрямую (статуса «отказ» и
//   даты продления в базе нет, см. fetchMembershipRecords);
// - «Отчёт по абонементам» 1-го числа каждого месяца (src/index.js) — за
//   весь прошедший месяц: Ушли / Продлили / Новые, только @Kodrosta.

import { fetchMembershipRecords } from "./sheets-sync.js";

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

// Для кнопки «Продление» — от сегодня и на месяц вперёд, отсортировано по
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
  return formatSubscriptionList("Продление — абонементы заканчиваются в течение месяца", results);
}

// ---- Новые / Ушли / Продлили за календарный месяц -------------------------

// Клуб в Казани — «сегодня» и границы месяца считаем по московскому времени,
// а не по UTC: иначе ночью 1-го числа кнопка показала бы прошлый месяц.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

function mskToday() {
  return new Date(Date.now() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

function isoDate(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

// Текущий месяц: с 1-го числа по сегодня включительно.
function currentMonthToDate() {
  const today = mskToday();
  const [y, m] = today.split("-").map(Number);
  return { from: isoDate(y, m - 1, 1), to: today, label: `${MONTHS_RU[m - 1]} ${y}` };
}

// Календарный месяц целиком: с 1-го по последнее число (monthIndex — 0..11,
// можно выйти за границы: -1 = декабрь прошлого года). Текущий месяц
// обрезается по сегодня — дальше данных всё равно нет.
function monthPeriod(year, monthIndex) {
  const from = isoDate(year, monthIndex, 1);
  const lastDay = isoDate(year, monthIndex + 1, 0); // нулевой день следующего месяца = последний день этого
  const today = mskToday();
  const [y, m] = from.split("-").map(Number);
  return { from, to: lastDay < today ? lastDay : today, label: `${MONTHS_RU[m - 1]} ${y}` };
}

// Прошедший месяц целиком (для отчёта 1-го числа).
function previousMonth() {
  const [y, m] = mskToday().split("-").map(Number);
  return monthPeriod(y, m - 2);
}

// Первый год, за который есть смысл строить отчёт: клуб стартовал в 2023-м
// (первые «Дата начала» во «Вступивших» — октябрь 2023).
export const FIRST_REPORT_YEAR = 2023;

export function currentReportYear() {
  return Number(mskToday().slice(0, 4));
}

// Месяцы выбранного года для кнопок «Отчёт за прошлый период»: для прошлых
// лет — все двенадцать, для текущего — с января по текущий. key («2026-08»)
// уходит в callback_data и обратно в buildSubscriptionReportForMonth.
export function listReportMonths(year = currentReportYear()) {
  const [y, m] = mskToday().split("-").map(Number);
  if (year > y || year < FIRST_REPORT_YEAR) return [];
  const count = year === y ? m : 12;
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = MONTHS_RU[i];
    out.push({ key: `${year}-${String(i + 1).padStart(2, "0")}`, label: name[0].toUpperCase() + name.slice(1) });
  }
  return out;
}

function inRange(iso, period) {
  return Boolean(iso) && iso >= period.from && iso <= period.to;
}

function isRefused(record) {
  return record.status.toLowerCase().includes("отказ");
}

// Новые — «Дата начала» (первый абонемент) попадает в период.
function selectNew(records, period) {
  return records.filter((r) => inRange(r.startDate, period))
    .map((r) => ({ ...r, date: r.startDate }));
}

// Ушли — статус «отказ» и абонемент закончился в этом периоде (последняя из
// дат окончания — если человек успел продлиться, то дата после продления).
function selectLeft(records, period) {
  return records.filter((r) => isRefused(r) && inRange(r.endDate, period))
    .map((r) => ({ ...r, date: r.endDate }));
}

// Продлили — «Дата продления» (начало нового абонемента) попадает в период.
function selectRenewed(records, period) {
  return records.filter((r) => inRange(r.renewalDate, period))
    .map((r) => ({ ...r, date: r.renewalDate }));
}

function formatPeriod(period) {
  return `${formatRuDate(period.from)} – ${formatRuDate(period.to)}`;
}

// showDate = false — только ФИО и username, по алфавиту (так выводим «Ушли»:
// дата окончания там не нужна; в выборку она всё равно попадает — по ней
// решается, относится ли человек к периоду).
function formatRecordLines(items, showDate = true) {
  if (!items.length) return ["— никого"];
  const byName = (a, b) => a.fullName.localeCompare(b.fullName, "ru");
  return items
    .sort(showDate ? (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byName(a, b)) : byName)
    .map((r, i) => {
      const username = r.telegramUsername ? "@" + r.telegramUsername : "—";
      return `${i + 1}. ${r.fullName} / ${username}` + (showDate ? ` / ${formatRuDate(r.date)}` : "");
    });
}

// Для кнопки «Новые». Возвращает null, если в этом месяце никто не вступил.
export async function listNewMembersThisMonth(env) {
  const period = currentMonthToDate();
  const items = selectNew(await fetchMembershipRecords(env), period);
  if (!items.length) return null;
  return [
    `<b>Новые — ${period.label}</b>`,
    `${formatPeriod(period)} · дата начала абонемента`,
    "",
    ...formatRecordLines(items),
  ].join("\n");
}

// Для кнопки «Ушли». Возвращает null, если в этом месяце никто не ушёл.
export async function listLeftMembersThisMonth(env) {
  const period = currentMonthToDate();
  const items = selectLeft(await fetchMembershipRecords(env), period);
  if (!items.length) return null;
  return [
    `<b>Ушли — ${period.label}</b>`,
    `${formatPeriod(period)} · статус «отказ»`,
    "",
    ...formatRecordLines(items, false),
  ].join("\n");
}

// «Отчёт по абонементам» — 1-го числа за весь прошедший месяц. Отправляется
// всегда, даже если все три раздела пустые: отсутствие отчёта 1-го числа
// выглядело бы как поломка.
export async function buildMonthlySubscriptionReport(env) {
  return buildSubscriptionReport(env, previousMonth());
}

// Тот же отчёт за выбранный месяц (кнопка «Отчёт за прошлый период»).
// monthKey — «ГГГГ-ММ»; месяцы из будущего не принимаем. null — ключ кривой.
export async function buildSubscriptionReportForMonth(env, monthKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey || "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const period = monthPeriod(year, month - 1);
  if (period.from > mskToday()) return null;
  return buildSubscriptionReport(env, period);
}

async function buildSubscriptionReport(env, period) {
  const records = await fetchMembershipRecords(env);
  const left = selectLeft(records, period);
  const renewed = selectRenewed(records, period);
  const fresh = selectNew(records, period);
  return [
    `<b>Отчёт по абонементам — ${period.label}</b>`,
    formatPeriod(period),
    "",
    `<b>1. Ушли (${left.length})</b> — не продлили`,
    ...formatRecordLines(left, false),
    "",
    `<b>2. Продлили (${renewed.length})</b> — дата начала нового абонемента`,
    ...formatRecordLines(renewed),
    "",
    `<b>3. Новые (${fresh.length})</b> — дата начала абонемента`,
    ...formatRecordLines(fresh),
  ].join("\n");
}
