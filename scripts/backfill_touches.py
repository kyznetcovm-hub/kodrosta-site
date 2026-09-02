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
# Название сессии — первым аргументом: python3 backfill_touches.py kodrosta_official
# (для другого аккаунта, например @Kodrosta). Без аргумента — обычная личная сессия,
# та же, что у dump_group_members.py, повторно логиниться не надо.
SESSION_NAME = sys.argv[1] if len(sys.argv) > 1 else "kodrosta_session"
SESSION_PATH = os.path.join(HERE, SESSION_NAME)
OUT_DIR = os.path.join(HERE, "out")

try:
    from telethon import TelegramClient
    from telethon.errors import SessionPasswordNeededError, ApiIdPublishedFloodError, FloodWaitError
    from telethon.tl.types import User, Message
    from telethon.tl.functions.messages import GetForumTopicsRequest
except ImportError as e:
    print(
        f"\nНе смог импортировать Telethon ({e}).\n"
        "Если библиотека точно установлена — это, вероятно, баг в скрипте (несовпадение "
        "версии Telethon), напишите разработчику с текстом ошибки выше.\n"
        "Если не установлена — выполни в Терминале одну команду и запусти скрипт заново:\n\n"
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
            peer=entity, offset_date=None, offset_id=0, offset_topic=offset_topic, limit=100,
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
    slug = slugify(title) + "_" + str(entity.id)  # id в имени — чтобы одноимённые чаты не затирали друг друга

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
    topic_msg_counts = {}    # topic_id -> сколько сообщений реально встретилось — проверить, что все темы разобрались

    count = 0
    async for message in client.iter_messages(entity, reverse=True):
        count += 1
        if count % 1000 == 0:
            print(f"  …обработано сообщений: {count}")

        if not isinstance(message, Message):
            continue  # служебное сообщение (вступление/выход/смена фото и т.п.)
        sender_id = message.sender_id
        if not sender_id:
            continue  # аноним-канал и т.п. — определить человека невозможно

        if sender_id in people:
            username, first_name, last_name = people[sender_id]
        else:
            # отправителя уже нет среди текущих участников (кикнули/вышел после
            # мероприятия) — берём данные прямо из самого сообщения, а не из
            # списка участников, иначе вся его история молча пропадёт
            sender = message.sender or await message.get_sender()
            if not isinstance(sender, User) or sender.bot or sender.deleted:
                continue
            username, first_name, last_name = (sender.username or "").lower(), sender.first_name or "", sender.last_name or ""
            people[sender_id] = (username, first_name, last_name)

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

        topic_msg_counts[topic_id] = topic_msg_counts.get(topic_id, 0) + 1

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

    if is_forum:
        print("\nСообщений по темам (проверка, что разобрались все):")
        empty_topics = []
        for tid, ttitle in topics.items():
            n = topic_msg_counts.get(tid, 0)
            if n:
                print(f"  {ttitle}: {n}")
            else:
                empty_topics.append(ttitle)
        unknown = sum(n for tid, n in topic_msg_counts.items() if tid not in topics)
        if unknown:
            print(f"  (тема не опознана по названию, но сообщения учтены: {unknown})")
        if empty_topics:
            print(f"  Без сообщений вообще (или тема создана позже последнего сообщения): {', '.join(empty_topics)}")


PHONE_RE = re.compile(r"\+?\d[\d\s()\-]{9,}\d")


def normalize_phone(raw):
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 11 and digits.startswith("8"):
        return "7" + digits[1:]
    if len(digits) == 11 and digits.startswith("7"):
        return digits
    if len(digits) == 10:
        return "7" + digits
    return None


async def dump_phone_touches(client, dialog):
    """Режим для старого чата, куда САЙТ ПРИСЫЛАЛ ТЕКСТОМ заявки (имя+телефон) —
    участники группы тут ни при чём, телефон нужно вытащить из текста сообщения."""
    entity = dialog.entity
    title = dialog.name
    slug = slugify(title) + "_" + str(entity.id)
    print(f"\n─── {title} (телефоны из текста сообщений) ───")

    rows = []
    count = 0
    no_phone = 0
    async for message in client.iter_messages(entity, reverse=True):
        count += 1
        if count % 1000 == 0:
            print(f"  …обработано сообщений: {count}")
        if not isinstance(message, Message):
            continue
        text = (message.message or "").strip()
        if not text:
            continue
        m = PHONE_RE.search(text)
        if not m:
            no_phone += 1
            continue
        phone = normalize_phone(m.group())
        if not phone:
            continue
        ts = message.date.astimezone(timezone.utc).isoformat()
        snippet = text.replace("\n", " ")[:120]
        rows.append((phone, "apply", snippet, ts))

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, f"phones_{slug}.csv")
    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["phone", "kind", "note", "ts"])
        w.writerows(rows)
    print(f"\nВсего сообщений: {count}, с телефоном: {len(rows)}, без телефона: {no_phone}  →  {out_path}")


