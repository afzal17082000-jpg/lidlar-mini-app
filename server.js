const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { getLeadsCollection, getEmployeesCollection } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '';

// Validates Telegram WebApp initData per Telegram's documented HMAC scheme,
// so only requests coming from your real bot's Mini App are trusted.
function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const pairs = [];
    for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      pairs.push(`${key}=${value}`);
    }
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) return null;

    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch (e) {
    return null;
  }
}

// Returns the validated Telegram user object ({id, first_name, ...}) or null
// if the request isn't coming from a real Telegram Mini App session.
function getTelegramUser(req) {
  const initData = req.header('X-Telegram-Init-Data');
  return validateInitData(initData);
}

function getEmployeeName(req) {
  const user = getTelegramUser(req);
  if (user) {
    return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || ('User ' + user.id);
  }
  // Fallback for local testing outside Telegram (see README).
  return req.header('X-Dev-Name') || "Noma'lum";
}

function uid() {
  return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtmlServer(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- Telegram notifications ----------
async function sendTelegramMessage(chatId, text) {
  if (!chatId || !BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('Telegramga xabar yuborishda xatolik:', e.message);
  }
}

function notifyGroup(text) {
  return sendTelegramMessage(GROUP_CHAT_ID, text);
}

function notifyUser(telegramId, text) {
  return sendTelegramMessage(telegramId, text);
}

const STATUS_LABELS = {
  yangi: "Yangi",
  boglanildi: "Bog'lanildi",
  muzokara: "Muzokarada",
  followup: "Follow up",
  buyurtma: "Buyurtma berdi",
  yetkazildi: "Yetkazildi",
};

const ROLE_LABELS = {
  sotuvchi: "Sotuvchi",
  marketolog: "Marketolog",
  taminotchi: "Ta'minotchi",
  rop: "ROP",
};

// ================= Employees (registration) =================

// Returns { registered: true/false, employee? }.
// If the request isn't from a real Telegram session (local testing), registration is skipped.
app.get('/api/employees/me', async (req, res) => {
  const user = getTelegramUser(req);
  if (!user) {
    return res.json({ registered: true, skipped: true });
  }
  try {
    const col = await getEmployeesCollection();
    const employee = await col.findOne({ telegramId: user.id }, { projection: { _id: 0 } });
    if (!employee) return res.json({ registered: false });
    res.json({ registered: true, employee });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bazaga ulanishda xatolik' });
  }
});

app.post('/api/employees', async (req, res) => {
  const user = getTelegramUser(req);
  if (!user) {
    return res.status(400).json({ error: "Ro'yxatdan o'tish faqat Telegram orqali mumkin" });
  }
  const { name, role } = req.body || {};
  if (!name || !role || !ROLE_LABELS[role]) {
    return res.status(400).json({ error: "Ism va lavozim to'g'ri kiritilishi kerak" });
  }
  const employee = {
    telegramId: user.id,
    name: String(name).trim(),
    role,
    username: user.username || '',
    registeredAt: Date.now(),
  };
  try {
    const col = await getEmployeesCollection();
    await col.updateOne({ telegramId: user.id }, { $set: employee }, { upsert: true });
    res.json({ ok: true, employee });

    notifyGroup(
      `🆕 <b>Yangi xodim ro'yxatdan o'tdi</b>\n` +
      `👤 ${escapeHtmlServer(employee.name)}\n` +
      `🏷 ${escapeHtmlServer(ROLE_LABELS[role])}`
    );
    notifyUser(
      user.id,
      `✅ <b>Ro'yxatdan muvaffaqiyatli o'tdingiz!</b>\n` +
      `Lavozim: ${escapeHtmlServer(ROLE_LABELS[role])}\n\n` +
      `Endi tizimdan foydalanishingiz mumkin.`
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Saqlashda xatolik' });
  }
});

// ================= Leads =================

app.get('/api/leads', async (req, res) => {
  try {
    const col = await getLeadsCollection();
    const leads = await col.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
    res.json(leads);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bazaga ulanishda xatolik' });
  }
});

app.post('/api/leads', async (req, res) => {
  const user = getTelegramUser(req);

  // Enforce registration for real Telegram sessions.
  if (user) {
    try {
      const empCol = await getEmployeesCollection();
      const employee = await empCol.findOne({ telegramId: user.id });
      if (!employee) {
        return res.status(403).json({ error: "Avval ro'yxatdan o'ting" });
      }
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Bazaga ulanishda xatolik' });
    }
  }

  const { name, phone, source, address, product, comment, leadDate } = req.body || {};
  if (!name || !phone) {
    return res.status(400).json({ error: "Ism va telefon raqami majburiy" });
  }
  const employeeName = getEmployeeName(req);
  const lead = {
    id: uid(),
    name: String(name).trim(),
    phone: String(phone).trim(),
    source: source || '',
    address: address || '',
    product: product || '',
    comment: comment || '',
    leadDate: leadDate || new Date().toISOString().slice(0, 10),
    status: 'yangi',
    createdAt: Date.now(),
    addedBy: employeeName,
    updatedBy: employeeName,
    updatedAt: Date.now(),
    responsibleTelegramId: user ? user.id : null,
  };
  try {
    const col = await getLeadsCollection();
    await col.insertOne({ ...lead });
    res.json(lead);

    notifyGroup(
      `🆕 <b>Yangi lid</b>\n` +
      `👤 ${escapeHtmlServer(lead.name)}\n` +
      `📞 ${escapeHtmlServer(lead.phone)}\n` +
      (lead.source ? `🔗 Manba: ${escapeHtmlServer(lead.source)}\n` : '') +
      (lead.address ? `📍 Manzil: ${escapeHtmlServer(lead.address)}\n` : '') +
      (lead.product ? `🫖 Mahsulot: ${escapeHtmlServer(lead.product)}\n` : '') +
      (lead.comment ? `💬 Natija: ${escapeHtmlServer(lead.comment)}\n` : '') +
      `➕ Qo'shdi: ${escapeHtmlServer(employeeName)}`
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Saqlashda xatolik' });
  }
});

app.patch('/api/leads/:id', async (req, res) => {
  try {
    const col = await getLeadsCollection();
    const employeeName = getEmployeeName(req);
    const update = { updatedBy: employeeName, updatedAt: Date.now() };
    if (typeof req.body.status === 'string') update.status = req.body.status;
    if (typeof req.body.comment === 'string') update.comment = req.body.comment;
    if (typeof req.body.address === 'string') update.address = req.body.address;
    if (typeof req.body.product === 'string') update.product = req.body.product;
    if (typeof req.body.leadDate === 'string') update.leadDate = req.body.leadDate;

    const before = await col.findOne({ id: req.params.id }, { projection: { _id: 0 } });
    const updated = await col.findOneAndUpdate(
      { id: req.params.id },
      { $set: update },
      { returnDocument: 'after', projection: { _id: 0 } }
    );
    if (!updated) return res.status(404).json({ error: 'Lid topilmadi' });
    res.json(updated);

    if (before && update.status && update.status !== before.status) {
      notifyGroup(
        `🔄 <b>Holat o'zgardi</b>\n` +
        `👤 ${escapeHtmlServer(updated.name)} (${escapeHtmlServer(updated.phone)})\n` +
        `${STATUS_LABELS[before.status] || before.status} → <b>${STATUS_LABELS[updated.status] || updated.status}</b>\n` +
        `✏️ Yangiladi: ${escapeHtmlServer(employeeName)}`
      );

      if (update.status === 'followup' && updated.responsibleTelegramId) {
        notifyUser(
          updated.responsibleTelegramId,
          `📞 <b>Eslatma</b>\n` +
          `${escapeHtmlServer(updated.name)} (${escapeHtmlServer(updated.phone)}) ga qo'ng'iroq qilish vaqti keldi!`
        );
      }
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Yangilashda xatolik' });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    const col = await getLeadsCollection();
    await col.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "O'chirishda xatolik" });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server ' + PORT + '-portda ishga tushdi'));
