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
  contract: "Shartnoma",
  production: "Ishlab chiqarish/Bron",
  installation: "O'rnatish",
  won: "Yopildi (muvaffaqiyatli)",
  lost: "Otkaz",
};

const ROLE_LABELS = {
  admin: "Rahbar",
  sales: "Sotuvchi",
  warehouse_production: "Omborchi/Usta",
  finance: "Moliyachi",
};

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

  const { name, phone, source, address, product, comment, leadDate } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "Ism va telefon raqami majburiy" });
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
    status: 'lead',
    dealAmount: 0,
    assignedSerialId: null,
    assignedSerialNumber: '',
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
    if (req.body.dealAmount !== undefined) update.dealAmount = Number(req.body.dealAmount) || 0;

    const before = await col.findOne({ id: req.params.id });
    if (!before) return res.status(404).json({ error: 'Lid topilmadi' });

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

      if (update.status === 'won') {
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

      if (update.status === 'lost' && updated.assignedSerialId) {
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

    const wonDeals = await leadsCol.find({ status: 'won' }).toArray();
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
      { header: 'Mahsulot', key: 'product', width: 22 },
      { header: 'Summa', key: 'dealAmount', width: 14 },
      { header: 'Seriya', key: 'assignedSerialNumber', width: 16 },
      { header: "Qo'shdi", key: 'addedBy', width: 18 },
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

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server ' + PORT + '-portda ishga tushdi'));
