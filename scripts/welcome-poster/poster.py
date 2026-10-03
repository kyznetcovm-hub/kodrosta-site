from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageFilter
import os
S=2  # масштаб
W,H=1080*S,1350*S
BLUE=(41,110,247); RED=(235,52,74); BLACK=(11,11,12); GRAY=(110,110,115)
F=lambda n,s: ImageFont.truetype(os.path.join(os.path.dirname(os.path.abspath(__file__)),n),s*S)
img=Image.new("RGB",(W,H),"white"); d=ImageDraw.Draw(img)

# фон: крупные фирменные круги по краям
d.ellipse([W-330*S,-260*S,W+250*S,320*S],fill=RED)
d.ellipse([870*S,215*S,1050*S,395*S],fill=BLUE)

# логотип (из favicon-source.svg)
def logo(x,y,sc):
    def P(pts): return [(x+(px*0.95+7)*sc, y+(py*0.95+10.5)*sc) for px,py in pts]
    blob=[(6.07,14.23),(9.13,6.22),(20.19,3.0),(30.77,7.05),(41.35,11.1),(47.45,20.88),(44.38,28.9),(41.31,36.92),(30.25,40.13),(19.67,36.08),(9.09,32.03),(3.0,22.25)]
    # сглаженный блоб — эллипс по габаритам
    xs=[p[0] for p in P(blob)]; ys=[p[1] for p in P(blob)]
    d.ellipse([min(xs),min(ys),max(xs),max(ys)],fill=BLUE)
    z=[(4.40,35.23),(4.31,19.88),(34.67,4.36),(34.75,14.57),(46.14,6.64),(46.14,14.74),(18.06,38.77),(18.06,25.95),(4.40,35.23)]
    d.polygon(P(z),fill=BLACK)
logo(60*S,52*S,1.9*S)
d.text((175*S,78*S),"Код Роста",font=F("unb700.ttf",30),fill=BLACK)

d.text((64*S,200*S),"#СВЕЖАЯКРОВЬ",font=F("unb700.ttf",30),fill=RED)
d.text((64*S,250*S),"Наше сообщество\nусилили",font=F("unb700.ttf",60),fill=BLACK,spacing=8*S)
d.text((64*S,410*S),"12 предпринимателей",font=F("unb700.ttf",60),fill=BLUE)
d.text((66*S,495*S),"Сентябрь 2026",font=F("int500.ttf",28),fill=GRAY)

people=[("Дамир","Зиятдинов","DamirZiyatdinov"),("Евгений","Маёров","e_mayorov"),("Анастасия","Насибуллина","Bushido8888"),("Тагир","Ахмеров","Tagir_Akhmerov"),
("Николай","Никифоров","nikiforovevent"),("Илья","Аксенов","iaksenov"),("Айгуль","Гареева","AygulyGA"),("Алия","Нигметзянова","Aliya_Orange"),
("Анна","Ивченко","a_ivchenco"),("Эльвира","Хайбулина","Buh_proff"),("Рушан","Садреев","rushhh921"),("Кирилл","Миленький","Milenkij")]
R=78*S; cols=4; x0=64*S; cw=(W-2*x0)//cols; y0=575*S; rh=232*S
for i,(fn,ln,u) in enumerate(people):
    cx=x0+cw*(i%cols)+cw//2; cy=y0+rh*(i//cols)+R
    acc=RED if (i%cols+i//cols)%2==0 else BLUE
    off=14*S
    d.ellipse([cx-R+off,cy-R+off,cx+R+off,cy+R+off],fill=acc)
    p=f"av-2026-09/{u}.jpg"
    if os.path.exists(p):
        a=ImageOps.fit(Image.open(p).convert("L"),(2*R,2*R),Image.LANCZOS)
        a=ImageOps.autocontrast(a,cutoff=1).convert("RGB")
    else:
        a=Image.new("RGB",(2*R,2*R),(232,232,235)); ad=ImageDraw.Draw(a)
        ad.text((R,R),fn[0]+ln[0],font=F("unb700.ttf",46),fill=(150,150,155),anchor="mm")
    m=Image.new("L",(2*R*4,2*R*4),0); ImageDraw.Draw(m).ellipse([0,0,2*R*4-1,2*R*4-1],fill=255); m=m.resize((2*R,2*R),Image.LANCZOS)
    img.paste(a,(cx-R,cy-R),m)
    d.text((cx,cy+R+22*S),fn,font=F("int700.ttf",22),fill=BLACK,anchor="mt")
    d.text((cx,cy+R+50*S),ln,font=F("int500.ttf",20),fill=GRAY,anchor="mt")

d.text((64*S,H-48*S),"codrosta.club",font=F("int700.ttf",26),fill=BLUE,anchor="ls")
img.save("/Users/admin/Claude/kodrosta-site/svezhaya-krov-2026-09.png")
