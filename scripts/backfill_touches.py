#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Разбор истории переписки Telegram-группы клуба «Код Роста» на касания
(для отчёта о вовлечённости), задним числом — до включения бота на вебхуке.

Зачем это нужно
---------------
Бот (через Bot API) видит только сообщения, отправленные ПОСЛЕ включения
вебхука — историю переписки за прошлые месяцы Telegram ботам не отдаёт.
Прочитать её может только личный аккаунт, который состоит в группе. Этот
скрипт заходит в Telegram под тем же сохранённым входом, что и
dump_group_members.py (повторно логиниться не нужно), проходит по всей
истории выбранной группы — включая ВСЕ темы форума по отдельности — и
раскладывает сообщения на касания:

  message     — сообщение в общем счёт (не чаще 1 в день на человека)
  reply       — ответ на чьё-то сообщение
  question    — сообщение со знаком «?»
  visit_card  — любое сообщение в теме, где в названии есть «знаком»
                (тема «Знакомство с резидентами») — считается один раз
                на человека, это факт «представился», а не активность
  event_signup — вступление в ГРУППУ МЕРОПРИЯТИЯ (не в клубный чат) само
                по себе, без сообщений — это делает отдельный режим ниже

Результат — CSV в scripts/out/, привязку к резиденту (по @username) и
загрузку в D1 скрипт не делает сам: это отдельный шаг через Cloudflare API,
чтобы не дублировать логику сопоставления, которая уже есть в src/engagement.js.

Запуск
------
    cd /Users/admin/Claude/kodrosta-site && python3 scripts/backfill_touches.py

