import asyncio
from telethon import TelegramClient
S="/Users/admin/Claude/kodrosta-site/scripts/kodrosta_session"
users="DamirZiyatdinov Bushido8888 iaksenov Aliya_Orange a_ivchenco rushhh921".split()
async def main():
    async with TelegramClient(S,2040,"b18441a1ff607e10a989891a5462e627") as c:
        if not await c.is_user_authorized(): print("NOT AUTHORIZED"); return
        for u in users:
            try:
                p=await c.download_profile_photo(u,file=f"{u}.jpg",download_big=True)
                print(u,p)
            except Exception as e: print(u,"ERR",e)
asyncio.run(main())
