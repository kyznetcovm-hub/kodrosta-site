#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Выгрузка участников Telegram-групп клуба «Код Роста» + сверка с базой резидентов.

Зачем это нужно
---------------
Telegram-бот (через Bot API) НЕ умеет отдавать список участников группы — это
ограничение самого Telegram. Полный список можно получить только от ЛИЧНОГО
аккаунта, который состоит в группе (а лучше — владеет ею). Этот скрипт заходит
в Telegram под твоим номером телефона (один раз, дальше — по сохранённой сессии),
берёт список участников выбранных групп и сохраняет их в CSV.

Дополнительно: если рядом положить файл scripts/residents.csv (выгрузка вкладки
«вступившие» из гугл-таблицы), скрипт сверит участников группы с резидентами и
разложит их на три списка:
  ✅ уже резидент
  ✉️  не резидент, есть @username  → в рассылку приглашений
  ❓ не резидент, без @username     → проверить вручную

Что нужно один раз подготовить
------------------------------
1. Установить библиотеку Telethon:
       python3 -m pip install --user telethon
2. Получить api_id и api_hash на https://my.telegram.org
   (App title и Short name — любые, например «kodrosta»; Platform — Desktop).
   Скрипт спросит их при первом запуске и сохранит в scripts/kodrosta_config.json.

Запуск
------
    cd /Users/admin/Claude/kodrosta-site && python3 scripts/dump_group_members.py

