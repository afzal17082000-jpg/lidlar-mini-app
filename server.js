const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const ExcelJS = require('exceljs');
const {
  getLeadsCollection,
  getEmployeesCollection,
  getMaterialsCollection,
  getProductsCollection,
  getBomsCollection,
  getSerialsCollection,
  getFinanceCollection,
} = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '';

// ================= Telegram auth helpers =================

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

function getTelegramUser(req) {
  const initData = req.header('X-Telegram-Init-Data');
  return validateInitData(initData);
}

function getEmployeeName(req) {
  const user = getTelegramUser(req);
  if (user) {
    return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || ('User ' + user.id);
  }
  return req.header('X-Dev-Name') || "Noma'lum";
}

async function getCurrentEmployee(req) {
  const user = getTelegramUser(req);
  if (!user) return null;
  const col = await getEmployeesCollection();
  return col.findOne({ telegramId: user.id });
}

async function attachEmployee(req, res, next) {
  try {
    req.employee = await getCurrentEmployee(req);
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bazaga ulanishda xatolik' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.employee) {
      return res.status(403).json({ error: "Avval ro'yxatdan o'ting" });
    }
    if (!roles.includes(req.employee.role)) {
      return res.status(403).json({ error: "Bu bo'limga kirish huquqingiz yo'q" });
    }
    next();
  };
}

