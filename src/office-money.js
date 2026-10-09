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
// План продаж (9 октября): из чего он складывается — строки «что × сколько ×
// почём» по статьям (баня 8 × 15 000, продления 10 × 15 000…), план статьи =
// сумма её строк, план месяца = сумма статей. Главное — месяц: недели
// необязательны и на экране приглушены (Рубеж конца месяца продают и в начале).
//
// Расходы (9 октября): комиссия менеджерам с продаж и себестоимость
// мероприятий (обязательно с привязкой к мероприятию). Вносятся так же, как
// продажи: по дню оплаты, с отменой без удаления и защитой от повтора.
//
// Таблицы создаются кодом (ensureMoneyTables), migrations/0011–0012 — для истории.

export const SOURCES = [
  { key: "new", label: "Новые абонементы" },
  { key: "renewal", label: "Продления" },
  { key: "events", label: "Мероприятия" },
  { key: "ads", label: "Реклама" },
];
const SOURCE_KEYS = SOURCES.map((s) => s.key);

export const EXPENSE_CATEGORIES = [
  { key: "commission", label: "Комиссия менеджерам" },
  { key: "event_cost", label: "Себестоимость мероприятий" },
];
const EXPENSE_KEYS = EXPENSE_CATEGORIES.map((c) => c.key);

const MAX_PLAN_ITEMS = 100;
const MAX_QTY = 100000;
const MAX_TITLE = 120;

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
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS sales_plan_items (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "month TEXT NOT NULL, " +              // YYYY-MM
    "source TEXT NOT NULL, " +             // new | renewal | events | ads
    "title TEXT, " +                       // «Бизнес-баня», «Продления» — для себя
    "event_id TEXT, " +                    // если строка про конкретное мероприятие
    "qty INTEGER NOT NULL, " +             // сколько продаём
    "price_kop INTEGER NOT NULL, " +       // почём
    "pos INTEGER NOT NULL, " +             // порядок строк в статье
    "updated_at TEXT NOT NULL, " +
    "updated_by TEXT)"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_plan_items_month ON sales_plan_items(month)").run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS expenses (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "client_id TEXT NOT NULL UNIQUE, " +
    "exp_date TEXT NOT NULL, " +           // YYYY-MM-DD, день оплаты по Москве
    "amount_kop INTEGER NOT NULL, " +
    "category TEXT NOT NULL, " +           // commission | event_cost
    "event_id TEXT, " +                    // для себестоимости — обязательно
    "comment TEXT, " +
    "created_at TEXT NOT NULL, " +
    "created_by_id INTEGER, " +
    "created_by TEXT, " +
    "voided_at TEXT, " +
    "voided_by TEXT)"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(exp_date)").run();
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
  const { results: itemRows } = await db.prepare(
    "SELECT source, title, event_id, qty, price_kop FROM sales_plan_items WHERE month = ? ORDER BY source, pos, id"
  ).bind(month).all();
  const { results: expRows } = await db.prepare(
    "SELECT id, exp_date, amount_kop, category, event_id, comment, created_at, created_by, voided_at, voided_by " +
    "FROM expenses WHERE exp_date >= ? AND exp_date <= ? ORDER BY exp_date DESC, id DESC"
  ).bind(month + "-01", month + "-31").all();
  const eventTitles = await loadEventTitles(db, [].concat(
    (saleRows || []).map((r) => r.event_id), (itemRows || []).map((r) => r.event_id), (expRows || []).map((r) => r.event_id)));

  const plans = {};
  for (const p of planRows || []) plans[p.scope] = p.amount_kop;

  // план статьи: сумма её строк «сколько × почём»; если строк нет — прежняя
  // одной суммой (планы, введённые до 9 октября); иначе плана нет
  const sources = SOURCES.map((s) => {
    const items = (itemRows || []).filter((r) => r.source === s.key).map((r) => ({
      title: r.title || null,
      eventId: r.event_id || null,
      eventTitle: r.event_id ? eventTitles[r.event_id] || null : null,
      qty: r.qty,
      priceKop: r.price_kop,
      totalKop: r.qty * r.price_kop,
    }));
    const planKop = items.length ? items.reduce((a, it) => a + it.totalKop, 0)
      : plans["source:" + s.key] != null ? plans["source:" + s.key] : null;
    return { key: s.key, label: s.label, factKop: 0, planKop, items };
  });
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

  // расходы: по статьям и по мероприятиям (себестоимость)
  const expByCat = EXPENSE_CATEGORIES.map((c) => ({ key: c.key, label: c.label, factKop: 0 }));
  const expByEvent = {};
  let expKop = 0;
  for (const r of expRows || []) {
    if (r.voided_at) continue;
    expKop += r.amount_kop;
    const ci = EXPENSE_KEYS.indexOf(r.category);
    if (ci !== -1) expByCat[ci].factKop += r.amount_kop;
    if (r.category === "event_cost" && r.event_id) expByEvent[r.event_id] = (expByEvent[r.event_id] || 0) + r.amount_kop;
  }

  return {
    month,
    factKop,
    planKop,
    sources,
    weeks,
    expenses: {
      totalKop: expKop,
      categories: expByCat,
      byEvent: Object.keys(expByEvent).map((id) => ({ eventId: id, eventTitle: eventTitles[id] || id, factKop: expByEvent[id] }))
        .sort((a, b) => b.factKop - a.factKop),
      list: (expRows || []).map((r) => ({
        id: r.id,
        date: r.exp_date,
        amountKop: r.amount_kop,
        category: r.category,
        eventId: r.event_id || null,
        eventTitle: r.event_id ? eventTitles[r.event_id] || null : null,
        comment: r.comment || null,
        createdAt: r.created_at,
        createdBy: r.created_by || null,
        voided: !!r.voided_at,
        voidedBy: r.voided_by || null,
      })),
    },
    sales: (saleRows || []).map((r) => ({
      id: r.id,
      date: r.sale_date,
      amountKop: r.amount_kop,
      source: r.source,
      eventId: r.event_id || null,
      eventTitle: r.event_id ? eventTitles[r.event_id] || null : null,
      comment: r.comment || null,
      createdAt: r.created_at,
      createdBy: r.created_by || null,
      voided: !!r.voided_at,
      voidedBy: r.voided_by || null,
    })),
  };
}

