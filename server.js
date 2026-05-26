const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'wms-secret-2024';

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));

// ── DB HELPERS ────────────────────────────────────────────────
const query = async (sql, params = []) => {
  // Convert SQLite ? placeholders to PostgreSQL $1, $2...
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  const result = await pool.query(pgSql, params);
  return result.rows;
};
const getOne = async (sql, params = []) => {
  const rows = await query(sql, params);
  return rows[0] || null;
};
const run = async (sql, params = []) => {
  // For INSERT...RETURNING id, UPDATE, DELETE
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  // Add RETURNING id for INSERT statements
  const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
  const finalSql = isInsert && !pgSql.includes('RETURNING') ? pgSql + ' RETURNING id' : pgSql;
  const result = await pool.query(finalSql, params);
  return result.rows[0]?.id || null;
};

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};
const adminOnly = (req, res, next) => {
  if (!['admin', 'manager'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
  next();
};

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await getOne('SELECT * FROM users WHERE email=?', [email]);
    if (!user) return res.status(400).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role, warehouse_id: user.warehouse_id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, warehouse_id: user.warehouse_id, phone: user.phone } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, password, role, warehouse_id, phone } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const id = await run('INSERT INTO users (name,email,password,role,warehouse_id,phone) VALUES (?,?,?,?,?,?)', [name, email, hash, role||'staff', warehouse_id||null, phone||null]);
    res.json({ id, name, email, role });
  } catch { res.status(400).json({ error: 'Email already exists' }); }
});

// ── DASHBOARD ─────────────────────────────────────────────────
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [tp,tw,ts,ls,es,exp,tm,pg,pd,rm] = await Promise.all([
      getOne('SELECT COUNT(*) as c FROM products'),
      getOne('SELECT COUNT(*) as c FROM warehouses'),
      getOne('SELECT COALESCE(SUM(quantity),0) as c FROM stock'),
      getOne(`SELECT COUNT(DISTINCT p.id) as c FROM products p LEFT JOIN (SELECT product_id,SUM(quantity) as total FROM stock GROUP BY product_id) s ON p.id=s.product_id WHERE COALESCE(s.total,0)<p.min_threshold`),
      getOne(`SELECT COUNT(*) as c FROM stock WHERE expiry_date IS NOT NULL AND expiry_date<=CURRENT_DATE+INTERVAL'30 days' AND expiry_date>=CURRENT_DATE AND quantity>0`),
      getOne(`SELECT COUNT(*) as c FROM stock WHERE expiry_date IS NOT NULL AND expiry_date<CURRENT_DATE AND quantity>0`),
      getOne('SELECT COUNT(*) as c FROM movements WHERE DATE(created_at)=?', [today]),
      getOne(`SELECT COUNT(*) as c FROM grn WHERE status='draft'`),
      getOne(`SELECT COUNT(*) as c FROM dispatch_notes WHERE status='pending'`),
      query('SELECT m.*,p.name as product_name,w.name as warehouse_name FROM movements m JOIN products p ON m.product_id=p.id JOIN warehouses w ON m.warehouse_id=w.id ORDER BY m.created_at DESC LIMIT 10')
    ]);
    res.json({ totalProducts:tp.c, totalWarehouses:tw.c, totalStock:ts.c, lowStock:ls.c, expiringSoon:es.c, expired:exp.c, todayMovements:tm.c, pendingGRN:pg.c, pendingDispatch:pd.c, recentMovements:rm });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── WAREHOUSES ────────────────────────────────────────────────
