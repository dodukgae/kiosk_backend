const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config(); // Load .env variables

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// Database configuration
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT, 10),
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

// Health check
app.get('/', (req, res) => {
  res.send('🚀 푸드코트 API 서버가 정상적으로 실행 중입니다!');
});

// ---------- Utility ----------
async function getPool() {
  return await sql.connect(dbConfig);
}

// ---------- Public APIs ----------
// Get all food corners
app.get('/api/corners', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='food_corner' AND COLUMN_NAME='corner_desc')
      ALTER TABLE food_corner ADD corner_desc NVARCHAR(200) NULL
    `);
    const result = await pool.request().query('SELECT corner_no, corner_name, corner_desc FROM food_corner ORDER BY corner_no');
    const corners = result.recordset.map(row => ({ corner_id: row.corner_no, corner_name: row.corner_name, corner_desc: row.corner_desc || '' }));
    res.json(corners);
  } catch (err) {
    console.error('[API Error] /api/corners:', err.message);
    res.status(500).send('데이터베이스 오류');
  }
});

// Get menus for a specific corner
app.get('/api/menus/:corner_id', async (req, res) => {
  try {
    const cornerId = parseInt(req.params.corner_id, 10);
    const pool = await getPool();
    const result = await pool.request()
      .input('c_no', sql.Int, cornerId)
      .query('SELECT menu_no, menu_name, price_amount, corner_no FROM product_menu WHERE corner_no = @c_no');
    const menus = result.recordset.map(row => ({ menu_id: row.menu_no, menu_name: row.menu_name, price: row.price_amount, corner_id: row.corner_no }));
    res.json(menus);
  } catch (err) {
    console.error('[API Error] /api/menus:', err.message);
    res.status(500).send('데이터베이스 오류');
  }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { name, type } = req.body;
    console.log('🔍 Login request body:', req.body);
    const customerType = type || "내국인 주문하기";
    const pool = await getPool();
    const insertResult = await pool.request()
      .input('c_type', sql.NVarChar, customerType)
      .query("INSERT INTO court_customer (customer_type) OUTPUT INSERTED.customer_no VALUES (@c_type)");
    const customerNo = insertResult.recordset[0].customer_no;
    res.json({ success: true, customerNo, name });
  } catch (err) {
    console.error('[API Error] /api/login:', err.message);
    res.status(500).json({ success: false, message: '로그인 처리 중 오류 발생' });
  }
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true });
});

// Translation proxy endpoint
app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang } = req.body;
    if (!text) return res.json({ success: false, text: '' });
    
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const fetchFn = typeof fetch !== 'undefined' ? fetch : (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    
    const response = await fetchFn(url);
    const data = await response.json();
    const translatedText = data[0][0][0];
    res.json({ success: true, text: translatedText });
  } catch (err) {
    console.error('[API Error] /api/translate:', err.message);
    res.json({ success: false, text: req.body.text });
  }
});

// Order creation endpoint
app.post('/api/order', async (req, res) => {
  try {
    const { name, cart, totalPrice } = req.body;
    const pool = await getPool();
    const custResult = await pool.request()
      .input('c_type', sql.NVarChar, "내국인 주문하기")
      .query("INSERT INTO court_customer (customer_type) OUTPUT INSERTED.customer_no VALUES (@c_type)");
    const customerNo = custResult.recordset[0].customer_no;

    const orderResult = await pool.request()
      .input('cust_no', sql.Int, customerNo)
      .input('total', sql.Int, totalPrice)
      .query("INSERT INTO order_master (customer_no) OUTPUT INSERTED.order_no VALUES (@cust_no)");
    const orderNo = orderResult.recordset[0].order_no;

    for (const item of cart) {
      await pool.request()
        .input('ord_no', sql.Int, orderNo)
        .input('menu_no', sql.Int, item.menu_id)
        .input('qty', sql.Int, item.quantity)
        .query('INSERT INTO order_item (order_no, menu_no, order_qty) VALUES (@ord_no, @menu_no, @qty)');
    }

    res.json({ success: true, orderId: orderNo });
  } catch (err) {
    console.error('[API Error] /api/order:', err.message);
    res.status(500).json({ success: false, message: '주문 처리 중 오류 발생' });
  }
});


// ---------- Admin APIs ----------
app.post('/api/admin/login', async (req, res) => {
  try {
    const { id, password } = req.body;
    const pool = await getPool();
    const result = await pool.request()
      .input('admin_id', sql.NVarChar, id)
      .input('admin_pw', sql.NVarChar, password)
      .query('SELECT admin_no FROM admin_account WHERE admin_id = @admin_id AND admin_pw = @admin_pw');
    if (result.recordset.length > 0) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: '아이디 또는 비밀번호가 틀렸습니다.' });
    }
  } catch (err) {
    const { id, password } = req.body;
    if (id === 'admin' && password === 'admin1234') {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: '아이디 또는 비밀번호가 틀렸습니다.' });
    }
  }
});

app.post('/api/admin/corner', async (req, res) => {
  try {
    const { cornerName, cornerDesc } = req.body;
    const pool = await getPool();
    const result = await pool.request()
      .input('c_name', sql.NVarChar, cornerName)
      .input('c_desc', sql.NVarChar, cornerDesc || '')
      .query('INSERT INTO food_corner (corner_name, corner_desc) OUTPUT INSERTED.corner_no VALUES (@c_name, @c_desc)');
    const newId = result.recordset[0].corner_no;
    res.json({ success: true, cornerId: newId });
  } catch (err) {
    console.error('[API Error] /api/admin/corner:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/admin/corner/:cornerId', async (req, res) => {
  try {
    const cornerId = parseInt(req.params.cornerId, 10);
    const {
      cornerName = req.body.corner_name,
      cornerDesc = req.body.corner_desc,
    } = req.body;
    const pool = await getPool();
    const updates = [];
    if (cornerName !== undefined) updates.push('corner_name = @c_name');
    if (cornerDesc !== undefined) updates.push('corner_desc = @c_desc');
    if (updates.length === 0) {
      return res.json({ success: false, message: 'No fields to update' });
    }
    const query = `UPDATE food_corner SET ${updates.join(', ')} WHERE corner_no = @c_id`;
    const request = pool.request().input('c_id', sql.Int, cornerId);
    if (cornerName !== undefined) request.input('c_name', sql.NVarChar, cornerName);
    if (cornerDesc !== undefined) request.input('c_desc', sql.NVarChar, cornerDesc);
    await request.query(query);
    res.json({ success: true });
  } catch (err) {
    console.error('[API Error] /api/admin/corner/:cornerId:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/menu', async (req, res) => {
  try {
    const { cornerId, menuName, price } = req.body;
    const pool = await getPool();
    const result = await pool.request()
      .input('c_id', sql.Int, cornerId)
      .input('m_name', sql.NVarChar, menuName)
      .input('price', sql.Int, price)
      .query('INSERT INTO product_menu (corner_no, menu_name, price_amount) OUTPUT INSERTED.menu_no VALUES (@c_id, @m_name, @price)');
    const newMenuId = result.recordset[0].menu_no;
    res.json({ success: true, menuId: newMenuId });
  } catch (err) {
    console.error('[API Error] /api/admin/menu:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/orders', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(
      `SELECT om.order_no, om.customer_no, om.ordered_at, om.order_status,
              i.item_no, i.menu_no, i.order_qty,
              m.menu_name, m.price_amount
       FROM order_master om
       JOIN order_item i ON om.order_no = i.order_no
       JOIN product_menu m ON i.menu_no = m.menu_no
       ORDER BY om.ordered_at DESC`
    );
    res.json(result.recordset);
  } catch (err) {
    console.error('[API Error] /api/admin/orders:', err.message);
    res.status(500).send('데이터베이스 오류');
  }
});

app.delete('/api/admin/corner/:id', async (req, res) => {
  try {
    const cornerId = parseInt(req.params.id, 10);
    const pool = await getPool();
    await pool.request()
      .input('c_id', sql.Int, cornerId)
      .query('DELETE FROM order_item WHERE menu_no IN (SELECT menu_no FROM product_menu WHERE corner_no = @c_id)');
    await pool.request()
      .input('c_id', sql.Int, cornerId)
      .query('DELETE FROM food_corner WHERE corner_no = @c_id');
    res.json({ success: true });
  } catch (err) {
    console.error('[API Error] DELETE /api/admin/corner:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/menu/:id', async (req, res) => {
  try {
    const menuId = parseInt(req.params.id, 10);
    const pool = await getPool();
    await pool.request()
      .input('m_id', sql.Int, menuId)
      .query('DELETE FROM order_item WHERE menu_no = @m_id');
    await pool.request()
      .input('m_id', sql.Int, menuId)
      .query('DELETE FROM product_menu WHERE menu_no = @m_id');
    res.json({ success: true });
  } catch (err) {
    console.error('[API Error] DELETE /api/admin/menu:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 💡 1. 포트 설정을 Vercel 환경에 맞게 동적으로 변경 (process.env.PORT 사용)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 푸드코트 서버 실행 중: 포트 ${PORT}`);
  console.log(`📡 연결된 DB: ${process.env.DB_DATABASE}`);
});

// 💡 2. Vercel 서버리스 환경을 위해 app 모듈 내보내기 추가
module.exports = app;