// названия мероприятий по id (в том числе прошлых месяцев) — для журнала и плана
async function loadEventTitles(db, ids) {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  const out = {};
  if (!uniq.length) return out;
  try {
    const { results } = await db.prepare(
      "SELECT id, title FROM events WHERE id IN (" + uniq.map(() => "?").join(",") + ")"
    ).bind(...uniq).all();
    for (const r of results || []) out[r.id] = r.title;
  } catch (e) {
    // таблицы мероприятий нет (тестовая база) — просто без названий
  }
  return out;
}

// ---- Запись -----------------------------------------------------------------

// Общая проверка суммы/даты/повтора для продаж и расходов.
function checkCommon(input) {
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  if (!clientId || clientId.length > 64) return { error: "bad_client_id" };
  if (!isValidDay(input.date)) return { error: "bad_date" };
  if (input.date > moscowDay(new Date())) return { error: "future_date" };
  if (!Number.isInteger(input.amountKop) || input.amountKop <= 0 || input.amountKop > MAX_AMOUNT_KOP) {
    return { error: "bad_amount" };
  }
  const comment = typeof input.comment === "string" && input.comment.trim() ? input.comment.trim().slice(0, MAX_COMMENT) : null;
  return { clientId, comment };
}

// Вставка с защитой от повтора: та же форма второй раз — та же запись.
async function insertOnce(db, table, clientId, sql, values) {
  const existing = await db.prepare("SELECT id FROM " + table + " WHERE client_id = ?").bind(clientId).first();
  if (existing) return { ok: true, id: existing.id, duplicate: true };
  try {
    await db.prepare(sql).bind(...values).run();
  } catch (e) {
    // два одинаковых запроса пришли одновременно — второй упёрся в UNIQUE
    if (!/unique/i.test(String(e && e.message))) throw e;
  }
  const row = await db.prepare("SELECT id FROM " + table + " WHERE client_id = ?").bind(clientId).first();
  return { ok: true, id: row.id, duplicate: false };
}

async function voidRecord(db, table, id, user) {
  await ensureMoneyTables(db);
  if (!Number.isInteger(id)) return { ok: false, error: "bad_id" };
  const row = await db.prepare("SELECT id, voided_at FROM " + table + " WHERE id = ?").bind(id).first();
  if (!row) return { ok: false, error: "not_found" };
  if (!row.voided_at) {
    await db.prepare("UPDATE " + table + " SET voided_at = ?, voided_by = ? WHERE id = ? AND voided_at IS NULL")
      .bind(new Date().toISOString(), who(user), id).run();
  }
  return { ok: true, id };
}