Результаты появятся в папке scripts/out/.
"""

import asyncio
import csv
import json
import os
import re
import sys
from getpass import getpass

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "kodrosta_config.json")
SESSION_PATH = os.path.join(HERE, "kodrosta_session")  # Telethon добавит .session
OUT_DIR = os.path.join(HERE, "out")
RESIDENTS_CSV = os.path.join(HERE, "residents.csv")

try:
    from telethon import TelegramClient
    from telethon.errors import SessionPasswordNeededError, ApiIdPublishedFloodError, FloodWaitError
    from telethon.tl.types import User
except ImportError:
    print(
        "\nНе установлена библиотека Telethon.\n"
        "Выполни в Терминале одну команду и запусти скрипт заново:\n\n"
        "    python3 -m pip install --user telethon\n"
    )
    sys.exit(1)


# --------------------------------------------------------------------------
# Нормализация — приводим username и телефоны к единому виду для сравнения
# --------------------------------------------------------------------------

def norm_username(raw):
    """'@Ivan', 'Tg: ivan', 'https://t.me/ivan' -> 'ivan' (нижний регистр). Мусор -> ''."""
    if not raw:
        return ""
    s = str(raw).strip().lower()
    if s in ("нет", "-", "—", "–", "none", "null", "n/a", "не указан", "не указано"):
        return ""
    m = re.search(r"(?:t\.me/|telegram\.me/|@)\s*([a-z0-9_]{3,64})", s)
    if m:
        return m.group(1)
    # иногда в ячейке просто голый ник без @
    m = re.fullmatch(r"([a-z0-9_]{3,64})", s)
    return m.group(1) if m else ""


def norm_phone(raw):
    """Любой формат телефона -> последние 10 цифр (без кода страны 7/8)."""
    if not raw:
        return ""
    digits = re.sub(r"\D", "", str(raw))
    return digits[-10:] if len(digits) >= 10 else ""


def slugify(title):
    s = re.sub(r"[^\w\-]+", "_", str(title).strip(), flags=re.UNICODE)
    return s.strip("_")[:60] or "group"


# --------------------------------------------------------------------------
# Конфиг: api_id / api_hash
# --------------------------------------------------------------------------

# Публичный ключ официального клиента Telegram Desktop. Ключ идентифицирует
# ПРИЛОЖЕНИЕ, а не аккаунт — вход всё равно по номеру телефона и коду.
# Часто срабатывает и позволяет вообще не ходить на my.telegram.org.
# Если Telegram его не примет — будет ошибка ApiIdPublishedFloodError, тогда
# нужен свой ключ с my.telegram.org.
BUILTIN_API_ID = 2040
BUILTIN_API_HASH = "b18441a1ff607e10a989891a5462e627"


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if cfg.get("api_id") and cfg.get("api_hash"):
            return int(cfg["api_id"]), str(cfg["api_hash"])

    print("\nНужен ключ приложения Telegram.")
    print("• Просто нажми Enter — попробуем встроенный ключ (ничего получать не надо).")
    print("• Или вставь свой api_id с https://my.telegram.org (раздел «API development tools»).\n")
    api_id = input("api_id (или Enter для встроенного): ").strip()
    if not api_id:
        print("Использую встроенный ключ.\n")
        return BUILTIN_API_ID, BUILTIN_API_HASH
    api_hash = input("Теперь вставь api_hash (длинная строка): ").strip()
    if not api_id.isdigit() or len(api_hash) < 20:
        print("api_id должен быть числом, api_hash — длинной строкой. Запусти скрипт заново.")
        sys.exit(1)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump({"api_id": int(api_id), "api_hash": api_hash}, f, indent=2)
    print(f"Сохранил в {CONFIG_PATH} — больше спрашивать не буду.\n")
    return int(api_id), api_hash


# --------------------------------------------------------------------------
# База резидентов из scripts/residents.csv (выгрузка вкладки «вступившие»)
# --------------------------------------------------------------------------

def load_residents():
    """Возвращает (set_usernames, set_phones) или (None, None), если файла нет."""
    if not os.path.exists(RESIDENTS_CSV):
        return None, None

    # Читаем все строки, ищем строку-заголовок (где есть «телеграм» и «username»/«ник»,
    # либо «телефон»). Google Sheets часто добавляет пустые строки/столбцы сверху.
    with open(RESIDENTS_CSV, "r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))

    header_idx = None
    for i, row in enumerate(rows[:40]):
        joined = " ".join(c.lower() for c in row)
        if ("телеграм" in joined or "telegram" in joined or "username" in joined or "юзернейм" in joined) \
           and ("username" in joined or "ник" in joined or "телеграм" in joined):
            header_idx = i
            break
    if header_idx is None:
        for i, row in enumerate(rows[:40]):
            joined = " ".join(c.lower() for c in row)
            if "телефон" in joined and ("ф.и.о" in joined or "фио" in joined or "имя" in joined):
                header_idx = i
                break
    if header_idx is None:
        print(f"⚠️  {RESIDENTS_CSV} есть, но не нашёл строку-заголовок с колонками "
              f"«Телеграм username» / «Мобильный телефон». Сверку пропускаю.")
        return None, None

    header = [c.strip().lower() for c in rows[header_idx]]

    def find_col(*keywords):
        for j, name in enumerate(header):
            if all(k in name for k in keywords):
                return j
        return None

    u_col = find_col("телеграм", "username") or find_col("телеграм") or find_col("username") \
        or find_col("юзернейм") or find_col("ник")
    p_col = find_col("мобильн", "телефон") or find_col("телефон")

    usernames, phones = set(), set()
    for row in rows[header_idx + 1:]:
        if not any(c.strip() for c in row):
            continue
        if u_col is not None and u_col < len(row):
            u = norm_username(row[u_col])
            if u:
                usernames.add(u)
        if p_col is not None and p_col < len(row):
            p = norm_phone(row[p_col])
            if p:
                phones.add(p)

    print(f"База резидентов: {len(usernames)} username, {len(phones)} телефонов "
          f"(из {RESIDENTS_CSV}).")
    return usernames, phones


# --------------------------------------------------------------------------
# Основная логика
# --------------------------------------------------------------------------

async def pick_groups(client):
    """Показывает список групп и даёт выбрать номера (или «все»)."""
    dialogs = []
    async for d in client.iter_dialogs():
        if d.is_group:  # обычные группы и супергруппы, без каналов-рассылок
            dialogs.append(d)

    if not dialogs:
        print("Не нашёл ни одной группы в твоём аккаунте.")
        return []

    print("\nТвои группы:\n")
    for i, d in enumerate(dialogs, 1):
        uname = f" @{d.entity.username}" if getattr(d.entity, "username", None) else ""
        print(f"  {i:>3}. {d.name}{uname}")
    print()
    raw = input("Введи номера нужных групп через запятую (или слово «все»): ").strip().lower()

    if raw in ("все", "all", "*"):
        return dialogs
    chosen = []
    for part in re.split(r"[,\s]+", raw):
        if part.isdigit() and 1 <= int(part) <= len(dialogs):
            chosen.append(dialogs[int(part) - 1])
    if not chosen:
        print("Ничего не выбрал — выходим.")
    return chosen


async def dump_group(client, dialog, res_usernames, res_phones):
    title = dialog.name
    slug = slugify(title)
    members = []
    async for user in client.iter_participants(dialog.entity):
        if not isinstance(user, User) or user.bot or user.deleted:
            continue
        members.append({
            "user_id": user.id,
            "username": (user.username or "").lower(),
            "first_name": user.first_name or "",
            "last_name": user.last_name or "",
            "phone": user.phone or "",  # обычно пусто: телефон виден только у контактов
            "is_premium": bool(getattr(user, "premium", False)),
        })

    os.makedirs(OUT_DIR, exist_ok=True)
    members_path = os.path.join(OUT_DIR, f"members_{slug}.csv")
    with open(members_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(members[0].keys()) if members else
                           ["user_id", "username", "first_name", "last_name", "phone", "is_premium"])
        w.writeheader()
        w.writerows(members)

    print(f"\n─── {title} ───")
    print(f"Участников (без ботов): {len(members)}  →  {members_path}")

    all_handles = ["@" + m["username"] for m in members if m["username"]]
    no_handle = len(members) - len(all_handles)
    print(f"С @username: {len(all_handles)}, без @username: {no_handle}")
    if all_handles:
        print("\nВесь список @username (можно целиком вставить боту после /match):")
        print(" ".join(all_handles))

    if res_usernames is None:
        print("Сверка с резидентами пропущена (нет scripts/residents.csv).")
        return

    residents, invite, manual = [], [], []
    for m in members:
        u = norm_username(m["username"])
        p = norm_phone(m["phone"])
        is_resident = (u and u in res_usernames) or (p and p in res_phones)
        name = (m["first_name"] + " " + m["last_name"]).strip() or f"id{m['user_id']}"
        if is_resident:
            residents.append((name, u))
        elif u:
            invite.append((name, u))
        else:
            manual.append((name, m["user_id"]))

    xref_path = os.path.join(OUT_DIR, f"crossref_{slug}.csv")
    with open(xref_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["status", "name", "username", "user_id"])
        for name, u in residents:
            w.writerow(["резидент", name, ("@" + u) if u else "", ""])
        for name, u in invite:
            w.writerow(["пригласить", name, "@" + u, ""])
        for name, uid in manual:
            w.writerow(["проверить_вручную", name, "", uid])

    print(f"  ✅ уже резиденты:          {len(residents)}")
    print(f"  ✉️  не резиденты (есть @):  {len(invite)}   ← список на приглашение")
    print(f"  ❓ без @username:           {len(manual)}   ← проверить вручную")
    print(f"  Подробно: {xref_path}")

    if invite:
        print("\n  Кому слать приглашение (скопируй строку целиком):")
        print("  " + " ".join("@" + u for _, u in invite))


def _drop_session():
    for suffix in (".session", ".session-journal"):
        try:
            os.remove(SESSION_PATH + suffix)
        except OSError:
            pass


async def main():
    api_id, api_hash = load_config()
    client = TelegramClient(SESSION_PATH, api_id, api_hash)

    try:
        await client.connect()

        if not await client.is_user_authorized():
            print("\nВход в Telegram (нужен один раз).")
            phone = input("Номер телефона как в Telegram, в формате +79XXXXXXXXX: ").strip()
            await client.send_code_request(phone)
            code = input("Код подтверждения (придёт сообщением в Telegram): ").strip()
            try:
                await client.sign_in(phone, code)
            except SessionPasswordNeededError:
                pw = getpass("Пароль двухэтапной проверки (не отображается при вводе): ")
                await client.sign_in(password=pw)
            print("Готово, вошли. Сессия сохранена — в следующий раз вход не потребуется.\n")
    except ApiIdPublishedFloodError:
        await client.disconnect()
        _drop_session()
        print("\nTelegram не принял встроенный ключ (такое бывает).")
        print("Нужен свой: https://my.telegram.org → войти → «API development tools» →")
        print("создать приложение (название и краткое имя — kodrosta, платформа — Рабочий стол) →")
        print("скопировать api_id и api_hash. Потом запусти скрипт заново и вставь их.")
        sys.exit(1)
    except FloodWaitError as e:
        await client.disconnect()
        mins = (e.seconds + 59) // 60
        print(f"\nTelegram просит подождать ещё ~{mins} мин перед следующей попыткой входа.")
        print("Это временно. Запусти скрипт снова позже.")
        sys.exit(1)

    res_usernames, res_phones = load_residents()
    groups = await pick_groups(client)
    for d in groups:
        try:
            await dump_group(client, d, res_usernames, res_phones)
        except Exception as e:
            print(f"  ! Не смог обработать «{d.name}»: {e}")

    await client.disconnect()
    print("\nВсё. Файлы — в папке scripts/out/")


if __name__ == "__main__":
    asyncio.run(main())
