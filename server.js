const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { getLeadsCollection } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN || '';

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

function getEmployeeName(req) {
  const initData = req.header('X-Telegram-Init-Data');
  const user = validateInitData(initData);
  if (user) {
    return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || ('User ' + user.id);
  }
  // Fallback for local testing outside Telegram (see README).
  return req.header('X-Dev-Name') || "Noma'lum";
}

function uid() {
  return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

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
  const { name, phone, source, comment } = req.body || {};
  if (!name || !phone) {
    return res.status(400).json({ error: "Ism va telefon raqami majburiy" });
  }
  const employee = getEmployeeName(req);
  const lead = {
    id: uid(),
    name: String(name).trim(),
    phone: String(phone).trim(),
    source: source || '',
    comment: comment || '',
    status: 'yangi',
    createdAt: Date.now(),
    addedBy: employee,
    updatedBy: employee,
    updatedAt: Date.now(),
  };
  try {
    const col = await getLeadsCollection();
    await col.insertOne({ ...lead });
    res.json(lead);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Saqlashda xatolik' });
  }
});

app.patch('/api/leads/:id', async (req, res) => {
  try {
    const col = await getLeadsCollection();
    const employee = getEmployeeName(req);
    const update = { updatedBy: employee, updatedAt: Date.now() };
    if (typeof req.body.status === 'string') update.status = req.body.status;
    if (typeof req.body.comment === 'string') update.comment = req.body.comment;

    const updated = await col.findOneAndUpdate(
      { id: req.params.id },
      { $set: update },
      { returnDocument: 'after', projection: { _id: 0 } }
    );
    if (!updated) return res.status(404).json({ error: 'Lid topilmadi' });
    res.json(updated);
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
