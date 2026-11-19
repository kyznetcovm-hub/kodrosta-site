// Оплаты читаются сервером. Формула «К выпуску» в таблице не заменяет проверку.
import { readGoogleSheetRange } from './sheets-sync.js';

export const ADMISSION_TARIFFS = Object.freeze({ 'Гость': 700000, 'Гость + игра': 1000000,
  'Гость + подкаст': 1200000, 'Гость + игра + подкаст': 1500000 });
export const ADMISSION_SOURCE_SCHEMA = `CREATE TABLE IF NOT EXISTS admission_sheet_tickets (
  ticket_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, source_id TEXT NOT NULL,
  tariff TEXT NOT NULL, payment_status TEXT NOT NULL, expected_kopeks INTEGER NOT NULL,
  received_kopeks INTEGER, payment_date TEXT, synced_at TEXT NOT NULL,
  UNIQUE(event_id, source_id)
)`;
const headers = ['ID билета','Имя и фамилия','Компания','Формат билета','К оплате, ₽','Получено, ₽','Статус оплаты','Дата оплаты'];
const clean = v => String(v ?? '').trim();
function money(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100000000 && Math.abs(v * 100 - Math.round(v * 100)) < 0.00001 ? Math.round(v * 100) : null; }
function dateCell(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 36526 && v <= 73415)
    return new Date(Date.UTC(1899,11,30) + Math.floor(v) * 86400000).toISOString().slice(0,10);
  const m = clean(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const date = new Date(Date.UTC(+m[3], +m[2]-1, +m[1]));
  return date.getUTCFullYear() === +m[3] && date.getUTCMonth() === +m[2]-1 && date.getUTCDate() === +m[1] ? date.toISOString().slice(0,10) : null;
}
export function parseAdmissionSheet(rows) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) throw new Error('В таблице оплат нет заголовков.');
  const h = rows[0].map(clean), indexes = headers.map(name => h.indexOf(name));
  if (indexes.some((i,j) => i < 0 || h.lastIndexOf(headers[j]) !== i)) throw new Error('Изменились заголовки таблицы оплат. Билеты не изменены.');
  const guests = [], seen = new Set();
  for (let i = 1; i < rows.length; i++) {
    const [id,name,company,tariff,expectedValue,paidValue,status,date] = indexes.map(c=>rows[i]?.[c]);
    if (!clean(name)) continue; // Удалённая/пустая строка сама по себе не отзывает билет.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(clean(id))) throw new Error('Строка ' + (i+7) + ': нужен постоянный ID билета.');
    if (seen.has(clean(id))) throw new Error('Повторяется ID билета ' + clean(id) + '. Билеты не изменены.');
    seen.add(clean(id));
    if (clean(name).length > 120 || clean(company).length > 160) throw new Error('Строка ' + (i+7) + ': слишком длинное имя или название компании.');
    const expected = Object.hasOwn(ADMISSION_TARIFFS,clean(tariff)) ? ADMISSION_TARIFFS[clean(tariff)] : null;
    const paid = money(paidValue), paymentDate = dateCell(date);
    const eligible = status === 'Оплачено' && expected !== null && money(expectedValue) === expected && paid !== null && paid >= expected && !!paymentDate;
    let reason = status === 'Не оплачено' ? 'Не оплачено' : status === 'Ожидаем оплаты' ? 'Ожидаем оплаты'
      : status !== 'Оплачено' ? 'Не выбран статус оплаты' : expected === null ? 'Неизвестный тариф'
      : money(expectedValue) !== expected ? 'Стоимость не совпадает с тарифом'
      : paid === null || paid < expected ? 'Нужна полная оплата' : !paymentDate ? 'Не указана дата оплаты' : '';
    guests.push({ row:i+7, id:clean(id), name:clean(name), company:clean(company), tariff:clean(tariff),
      paymentStatus:clean(status), expected:expected ?? 0, paid, paymentDate, eligible, reason,
      status:eligible ? 'active' : status === 'Не оплачено' ? 'cancelled' : 'pending' });
  }
  return guests;
}
async function ticketId(eventId, sourceId) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(eventId + '\n' + sourceId));
  return 'sheet-' + Array.from(new Uint8Array(bytes), x=>x.toString(16).padStart(2,'0')).join('').slice(0,48);
}
function token() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), x=>x.toString(16).padStart(2,'0')).join(''); }
export async function syncAdmissionRows(env, eventId, rows, startedAt = new Date().toISOString()) {
  const guests = parseAdmissionSheet(rows);
  const existing = (await env.DB.prepare('SELECT t.id,t.status,s.source_id FROM admission_tickets t JOIN admission_sheet_tickets s ON s.ticket_id=t.id WHERE t.event_id=?').bind(eventId).all()).results;
  const bySource = new Map(existing.map(t=>[t.source_id,t]));
  const statements = [], report = { created:0, updated:0, revoked:0, waiting:0, eligible:0, sourceRows:guests.length, syncedAt:startedAt, issues:[] };
  for (const guest of guests) {
    const old = bySource.get(guest.id);
    if (guest.eligible) report.eligible++; else { report.waiting++; report.issues.push({ id:guest.id,row:guest.row,reason:guest.reason }); }
    if (!old && !guest.eligible) continue; // Новый QR выпускается только полностью оплатившим.
    const id = old?.id || await ticketId(eventId,guest.id);
    // История входа и токен никогда не перезаписываются при синхронизации.
    // Устаревший параллельный запрос не может заменить более свежую запись.
    statements.push(env.DB.prepare(`INSERT INTO admission_tickets
      (id,event_id,token,person_name,company,category,status,created_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET person_name=excluded.person_name,company=excluded.company,
      category=excluded.category,status=excluded.status
      WHERE NOT EXISTS(SELECT 1 FROM admission_sheet_tickets WHERE ticket_id=? AND synced_at>?)`)
      .bind(id,eventId,token(),guest.name,guest.company,guest.tariff,guest.status,startedAt,id,startedAt));
    statements.push(env.DB.prepare(`INSERT INTO admission_sheet_tickets
      (ticket_id,event_id,source_id,tariff,payment_status,expected_kopeks,received_kopeks,payment_date,synced_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(ticket_id) DO UPDATE SET tariff=excluded.tariff,
      payment_status=excluded.payment_status,expected_kopeks=excluded.expected_kopeks,
      received_kopeks=excluded.received_kopeks,payment_date=excluded.payment_date,synced_at=excluded.synced_at
      WHERE excluded.synced_at>=admission_sheet_tickets.synced_at`)
      .bind(id,eventId,guest.id,guest.tariff,guest.paymentStatus,guest.expected,guest.paid,guest.paymentDate,startedAt));
    if (!old) report.created++; else { report.updated++; if (old.status==='active' && !guest.eligible) report.revoked++; }
  }
  if (statements.length) await env.DB.batch(statements);
  return report;
}
export async function syncAdmissionFromSheet(env,eventId) {
  const startedAt = new Date().toISOString();
  // Инъекция источника используется только локальной демонстрацией и тестами.
  const rows = typeof env.ADMISSION_READ_SHEET === 'function' ? await env.ADMISSION_READ_SHEET()
    : await readGoogleSheetRange(env,env.ADMISSION_SHEET_ID,"'Билеты'!A7:L1000");
  return { ...(await syncAdmissionRows(env,eventId,rows,startedAt)), source: env.ADMISSION_SOURCE_LABEL || 'Google-таблица оплат' };
}
