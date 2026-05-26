// WMS Database Setup for PostgreSQL (Railway)
// Run once: node db/setup.js
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function setup() {
  const client = await pool.connect();
  try {
    console.log('Creating tables...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
        role TEXT DEFAULT 'staff', warehouse_id INTEGER, phone TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS warehouses (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL,
        address TEXT, city TEXT, phone TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bins (
        id SERIAL PRIMARY KEY, warehouse_id INTEGER NOT NULL,
        zone TEXT NOT NULL, rack TEXT NOT NULL, shelf TEXT NOT NULL,
        bin_code TEXT UNIQUE NOT NULL, capacity INTEGER DEFAULT 100,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL,
        sku TEXT UNIQUE NOT NULL, barcode TEXT UNIQUE,
        category_id INTEGER, unit TEXT DEFAULT 'pcs',
        min_threshold INTEGER DEFAULT 10, reorder_qty INTEGER DEFAULT 50,
        weight REAL, description TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS stock (
        id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL,
        warehouse_id INTEGER NOT NULL, bin_id INTEGER,
        quantity INTEGER DEFAULT 0, batch_no TEXT,
        expiry_date DATE, mfg_date DATE, updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS suppliers (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL,
        contact_person TEXT, phone TEXT, email TEXT,
        address TEXT, gst_no TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id SERIAL PRIMARY KEY, po_number TEXT UNIQUE NOT NULL,
        supplier_id INTEGER, warehouse_id INTEGER,
        status TEXT DEFAULT 'pending', total_amount REAL DEFAULT 0,
        notes TEXT, created_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS po_items (
        id SERIAL PRIMARY KEY, po_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL, ordered_qty INTEGER NOT NULL,
        received_qty INTEGER DEFAULT 0, unit_price REAL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS grn (
        id SERIAL PRIMARY KEY, grn_number TEXT UNIQUE NOT NULL,
        po_id INTEGER, supplier_id INTEGER, warehouse_id INTEGER,
        received_by INTEGER, status TEXT DEFAULT 'draft',
        notes TEXT, received_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS grn_items (
        id SERIAL PRIMARY KEY, grn_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL, bin_id INTEGER,
        received_qty INTEGER NOT NULL, batch_no TEXT,
        expiry_date DATE, mfg_date DATE, unit_price REAL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS dispatch_notes (
        id SERIAL PRIMARY KEY, dn_number TEXT UNIQUE NOT NULL,
        warehouse_id INTEGER, customer_name TEXT, customer_phone TEXT,
        customer_address TEXT, delivery_date DATE,
        status TEXT DEFAULT 'pending', dispatched_by INTEGER,
        notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS dn_items (
        id SERIAL PRIMARY KEY, dn_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL, bin_id INTEGER,
        qty INTEGER NOT NULL, batch_no TEXT
      );
      CREATE TABLE IF NOT EXISTS movements (
        id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL,
        warehouse_id INTEGER NOT NULL, bin_id INTEGER,
        type TEXT NOT NULL, qty INTEGER NOT NULL,
        reference_no TEXT, batch_no TEXT, expiry_date DATE,
        notes TEXT, created_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY, type TEXT NOT NULL,
        product_id INTEGER, warehouse_id INTEGER,
        message TEXT NOT NULL, is_read INTEGER DEFAULT 0,
        sent_sms INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const hash = await bcrypt.hash('admin123', 10);
    await client.query(`
      INSERT INTO users (name,email,password,role)
      VALUES ('Admin','admin@wms.com',$1,'admin')
      ON CONFLICT (email) DO NOTHING
    `, [hash]);

    console.log('✅ Database setup complete!');
    console.log('   Login: admin@wms.com / admin123');
  } finally {
    client.release();
    await pool.end();
  }
}

setup().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