function uid(prefix) {
  return (prefix || 'l') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtmlServer(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ================= Telegram notifications =================

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
function notifyGroup(text) { return sendTelegramMessage(GROUP_CHAT_ID, text); }
function notifyUser(telegramId, text) { return sendTelegramMessage(telegramId, text); }

// ================= Constants =================

const STATUS_LABELS = {
  lead: "Yangi lid",
  consultation: "Konsultatsiya",
  negotiation: "Muzokarada",
  contract: "Shartnoma",
  production: "Ishlab chiqarish",
  closed_won: "Sotildi",
  closed_lost: "Otkaz",
};

const ROLE_LABELS = {
  admin: "Rahbar",
  sales: "Sotuvchi",
  warehouse_production: "Omborchi/Usta",
  finance: "Moliyachi",
};

// ================= Product knowledge base (static catalog) =================
// Reference catalog for sales: category -> tiers with fixed specs.
// All sizes ship with free delivery across Uzbekistan.
const PRODUCT_CATALOG = {
  bunkerlik: {
    label: "Bunkerlik (avtomat)",
    sizes: [150, 200, 300, 400, 500],
    tiers: {
      silver: {
        label: "Silver",
        specs: "Steklovata teploizolyatsiya (4 tomon), 100 kg bunker, oddiy miyya, 65W ventilyator, dvornik motor, komplektida kul tortgich.",
      },
      gold: {
        label: "Gold",
        specs: "Steklovata teploizolyatsiya (4 tomon), 120 kg bunker, oddiy miyya, 85W ventilyator, 0.25 kW 220V motor, 2 talik podacha-obratka klapani, kul tortgich, kuldon va gradusnik.",
      },
      platinium: {
        label: "Platinium",
        specs: "Basalt teploizolyatsiya (4 tomon), 150 kg bunker, aqlli shitga terilgan miyya, 120W ventilyator, 0.37 kW 220V motor, 2 talik podacha-obratka klapan, o'ng/chapga siljish joyi, tiqilishga qarshi va shnegni oldi/orqaga qilish knopkasi, kul tortgich, kuldon va gradusnik.",
      },
      premium_platinium: {
        label: "Premium Platinium",
        specs: "Basalt teploizolyatsiya (4 tomon), 150 kg bunker, aqlli shitga terilgan Wi-Fi miyya, 120W ventilyator, 0.37 kW 220V motor, 2 talik podacha-obratka klapan, o'ng/chapga siljish joyi, tiqilib qolganda avtomatik orqaga/oldinga ishlovchi shneg, kul tortgich, kuldon, gradusnik, stabilizator va vzrivnoy klapan.",
      },
    },
  },
  bunkersiz: {
    label: "Bunkersiz (poluavtomat)",
    sizes: [150, 200, 300, 400, 500],
    tiers: {
      silver: {
        label: "Silver",
        specs: "Steklovata teploizolyatsiya (4 tomon), sariq oddiy miyya, ventilyator.",
      },
      gold: {
        label: "Gold",
        specs: "Basalt teploizolyatsiya (4 tomon), shitga terilgan aqlli miyya, ventilyator, 2 talik podacha-obratka klapan, 2 ta siljitish joyi, kuldon, kurakcha va kul tortgich.",
      },
      platinium: {
        label: "Platinium",
        specs: "Basalt teploizolyatsiya (4 tomon), shitga terilgan aqlli miyya, ventilyator, 2 talik podacha-obratka klapan, 2 ta siljitish joyi, kuldon, kurakcha, kul tortgich hamda toksiz ishlash uchun regulyator tyagasi.",
      },
    },
  },
};

app.get('/api/catalog', attachEmployee, requireRole('admin', 'sales', 'warehouse_production'), (req, res) => {
  res.json(PRODUCT_CATALOG);
});

// ================= Locations (Uzbekistan regions & districts) =================
const REGIONS = {
  "Toshkent shahri": ["Bektemir", "Chilonzor", "Yakkasaroy", "Mirobod", "Mirzo Ulug'bek", "Olmazor", "Sergeli", "Shayxontohur", "Uchtepa", "Yashnobod", "Yunusobod", "Yangihayot"],
  "Toshkent viloyati": ["Bekobod", "Bo'ka", "Bo'stonliq", "Chinoz", "Qibray", "Ohangaron", "Oqqo'rg'on", "Parkent", "Piskent", "Quyichirchiq", "Yuqorichirchiq", "O'rtachirchiq", "Zangiota", "Toshkent tumani", "Yangiyo'l"],
  "Andijon": ["Andijon shahri", "Andijon tumani", "Asaka", "Baliqchi", "Bo'z", "Buloqboshi", "Izboskan", "Jalaquduq", "Xo'jaobod", "Qo'rg'ontepa", "Marhamat", "Oltinko'l", "Paxtaobod", "Shahrixon", "Ulug'nor", "Xonobod"],
  "Buxoro": ["Buxoro shahri", "Buxoro tumani", "G'ijduvon", "Jondor", "Kogon", "Qorako'l", "Qorovulbozor", "Peshku", "Romitan", "Shofirkon", "Vobkent", "Olot"],
  "Farg'ona": ["Farg'ona shahri", "Farg'ona tumani", "Beshariq", "Bog'dod", "Buvayda", "Dang'ara", "Furqat", "Qo'shtepa", "Oltiariq", "Quva", "Quvasoy", "Rishton", "So'x", "Toshloq", "Uchko'prik", "O'zbekiston tumani", "Yozyovon", "Marg'ilon", "Qo'qon"],
  "Jizzax": ["Jizzax shahri", "Arnasoy", "Baxmal", "Do'stlik", "Forish", "G'allaorol", "Mirzachoʻl", "Paxtakor", "Yangiobod", "Zafarobod", "Zarbdor", "Zomin"],
  "Xorazm": ["Urganch shahri", "Urganch tumani", "Bog'ot", "Gurlan", "Xiva", "Xonqa", "Qo'shko'pir", "Shovot", "Yangiariq", "Yangibozor"],
  "Namangan": ["Namangan shahri", "Namangan tumani", "Chortoq", "Chust", "Kosonsoy", "Mingbuloq", "Norin", "Pop", "To'raqo'rg'on", "Uychi", "Uchqo'rg'on", "Yangiqo'rg'on"],
  "Navoiy": ["Navoiy shahri", "Zarafshon", "Karmana", "Konimex", "Navbahor", "Nurota", "Qiziltepa", "Tomdi", "Uchquduq", "Xatirchi"],
  "Qashqadaryo": ["Qarshi shahri", "Qarshi tumani", "Dehqonobod", "G'uzor", "Kasbi", "Kitob", "Koson", "Mirishkor", "Muborak", "Nishon", "Chiroqchi", "Shahrisabz", "Yakkabog'"],
  "Samarqand": ["Samarqand shahri", "Samarqand tumani", "Bulung'ur", "Ishtixon", "Jomboy", "Kattaqo'rg'on", "Narpay", "Nurobod", "Oqdaryo", "Payariq", "Pastdarg'om", "Paxtachi", "Toyloq", "Urgut"],
  "Sirdaryo": ["Guliston shahri", "Guliston tumani", "Boyovut", "Xovos", "Mirzaobod", "Sardoba", "Sayxunobod", "Sirdaryo", "Shirin"],
  "Surxondaryo": ["Termiz shahri", "Angor", "Bandixon", "Boysun", "Denov", "Jarqo'rg'on", "Qiziriq", "Qumqo'rg'on", "Muzrabot", "Oltinsoy", "Sariosiyo", "Sherobod", "Shorchi", "Termiz tumani", "Uzun"],
  "Qoraqalpog'iston": ["Nukus shahri", "Amudaryo", "Beruniy", "Chimboy", "Ellikqal'a", "Kegeyli", "Mo'ynoq", "Nukus tumani", "Qanliko'l", "Qorao'zak", "Qo'ng'irot", "Shumanay", "Taxtako'pir", "To'rtko'l", "Xo'jayli"],
};

app.get('/api/locations', attachEmployee, requireRole('admin', 'sales'), (req, res) => {
  res.json(REGIONS);
});

// ================= Employees (registration) =================

app.get('/api/employees/me', async (req, res) => {
  const user = getTelegramUser(req);
  if (!user) return res.json({ registered: true, skipped: true });
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
  if (!user) return res.status(400).json({ error: "Ro'yxatdan o'tish faqat Telegram orqali mumkin" });
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
      `🆕 <b>Yangi xodim ro'yxatdan o'tdi</b>\n👤 ${escapeHtmlServer(employee.name)}\n🏷 ${escapeHtmlServer(ROLE_LABELS[role])}`
    );
    notifyUser(user.id, `✅ <b>Ro'yxatdan muvaffaqiyatli o'tdingiz!</b>\nLavozim: ${escapeHtmlServer(ROLE_LABELS[role])}\n\nEndi tizimdan foydalanishingiz mumkin.`);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Saqlashda xatolik' });
  }
});