async def dump_dm_touches(client):
    """Личные диалоги: считаем касанием последнее ВХОДЯЩЕЕ сообщение — то есть
    человек написал вам, а не наоборот. Если самое последнее сообщение в диалоге —
    ваше (например, переписка закончилась на вашей реплике, хотя человек ответил
    парой часов раньше), заглядываем в последние ~20 сообщений и берём оттуда
    последнее входящее — иначе такой диалог молча терялся бы целиком. Полную
    историю не читаем (только этот небольшой хвост), содержимое переписки никуда
    не идёт — только сам факт и дата. Сопоставление с базой резидентов — на этапе
    загрузки; всё, что не совпало с резидентом, отбрасывается и нигде не остаётся."""
    print("\n─── Личные диалоги (входящие сообщения) ───")
    rows = []
    total = 0
    skipped_no_incoming = 0
    checked = 0
    async for d in client.iter_dialogs():
        if not d.is_user:
            continue
        entity = d.entity
        if not isinstance(entity, User) or entity.bot or entity.deleted or getattr(entity, "is_self", False):
            continue
        total += 1
        msg = d.message

        if msg and not msg.out:
            last_incoming = msg
        elif msg and msg.out:
            # последнее сообщение — ваше; ищем последнее входящее в недавнем хвосте
            checked += 1
            if checked % 100 == 0:
                print(f"  …проверено диалогов с исходящим последним сообщением: {checked}")
            last_incoming = None
            async for m in client.iter_messages(entity, limit=20):
                if not m.out:
                    last_incoming = m
                    break
        else:
            last_incoming = None

        if not last_incoming:
            skipped_no_incoming += 1
            continue

        username = (entity.username or "").lower()
        ts = last_incoming.date.astimezone(timezone.utc).isoformat()
        rows.append((entity.id, username, entity.first_name or "", entity.last_name or "", "dm", None, ts))

    os.makedirs(OUT_DIR, exist_ok=True)
    me = await client.get_me()
    slug = "dm_" + (me.username or str(me.id))
    out_path = os.path.join(OUT_DIR, f"touches_{slug}.csv")
    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["telegram_user_id", "username", "first_name", "last_name", "kind", "note", "ts"])
        w.writerows(rows)
    print(f"Личных диалогов: {total}, найдено входящее (сразу или в хвосте): {len(rows)}, без входящих в хвосте: {skipped_no_incoming}  →  {out_path}")


async def dump_event_signups(client, dialog):
    """Режим для группы мероприятия: сам факт участия = регистрация, без разбора сообщений."""
    entity = dialog.entity
    title = dialog.name
    slug = slugify(title) + "_" + str(entity.id)  # id в имени — чтобы одноимённые чаты не затирали друг друга
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

    dm_answer = input("\nРазобрать личные диалоги (входящие сообщения от людей)? (да/нет): ").strip().lower()
    if dm_answer in ("да", "d", "y", "yes", "1", "ага", "угу"):
        await dump_dm_touches(client)

    groups = await pick_groups(client)
    for d in groups:
        print("\nЧто это за группа?")
        print("  1. Клубный чат резидентов (или похожий) — разобрать всю историю сообщений по темам")
        print("  2. Группа мероприятия — участники группы это уже регистрация")
        print("  3. Старый чат сайта — заявки текстом (имя+телефон), участники группы тут не при чём")
        mode = input("Номер: ").strip()
        try:
            if mode == "2":
                await dump_event_signups(client, d)
            elif mode == "3":
                await dump_phone_touches(client, d)
            else:
                await dump_touches(client, d)
        except Exception as e:
            print(f"  ! Не смог обработать «{d.name}»: {e}")

    await client.disconnect()
    print("\nГотово. Дальше пришли файл(ы) из scripts/out/ — загружу в базу.")


if __name__ == "__main__":
    asyncio.run(main())