app.get('/api/warehouses', auth, async (req, res) => { try { res.json(await query('SELECT * FROM warehouses ORDER BY name')); } catch(e) { res.status(500).json({error:e.message}); } });
app.post('/api/warehouses', auth, adminOnly, async (req, res) => {
  try { const { name,address,city,phone } = req.body; const id = await run('INSERT INTO warehouses (name,address,city,phone) VALUES (?,?,?,?)',[name,address||null,city||null,phone||null]); res.json({id,name}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.put('/api/warehouses/:id', auth, adminOnly, async (req, res) => {
  try { const {name,address,city,phone}=req.body; await run('UPDATE warehouses SET name=?,address=?,city=?,phone=? WHERE id=?',[name,address||null,city||null,phone||null,req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/warehouses/:id', auth, adminOnly, async (req, res) => {
  try { await run('DELETE FROM warehouses WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── BINS ──────────────────────────────────────────────────────
app.get('/api/bins', auth, async (req, res) => {
  try {
    const { warehouse_id } = req.query;
    const q = warehouse_id ? 'SELECT b.*,w.name as warehouse_name FROM bins b JOIN warehouses w ON b.warehouse_id=w.id WHERE b.warehouse_id=? ORDER BY b.bin_code' : 'SELECT b.*,w.name as warehouse_name FROM bins b JOIN warehouses w ON b.warehouse_id=w.id ORDER BY b.bin_code';
    res.json(warehouse_id ? await query(q,[warehouse_id]) : await query(q));
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/bins', auth, adminOnly, async (req, res) => {
  try { const {warehouse_id,zone,rack,shelf}=req.body; const bin_code=`${zone}-${rack}-${shelf}`; const id=await run('INSERT INTO bins (warehouse_id,zone,rack,shelf,bin_code) VALUES (?,?,?,?,?)',[warehouse_id,zone,rack,shelf,bin_code]); res.json({id,bin_code}); } catch(e) { res.status(400).json({error:'Bin code already exists'}); }
});
app.put('/api/bins/:id', auth, adminOnly, async (req, res) => {
  try { const {zone,rack,shelf}=req.body; const bin_code=`${zone}-${rack}-${shelf}`; await run('UPDATE bins SET zone=?,rack=?,shelf=?,bin_code=? WHERE id=?',[zone,rack,shelf,bin_code,req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/bins/:id', auth, adminOnly, async (req, res) => {
  try { await run('DELETE FROM bins WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── CATEGORIES ────────────────────────────────────────────────
app.get('/api/categories', auth, async (req, res) => { try { res.json(await query('SELECT * FROM categories ORDER BY name')); } catch(e) { res.status(500).json({error:e.message}); } });
app.post('/api/categories', auth, adminOnly, async (req, res) => {
  try { const id=await run('INSERT INTO categories (name) VALUES (?)',[req.body.name]); res.json({id,name:req.body.name}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.put('/api/categories/:id', auth, adminOnly, async (req, res) => {
  try { await run('UPDATE categories SET name=? WHERE id=?',[req.body.name,req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/categories/:id', auth, adminOnly, async (req, res) => {
  try { await run('UPDATE products SET category_id=NULL WHERE category_id=?',[req.params.id]); await run('DELETE FROM categories WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── PRODUCTS ──────────────────────────────────────────────────
app.get('/api/products', auth, async (req, res) => {
  try { res.json(await query(`SELECT p.*,c.name as category_name,COALESCE((SELECT SUM(quantity) FROM stock WHERE product_id=p.id),0) as total_stock FROM products p LEFT JOIN categories c ON p.category_id=c.id ORDER BY p.name`)); } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/products', auth, adminOnly, async (req, res) => {
  try { const {name,sku,barcode,category_id,unit,min_threshold,reorder_qty,weight,description}=req.body; const id=await run('INSERT INTO products (name,sku,barcode,category_id,unit,min_threshold,reorder_qty,weight,description) VALUES (?,?,?,?,?,?,?,?,?)',[name,sku,barcode||null,category_id||null,unit||'pcs',min_threshold||10,reorder_qty||50,weight||null,description||null]); res.json({id,name,sku}); } catch(e) { res.status(400).json({error:'SKU or barcode already exists'}); }
});
app.put('/api/products/:id', auth, adminOnly, async (req, res) => {
  try { const {name,sku,barcode,category_id,unit,min_threshold,reorder_qty,weight,description}=req.body; await run('UPDATE products SET name=?,sku=?,barcode=?,category_id=?,unit=?,min_threshold=?,reorder_qty=?,weight=?,description=? WHERE id=?',[name,sku,barcode||null,category_id||null,unit||'pcs',min_threshold||10,reorder_qty||50,weight||null,description||null,req.params.id]); res.json({success:true}); } catch(e) { res.status(400).json({error:e.message}); }
});
app.delete('/api/products/:id', auth, adminOnly, async (req, res) => {
  try { await run('DELETE FROM stock WHERE product_id=?',[req.params.id]); await run('DELETE FROM products WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.get('/api/products/barcode/:barcode', auth, async (req, res) => {
  try { const p=await getOne('SELECT p.*,c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.barcode=? OR p.sku=?',[req.params.barcode,req.params.barcode]); if(!p) return res.status(404).json({error:'Product not found'}); res.json(p); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── STOCK ─────────────────────────────────────────────────────
app.get('/api/stock', auth, async (req, res) => {
  try {
    const {warehouse_id,product_id}=req.query;
    let q=`SELECT s.*,p.name as product_name,p.sku,p.barcode,p.min_threshold,p.unit,w.name as warehouse_name,b.bin_code,b.zone,b.rack,b.shelf,c.name as category_name FROM stock s JOIN products p ON s.product_id=p.id JOIN warehouses w ON s.warehouse_id=w.id LEFT JOIN bins b ON s.bin_id=b.id LEFT JOIN categories c ON p.category_id=c.id WHERE 1=1`;
    const params=[];
    if(warehouse_id){q+=' AND s.warehouse_id=?';params.push(warehouse_id);}
    if(product_id){q+=' AND s.product_id=?';params.push(product_id);}
    res.json(await query(q,params));
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.put('/api/stock/:id', auth, adminOnly, async (req, res) => {
  try { const {quantity,batch_no,expiry_date,mfg_date}=req.body; await run('UPDATE stock SET quantity=?,batch_no=?,expiry_date=?,mfg_date=?,updated_at=NOW() WHERE id=?',[quantity,batch_no||null,expiry_date||null,mfg_date||null,req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/stock/:id', auth, adminOnly, async (req, res) => {
  try { await run('DELETE FROM stock WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── SUPPLIERS ─────────────────────────────────────────────────
app.get('/api/suppliers', auth, async (req, res) => { try { res.json(await query('SELECT * FROM suppliers ORDER BY name')); } catch(e) { res.status(500).json({error:e.message}); } });
app.post('/api/suppliers', auth, adminOnly, async (req, res) => {
  try { const {name,contact_person,phone,email,address,gst_no}=req.body; const id=await run('INSERT INTO suppliers (name,contact_person,phone,email,address,gst_no) VALUES (?,?,?,?,?,?)',[name,contact_person||null,phone||null,email||null,address||null,gst_no||null]); res.json({id,name}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.put('/api/suppliers/:id', auth, adminOnly, async (req, res) => {
  try { const {name,contact_person,phone,email,address,gst_no}=req.body; await run('UPDATE suppliers SET name=?,contact_person=?,phone=?,email=?,address=?,gst_no=? WHERE id=?',[name,contact_person||null,phone||null,email||null,address||null,gst_no||null,req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/suppliers/:id', auth, adminOnly, async (req, res) => {
  try { await run('DELETE FROM suppliers WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── PURCHASE ORDERS ───────────────────────────────────────────
app.get('/api/purchase-orders', auth, async (req, res) => {
  try { res.json(await query(`SELECT po.*,s.name as supplier_name,w.name as warehouse_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id=s.id LEFT JOIN warehouses w ON po.warehouse_id=w.id ORDER BY po.created_at DESC`)); } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/purchase-orders', auth, adminOnly, async (req, res) => {
  try {
    const {supplier_id,warehouse_id,items,notes}=req.body;
    const po_number='PO-'+Date.now();
    const total=items.reduce((s,i)=>s+(i.qty*(i.unit_price||0)),0);
    const poId=await run('INSERT INTO purchase_orders (po_number,supplier_id,warehouse_id,total_amount,notes,created_by) VALUES (?,?,?,?,?,?)',[po_number,supplier_id||null,warehouse_id||null,total,notes||null,req.user.id]);
    for(const i of items) await run('INSERT INTO po_items (po_id,product_id,ordered_qty,unit_price) VALUES (?,?,?,?)',[poId,i.product_id,i.qty,i.unit_price||0]);
    res.json({id:poId,po_number});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.patch('/api/purchase-orders/:id/status', auth, async (req, res) => {
  try { await run('UPDATE purchase_orders SET status=? WHERE id=?',[req.body.status,req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/purchase-orders/:id', auth, adminOnly, async (req, res) => {
  try { await run('DELETE FROM po_items WHERE po_id=?',[req.params.id]); await run('DELETE FROM purchase_orders WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── GRN ───────────────────────────────────────────────────────
app.get('/api/grn', auth, async (req, res) => {
  try { res.json(await query(`SELECT g.*,s.name as supplier_name,w.name as warehouse_name FROM grn g LEFT JOIN suppliers s ON g.supplier_id=s.id LEFT JOIN warehouses w ON g.warehouse_id=w.id ORDER BY g.received_at DESC`)); } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/grn', auth, async (req, res) => {
  try {
    const {po_id,supplier_id,warehouse_id,items,notes}=req.body;
    const grn_number='GRN-'+Date.now();
    const grnId=await run('INSERT INTO grn (grn_number,po_id,supplier_id,warehouse_id,received_by,notes,status) VALUES (?,?,?,?,?,?,?)',[grn_number,po_id||null,supplier_id||null,warehouse_id,req.user.id,notes||null,'confirmed']);
    for(const i of items){
      await run('INSERT INTO grn_items (grn_id,product_id,bin_id,received_qty,batch_no,expiry_date,mfg_date,unit_price) VALUES (?,?,?,?,?,?,?,?)',[grnId,i.product_id,i.bin_id||null,i.qty,i.batch_no||null,i.expiry_date||null,i.mfg_date||null,i.unit_price||0]);
      const existing=await getOne('SELECT id FROM stock WHERE product_id=? AND warehouse_id=? AND (bin_id=? OR (bin_id IS NULL AND ? IS NULL))',[i.product_id,warehouse_id,i.bin_id||null,i.bin_id||null]);
      if(existing){ await run('UPDATE stock SET quantity=quantity+?,updated_at=NOW() WHERE id=?',[i.qty,existing.id]); }
      else { await run('INSERT INTO stock (product_id,warehouse_id,bin_id,quantity,batch_no,expiry_date,mfg_date) VALUES (?,?,?,?,?,?,?)',[i.product_id,warehouse_id,i.bin_id||null,i.qty,i.batch_no||null,i.expiry_date||null,i.mfg_date||null]); }
      await run('INSERT INTO movements (product_id,warehouse_id,bin_id,type,qty,reference_no,batch_no,expiry_date,created_by) VALUES (?,?,?,?,?,?,?,?,?)',[i.product_id,warehouse_id,i.bin_id||null,'inward',i.qty,grn_number,i.batch_no||null,i.expiry_date||null,req.user.id]);
    }
    res.json({id:grnId,grn_number});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/grn/:id', auth, adminOnly, async (req, res) => {
  try { await run('DELETE FROM grn_items WHERE grn_id=?',[req.params.id]); await run('DELETE FROM grn WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── DISPATCH NOTES ────────────────────────────────────────────
app.get('/api/dispatch-notes', auth, async (req, res) => {
  try { res.json(await query(`SELECT dn.*,w.name as warehouse_name FROM dispatch_notes dn LEFT JOIN warehouses w ON dn.warehouse_id=w.id ORDER BY dn.created_at DESC`)); } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/dispatch-notes', auth, async (req, res) => {
  try {
    const {warehouse_id,customer_name,customer_phone,customer_address,delivery_date,items,notes}=req.body;
    const dn_number='DN-'+Date.now();
    const dnId=await run('INSERT INTO dispatch_notes (dn_number,warehouse_id,customer_name,customer_phone,customer_address,delivery_date,dispatched_by,notes) VALUES (?,?,?,?,?,?,?,?)',[dn_number,warehouse_id,customer_name||null,customer_phone||null,customer_address||null,delivery_date||null,req.user.id,notes||null]);
    for(const i of items){
      await run('INSERT INTO dn_items (dn_id,product_id,bin_id,qty,batch_no) VALUES (?,?,?,?,?)',[dnId,i.product_id,i.bin_id||null,i.qty,i.batch_no||null]);
      await run('UPDATE stock SET quantity=GREATEST(0,quantity-?),updated_at=NOW() WHERE product_id=? AND warehouse_id=?',[i.qty,i.product_id,warehouse_id]);
      await run('INSERT INTO movements (product_id,warehouse_id,bin_id,type,qty,reference_no,batch_no,created_by) VALUES (?,?,?,?,?,?,?,?)',[i.product_id,warehouse_id,i.bin_id||null,'outward',i.qty,dn_number,i.batch_no||null,req.user.id]);
    }
    res.json({id:dnId,dn_number});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.patch('/api/dispatch-notes/:id/status', auth, async (req, res) => {
  try { await run('UPDATE dispatch_notes SET status=? WHERE id=?',[req.body.status,req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.put('/api/dispatch-notes/:id', auth, adminOnly, async (req, res) => {
  try { const {customer_name,customer_phone,customer_address,delivery_date,notes}=req.body; await run('UPDATE dispatch_notes SET customer_name=?,customer_phone=?,customer_address=?,delivery_date=?,notes=? WHERE id=?',[customer_name||null,customer_phone||null,customer_address||null,delivery_date||null,notes||null,req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/dispatch-notes/:id', auth, adminOnly, async (req, res) => {
  try { await run('DELETE FROM dn_items WHERE dn_id=?',[req.params.id]); await run('DELETE FROM dispatch_notes WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── MOVEMENTS ─────────────────────────────────────────────────
app.get('/api/movements', auth, async (req, res) => {
  try {
    const {warehouse_id,type,limit=50}=req.query;
    let q=`SELECT m.*,p.name as product_name,p.sku,w.name as warehouse_name,b.bin_code,u.name as created_by_name FROM movements m JOIN products p ON m.product_id=p.id JOIN warehouses w ON m.warehouse_id=w.id LEFT JOIN bins b ON m.bin_id=b.id LEFT JOIN users u ON m.created_by=u.id WHERE 1=1`;
    const params=[];
    if(warehouse_id){q+=' AND m.warehouse_id=?';params.push(warehouse_id);}
    if(type){q+=' AND m.type=?';params.push(type);}
    q+=` ORDER BY m.created_at DESC LIMIT ?`;params.push(parseInt(limit));
    res.json(await query(q,params));
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/movements/:id', auth, adminOnly, async (req, res) => {
  try { await run('DELETE FROM movements WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── EXPIRY ────────────────────────────────────────────────────
app.get('/api/expiry', auth, async (req, res) => {
  try {
    const base=`SELECT s.*,p.name as product_name,p.sku,w.name as warehouse_name,b.bin_code FROM stock s JOIN products p ON s.product_id=p.id JOIN warehouses w ON s.warehouse_id=w.id LEFT JOIN bins b ON s.bin_id=b.id`;
    const [expired,expiring7,expiring30]=await Promise.all([
      query(base+` WHERE s.expiry_date<CURRENT_DATE AND s.quantity>0 ORDER BY s.expiry_date`),
      query(base+` WHERE s.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL'7 days' AND s.quantity>0 ORDER BY s.expiry_date`),
      query(base+` WHERE s.expiry_date BETWEEN CURRENT_DATE+INTERVAL'8 days' AND CURRENT_DATE+INTERVAL'30 days' AND s.quantity>0 ORDER BY s.expiry_date`)
    ]);
    res.json({expired,expiring7,expiring30});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── REPORTS ───────────────────────────────────────────────────
app.get('/api/reports/stock-summary', auth, async (req, res) => {
  try {
    const [byWarehouse,byCategory,topProducts,lowStock,movementTrend]=await Promise.all([
      query(`SELECT w.name,SUM(s.quantity) as total FROM stock s JOIN warehouses w ON s.warehouse_id=w.id GROUP BY w.id,w.name`),
      query(`SELECT c.name,SUM(s.quantity) as total FROM stock s JOIN products p ON s.product_id=p.id LEFT JOIN categories c ON p.category_id=c.id GROUP BY c.id,c.name`),
      query(`SELECT p.name,SUM(s.quantity) as total FROM stock s JOIN products p ON s.product_id=p.id GROUP BY p.id,p.name ORDER BY total DESC LIMIT 10`),
      query(`SELECT p.name,p.min_threshold,p.unit,COALESCE(SUM(s.quantity),0) as total FROM products p LEFT JOIN stock s ON p.id=s.product_id GROUP BY p.id,p.name,p.min_threshold,p.unit HAVING COALESCE(SUM(s.quantity),0)<p.min_threshold ORDER BY total`),
      query(`SELECT DATE(created_at) as date,type,SUM(qty) as total FROM movements WHERE created_at>=NOW()-INTERVAL'30 days' GROUP BY DATE(created_at),type ORDER BY date`)
    ]);
    res.json({byWarehouse,byCategory,topProducts,lowStock,movementTrend});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/reports/movements/export', auth, async (req, res) => {
  try {
    const movements=await query(`SELECT m.created_at,p.name as product,p.sku,m.type,m.qty,w.name as warehouse,b.bin_code,m.reference_no,m.batch_no,m.expiry_date,m.notes FROM movements m JOIN products p ON m.product_id=p.id JOIN warehouses w ON m.warehouse_id=w.id LEFT JOIN bins b ON m.bin_id=b.id ORDER BY m.created_at DESC`);
    const headers=['Date','Product','SKU','Type','Qty','Warehouse','Bin','Reference','Batch','Expiry','Notes'];
    const rows=movements.map(m=>[m.created_at,m.product,m.sku,m.type,m.qty,m.warehouse,m.bin_code||'',m.reference_no||'',m.batch_no||'',m.expiry_date||'',m.notes||''].join(','));
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename="movements.csv"');
    res.send([headers.join(','),...rows].join('\n'));
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/reports/warehouse/:id', auth, async (req, res) => {
  try {
    const wid=req.params.id;
    const today=new Date().toISOString().split('T')[0];
    const [warehouse,ts,tp,tb,ob,ls,exp,ex7,ex30,ti,to_,pg,pd,sbc,top,lsi,ei,rm,bs]=await Promise.all([
      getOne('SELECT * FROM warehouses WHERE id=?',[wid]),
      getOne('SELECT COALESCE(SUM(quantity),0) as v FROM stock WHERE warehouse_id=?',[wid]),
      getOne('SELECT COUNT(DISTINCT product_id) as v FROM stock WHERE warehouse_id=? AND quantity>0',[wid]),
      getOne('SELECT COUNT(*) as v FROM bins WHERE warehouse_id=?',[wid]),
      getOne('SELECT COUNT(DISTINCT bin_id) as v FROM stock WHERE warehouse_id=? AND quantity>0 AND bin_id IS NOT NULL',[wid]),
      getOne(`SELECT COUNT(DISTINCT s.product_id) as v FROM stock s JOIN products p ON s.product_id=p.id WHERE s.warehouse_id=? AND (SELECT COALESCE(SUM(quantity),0) FROM stock WHERE product_id=s.product_id AND warehouse_id=?)<p.min_threshold`,[wid,wid]),
      getOne(`SELECT COUNT(*) as v FROM stock WHERE warehouse_id=? AND expiry_date<CURRENT_DATE AND quantity>0`,[wid]),
      getOne(`SELECT COUNT(*) as v FROM stock WHERE warehouse_id=? AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL'7 days' AND quantity>0`,[wid]),
      getOne(`SELECT COUNT(*) as v FROM stock WHERE warehouse_id=? AND expiry_date BETWEEN CURRENT_DATE+INTERVAL'8 days' AND CURRENT_DATE+INTERVAL'30 days' AND quantity>0`,[wid]),
      getOne(`SELECT COALESCE(SUM(qty),0) as v FROM movements WHERE warehouse_id=? AND type='inward' AND DATE(created_at)=?`,[wid,today]),
      getOne(`SELECT COALESCE(SUM(qty),0) as v FROM movements WHERE warehouse_id=? AND type='outward' AND DATE(created_at)=?`,[wid,today]),
      getOne(`SELECT COUNT(*) as v FROM grn WHERE warehouse_id=? AND status='draft'`,[wid]),
      getOne(`SELECT COUNT(*) as v FROM dispatch_notes WHERE warehouse_id=? AND status='pending'`,[wid]),
      query(`SELECT c.name,SUM(s.quantity) as total FROM stock s JOIN products p ON s.product_id=p.id LEFT JOIN categories c ON p.category_id=c.id WHERE s.warehouse_id=? AND s.quantity>0 GROUP BY c.id,c.name ORDER BY total DESC`,[wid]),
      query(`SELECT p.name,p.sku,p.unit,SUM(s.quantity) as total FROM stock s JOIN products p ON s.product_id=p.id WHERE s.warehouse_id=? AND s.quantity>0 GROUP BY p.id,p.name,p.sku,p.unit ORDER BY total DESC LIMIT 10`,[wid]),
      query(`SELECT p.name,p.sku,p.unit,p.min_threshold,COALESCE(SUM(s.quantity),0) as total FROM products p LEFT JOIN stock s ON p.id=s.product_id AND s.warehouse_id=? GROUP BY p.id,p.name,p.sku,p.unit,p.min_threshold HAVING COALESCE(SUM(s.quantity),0)<p.min_threshold ORDER BY total`,[wid]),
      query(`SELECT p.name,p.sku,s.batch_no,s.expiry_date,s.quantity,p.unit FROM stock s JOIN products p ON s.product_id=p.id WHERE s.warehouse_id=? AND s.expiry_date<=CURRENT_DATE+INTERVAL'30 days' AND s.quantity>0 ORDER BY s.expiry_date`,[wid]),
      query(`SELECT m.created_at,p.name as product_name,m.type,m.qty,b.bin_code,m.reference_no FROM movements m JOIN products p ON m.product_id=p.id LEFT JOIN bins b ON m.bin_id=b.id WHERE m.warehouse_id=? ORDER BY m.created_at DESC LIMIT 10`,[wid]),
      query(`SELECT b.bin_code,b.zone,b.rack,b.shelf,COALESCE(SUM(s.quantity),0) as total FROM bins b LEFT JOIN stock s ON b.id=s.bin_id AND s.warehouse_id=? WHERE b.warehouse_id=? GROUP BY b.id,b.bin_code,b.zone,b.rack,b.shelf ORDER BY b.zone,b.rack,b.shelf`,[wid,wid])
    ]);
    if(!warehouse) return res.status(404).json({error:'Warehouse not found'});
    res.json({warehouse,totalStock:ts.v,totalProducts:tp.v,totalBins:tb.v,occupiedBins:ob.v,lowStock:ls.v,expired:exp.v,expiring7:ex7.v,expiring30:ex30.v,todayIn:ti.v,todayOut:to_.v,pendingGRN:pg.v,pendingDispatch:pd.v,stockByCategory:sbc,topProducts:top,lowStockItems:lsi,expiringItems:ei,recentMovements:rm,binStock:bs});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── STOCK TRANSFER ────────────────────────────────────────────
app.post('/api/stock/transfer', auth, async (req, res) => {
  try {
    const {stock_id,to_warehouse_id,to_bin_id,qty,notes}=req.body;
    if(!stock_id||!to_warehouse_id||!qty||qty<=0) return res.status(400).json({error:'stock_id, to_warehouse_id and qty are required'});
    const src=await getOne('SELECT s.*,p.name as product_name,p.unit FROM stock s JOIN products p ON s.product_id=p.id WHERE s.id=?',[stock_id]);
    if(!src) return res.status(404).json({error:'Source stock not found'});
    if(src.quantity<qty) return res.status(400).json({error:`Only ${src.quantity} ${src.unit} available`});
    if(src.warehouse_id==to_warehouse_id&&(src.bin_id==to_bin_id||(!src.bin_id&&!to_bin_id))) return res.status(400).json({error:'Source and destination are the same'});
    const ref='TRF-'+Date.now();
    await run('UPDATE stock SET quantity=quantity-?,updated_at=NOW() WHERE id=?',[qty,stock_id]);
    const dest=await getOne('SELECT id FROM stock WHERE product_id=? AND warehouse_id=? AND (bin_id=? OR (bin_id IS NULL AND ? IS NULL))',[src.product_id,to_warehouse_id,to_bin_id||null,to_bin_id||null]);
    if(dest){ await run('UPDATE stock SET quantity=quantity+?,updated_at=NOW() WHERE id=?',[qty,dest.id]); }
    else { await run('INSERT INTO stock (product_id,warehouse_id,bin_id,quantity,batch_no,expiry_date,mfg_date) VALUES (?,?,?,?,?,?,?)',[src.product_id,to_warehouse_id,to_bin_id||null,qty,src.batch_no,src.expiry_date,src.mfg_date]); }
    await run('INSERT INTO movements (product_id,warehouse_id,bin_id,type,qty,reference_no,batch_no,expiry_date,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',[src.product_id,src.warehouse_id,src.bin_id,'transfer',qty,ref,src.batch_no,src.expiry_date,'Transfer out '+(notes||''),req.user.id]);
    await run('INSERT INTO movements (product_id,warehouse_id,bin_id,type,qty,reference_no,batch_no,expiry_date,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',[src.product_id,to_warehouse_id,to_bin_id||null,'transfer',qty,ref,src.batch_no,src.expiry_date,'Transfer in '+(notes||''),req.user.id]);
    res.json({success:true,reference:ref,product:src.product_name,qty,unit:src.unit});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── ALERTS ────────────────────────────────────────────────────
app.get('/api/alerts', auth, async (req, res) => {
  try { res.json(await query('SELECT a.*,p.name as product_name,w.name as warehouse_name FROM alerts a LEFT JOIN products p ON a.product_id=p.id LEFT JOIN warehouses w ON a.warehouse_id=w.id ORDER BY a.created_at DESC LIMIT 50')); } catch(e) { res.status(500).json({error:e.message}); }
});
app.patch('/api/alerts/:id/read', auth, async (req, res) => {
  try { await run('UPDATE alerts SET is_read=1 WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── USERS ─────────────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, async (req, res) => { try { res.json(await query('SELECT id,name,email,role,phone,warehouse_id,created_at FROM users ORDER BY name')); } catch(e) { res.status(500).json({error:e.message}); } });
app.put('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const {name,email,role,phone,warehouse_id,password}=req.body;
    if(password){ const hash=await bcrypt.hash(password,10); await run('UPDATE users SET name=?,email=?,role=?,phone=?,warehouse_id=?,password=? WHERE id=?',[name,email,role||'staff',phone||null,warehouse_id||null,hash,req.params.id]); }
    else { await run('UPDATE users SET name=?,email=?,role=?,phone=?,warehouse_id=? WHERE id=?',[name,email,role||'staff',phone||null,warehouse_id||null,req.params.id]); }
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try { if(parseInt(req.params.id)===req.user.id) return res.status(400).json({error:'Cannot delete your own account'}); await run('DELETE FROM users WHERE id=?',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── EXCEL IMPORT ──────────────────────────────────────────────
app.post('/api/import/products', auth, adminOnly, async (req, res) => {
  const {rows}=req.body; if(!rows||!rows.length) return res.status(400).json({error:'No data'});
  let inserted=0,skipped=0,errors=[];
  for(const [i,r] of rows.entries()){
    const name=(r['Product Name']||r['name']||'').trim(); const sku=(r['SKU']||r['sku']||'').trim();
    if(!name||!sku){skipped++;continue;}
    const barcode=(r['Barcode']||'').trim()||null; const unit=(r['Unit']||'pkt').trim();
    const min_threshold=parseInt(r['Min Threshold']||10)||10; const reorder_qty=parseInt(r['Reorder Qty']||50)||50;
    const description=(r['Description']||'').trim()||null;
    let category_id=null; const catName=(r['Category']||'').trim();
    if(catName){ let cat=await getOne('SELECT id FROM categories WHERE name=?',[catName]); if(!cat){await run('INSERT INTO categories (name) VALUES (?)',[catName]);cat=await getOne('SELECT id FROM categories WHERE name=?',[catName]);} category_id=cat?.id||null; }
    try{ await run('INSERT INTO products (name,sku,barcode,category_id,unit,min_threshold,reorder_qty,description) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',[name,sku,barcode,category_id,unit,min_threshold,reorder_qty,description]); inserted++; }catch(e){errors.push(`Row ${i+2}: ${e.message}`);skipped++;}
  }
  res.json({inserted,skipped,errors});
});

app.post('/api/import/suppliers', auth, adminOnly, async (req, res) => {
  const {rows}=req.body; if(!rows||!rows.length) return res.status(400).json({error:'No data'});
  let inserted=0,skipped=0,errors=[];
  for(const [i,r] of rows.entries()){
    const name=(r['Supplier Name']||r['name']||'').trim(); if(!name){skipped++;continue;}
    try{ await run('INSERT INTO suppliers (name,contact_person,phone,email,address,gst_no) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',[name,r['Contact Person']||null,r['Phone']||null,r['Email']||null,r['Address']||null,r['GST No']||null]); inserted++; }catch(e){errors.push(`Row ${i+2}: ${e.message}`);skipped++;}
  }
  res.json({inserted,skipped,errors});
});

app.post('/api/import/stock', auth, adminOnly, async (req, res) => {
  const {rows}=req.body; if(!rows||!rows.length) return res.status(400).json({error:'No data'});
  let inserted=0,skipped=0,errors=[];
  for(const [i,r] of rows.entries()){
    const sku=(r['SKU']||'').trim(); const warehouseName=(r['Warehouse']||'').trim(); const qty=parseInt(r['Quantity']||0);
    if(!sku||!warehouseName||isNaN(qty)){skipped++;continue;}
    const product=await getOne('SELECT id FROM products WHERE sku=?',[sku]);
    const warehouse=await getOne('SELECT id FROM warehouses WHERE name=?',[warehouseName]);
    if(!product){errors.push(`Row ${i+2}: SKU "${sku}" not found`);skipped++;continue;}
    if(!warehouse){errors.push(`Row ${i+2}: Warehouse "${warehouseName}" not found`);skipped++;continue;}
    const binCode=(r['Bin Code']||'').trim()||null; let bin_id=null;
    if(binCode){const b=await getOne('SELECT id FROM bins WHERE bin_code=?',[binCode]);bin_id=b?.id||null;}
    const batch_no=(r['Batch No']||'').trim()||null; const expiry_date=(r['Expiry Date']||'').trim()||null;
    try{
      const existing=await getOne('SELECT id FROM stock WHERE product_id=? AND warehouse_id=? AND (bin_id=? OR (bin_id IS NULL AND ? IS NULL))',[product.id,warehouse.id,bin_id,bin_id]);
      if(existing){await run('UPDATE stock SET quantity=quantity+?,updated_at=NOW() WHERE id=?',[qty,existing.id]);}
      else{await run('INSERT INTO stock (product_id,warehouse_id,bin_id,quantity,batch_no,expiry_date) VALUES (?,?,?,?,?,?)',[product.id,warehouse.id,bin_id,qty,batch_no,expiry_date]);}
      await run('INSERT INTO movements (product_id,warehouse_id,bin_id,type,qty,reference_no,batch_no,expiry_date,created_by) VALUES (?,?,?,?,?,?,?,?,?)',[product.id,warehouse.id,bin_id,'inward',qty,'EXCEL-IMPORT',batch_no,expiry_date,req.user.id]);
      inserted++;
    }catch(e){errors.push(`Row ${i+2}: ${e.message}`);skipped++;}
  }
  res.json({inserted,skipped,errors});
});

app.post('/api/import/bins', auth, adminOnly, async (req, res) => {
  const {rows}=req.body; if(!rows||!rows.length) return res.status(400).json({error:'No data'});
  let inserted=0,skipped=0,errors=[];
  for(const [i,r] of rows.entries()){
    const warehouseName=(r['Warehouse']||'').trim(); const zone=(r['Zone']||'').trim(); const rack=(r['Rack']||'').trim(); const shelf=(r['Shelf']||'').trim();
    if(!warehouseName||!zone||!rack||!shelf){skipped++;continue;}
    const warehouse=await getOne('SELECT id FROM warehouses WHERE name=?',[warehouseName]);
    if(!warehouse){errors.push(`Row ${i+2}: Warehouse "${warehouseName}" not found`);skipped++;continue;}
    const bin_code=`${zone}-${rack}-${shelf}`;
    try{ await run('INSERT INTO bins (warehouse_id,zone,rack,shelf,bin_code) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',[warehouse.id,zone,rack,shelf,bin_code]); inserted++; }catch(e){errors.push(`Row ${i+2}: ${e.message}`);skipped++;}
  }
  res.json({inserted,skipped,errors});
});

// ── CLEAR DATABASE ────────────────────────────────────────────
app.post('/api/admin/clear-database', auth, adminOnly, async (req, res) => {
  if(req.body.confirm!=='CLEAR') return res.status(400).json({error:'Send confirm: "CLEAR"'});
  try {
    const tables=['alerts','movements','dn_items','dispatch_notes','grn_items','grn','po_items','purchase_orders','stock','bins','products','categories','suppliers','warehouses'];
    for(const t of tables) await pool.query(`DELETE FROM ${t}`);
    res.json({success:true,message:'All data cleared. Users kept intact.'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── AI CHAT ───────────────────────────────────────────────────
app.post('/api/ai/chat', auth, async (req, res) => {
  const {message}=req.body;
  const stats=await getOne('SELECT (SELECT COUNT(*) FROM products) as products,(SELECT COALESCE(SUM(quantity),0) FROM stock) as stock,(SELECT COUNT(*) FROM stock WHERE expiry_date<CURRENT_DATE AND quantity>0) as expired');
  try {
    const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:500,system:`You are a WMS assistant. Stats: ${JSON.stringify(stats)}. Be brief and helpful.`,messages:[{role:'user',content:message}]})});
    const data=await response.json();
    res.json({reply:data.content?.[0]?.text||'No response'});
  } catch { res.json({reply:'AI unavailable. Set ANTHROPIC_API_KEY in Railway environment variables.'}); }
});

// ── CRON: Daily alerts ────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  try {
    const lowItems=await query(`SELECT p.*,COALESCE(SUM(s.quantity),0) as total FROM products p LEFT JOIN stock s ON p.id=s.product_id GROUP BY p.id,p.name,p.sku,p.unit,p.min_threshold,p.reorder_qty,p.barcode,p.category_id,p.weight,p.description,p.created_at HAVING COALESCE(SUM(s.quantity),0)<p.min_threshold`);
    for(const p of lowItems) await run('INSERT INTO alerts (type,product_id,message) VALUES (?,?,?)',['low_stock',p.id,`Low stock: ${p.name} has only ${p.total} ${p.unit} (min: ${p.min_threshold})`]);
    const expiringItems=await query(`SELECT s.*,p.name,p.id as pid FROM stock s JOIN products p ON s.product_id=p.id WHERE s.expiry_date<=CURRENT_DATE+INTERVAL'7 days' AND s.expiry_date>=CURRENT_DATE AND s.quantity>0`);
    for(const s of expiringItems) await run('INSERT INTO alerts (type,product_id,warehouse_id,message) VALUES (?,?,?,?)',['expiry',s.pid,s.warehouse_id,`Expiring soon: ${s.name} batch ${s.batch_no||'N/A'} expires ${s.expiry_date}`]);
    console.log(`Daily alerts: ${lowItems.length} low stock, ${expiringItems.length} expiry`);
  } catch(e) { console.error('Cron error:',e.message); }
});

// ── INIT DB TABLES ON START ───────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT DEFAULT 'staff', warehouse_id INTEGER, phone TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS warehouses (id SERIAL PRIMARY KEY, name TEXT NOT NULL, address TEXT, city TEXT, phone TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS bins (id SERIAL PRIMARY KEY, warehouse_id INTEGER NOT NULL, zone TEXT NOT NULL, rack TEXT NOT NULL, shelf TEXT NOT NULL, bin_code TEXT UNIQUE NOT NULL, capacity INTEGER DEFAULT 100, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, name TEXT NOT NULL, sku TEXT UNIQUE NOT NULL, barcode TEXT UNIQUE, category_id INTEGER, unit TEXT DEFAULT 'pcs', min_threshold INTEGER DEFAULT 10, reorder_qty INTEGER DEFAULT 50, weight REAL, description TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stock (id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, bin_id INTEGER, quantity INTEGER DEFAULT 0, batch_no TEXT, expiry_date DATE, mfg_date DATE, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS suppliers (id SERIAL PRIMARY KEY, name TEXT NOT NULL, contact_person TEXT, phone TEXT, email TEXT, address TEXT, gst_no TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS purchase_orders (id SERIAL PRIMARY KEY, po_number TEXT UNIQUE NOT NULL, supplier_id INTEGER, warehouse_id INTEGER, status TEXT DEFAULT 'pending', total_amount REAL DEFAULT 0, notes TEXT, created_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS po_items (id SERIAL PRIMARY KEY, po_id INTEGER NOT NULL, product_id INTEGER NOT NULL, ordered_qty INTEGER NOT NULL, received_qty INTEGER DEFAULT 0, unit_price REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS grn (id SERIAL PRIMARY KEY, grn_number TEXT UNIQUE NOT NULL, po_id INTEGER, supplier_id INTEGER, warehouse_id INTEGER, received_by INTEGER, status TEXT DEFAULT 'draft', notes TEXT, received_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS grn_items (id SERIAL PRIMARY KEY, grn_id INTEGER NOT NULL, product_id INTEGER NOT NULL, bin_id INTEGER, received_qty INTEGER NOT NULL, batch_no TEXT, expiry_date DATE, mfg_date DATE, unit_price REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS dispatch_notes (id SERIAL PRIMARY KEY, dn_number TEXT UNIQUE NOT NULL, warehouse_id INTEGER, customer_name TEXT, customer_phone TEXT, customer_address TEXT, delivery_date DATE, status TEXT DEFAULT 'pending', dispatched_by INTEGER, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS dn_items (id SERIAL PRIMARY KEY, dn_id INTEGER NOT NULL, product_id INTEGER NOT NULL, bin_id INTEGER, qty INTEGER NOT NULL, batch_no TEXT);
    CREATE TABLE IF NOT EXISTS movements (id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, bin_id INTEGER, type TEXT NOT NULL, qty INTEGER NOT NULL, reference_no TEXT, batch_no TEXT, expiry_date DATE, notes TEXT, created_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS alerts (id SERIAL PRIMARY KEY, type TEXT NOT NULL, product_id INTEGER, warehouse_id INTEGER, message TEXT NOT NULL, is_read INTEGER DEFAULT 0, sent_sms INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW());
  `);
  const hash = await bcrypt.hash('admin123', 10);
  await pool.query(`INSERT INTO users (name,email,password,role) VALUES ('Admin','admin@wms.com',$1,'admin') ON CONFLICT (email) DO NOTHING`, [hash]);
  console.log('✅ Database ready');
}

// ── START ─────────────────────────────────────────────────────
async function start() {
  try {
    if (!process.env.DATABASE_URL) {
      console.error('❌ DATABASE_URL environment variable is not set!');
      console.error('   On Railway: Add PostgreSQL database to your project,');
      console.error('   then link it to this service. DATABASE_URL is set automatically.');
      process.exit(1);
    }
    console.log('🔌 Connecting to PostgreSQL...');
    await initDb();
    app.listen(PORT, () => {
      console.log(`✅ WMS Pro running on port ${PORT}`);
      console.log(`✅ PostgreSQL connected successfully`);
    });
  } catch(e) {
    console.error('❌ Failed to start:', e.message);
    console.error('   Full error:', e.stack);
    process.exit(1);
  }
}

start();
