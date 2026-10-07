// Деньги для Mini App «Офис в кармане»: ручной ввод продаж и план продаж.
//
// Решения Михаила (8 октября 2026):
// - факт продаж = полученные деньги; каждое поступление вносится отдельной
//   записью в день, когда деньги пришли (частичная оплата — отдельная запись);
// - статьи: новые абонементы, продления, мероприятия, реклама;
// - вносит продажи сотрудница с @Kodrosta (может и Михаил), план задаёт Михаил;
// - недели — пн–вс по Москве, обрезанные границами месяца.
//
// Суммы хранятся в копейках (целые), чтобы не было ошибок округления.
// Ошибочную запись не удаляем, а отменяем: остаётся в журнале с пометкой,
// кто и когда отменил, и не входит в итоги. Повтор отправки той же формы
// (двойное нажатие, потеря сети) не создаёт дубль — по client_id.
//
// Таблицы создаются кодом (ensureMoneyTables), migrations/0011 — для истории.

export const SOURCES = [
  { key: "new", label: "Новые абонементы" },
  { key: "renewal", label: "Продления" },
  { key: "events", label: "Мероприятия" },
  { key: "ads", label: "Реклама" },
];
const SOURCE_KEYS = SOURCES.map((s) => s.key);

const MAX_AMOUNT_KOP = 100000000 * 100; // 100 млн ₽ — защита от опечатки
const MAX_COMMENT = 300;

const tablesReady = new WeakSet();

// кто внёс/изменил — ник без @ в нижнем регистре, как везде в базе бота
function who(user) {
  return user.username ? String(user.username).replace(/^@/, "").toLowerCase() : String(user.id);
}

export async function ensureMoneyTables(db) {
  if (tablesReady.has(db)) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS sales (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "client_id TEXT NOT NULL UNIQUE, " +   // id формы из приложения — защита от повтора
    "sale_date TEXT NOT NULL, " +          // YYYY-MM-DD, день поступления по Москве
    "amount_kop INTEGER NOT NULL, " +
    "source TEXT NOT NULL, " +             // new | renewal | events | ads
    "event_id TEXT, " +                    // для «Мероприятий» — какое событие, если указали
    "comment TEXT, " +
    "created_at TEXT NOT NULL, " +
    "created_by_id INTEGER, " +
    "created_by TEXT, " +                  // username того, кто внёс
    "voided_at TEXT, " +                   // отменена — не входит в итоги
    "voided_by TEXT)"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date)").run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS sales_plans (" +
    "month TEXT NOT NULL, " +              // YYYY-MM
    "scope TEXT NOT NULL, " +              // source:<key> | week:<номер с 1>
    "amount_kop INTEGER NOT NULL, " +
    "updated_at TEXT NOT NULL, " +
    "updated_by TEXT, " +
    "PRIMARY KEY (month, scope))"
  ).run();
  tablesReady.add(db);
}

// ---- Даты -------------------------------------------------------------------

export function moscowDay(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function pad(n) { return String(n).padStart(2, "0"); }

// Недели месяца: пн–вс, обрезанные границами месяца. month — "YYYY-MM".
// Та же сетка, что monthWeeks в js/office.js.
export function monthWeeks(month) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weeks = [];
  let from = 1;
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 — воскресенье
    if (dow === 0 || d === last) {
      weeks.push({ from: month + "-" + pad(from), to: month + "-" + pad(d) });
      from = d + 1;
    }
  }
  return weeks;
}

