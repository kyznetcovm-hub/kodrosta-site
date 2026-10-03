#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Разовая выгрузка заявок НА ВСТУПЛЕНИЕ из старого чата «Бот сайта Код Роста».

Берёт из чата только сообщения вида:

    🔔‌Заявка на вступление🔔

    Имя: ...
    Телефон: ...
    Деятельность: ...
    Сообщение:
    ИНН: ...

Записи «🔔‌Запись на мероприятие …», «Форма обратной связи» и обычную переписку
людей — игнорирует.

Использует ту же сохранённую сессию личного аккаунта, что и остальные скрипты
в этой папке (scripts/kodrosta_session.session) — повторно логиниться не надо.

Результат:
    scripts/out/join_requests.csv   — колонки: date, name, phone, phone10, inn, activity, msg_id
"""

import asyncio
import csv
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SESSION_PATH = os.path.join(HERE, "kodrosta_session")
OUT_DIR = os.path.join(HERE, "out")

BUILTIN_API_ID = 2040
BUILTIN_API_HASH = "b18441a1ff607e10a989891a5462e627"

CHAT_ID = 2081174452          # «Бот сайта Код Роста»
MARKER = "Заявка на вступление"

from telethon import TelegramClient


def field(text, label):
    """Значение строки вида 'Label: value' (первое вхождение)."""
    m = re.search(rf"^{label}\s*:\s*(.+)$", text, re.MULTILINE)
    return m.group(1).strip() if m else ""


def parse_inn(text):
    m = re.search(r"ИНН\s*:\s*([\d\s]+)", text)
    return re.sub(r"\s+", "", m.group(1)) if m else ""


def phone10(raw):
    d = re.sub(r"\D", "", raw or "")
    return d[-10:] if len(d) >= 10 else ""


async def main():
    client = TelegramClient(SESSION_PATH, BUILTIN_API_ID, BUILTIN_API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        print("Сессия не авторизована — запусти сначала dump_group_members.py и войди.")
        sys.exit(1)

    ent = await client.get_entity(CHAT_ID)
    rows = []
    async for m in client.iter_messages(ent):
        t = m.message or ""
        if MARKER not in t:
            continue
        rows.append({
            "date": m.date.astimezone().strftime("%Y-%m-%d"),
            "name": field(t, "Имя"),
            "phone": field(t, "Телефон"),
            "phone10": phone10(field(t, "Телефон")),
            "inn": parse_inn(t),
            "activity": field(t, "Деятельность"),
            "msg_id": m.id,
        })
    await client.disconnect()

    rows.sort(key=lambda r: r["date"])
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "join_requests.csv")
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["date", "name", "phone", "phone10", "inn", "activity", "msg_id"])
        w.writeheader()
        w.writerows(rows)

    print(f"Заявок на вступление: {len(rows)}")
    print(f"Файл: {path}")


if __name__ == "__main__":
    asyncio.run(main())
