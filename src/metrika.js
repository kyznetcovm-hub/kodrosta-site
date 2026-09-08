// Отчёт по Яндекс.Метрике для клуба (счётчик codrosta.club).
//
// Два сценария, оба зовут buildMetrikaDigest():
// - по расписанию раз в неделю (см. triggers.crons в wrangler.jsonc и
//   scheduled() в src/index.js) — сводка за прошедшую неделю в личку всем
//   админам из ADMIN_USERNAMES;
// - закрытый эндпоинт GET /api/metrika?key=METRIKA_REPORT_KEY (src/index.js) —
//   отдаёт те же данные в JSON, чтобы можно было смотреть цифры на лету.
//
// Токен только на чтение (metrika:read) лежит в секрете METRIKA_TOKEN.
// Номер счётчика — env.METRIKA_COUNTER_ID, по умолчанию боевой 111842641.

const DEFAULT_COUNTER_ID = "111842641";
const API = "https://api-metrika.yandex.net";

// слова, по которым считаем поисковый запрос брендовым (не показываем в
// списке «небрендовых» — они и так понятно что про нас)
const BRAND_WORDS = ["код рост", "кодрост", "codrosta", "code rost", "кодроста"];

const SOURCE_RU = {
  "Direct traffic": "Прямые",
  "Search engine traffic": "Поиск",
  "Internal traffic": "Внутренние",
  "Link traffic": "Ссылки",
  "Social network traffic": "Соцсети",
  "Ad traffic": "Реклама",
  "Recommendation system traffic": "Рекомендации",
  "Saved traffic": "Сохранённые",
  "Messenger traffic": "Мессенджеры",
};

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function ruDateShort(iso) {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function round(x) {
  return Math.round(Number(x) || 0);
}

function fmtDuration(sec) {
  const s = round(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function fmtDelta(cur, prev) {
  if (!prev) return "";
  const pct = Math.round(((cur - prev) / prev) * 100);
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return ` (было ${round(prev)}, ${sign}${Math.abs(pct)}%)`;
}

async function mFetch(env, path, params) {
  const url = new URL(API + path);
  const cid = env.METRIKA_COUNTER_ID || DEFAULT_COUNTER_ID;
  url.searchParams.set("ids", cid);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), {
    headers: { Authorization: "OAuth " + env.METRIKA_TOKEN },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error("Metrika API " + resp.status + ": " + body.slice(0, 300));
  }
  return resp.json();
}

// Сводные метрики за период (без разбивки) — берём из resp.totals.
async function summary(env, date1, date2) {
  const d = await mFetch(env, "/stat/v1/data", {
    metrics: "ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate,ym:s:avgVisitDurationSeconds",
    date1,
    date2,
  });
  const t = (d.totals && d.totals[0] !== undefined) ? d.totals : [0, 0, 0, 0, 0];
  const arr = Array.isArray(t[0]) ? t[0] : t;
  return {
    visits: round(arr[0]),
    users: round(arr[1]),
    pageviews: round(arr[2]),
    bounceRate: Math.round(Number(arr[3]) || 0),
    avgDuration: round(arr[4]),
  };
}

async function breakdown(env, dimension, metric, date1, date2, limit) {
  const d = await mFetch(env, "/stat/v1/data", {
    metrics: metric,
    dimensions: dimension,
    date1,
    date2,
    limit: String(limit || 20),
  });
  return (d.data || []).map((r) => ({
    name: (r.dimensions[0] && r.dimensions[0].name) || "—",
    value: round(r.metrics[0]),
  }));
}

async function goalReaches(env, date1, date2) {
  let goals = [];
  try {
    const g = await mFetch(env, "/management/v1/counter/" +
      (env.METRIKA_COUNTER_ID || DEFAULT_COUNTER_ID) + "/goals", {});
    goals = (g.goals || []).slice(0, 15);
  } catch (e) {
    return [];
  }
  if (!goals.length) return [];
  const metrics = goals.map((x) => "ym:s:goal" + x.id + "visits").join(",");
  const d = await mFetch(env, "/stat/v1/data", { metrics, date1, date2 });
  const row = (d.totals && d.totals.length) ? d.totals : goals.map(() => 0);
  return goals.map((x, i) => ({
    name: String(x.name || "цель " + x.id).replace(/^Автоцель:\s*/i, ""),
    value: round(row[i]),
  }));
}

function isBrand(phrase) {
  const p = String(phrase).toLowerCase();
  return BRAND_WORDS.some((w) => p.includes(w));
}

// Собирает и данные, и готовый текст. text — для Telegram (parse_mode HTML).
export async function buildMetrikaDigest(env) {
  const wStart = isoDaysAgo(7);
  const wEnd = isoDaysAgo(1);
  const pStart = isoDaysAgo(14);
  const pEnd = isoDaysAgo(8);
  const mStart = isoDaysAgo(30);

  const [cur, prev, sources, engines, phrases, goals] = await Promise.all([
    summary(env, wStart, wEnd),
    summary(env, pStart, pEnd),
    breakdown(env, "ym:s:lastsignTrafficSource", "ym:s:visits", wStart, wEnd, 15),
    breakdown(env, "ym:s:searchEngineName", "ym:s:visits", mStart, wEnd, 10),
    breakdown(env, "ym:s:searchPhrase", "ym:s:visits", mStart, wEnd, 30),
    goalReaches(env, wStart, wEnd),
  ]);

  const nonBrandPhrases = phrases.filter((p) => p.name && p.name !== "—" && !isBrand(p.name));

  const data = {
    counter: env.METRIKA_COUNTER_ID || DEFAULT_COUNTER_ID,
    period: { from: wStart, to: wEnd },
    current: cur,
    previous: prev,
    sources,
    searchEngines: engines,
    searchPhrases: phrases,
    nonBrandSearchPhrases: nonBrandPhrases,
    goals,
  };

  const L = [];
  L.push(`📊 <b>Метрика · неделя ${ruDateShort(wStart)}–${ruDateShort(wEnd)}</b>`);
  L.push("");
  L.push(`Визиты: ${cur.visits}${fmtDelta(cur.visits, prev.visits)}`);
  L.push(`Посетители: ${cur.users}${fmtDelta(cur.users, prev.users)}`);
  L.push(`Просмотры: ${cur.pageviews}`);
  L.push(`Отказы: ${cur.bounceRate}%`);
  L.push(`Время на сайте: ${fmtDuration(cur.avgDuration)}`);

  if (sources.length) {
    L.push("");
    L.push("<b>Источники</b>");
    for (const s of sources) {
      if (!s.value) continue;
      L.push(`• ${esc(SOURCE_RU[s.name] || s.name)} — ${s.value}`);
    }
  }

  const engLine = engines.filter((e) => e.value).map((e) => `${esc(e.name)} — ${e.value}`).join(", ");
  if (engLine) {
    L.push("");
    L.push("<b>Поиск (30 дней)</b>");
    L.push(engLine);
    if (nonBrandPhrases.length) {
      L.push("Небрендовые запросы:");
      for (const p of nonBrandPhrases.slice(0, 10)) L.push(`• ${esc(p.name)} — ${p.value}`);
    } else {
      L.push("Небрендовых запросов нет.");
    }
  }

  const hitGoals = goals.filter((g) => g.value);
  L.push("");
  L.push("<b>Обращения (неделя)</b>");
  if (hitGoals.length) {
    for (const g of hitGoals) L.push(`• ${esc(g.name)} — ${g.value}`);
  } else {
    L.push("Ни одного целевого действия за неделю.");
  }

  L.push("");
  L.push(`codrosta.club · счётчик ${data.counter}`);

  data.text = L.join("\n");
  return data;
}
