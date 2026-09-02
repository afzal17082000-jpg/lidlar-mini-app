# Lidlar — Telegram Mini App (jamoaviy)

Bitta server barcha xodimlar uchun umumiy lidlar ro'yxatini saqlaydi. Har bir lidga
kim qo'shgani va kim oxirgi marta o'zgartirgani avtomatik yoziladi (Telegram
akkauntidan olinadi — xodim hech narsa kiritmaydi).

Ma'lumotlar **MongoDB Atlas**'da (haqiqiy bepul, muddati tugamaydigan baza) saqlanadi,
server esa **Render.com**'da (bepul, kartasiz) ishlaydi.

## Loyihadagi fayllar

- `server.js` — API va Mini App sahifasini beruvchi Express server
- `db.js` — MongoDB'ga ulanish
- `public/index.html` — Mini App interfeysi
- `.env.example` — kerakli environment o'zgaruvchilar namunasi

## 1. Botni yaratish (agar hali yo'q bo'lsa)

1. Telegram'da **@BotFather** ga kiring
2. `/newbot` → nom va username bering
3. Sizga beriladigan **tokenni** saqlab qo'ying (masalan `123456:AAExxxx...`)

## 2. MongoDB Atlas'da bepul baza yaratish

1. [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register) — ro'yxatdan o'ting (kredit karta shart emas)
2. Yangi loyiha yaratilgach, **"Deploy a cluster"** bosing → **M0 (Free)** tarifini tanlang → **Create**
3. **Security Quickstart** oynasida:
   - Username va parol o'rnating (buni saqlab qo'ying)
   - **"My Local Environment"** o'rniga **"Allow access from anywhere"** (0.0.0.0/0) tanlang — server har xil manzildan ulanadi
4. Cluster tayyor bo'lgach, **"Connect"** → **"Drivers"** ni bosing
5. Ko'rsatilgan ulanish satrini (connection string) nusxalang — u shunday ko'rinishda bo'ladi:
   ```
   mongodb+srv://username:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. `<password>` o'rniga haqiqiy parolingizni yozing — bu sizning `MONGODB_URI` qiymatingiz

## 3. GitHub'ga yuklash

Oldingi xabarimda ko'rsatilgan qadamlar bo'yicha ushbu papkani GitHub'ga yuklang.

## 4. Render'ga deploy qilish (bepul, kartasiz)

1. [render.com](https://render.com) ga kiring, GitHub akkauntingiz bilan ro'yxatdan o'ting
2. **New → Web Service** → GitHub repo'ingizni tanlang
3. Sozlamalar:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. **Environment** bo'limida qo'shing:
   - `BOT_TOKEN` = BotFather'dan olgan tokeningiz
   - `MONGODB_URI` = 2-qadamda olgan ulanish satringiz
5. **Create Web Service** ni bosing — bir necha daqiqada deploy bo'ladi
6. Deploy tugagach, yuqorida `https://...onrender.com` ko'rinishidagi URL chiqadi

**Eslatma:** Render bepul tarifida server 15 daqiqa foydalanilmasa "uxlab qoladi" va
keyingi ochilishda 30–60 soniya kutish kerak bo'lishi mumkin. Bu — bepul tarifning
tabiiy cheklovi, ma'lumotlarga hech qanday zarar yetkazmaydi (baza alohida, doim ishlaydi).

## 5. Mini App'ni botga ulash

1. **@BotFather** → `/mybots` → botingizni tanlang
2. **Bot Settings → Menu Button**
3. 4-qadamda olgan Render URL'ini kiriting
4. Tugma nomini bering, masalan: "Lidlar"

Tayyor. Botni oching — pastda "Lidlar" tugmasi chiqadi, bosilganda barcha xodimlar
bitta umumiy ro'yxatni ko'radi.

## Mahalliy kompyuterda sinab ko'rish (ixtiyoriy)

```bash
npm install
cp .env.example .env   # BOT_TOKEN va MONGODB_URI'ni kiriting
npm start
```

`http://localhost:3000` manzilida ochiladi. Telegram tashqarisida ochilgani uchun
xodim ismi aniqlanmaydi va "Noma'lum" deb yoziladi — bu normal, faqat Telegram
ichida ochilganda haqiqiy ism ko'rinadi.

## Eslatma

- MongoDB Atlas M0 tarifi 512 MB gacha bepul va muddatsiz — kichik-o'rta jamoa uchun yetarli.
- `BOT_TOKEN` va `MONGODB_URI` — sirlar. Ularni hech qachon ochiq GitHub repo'ga
  yozmang (`.env` fayli `.gitignore`'da allaqachon istisno qilingan), faqat
  Render'ning Environment bo'limida saqlang.