export function isValidMonth(month) {
  return typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

function isValidDay(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(day + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === day;
}

// ---- Чтение: итоги месяца ---------------------------------------------------

export async function getMonthMoney(db, month) {
  await ensureMoneyTables(db);
  const weeksGrid = monthWeeks(month);
  const { results: saleRows } = await db.prepare(
    "SELECT id, sale_date, amount_kop, source, event_id, comment, created_at, created_by, voided_at, voided_by " +
    "FROM sales WHERE sale_date >= ? AND sale_date <= ? ORDER BY sale_date DESC, id DESC"
  ).bind(month + "-01", month + "-31").all();
  const { results: planRows } = await db.prepare(
    "SELECT scope, amount_kop FROM sales_plans WHERE month = ?"
  ).bind(month).all();

  const plans = {};
  for (const p of planRows || []) plans[p.scope] = p.amount_kop;

  const sources = SOURCES.map((s) => ({
    key: s.key, label: s.label, factKop: 0,
    planKop: plans["source:" + s.key] != null ? plans["source:" + s.key] : null,
  }));
  const weeks = weeksGrid.map((w, i) => ({
    from: w.from, to: w.to, factKop: 0,
    planKop: plans["week:" + (i + 1)] != null ? plans["week:" + (i + 1)] : null,
    bySource: SOURCES.map(() => 0),
  }));

  // все итоги — из одного набора записей, поэтому месяц = сумма недель = сумма статей
  let factKop = 0;
  for (const r of saleRows || []) {
    if (r.voided_at) continue;
    factKop += r.amount_kop;
    const si = SOURCE_KEYS.indexOf(r.source);
    if (si !== -1) sources[si].factKop += r.amount_kop;
    const wi = weeksGrid.findIndex((w) => r.sale_date >= w.from && r.sale_date <= w.to);
    if (wi !== -1) {
      weeks[wi].factKop += r.amount_kop;
      if (si !== -1) weeks[wi].bySource[si] += r.amount_kop;
    }
  }

  // план месяца = сумма планов по статьям; пока ни одна не задана — плана нет
  const sourcePlans = sources.filter((s) => s.planKop != null);
  const planKop = sourcePlans.length ? sourcePlans.reduce((a, s) => a + s.planKop, 0) : null;

  return {
    month,
    factKop,
    planKop,
    sources,
    weeks,
    sales: (saleRows || []).map((r) => ({
      id: r.id,
      date: r.sale_date,
      amountKop: r.amount_kop,
      source: r.source,
      eventId: r.event_id || null,
      comment: r.comment || null,
      createdBy: r.created_by || null,
      voided: !!r.voided_at,
      voidedBy: r.voided_by || null,
    })),
  };
}

// ---- Запись -----------------------------------------------------------------

// Возвращает { ok, id, duplicate } или { ok: false, error }.
export async function addSale(db, input, user) {
  await ensureMoneyTables(db);
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  if (!clientId || clientId.length > 64) return { ok: false, error: "bad_client_id" };
  if (!isValidDay(input.date)) return { ok: false, error: "bad_date" };
  if (input.date > moscowDay(new Date())) return { ok: false, error: "future_date" };
  if (!Number.isInteger(input.amountKop) || input.amountKop <= 0 || input.amountKop > MAX_AMOUNT_KOP) {
    return { ok: false, error: "bad_amount" };
  }
  if (!SOURCE_KEYS.includes(input.source)) return { ok: false, error: "bad_source" };
  const eventId = input.source === "events" && typeof input.eventId === "string" && input.eventId ? input.eventId : null;
  const comment = typeof input.comment === "string" && input.comment.trim() ? input.comment.trim().slice(0, MAX_COMMENT) : null;

  // повтор той же формы — возвращаем уже сохранённую запись, второй не создаём
  const existing = await db.prepare("SELECT id FROM sales WHERE client_id = ?").bind(clientId).first();
  if (existing) return { ok: true, id: existing.id, duplicate: true };
  try {
    await db.prepare(
      "INSERT INTO sales (client_id, sale_date, amount_kop, source, event_id, comment, created_at, created_by_id, created_by) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(clientId, input.date, input.amountKop, input.source, eventId, comment,
      new Date().toISOString(), user.id, who(user)).run();
  } catch (e) {
    // два одинаковых запроса пришли одновременно — второй упёрся в UNIQUE
    if (!/unique/i.test(String(e && e.message))) throw e;
  }
  const row = await db.prepare("SELECT id FROM sales WHERE client_id = ?").bind(clientId).first();
  return { ok: true, id: row.id, duplicate: false };
}

export async function voidSale(db, id, user) {
  await ensureMoneyTables(db);
  if (!Number.isInteger(id)) return { ok: false, error: "bad_id" };
  const row = await db.prepare("SELECT id, voided_at FROM sales WHERE id = ?").bind(id).first();
  if (!row) return { ok: false, error: "not_found" };
  if (!row.voided_at) {
    await db.prepare("UPDATE sales SET voided_at = ?, voided_by = ? WHERE id = ? AND voided_at IS NULL")
      .bind(new Date().toISOString(), who(user), id).run();
  }
  return { ok: true, id };
}

// plans: { sources: { new: kop|null, ... }, weeks: [kop|null, ...] }.
// null — план по этой строке снят. Сохраняется целиком за месяц.
export async function savePlans(db, month, plans, user) {
  await ensureMoneyTables(db);
  if (!isValidMonth(month)) return { ok: false, error: "bad_month" };
  const weeksCount = monthWeeks(month).length;
  const okAmount = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= MAX_AMOUNT_KOP);
  const sources = (plans && plans.sources) || {};
  const weeks = (plans && plans.weeks) || [];
  if (!Array.isArray(weeks) || weeks.length > weeksCount) return { ok: false, error: "bad_weeks" };
  const rows = [];
  for (const key of SOURCE_KEYS) {
    const v = sources[key] === undefined ? null : sources[key];
    if (!okAmount(v)) return { ok: false, error: "bad_amount" };
    rows.push(["source:" + key, v]);
  }
  for (let i = 0; i < weeksCount; i++) {
    const v = weeks[i] === undefined ? null : weeks[i];
    if (!okAmount(v)) return { ok: false, error: "bad_amount" };
    rows.push(["week:" + (i + 1), v]);
  }
  const now = new Date().toISOString();
  const by = who(user);
  const stmts = rows.map(([scope, v]) => v === null
    ? db.prepare("DELETE FROM sales_plans WHERE month = ? AND scope = ?").bind(month, scope)
    : db.prepare(
        "INSERT INTO sales_plans (month, scope, amount_kop, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(month, scope) DO UPDATE SET amount_kop = excluded.amount_kop, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
      ).bind(month, scope, v, now, by));
  // D1 batch — одной транзакцией: план месяца не сохранится «наполовину»
  await db.batch(stmts);
  return { ok: true };
}