// List employees, optionally filtered by role (used to pick who a lead is reassigned to).
app.get('/api/employees', attachEmployee, requireRole('admin', 'sales'), async (req, res) => {
  try {
    const col = await getEmployeesCollection();
    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    const employees = await col.find(filter, { projection: { _id: 0, telegramId: 1, name: 1, role: 1 } }).toArray();
    res.json(employees);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bazaga ulanishda xatolik' });
  }
});

// ================= Leads / Deals (Sales pipeline) =================

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
  if (user) {
    try {
      const empCol = await getEmployeesCollection();
      const employee = await empCol.findOne({ telegramId: user.id });
      if (!employee) return res.status(403).json({ error: "Avval ro'yxatdan o'ting" });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Bazaga ulanishda xatolik' });
    }
  }

  const {
    name, phone, source, address, product, comment, leadDate,
    region, district, productCategory, productTier, productSize, consultationDate,
    assignedSalesTelegramId, assignedSalesName,
  } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "Ism va telefon raqami majburiy" });
  const employeeName = getEmployeeName(req);

  // Build a human-readable product label from the catalog selection, if given.
  let productLabel = product || '';
  if (productCategory && productTier && productSize) {
    const cat = PRODUCT_CATALOG[productCategory];
    const tier = cat && cat.tiers[productTier];
    if (cat && tier) {
      productLabel = `${cat.label} ${tier.label} ${productSize} kv`;
    }
  }

  const initialStatus = consultationDate ? 'consultation' : 'lead';

  // The person filling the form is always the creator, but the deal can be
  // explicitly assigned to a different sales rep right away (e.g. an admin
  // logging a lead on behalf of a specific salesperson).
  const finalAssignedName = assignedSalesName || employeeName;
  const finalAssignedTelegramId = assignedSalesTelegramId ? Number(assignedSalesTelegramId) : (user ? user.id : null);

  const lead = {
    id: uid(),
    name: String(name).trim(),
    phone: String(phone).trim(),
    source: source || '',
    address: address || '',
    region: region || '',
    district: district || '',
    product: productLabel,
    productCategory: productCategory || '',
    productTier: productTier || '',
    productSize: productSize || '',
    comment: comment || '',
    leadDate: leadDate || new Date().toISOString().slice(0, 10),
    consultationDate: consultationDate || '',
    consultationNotified: false,
    status: initialStatus,
    dealAmount: 0,
    assignedSerialId: null,
    assignedSerialNumber: '',
    createdAt: Date.now(),
    // Creator (who first captured the lead) vs. the sales rep currently responsible —
    // these can diverge after a reassignment.
    addedBy: employeeName,
    createdByTelegramId: user ? user.id : null,
    assignedSalesName: finalAssignedName,
    assignedSalesTelegramId: finalAssignedTelegramId,
    updatedBy: employeeName,
    updatedAt: Date.now(),
    responsibleTelegramId: finalAssignedTelegramId,
    history: [{ ts: Date.now(), by: employeeName, action: 'created', detail: '' }],
  };
  try {
    const col = await getLeadsCollection();
    await col.insertOne({ ...lead });
    res.json(lead);
    notifyGroup(
      `🆕 <b>Yangi lid</b>\n👤 ${escapeHtmlServer(lead.name)}\n📞 ${escapeHtmlServer(lead.phone)}\n` +
      (lead.source ? `🔗 Manba: ${escapeHtmlServer(lead.source)}\n` : '') +
      (lead.product ? `🫖 Mahsulot: ${escapeHtmlServer(lead.product)}\n` : '') +
      `➕ Qo'shdi: ${escapeHtmlServer(employeeName)}`
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Saqlashda xatolik' });
  }
});

