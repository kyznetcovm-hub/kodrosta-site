// Ежедневная синхронизация вкладки «Вступившие» гугл-таблицы с базой резидентов.
// Читает таблицу напрямую через Google Sheets API (сервис-аккаунт, доступ только
// на чтение), без какого-либо экспорта вручную. Обновляет только telegram_username
// у уже существующих резидентов (по совпадению телефона) и добавляет новых —
// ничего не удаляет и не трогает active/касания, это отдельная зона ответственности.
//
// Секреты/конфиг (Cloudflare → Variables and Secrets):
//   GOOGLE_SERVICE_ACCOUNT_JSON — содержимое JSON-ключа сервис-аккаунта целиком
//   GOOGLE_SHEET_ID             — id таблицы (кусок из ссылки между /d/ и /edit)

const SHEET_TAB_NAME = "Вступившие";

function base64UrlEncode(bytes) {
  let binary = typeof bytes === "string" ? bytes : String.fromCharCode.apply(null, Array.from(bytes));
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function importPrivateKey(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function getGoogleAccessToken(env) {
  const creds = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = base64UrlEncode(JSON.stringify(header)) + "." + base64UrlEncode(JSON.stringify(claim));
  const key = await importPrivateKey(creds.private_key);
  const sigBuf = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + "." + base64UrlEncode(new Uint8Array(sigBuf));

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt,
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("Google auth failed: " + JSON.stringify(data));
  return data.access_token;
}

async function fetchSheetRows(accessToken, sheetId, tabName) {
  const range = encodeURIComponent(tabName + "!A:Z");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`;
  const resp = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
  const data = await resp.json();
  if (!data.values) throw new Error("Sheets API error: " + JSON.stringify(data));
  return data.values;
}

function normalizePhone(raw) {
  const digits = String(raw == null ? "" : raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return "7" + digits.slice(1);
  if (digits.length === 11 && digits.startsWith("7")) return digits;
  if (digits.length === 10) return "7" + digits;
  return null;
}

function normalizeUsername(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/^@/, "").toLowerCase();
  return ["нет", "-", "—", "", "?", "null", "none"].includes(s) ? null : s;
}

// Даты в Google Sheets с valueRenderOption=UNFORMATTED_VALUE приходят либо
// текстом («21.11.2025»), либо (если ячейка отформатирована как дата)
// числом — серийный день с 30.12.1899. Обрабатываем оба случая.
function serialToIso(n) {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
function parseDateCell(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return serialToIso(v);
  const m = String(v).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, day, mon, year] = m;
  return `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function findColumn(header, mustHave) {
  for (let i = 0; i < header.length; i++) {
    const cell = String(header[i] || "").toLowerCase();
    if (mustHave.every((kw) => cell.includes(kw))) return i;
  }
  return -1;
}

// Разбирает всю вкладку «Вступившие» в список { fullName, phone, telegramUsername, joinedAt }.
// Останавливается на строке «ПОТЕНЦИАЛЬНЫЕ»/«ДОЛГИ» — это не резиденты.
function parseResidentsSheet(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((c) => String(c || ""));
  const colName = findColumn(header, ["фио"]);
  const colPhone = findColumn(header, ["телефон"]);
  const colTg = findColumn(header, ["телеграм"]);
  const colStart = findColumn(header, ["дата", "начала"]);
  if (colName === -1) return []; // не похоже на ожидаемый формат — не рискуем

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const joined = row.join(" ").toUpperCase();
    if (joined.includes("ПОТЕНЦИАЛЬНЫЕ") || joined.includes("ДОЛГИ")) break;

    const fullName = String(row[colName] || "").trim();
    if (!fullName) continue;
    const phone = colPhone >= 0 ? normalizePhone(row[colPhone]) : null;
    const telegramUsername = colTg >= 0 ? normalizeUsername(row[colTg]) : null;
    const joinedAt = colStart >= 0 ? parseDateCell(row[colStart]) : null;
    if (!phone && !telegramUsername) continue; // нечем зацепиться — пропускаем

    out.push({ fullName, phone, telegramUsername, joinedAt });
  }
  return out;
}

// Основная функция — вызывается и по расписанию (scheduled), и вручную
// (кнопка в меню бота). Возвращает текстовый отчёт для админа.
export async function syncResidentsFromSheet(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.GOOGLE_SHEET_ID) {
    return "Синхронизация не настроена: нет GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_SHEET_ID в секретах Worker'а.";
  }
  const accessToken = await getGoogleAccessToken(env);
  const rows = await fetchSheetRows(accessToken, env.GOOGLE_SHEET_ID, SHEET_TAB_NAME);
  const parsed = parseResidentsSheet(rows);

  const { results: existing } = await env.DB.prepare("SELECT id, full_name, phone, telegram_username FROM residents").all();
  const byPhone = new Map();
  const byUsername = new Map();
  for (const r of existing) {
    if (r.phone) byPhone.set(r.phone, r);
    if (r.telegram_username) byUsername.set(r.telegram_username.toLowerCase(), r);
  }

  // Один и тот же телефон на разные ФИО в самой таблице (опечатка при вводе) —
  // такие телефоны для сопоставления не используем вовсе, иначе двух разных
  // людей будет постоянно "перетягивать" друг на друга при каждом прогоне.
  const phoneToNames = new Map();
  for (const p of parsed) {
    if (!p.phone) continue;
    if (!phoneToNames.has(p.phone)) phoneToNames.set(p.phone, new Set());
    phoneToNames.get(p.phone).add(p.fullName);
  }
  const ambiguousPhones = new Set(
    [...phoneToNames.entries()].filter(([, names]) => names.size > 1).map(([phone]) => phone)
  );

  let updated = 0;
  let inserted = 0;
  const updatedNames = [];
  const insertedNames = [];
  const conflicts = [];

  for (const p of parsed) {
    if (p.phone && ambiguousPhones.has(p.phone)) {
      conflicts.push(`${p.phone} — ${[...phoneToNames.get(p.phone)].join(" / ")}`);
    }
    const usablePhone = p.phone && !ambiguousPhones.has(p.phone) ? p.phone : null;
    // Сначала по телефону, а если не нашли — по username: резидент мог быть
    // заведён раньше без телефона (например, вручную), и теперь в таблице
    // телефон появился — не должны создавать ему дубликат.
    const match = (usablePhone && byPhone.get(usablePhone)) || (p.telegramUsername && byUsername.get(p.telegramUsername)) || null;
    if (match) {
      const sets = [];
      const binds = [];
      if (p.telegramUsername && p.telegramUsername !== (match.telegram_username || "").toLowerCase()) {
        sets.push("telegram_username = ?");
        binds.push(p.telegramUsername);
      }
      if (usablePhone && !match.phone) {
        sets.push("phone = ?");
        binds.push(usablePhone);
      }
      if (sets.length) {
        binds.push(match.id);
        await env.DB.prepare(`UPDATE residents SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
        updated++;
        updatedNames.push(match.full_name);
      }
    } else if (usablePhone) {
      // новый телефон и не нашёлся ни по телефону, ни по username — новый
      // резидент (совсем без телефона не добавляем, слишком легко случайно
      // задвоить кого-то без надёжного ключа для сопоставления)
      await env.DB.prepare("INSERT INTO residents (full_name, phone, telegram_username, joined_at, active) VALUES (?, ?, ?, ?, 1)")
        .bind(p.fullName, usablePhone, p.telegramUsername, p.joinedAt).run();
      inserted++;
      insertedNames.push(p.fullName);
    }
  }

  const lines = [
    `<b>Синхронизация с таблицей</b> · ${new Date().toLocaleString("ru-RU")}`,
    `Строк разобрано: ${parsed.length}`,
    `Обновлён telegram: ${updated}${updated ? " (" + updatedNames.slice(0, 10).join(", ") + (updated > 10 ? "…" : "") + ")" : ""}`,
    `Новых резидентов: ${inserted}${inserted ? " (" + insertedNames.slice(0, 10).join(", ") + (inserted > 10 ? "…" : "") + ")" : ""}`,
  ];
  if (conflicts.length) {
    const uniqueConflicts = [...new Set(conflicts)];
    lines.push("", `⚠️ Один телефон на разных людей в таблице — поправьте вручную (${uniqueConflicts.length}):`);
    lines.push(...uniqueConflicts.map((c) => "• " + c));
  }
  return lines.join("\n");
}