// Возвращает { ok, id, duplicate } или { ok: false, error }.
export async function addSale(db, input, user) {
  await ensureMoneyTables(db);
  const c = checkCommon(input);
  if (c.error) return { ok: false, error: c.error };
  if (!SOURCE_KEYS.includes(input.source)) return { ok: false, error: "bad_source" };
  const eventId = input.source === "events" && typeof input.eventId === "string" && input.eventId ? input.eventId : null;
  return insertOnce(db, "sales", c.clientId,
    "INSERT INTO sales (client_id, sale_date, amount_kop, source, event_id, comment, created_at, created_by_id, created_by) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [c.clientId, input.date, input.amountKop, input.source, eventId, c.comment, new Date().toISOString(), user.id, who(user)]);
}

export function voidSale(db, id, user) {
  return voidRecord(db, "sales", id, user);
}

export async function addExpense(db, input, user) {
  await ensureMoneyTables(db);
  const c = checkCommon(input);
  if (c.error) return { ok: false, error: c.error };
  if (!EXPENSE_KEYS.includes(input.category)) return { ok: false, error: "bad_category" };
  const eventId = typeof input.eventId === "string" && input.eventId ? input.eventId : null;
  // себестоимость — всегда про конкретное мероприятие
  if (input.category === "event_cost" && !eventId) return { ok: false, error: "need_event" };
  return insertOnce(db, "expenses", c.clientId,
    "INSERT INTO expenses (client_id, exp_date, amount_kop, category, event_id, comment, created_at, created_by_id, created_by) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [c.clientId, input.date, input.amountKop, input.category, eventId, c.comment, new Date().toISOString(), user.id, who(user)]);
}

export function voidExpense(db, id, user) {
  return voidRecord(db, "expenses", id, user);
}

// plans: { items: { new: [{ title, eventId, qty, priceKop }], ... }, weeks: [kop|null, ...] }
// — строки плана по статьям; сохраняются целиком за месяц (старые заменяются),
// прежние суммы статей одной цифрой при этом снимаются: теперь план = строки.
// Старый формат { sources: { new: kop|null } } тоже принимается.
// null в weeks — план недели снят.
export async function savePlans(db, month, plans, user) {
  await ensureMoneyTables(db);
  if (!isValidMonth(month)) return { ok: false, error: "bad_month" };
  const weeksCount = monthWeeks(month).length;
  const okAmount = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= MAX_AMOUNT_KOP);
  const sources = (plans && plans.sources) || {};
  const weeks = (plans && plans.weeks) || [];
  if (!Array.isArray(weeks) || weeks.length > weeksCount) return { ok: false, error: "bad_weeks" };
  const rows = [];
  const itemsIn = plans && plans.items;
  const items = [];
  if (itemsIn) {
    if (typeof itemsIn !== "object") return { ok: false, error: "bad_items" };
    for (const key of SOURCE_KEYS) {
      const list = itemsIn[key] || [];
      if (!Array.isArray(list)) return { ok: false, error: "bad_items" };
      list.forEach((it, pos) => items.push({ key, pos, it }));
    }
    if (items.length > MAX_PLAN_ITEMS) return { ok: false, error: "bad_items" };
    for (const { it } of items) {
      if (!it || !Number.isInteger(it.qty) || it.qty <= 0 || it.qty > MAX_QTY) return { ok: false, error: "bad_qty" };
      if (!Number.isInteger(it.priceKop) || it.priceKop <= 0 || it.priceKop > MAX_AMOUNT_KOP) return { ok: false, error: "bad_amount" };
    }
    for (const key of SOURCE_KEYS) rows.push(["source:" + key, null]);
  } else {
    for (const key of SOURCE_KEYS) {
      const v = sources[key] === undefined ? null : sources[key];
      if (!okAmount(v)) return { ok: false, error: "bad_amount" };
      rows.push(["source:" + key, v]);
    }
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
  if (itemsIn) {
    stmts.push(db.prepare("DELETE FROM sales_plan_items WHERE month = ?").bind(month));
    for (const { key, pos, it } of items) {
      const title = typeof it.title === "string" && it.title.trim() ? it.title.trim().slice(0, MAX_TITLE) : null;
      const eventId = typeof it.eventId === "string" && it.eventId ? it.eventId : null;
      stmts.push(db.prepare(
        "INSERT INTO sales_plan_items (month, source, title, event_id, qty, price_kop, pos, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(month, key, title, eventId, it.qty, it.priceKop, pos, now, by));
    }
  }
  // D1 batch — одной транзакцией: план месяца не сохранится «наполовину»
  await db.batch(stmts);
  return { ok: true };
}