// Reassign a lead to a different sales rep.
app.post('/api/leads/:id/reassign', attachEmployee, requireRole('admin', 'sales'), async (req, res) => {
  const { toTelegramId, toName } = req.body || {};
  if (!toTelegramId || !toName) return res.status(400).json({ error: "Xodim tanlanmagan" });
  try {
    const col = await getLeadsCollection();
    const employeeName = getEmployeeName(req);
    const lead = await col.findOne({ id: req.params.id });
    if (!lead) return res.status(404).json({ error: 'Lid topilmadi' });

    const historyEntry = {
      ts: Date.now(), by: employeeName, action: 'reassign',
      detail: `${lead.assignedSalesName || ''} → ${toName}`,
    };
    const updated = await col.findOneAndUpdate(
      { id: req.params.id },
      {
        $set: {
          assignedSalesName: toName,
          assignedSalesTelegramId: Number(toTelegramId),
          responsibleTelegramId: Number(toTelegramId),
          updatedBy: employeeName,
          updatedAt: Date.now(),
        },
        $push: { history: historyEntry },
      },
      { returnDocument: 'after', projection: { _id: 0 } }
    );
    res.json(updated);
    notifyUser(Number(toTelegramId), `📋 <b>Sizga lid biriktirildi</b>\n👤 ${escapeHtmlServer(lead.name)} (${escapeHtmlServer(lead.phone)})`);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Qayta biriktirishda xatolik" });
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
    if (typeof req.body.region === 'string') update.region = req.body.region;
    if (typeof req.body.district === 'string') update.district = req.body.district;
    if (req.body.dealAmount !== undefined) update.dealAmount = Number(req.body.dealAmount) || 0;

    const before = await col.findOne({ id: req.params.id });
    if (!before) return res.status(404).json({ error: 'Lid topilmadi' });

    // Setting/changing the consultation date resets the notification flag and,
    // if the deal is still at the raw 'lead' stage, auto-advances it.
    if (typeof req.body.consultationDate === 'string' && req.body.consultationDate !== before.consultationDate) {
      update.consultationDate = req.body.consultationDate;
      update.consultationNotified = false;
      if (req.body.consultationDate && before.status === 'lead' && !update.status) {
        update.status = 'consultation';
      }
    }

    if (update.status && update.status !== before.status) {
      await col.updateOne(
        { id: req.params.id },
        { $push: { history: {
          ts: Date.now(), by: employeeName, action: 'status',
          detail: `${STATUS_LABELS[before.status] || before.status} → ${STATUS_LABELS[update.status] || update.status}`,
        } } }
      );
    }

    const updated = await col.findOneAndUpdate(
      { id: req.params.id },
      { $set: update },
      { returnDocument: 'after', projection: { _id: 0 } }
    );
    res.json(updated);

    // Status-change side effects
    if (update.status && update.status !== before.status) {
      notifyGroup(
        `🔄 <b>Bosqich o'zgardi</b>\n👤 ${escapeHtmlServer(updated.name)} (${escapeHtmlServer(updated.phone)})\n` +
        `${STATUS_LABELS[before.status] || before.status} → <b>${STATUS_LABELS[updated.status] || updated.status}</b>\n` +
        `✏️ Yangiladi: ${escapeHtmlServer(employeeName)}`
      );

      const serialsCol = await getSerialsCollection();

      if (update.status === 'closed_won') {
        if (updated.assignedSerialId) {
          const warrantyUntil = new Date();
          warrantyUntil.setMonth(warrantyUntil.getMonth() + 24);
          await serialsCol.updateOne(
            { id: updated.assignedSerialId },
            { $set: { status: 'sold', soldAt: Date.now(), warrantyUntil: warrantyUntil.getTime(), dealId: updated.id } }
          );
        }
        notifyGroup(
          `🎉 <b>Sotuv yopildi!</b>\n👤 ${escapeHtmlServer(updated.name)}\n💰 Summa: ${updated.dealAmount || 0}\n` +
          (updated.assignedSerialNumber ? `🔢 Seriya: ${escapeHtmlServer(updated.assignedSerialNumber)}` : '')
        );
      }

      if (update.status === 'closed_lost' && updated.assignedSerialId) {
        await serialsCol.updateOne(
          { id: updated.assignedSerialId, status: 'reserved' },
          { $set: { status: 'stock', dealId: null } }
        );
        await col.updateOne({ id: updated.id }, { $set: { assignedSerialId: null, assignedSerialNumber: '' } });
      }

      if (update.status === 'production' && updated.responsibleTelegramId) {
        notifyUser(updated.responsibleTelegramId, `🏭 <b>Eslatma</b>\n${escapeHtmlServer(updated.name)} ishlab chiqarish/bron bosqichiga o'tdi.`);
      }
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Yangilashda xatolik' });
  }
});

// Assign an in-stock serial to a deal (reserves it)
app.post('/api/leads/:id/assign-serial', attachEmployee, requireRole('admin', 'sales'), async (req, res) => {
  const { serialId } = req.body || {};
  if (!serialId) return res.status(400).json({ error: 'Seriya tanlanmagan' });
  try {
    const leadsCol = await getLeadsCollection();
    const serialsCol = await getSerialsCollection();

    const lead = await leadsCol.findOne({ id: req.params.id });
    if (!lead) return res.status(404).json({ error: 'Lid topilmadi' });

    const serial = await serialsCol.findOne({ id: serialId });
    if (!serial || serial.status !== 'stock') {
      return res.status(400).json({ error: "Bu seriya raqami omborda mavjud emas" });
    }

    await serialsCol.updateOne({ id: serialId }, { $set: { status: 'reserved', dealId: lead.id } });
    const updated = await leadsCol.findOneAndUpdate(
      { id: lead.id },
      { $set: { assignedSerialId: serialId, assignedSerialNumber: serial.serialNumber, updatedAt: Date.now() } },
      { returnDocument: 'after', projection: { _id: 0 } }
    );
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bron qilishda xatolik' });
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

// ================= Warehouse (raw materials) =================

app.get('/api/materials', attachEmployee, requireRole('admin', 'warehouse_production'), async (req, res) => {
  try {
    const col = await getMaterialsCollection();
    const materials = await col.find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray();
    res.json(materials);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bazaga ulanishda xatolik' });
  }
});

app.post('/api/materials', attachEmployee, requireRole('admin', 'warehouse_production'), async (req, res) => {
  const { name, unit, qty, minStock, purchasePrice } = req.body || {};
  if (!name || !unit) return res.status(400).json({ error: "Nomi va o'lchov birligi majburiy" });
  const material = {
    id: uid('m'), name: String(name).trim(), unit: String(unit).trim(),
    qty: Number(qty) || 0, minStock: Number(minStock) || 0, purchasePrice: Number(purchasePrice) || 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  try {
    const col = await getMaterialsCollection();
    await col.insertOne({ ...material });
    res.json(material);
    notifyGroup(`📦 <b>Yangi xomashyo qo'shildi</b>\n${escapeHtmlServer(material.name)}: ${material.qty} ${escapeHtmlServer(material.unit)}`);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Saqlashda xatolik' });
  }
});

app.post('/api/materials/:id/adjust', attachEmployee, requireRole('admin', 'warehouse_production'), async (req, res) => {
  const { type, qty, note } = req.body || {};
  const amount = Number(qty);
  if (!['in', 'out'].includes(type) || !amount || amount <= 0) {
    return res.status(400).json({ error: "Turi (kirim/chiqim) va miqdor to'g'ri kiritilishi kerak" });
  }
  try {
    const col = await getMaterialsCollection();
    const material = await col.findOne({ id: req.params.id });
    if (!material) return res.status(404).json({ error: 'Xomashyo topilmadi' });

    const delta = type === 'in' ? amount : -amount;
    const newQty = (material.qty || 0) + delta;
    if (newQty < 0) return res.status(400).json({ error: "Omborda yetarli miqdor yo'q" });

    const updated = await col.findOneAndUpdate(
      { id: req.params.id }, { $set: { qty: newQty, updatedAt: Date.now() } },
      { returnDocument: 'after', projection: { _id: 0 } }
    );
    res.json(updated);

    const employeeName = getEmployeeName(req);
    notifyGroup(
      `${type === 'in' ? '📥' : '📤'} <b>${type === 'in' ? 'Kirim' : 'Chiqim'}</b>\n${escapeHtmlServer(material.name)}: ${amount} ${escapeHtmlServer(material.unit)}\n` +
      (note ? `📝 ${escapeHtmlServer(note)}\n` : '') + `👤 ${escapeHtmlServer(employeeName)}\n📊 Qoldiq: ${newQty} ${escapeHtmlServer(material.unit)}`
    );
    if (newQty <= (material.minStock || 0)) {
      notifyGroup(`⚠️ <b>Xomashyo tugamoqda!</b>\n${escapeHtmlServer(material.name)}: ${newQty} ${escapeHtmlServer(material.unit)} qoldi (min: ${material.minStock} ${escapeHtmlServer(material.unit)})`);
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Yangilashda xatolik' });
  }
});

app.delete('/api/materials/:id', attachEmployee, requireRole('admin', 'warehouse_production'), async (req, res) => {
  try {
    const col = await getMaterialsCollection();
    await col.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "O'chirishda xatolik" });
  }
});

// ================= Production: Products, BOM, Assembly =================

app.get('/api/products', attachEmployee, requireRole('admin', 'warehouse_production', 'sales'), async (req, res) => {
  try {
    const col = await getProductsCollection();
    const products = await col.find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray();
    res.json(products);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bazaga ulanishda xatolik' });
  }
});

app.post('/api/products', attachEmployee, requireRole('admin', 'warehouse_production'), async (req, res) => {
  const { name, powerKw, salePrice, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nomi majburiy' });
  const product = {
    id: uid('p'), name: String(name).trim(), powerKw: Number(powerKw) || 0,
    salePrice: Number(salePrice) || 0, description: description || '', createdAt: Date.now(),
  };
  try {
    const col = await getProductsCollection();
    await col.insertOne({ ...product });
    res.json(product);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Saqlashda xatolik' });
  }
});

app.delete('/api/products/:id', attachEmployee, requireRole('admin', 'warehouse_production'), async (req, res) => {
  try {
    const col = await getProductsCollection();
    await col.deleteOne({ id: req.params.id });
    const bomsCol = await getBomsCollection();
    await bomsCol.deleteOne({ productId: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "O'chirishda xatolik" });
  }
});

// BOM (retseptura) for a product: { productId, items: [{materialId, qty}] }
app.get('/api/boms/:productId', attachEmployee, requireRole('admin', 'warehouse_production'), async (req, res) => {
  try {
    const col = await getBomsCollection();
    const bom = await col.findOne({ productId: req.params.productId }, { projection: { _id: 0 } });
    res.json(bom || { productId: req.params.productId, items: [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bazaga ulanishda xatolik' });
  }
});

app.post('/api/boms/:productId', attachEmployee, requireRole('admin', 'warehouse_production'), async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "Retseptura ro'yxati noto'g'ri" });
  const cleanItems = items
    .filter(i => i.materialId && Number(i.qty) > 0)
    .map(i => ({ materialId: i.materialId, qty: Number(i.qty) }));
  try {
    const col = await getBomsCollection();
    await col.updateOne(
      { productId: req.params.productId },
      { $set: { productId: req.params.productId, items: cleanItems, updatedAt: Date.now() } },
      { upsert: true }
    );
    res.json({ productId: req.params.productId, items: cleanItems });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Saqlashda xatolik' });
  }
});

// Assembly: consumes materials per BOM, produces one serial
app.post('/api/production/assemble', attachEmployee, requireRole('admin', 'warehouse_production'), async (req, res) => {
  const { productId } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'Mahsulot tanlanmagan' });
  try {
    const productsCol = await getProductsCollection();
    const bomsCol = await getBomsCollection();
    const materialsCol = await getMaterialsCollection();
    const serialsCol = await getSerialsCollection();

    const product = await productsCol.findOne({ id: productId });
    if (!product) return res.status(404).json({ error: 'Mahsulot topilmadi' });

    const bom = await bomsCol.findOne({ productId });
    if (!bom || !bom.items || !bom.items.length) {
      return res.status(400).json({ error: "Bu mahsulot uchun retseptura (BOM) kiritilmagan" });
    }

    // Verify stock is sufficient for every material first.
    const materials = {};
    for (const item of bom.items) {
      const material = await materialsCol.findOne({ id: item.materialId });
      if (!material) return res.status(400).json({ error: 'Retsepturadagi xomashyo topilmadi' });
      if ((material.qty || 0) < item.qty) {
        return res.status(400).json({ error: `Yetarli emas: ${material.name} (kerak: ${item.qty}, bor: ${material.qty})` });
      }
      materials[item.materialId] = material;
    }

    // Deduct stock and compute COGS.
    let cogs = 0;
    for (const item of bom.items) {
      const material = materials[item.materialId];
      const newQty = material.qty - item.qty;
      await materialsCol.updateOne({ id: item.materialId }, { $set: { qty: newQty, updatedAt: Date.now() } });
      cogs += (material.purchasePrice || 0) * item.qty;

      if (newQty <= (material.minStock || 0)) {
        notifyGroup(`⚠️ <b>Xomashyo tugamoqda!</b>\n${escapeHtmlServer(material.name)}: ${newQty} ${escapeHtmlServer(material.unit)} qoldi`);
      }
    }

    const year = new Date().getFullYear();
    const countThisYear = await serialsCol.countDocuments({ serialNumber: { $regex: `^#SB-${year}-` } });
    const serialNumber = `#SB-${year}-${String(countThisYear + 1).padStart(4, '0')}`;
    const employeeName = getEmployeeName(req);

    const serial = {
      id: uid('s'),
      serialNumber,
      productId,
      productName: product.name,
      cogs,
      status: 'stock',
      dealId: null,
      warrantyMonths: 24,
      assembledAt: Date.now(),
      assembledBy: employeeName,
    };
    await serialsCol.insertOne({ ...serial });
    res.json(serial);

    notifyGroup(`🔧 <b>Kotel yig'ildi!</b>\n${escapeHtmlServer(serialNumber)} — ${escapeHtmlServer(product.name)}\nTannarx: ${cogs.toFixed(0)}\n👤 ${escapeHtmlServer(employeeName)}`);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Yig'ishda xatolik" });
  }
});

app.get('/api/serials', attachEmployee, requireRole('admin', 'warehouse_production', 'sales'), async (req, res) => {
  try {
    const col = await getSerialsCollection();
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.productId) filter.productId = req.query.productId;
    const serials = await col.find(filter, { projection: { _id: 0 } }).sort({ assembledAt: -1 }).toArray();
    res.json(serials);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bazaga ulanishda xatolik' });
  }
});

// ================= Finance =================

app.get('/api/finance/entries', attachEmployee, requireRole('admin', 'finance'), async (req, res) => {
  try {
    const col = await getFinanceCollection();
    const entries = await col.find({}, { projection: { _id: 0 } }).sort({ date: -1 }).toArray();
    res.json(entries);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Bazaga ulanishda xatolik' });
  }
});

app.post('/api/finance/entries', attachEmployee, requireRole('admin', 'finance'), async (req, res) => {
  const { type, category, amount, note, date } = req.body || {};
  if (!['income', 'expense'].includes(type) || !amount) {
    return res.status(400).json({ error: "Turi va summa to'g'ri kiritilishi kerak" });
  }
  const entry = {
    id: uid('f'), type, category: category || '', amount: Number(amount),
    note: note || '', date: date || new Date().toISOString().slice(0, 10),
    createdAt: Date.now(), createdBy: getEmployeeName(req),
  };
  try {
    const col = await getFinanceCollection();
    await col.insertOne({ ...entry });
    res.json(entry);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Saqlashda xatolik' });
  }
});

app.delete('/api/finance/entries/:id', attachEmployee, requireRole('admin', 'finance'), async (req, res) => {
  try {
    const col = await getFinanceCollection();
    await col.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "O'chirishda xatolik" });
  }
});