Результаты — в scripts/out/touches_<группа>.csv
"""

import asyncio
import csv
import os
import re
import sys
from datetime import timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "kodrosta_config.json")
SESSION_PATH = os.path.join(HERE, "kodrosta_session")  # тот же файл, что у dump_group_members.py
OUT_DIR = os.path.join(HERE, "out")

try:
    from telethon import TelegramClient
    from telethon.errors import SessionPasswordNeededError, ApiIdPublishedFloodError, FloodWaitError
    from telethon.tl.types import User, Message
    from telethon.tl.functions.channels import GetForumTopicsRequest
except ImportError:
    print(
        "\nНе установлена библиотека Telethon.\n"
        "Выполни в Терминале одну команду и запусти скрипт заново:\n\n"
        "    python3 -m pip install --user telethon\n"
    )
    sys.exit(1)

import json

# Публичный ключ официального клиента Telegram Desktop — см. dump_group_members.py.
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
    api_id = input("api_id (или Enter для встроенного): ").strip()
    if not api_id:
        return BUILTIN_API_ID, BUILTIN_API_HASH
    api_hash = input("Теперь вставь api_hash (длинная строка): ").strip()
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump({"api_id": int(api_id), "api_hash": api_hash}, f, indent=2)
    return int(api_id), api_hash


def slugify(title):
    s = re.sub(r"[^\w\-]+", "_", str(title).strip(), flags=re.UNICODE)
    return s.strip("_")[:60] or "group"


async def pick_groups(client):
    dialogs = []
    async for d in client.iter_dialogs():
        if d.is_group:
            dialogs.append(d)
    if not dialogs:
        print("Не нашёл ни одной группы в твоём аккаунте.")
        return []
    print("\nТвои группы:\n")
    for i, d in enumerate(dialogs, 1):
        forum = " [форум/темы]" if getattr(d.entity, "forum", False) else ""
        print(f"  {i:>3}. {d.name}{forum}")
    print()
    raw = input("Введи номер группы (по одной за раз): ").strip()
    for part in re.split(r"[,\s]+", raw):
        if part.isdigit() and 1 <= int(part) <= len(dialogs):
            return [dialogs[int(part) - 1]]
    print("Не понял номер — выходим.")
    return []


async def build_participants_map(client, entity):
    """id -> (username, first_name, last_name), чтобы не резолвить отправителя на каждое сообщение."""
    people = {}
    async for user in client.iter_participants(entity):
        if isinstance(user, User):
            people[user.id] = (
                (user.username or "").lower(),
                user.first_name or "",
                user.last_name or "",
            )
    return people


async def get_topics_map(client, entity):
    """topic_id -> title. Для не-форумов — пусто (все сообщения в одной "теме" по умолчанию)."""
    topics = {1: "Основная"}  # General — обычно не приходит отдельной записью
    if not getattr(entity, "forum", False):
        return topics
    offset_topic = 0
    while True:
        res = await client(GetForumTopicsRequest(
            channel=entity, offset_date=0, offset_id=0, offset_topic=offset_topic, limit=100,
        ))
        if not res.topics:
            break
        for t in res.topics:
            title = getattr(t, "title", None)
            if title:
                topics[t.id] = title
        if len(res.topics) < 100:
            break
        offset_topic = res.topics[-1].id
    return topics


async def dump_touches(client, dialog):
    entity = dialog.entity
    title = dialog.name
    slug = slugify(title)

    print(f"\n─── {title} ───")
    print("Читаю участников (для сопоставления отправителей)…")
    people = await build_participants_map(client, entity)

    is_forum = getattr(entity, "forum", False)
    topics = await get_topics_map(client, entity) if is_forum else {}
    intro_topic_ids = {tid for tid, t in topics.items() if "знаком" in t.lower()}
    if is_forum:
        print(f"Тем форума: {len(topics)}" + (f", тема «знакомства»: {[topics[i] for i in intro_topic_ids]}" if intro_topic_ids else " (тему «знакомство» не нашёл — visit_card не будет)"))

    rows = []
    last_message_day = {}   # user_id -> "YYYY-MM-DD", для дедупа kind=message раз в день
    seen_visit_card = set()  # user_id, кому уже засчитали visit_card

    count = 0
    async for message in client.iter_messages(entity, reverse=True):
        count += 1
        if count % 1000 == 0:
            print(f"  …обработано сообщений: {count}")

        if not isinstance(message, Message):
            continue  # служебное сообщение (вступление/выход/смена фото и т.п.)
        sender_id = message.sender_id
        if not sender_id or sender_id not in people:
            continue  # бот, аноним-канал или уже вышедший из группы (нет в участниках)
        username, first_name, last_name = people[sender_id]

        text = (message.message or "").strip()
        has_media_no_text = bool(message.media) and not text

        topic_id = 1
        is_reply = False
        rt = message.reply_to
        if rt:
            if getattr(rt, "forum_topic", False):
                topic_id = rt.reply_to_top_id or rt.reply_to_msg_id or 1
                if rt.reply_to_msg_id and rt.reply_to_msg_id != topic_id:
                    is_reply = True
            elif rt.reply_to_msg_id:
                is_reply = True

        if not text and not has_media_no_text:
            continue  # совсем пустое служебное — пропускаем

        ts = message.date.astimezone(timezone.utc).isoformat()
        day = ts[:10]

        if topic_id in intro_topic_ids:
            if sender_id not in seen_visit_card:
                seen_visit_card.add(sender_id)
                rows.append((sender_id, username, first_name, last_name, "visit_card", topics.get(topic_id), ts))
        else:
            if last_message_day.get(sender_id) != day:
                last_message_day[sender_id] = day
                rows.append((sender_id, username, first_name, last_name, "message", None, ts))

        if is_reply:
            rows.append((sender_id, username, first_name, last_name, "reply", None, ts))
        elif "?" in text:
            rows.append((sender_id, username, first_name, last_name, "question", None, ts))

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, f"touches_{slug}.csv")
    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["telegram_user_id", "username", "first_name", "last_name", "kind", "note", "ts"])
        w.writerows(rows)

    by_kind = {}
    for r in rows:
        by_kind[r[4]] = by_kind.get(r[4], 0) + 1
    print(f"\nВсего сообщений просмотрено: {count}")
    print(f"Касаний получилось: {len(rows)}  →  {out_path}")
    for k, n in sorted(by_kind.items()):
        print(f"  {k}: {n}")
    no_username = sum(1 for r in rows if not r[1])
    if no_username:
        print(f"  (из них без @username — не сопоставится с резидентом при загрузке: {no_username})")


async def dump_event_signups(client, dialog):
    """Режим для группы мероприятия: сам факт участия = регистрация, без разбора сообщений."""
    entity = dialog.entity
    title = dialog.name
    slug = slugify(title)
    print(f"\n─── {title} (регистрация на мероприятие) ───")

    rows = []
    async for user in client.iter_participants(entity):
        if not isinstance(user, User) or user.bot or user.deleted:
            continue
        rows.append((user.id, (user.username or "").lower(), user.first_name or "", user.last_name or "",
                     "event_signup", title, ""))

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, f"touches_{slug}.csv")
    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["telegram_user_id", "username", "first_name", "last_name", "kind", "note", "ts"])
        w.writerows(rows)
    print(f"Участников: {len(rows)}  →  {out_path}")


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
                from getpass import getpass
                pw = getpass("Пароль двухэтапной проверки (не отображается при вводе): ")
                await client.sign_in(password=pw)
    except ApiIdPublishedFloodError:
        await client.disconnect()
        _drop_session()
        print("\nTelegram не принял встроенный ключ. Нужен свой — см. scripts/README.md.")
        sys.exit(1)
    except FloodWaitError as e:
        await client.disconnect()
        mins = (e.seconds + 59) // 60
        print(f"\nTelegram просит подождать ещё ~{mins} мин. Запусти скрипт снова позже.")
        sys.exit(1)

    groups = await pick_groups(client)
    for d in groups:
        print("\nЧто это за группа?")
        print("  1. Клубный чат резидентов (или похожий) — разобрать всю историю сообщений по темам")
        print("  2. Группа мероприятия — участники группы это уже регистрация")
        mode = input("Номер: ").strip()
        try:
            if mode == "2":
                await dump_event_signups(client, d)
            else:
                await dump_touches(client, d)
        except Exception as e:
            print(f"  ! Не смог обработать «{d.name}»: {e}")

    await client.disconnect()
    print("\nГотово. Дальше пришли файл(ы) из scripts/out/ — загружу в базу.")


if __name__ == "__main__":
    asyncio.run(main())
