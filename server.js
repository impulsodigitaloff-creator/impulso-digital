require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// CORS for panel communication
const PANEL_ORIGIN = process.env.PANEL_API_URL || 'http://localhost:3001';
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin === PANEL_ORIGIN || origin.endsWith('.up.railway.app') || origin.includes('localhost'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'impulso-digital-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'image/svg+xml'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Formato no soportado. Solo PDF, JPG, PNG, GIF, SVG.'));
  }
});

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }
  const user = db.getUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Error al cerrar sesión' });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.get('/api/session', (req, res) => {
  if (req.session.userId) {
    res.json({ authenticated: true, user: { id: req.session.userId, username: req.session.username, role: req.session.role } });
  } else {
    res.json({ authenticated: false });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ panelUrl: PANEL_ORIGIN });
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  const stats = db.getDashboardStats();
  res.json(stats);
});

app.get('/api/clientes', requireAuth, (req, res) => {
  const { search, estado } = req.query;
  let clientes;
  if (search) clientes = db.searchClientes(search);
  else if (estado) clientes = db.getClientesByEstado(estado);
  else clientes = db.getAllClientes();

  const now = new Date();
  clientes = clientes.map(c => ({
    ...c,
    proximoVencer: c.fecha_vencimiento ? diasEntre(now, new Date(c.fecha_vencimiento)) : null
  }));
  res.json(clientes);
});

app.get('/api/clientes/:id', requireAuth, (req, res) => {
  const cliente = db.getClienteById(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(cliente);
});

app.post('/api/clientes', requireAuth, (req, res) => {
  const c = req.body;
  if (!c.empresa) return res.status(400).json({ error: 'Nombre de empresa requerido' });
  const id = db.createCliente(c);
  res.json({ success: true, id });
});

app.put('/api/clientes/:id', requireAuth, (req, res) => {
  const existing = db.getClienteById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Cliente no encontrado' });
  db.updateCliente(req.params.id, req.body);
  res.json({ success: true });
});

app.delete('/api/clientes/:id', requireAuth, (req, res) => {
  const existing = db.getClienteById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Cliente no encontrado' });
  db.deleteCliente(req.params.id);
  res.json({ success: true });
});

app.get('/api/clientes/:id/pagos', requireAuth, (req, res) => {
  const pagos = db.getPagosByCliente(req.params.id);
  res.json(pagos);
});

app.post('/api/clientes/:id/pagos', requireAuth, (req, res) => {
  const { monto, mes_correspondiente } = req.body;
  if (!monto) return res.status(400).json({ error: 'Monto requerido' });
  db.registrarPago(req.params.id, monto, mes_correspondiente || '');
  res.json({ success: true });
});

app.post('/api/clientes/:id/archivos', requireAuth, upload.array('archivos', 5), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No se subieron archivos' });
  }
  const files = req.files.map(f => ({
    client_id: parseInt(req.params.id),
    filename: f.filename,
    original_name: f.originalname,
    mimetype: f.mimetype,
    size: f.size
  }));
  db.saveFiles(files);
  res.json({ success: true, files: files.map(f => ({ ...f, url: `/uploads/${req.params.id}/${f.filename}` })) });
});

app.get('/api/clientes/:id/archivos', requireAuth, (req, res) => {
  const archivos = db.getFilesByCliente(req.params.id);
  res.json(archivos.map(a => ({
    ...a,
    url: `/uploads/${req.params.id}/${a.filename}`
  })));
});

app.delete('/api/archivos/:id', requireAuth, (req, res) => {
  db.deleteFile(req.params.id);
  res.json({ success: true });
});

// Panel Cliente: crear acceso para un cliente del CRM
app.post('/api/clientes/:id/panel', requireAuth, async (req, res) => {
  const cliente = db.getClienteById(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (cliente.panel_id) return res.status(400).json({ error: 'Ya tiene acceso a Panel Cliente' });

  const { email: bodyEmail, password } = req.body;
  const email = bodyEmail || (cliente.email || cliente.empresa.toLowerCase().replace(/[^a-z0-9]/g, '') + '@panel.cliente').trim();
  const panelPassword = password || 'panel123';

  try {
    const fetchUrl = process.env.PANEL_API_URL || 'http://localhost:3001';
    const apiKey = process.env.PANEL_API_KEY;

    const response = await fetch(`${fetchUrl}/api/businesses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ name: cliente.empresa, contact: cliente.contacto, phone: cliente.telefono || cliente.whatsapp, email, password: panelPassword })
    });
    const result = await response.json();
    if (!result.success) return res.status(400).json({ error: result.error });
    db.setClientePanel(cliente.id, result.id, email, panelPassword);
    res.json({ success: true, email, password: panelPassword, id: result.id });
  } catch (err) {
    res.status(500).json({ error: 'Error al conectar con Panel Cliente: ' + err.message });
  }
});

// Panel Cliente: actualizar referencia y credenciales en panelcliente
app.put('/api/clientes/:id/panel', requireAuth, async (req, res) => {
  const cliente = db.getClienteById(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  // Si tiene panel_id, actualizar también en panelcliente
  if (cliente.panel_id) {
    try {
      const fetchUrl = process.env.PANEL_API_URL || 'http://localhost:3001';
      const apiKey = process.env.PANEL_API_KEY;
      const r = await fetch(`${fetchUrl}/api/businesses/${cliente.panel_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ name: cliente.empresa, contact: cliente.contacto, phone: cliente.telefono || cliente.whatsapp, email, password })
      });
      const result = await r.json();
      if (!result.success) return res.status(400).json({ error: result.error || 'Error al actualizar en Panel Cliente' });
    } catch (err) {
      return res.status(500).json({ error: 'Error al conectar con Panel Cliente: ' + err.message });
    }
  }
  db.setClientePanel(cliente.id, cliente.panel_id || 0, email, password);
  res.json({ success: true, email, password });
});



app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

function diasEntre(a, b) {
  const diff = b.getTime() - a.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

app.listen(PORT, () => {
  console.log(`\n  Impulso Digital CRM corriendo en:`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  Usuarios predeterminados:`);
  console.log(`    augusto / admin123`);
  console.log(`    socio  / socio123\n`);
});