// P&L: Sales Revenue - COGS - OPEX = Net Profit
app.get('/api/finance/pnl', attachEmployee, requireRole('admin', 'finance'), async (req, res) => {
  try {
    const leadsCol = await getLeadsCollection();
    const serialsCol = await getSerialsCollection();
    const financeCol = await getFinanceCollection();

    const wonDeals = await leadsCol.find({ status: 'closed_won' }).toArray();
    const salesRevenue = wonDeals.reduce((sum, d) => sum + (d.dealAmount || 0), 0);

    const soldSerials = await serialsCol.find({ status: 'sold' }).toArray();
    const cogs = soldSerials.reduce((sum, s) => sum + (s.cogs || 0), 0);

    const expenses = await financeCol.find({ type: 'expense' }).toArray();
    const opex = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);

    const incomeEntries = await financeCol.find({ type: 'income' }).toArray();
    const otherIncome = incomeEntries.reduce((sum, e) => sum + (e.amount || 0), 0);

    const netProfit = salesRevenue + otherIncome - cogs - opex;

    res.json({
      salesRevenue, otherIncome, cogs, opex, netProfit,
      dealsCount: wonDeals.length, serialsCount: soldSerials.length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Hisoblashda xatolik' });
  }
});

// ================= Analytics (sales performance, dashboard overview) =================

app.get('/api/analytics/sales', attachEmployee, requireRole('admin'), async (req, res) => {
  try {
    const leadsCol = await getLeadsCollection();
    const leads = await leadsCol.find({}).toArray();

    const byRep = {};
    for (const lead of leads) {
      const key = lead.assignedSalesTelegramId || lead.assignedSalesName || 'Noma\'lum';
      if (!byRep[key]) {
        byRep[key] = {
          name: lead.assignedSalesName || "Noma'lum",
          leadsCount: 0, consultationCount: 0, negotiationCount: 0,
          contractCount: 0, productionCount: 0, closedWonCount: 0, closedLostCount: 0,
          totalDealAmount: 0,
        };
      }
      const rep = byRep[key];
      rep.leadsCount += 1;
      if (lead.status === 'consultation') rep.consultationCount += 1;
      if (lead.status === 'negotiation') rep.negotiationCount += 1;
      if (lead.status === 'contract') rep.contractCount += 1;
      if (lead.status === 'production') rep.productionCount += 1;
      if (lead.status === 'closed_won') { rep.closedWonCount += 1; rep.totalDealAmount += (lead.dealAmount || 0); }
      if (lead.status === 'closed_lost') rep.closedLostCount += 1;
    }

    const result = Object.values(byRep).sort((a, b) => b.leadsCount - a.leadsCount);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Hisoblashda xatolik' });
  }
});

app.get('/api/analytics/overview', attachEmployee, requireRole('admin'), async (req, res) => {
  try {
    const leadsCol = await getLeadsCollection();
    const materialsCol = await getMaterialsCollection();

    const totalLeads = await leadsCol.countDocuments({});
    const activeDeals = await leadsCol.countDocuments({ status: { $nin: ['closed_won', 'closed_lost'] } });
    const closedWon = await leadsCol.countDocuments({ status: 'closed_won' });
    const closedLost = await leadsCol.countDocuments({ status: 'closed_lost' });
    const winRate = (closedWon + closedLost) > 0 ? Math.round((closedWon / (closedWon + closedLost)) * 100) : 0;

    const materials = await materialsCol.find({}).toArray();
    const stockAlerts = materials.filter(m => (m.qty || 0) <= (m.minStock || 0)).length;

    res.json({ totalLeads, activeDeals, stockAlerts, winRate, closedWon, closedLost });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Hisoblashda xatolik' });
  }
});

// ================= Excel reports =================

app.get('/api/reports/sales/excel', attachEmployee, requireRole('admin', 'finance'), async (req, res) => {
  try {
    const col = await getLeadsCollection();
    const leads = await col.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sotuvlar');
    ws.columns = [
      { header: 'Mijoz', key: 'name', width: 22 },
      { header: 'Telefon', key: 'phone', width: 18 },
      { header: 'Bosqich', key: 'status', width: 20 },
      { header: 'Mahsulot', key: 'product', width: 24 },
      { header: 'Viloyat', key: 'region', width: 18 },
      { header: 'Tuman/Shahar', key: 'district', width: 18 },
      { header: 'Summa', key: 'dealAmount', width: 14 },
      { header: 'Seriya', key: 'assignedSerialNumber', width: 16 },
      { header: 'Yaratdi', key: 'addedBy', width: 18 },
      { header: "Mas'ul sotuvchi", key: 'assignedSalesName', width: 18 },
      { header: 'Sana', key: 'leadDate', width: 14 },
    ];
    leads.forEach(l => ws.addRow({ ...l, status: STATUS_LABELS[l.status] || l.status }));
    ws.getRow(1).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sotuvlar.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Hisobot yaratishda xatolik' });
  }
});

app.get('/api/reports/warehouse/excel', attachEmployee, requireRole('admin', 'warehouse_production'), async (req, res) => {
  try {
    const materialsCol = await getMaterialsCollection();
    const serialsCol = await getSerialsCollection();
    const materials = await materialsCol.find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray();
    const serials = await serialsCol.find({}, { projection: { _id: 0 } }).sort({ assembledAt: -1 }).toArray();

    const wb = new ExcelJS.Workbook();
    const ws1 = wb.addWorksheet('Xomashyo');
    ws1.columns = [
      { header: 'Nomi', key: 'name', width: 24 },
      { header: 'Qoldiq', key: 'qty', width: 12 },
      { header: 'Birlik', key: 'unit', width: 10 },
      { header: 'Min', key: 'minStock', width: 10 },
      { header: 'Narx', key: 'purchasePrice', width: 12 },
    ];
    materials.forEach(m => ws1.addRow(m));
    ws1.getRow(1).font = { bold: true };

    const ws2 = wb.addWorksheet('Tayyor mahsulot');
    ws2.columns = [
      { header: 'Seriya', key: 'serialNumber', width: 18 },
      { header: 'Mahsulot', key: 'productName', width: 22 },
      { header: 'Tannarx', key: 'cogs', width: 14 },
      { header: 'Holat', key: 'status', width: 14 },
      { header: 'Yig\'ildi', key: 'assembledBy', width: 18 },
    ];
    serials.forEach(s => ws2.addRow(s));
    ws2.getRow(1).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="ombor.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Hisobot yaratishda xatolik' });
  }
});

app.get('/api/reports/finance/excel', attachEmployee, requireRole('admin', 'finance'), async (req, res) => {
  try {
    const financeCol = await getFinanceCollection();
    const entries = await financeCol.find({}, { projection: { _id: 0 } }).sort({ date: -1 }).toArray();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Moliya');
    ws.columns = [
      { header: 'Sana', key: 'date', width: 14 },
      { header: 'Turi', key: 'type', width: 12 },
      { header: 'Kategoriya', key: 'category', width: 18 },
      { header: 'Summa', key: 'amount', width: 14 },
      { header: 'Izoh', key: 'note', width: 30 },
      { header: 'Kiritdi', key: 'createdBy', width: 18 },
    ];
    entries.forEach(e => ws.addRow({ ...e, type: e.type === 'income' ? 'Tushum' : 'Xarajat' }));
    ws.getRow(1).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="moliya.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Hisobot yaratishda xatolik' });
  }
});

// ================= Consultation date reminders (background check) =================
// Every 15 minutes, find deals whose consultation date is today and haven't
// been notified yet, and ping the assigned sales rep.
async function checkConsultationReminders() {
  try {
    const col = await getLeadsCollection();
    const today = new Date().toISOString().slice(0, 10);
    const due = await col.find({
      consultationDate: today,
      consultationNotified: { $ne: true },
      status: { $nin: ['closed_won', 'closed_lost'] },
    }).toArray();

    for (const lead of due) {
      if (lead.assignedSalesTelegramId) {
        await notifyUser(
          lead.assignedSalesTelegramId,
          `📅 <b>Bugun konsultatsiya!</b>\n👤 ${escapeHtmlServer(lead.name)} (${escapeHtmlServer(lead.phone)})\n` +
          (lead.product ? `🫖 ${escapeHtmlServer(lead.product)}\n` : '') +
          (lead.address ? `📍 ${escapeHtmlServer(lead.address)}` : '')
        );
      }
      await col.updateOne({ id: lead.id }, { $set: { consultationNotified: true } });
    }
  } catch (e) {
    console.error('Konsultatsiya eslatmalarini tekshirishda xatolik:', e.message);
  }
}
setInterval(checkConsultationReminders, 15 * 60 * 1000);
checkConsultationReminders();

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server ' + PORT + '-portda ishga tushdi'));
