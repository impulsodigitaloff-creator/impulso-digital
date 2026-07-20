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

app.set('trust proxy', ['loopback', 'linklocal']);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// CORS for panel communication
const PANEL_ORIGIN = process.env.PANEL_API_URL || 'http://localhost:3001';
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [PANEL_ORIGIN, 'http://localhost:3001'];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.warn('[server] WARNING: SESSION_SECRET no configurado. Usando fallback inseguro. Configurá SESSION_SECRET en variables de entorno.');
}

app.use(session({
  secret: sessionSecret || 'impulso-digital-secret-fallback',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  },
  name: 'id.sid'
}));

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});

const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.pdf', '.svg'];
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'image/svg+xml'];
    if (allowedExtensions.includes(ext) && allowedMimes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Formato no soportado. Solo PDF, JPG, PNG, GIF, SVG.'));
  }
});

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }
  const cleanUser = username.trim();
  const key = `${req.ip || req.connection.remoteAddress}:${cleanUser}`;
  const now = Date.now();
  const attempts = loginAttempts.get(key);
  if (attempts && attempts.count >= MAX_LOGIN_ATTEMPTS && now - attempts.last < LOGIN_WINDOW_MS) {
    return res.status(429).json({ error: 'Demasiados intentos. Probá más tarde.' });
  }
  const user = db.getUserByUsername(cleanUser);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const current = loginAttempts.get(key) || { count: 0, last: now };
    current.count += 1;
    current.last = now;
    loginAttempts.set(key, current);
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  loginAttempts.delete(key);
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

app.post('/api/clientes/:id/archivos', requireAuth, (req, res, next) => {
  const cliente = db.getClienteById(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  upload.array('archivos', 5)(req, res, next);
}, (req, res) => {
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
  const cliente = db.getClienteById(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const archivos = db.getFilesByCliente(req.params.id);
  res.json(archivos.map(a => ({
    ...a,
    url: `/uploads/${req.params.id}/${a.filename}`
  })));
});

app.delete('/api/archivos/:id', requireAuth, (req, res) => {
  const fileId = parseInt(req.params.id, 10);
  const f = db.getFileById(fileId);
  if (!f) return res.status(404).json({ error: 'Archivo no encontrado' });
  db.deleteFile(fileId);
  res.json({ success: true });
});

// Panel Cliente: crear acceso para un cliente del CRM
app.post('/api/clientes/:id/panel', requireAuth, async (req, res) => {
  const cliente = db.getClienteById(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (cliente.panel_id) return res.status(400).json({ error: 'Ya tiene acceso a Panel Cliente' });

  const { email: bodyEmail, password } = req.body;
  const email = bodyEmail || (cliente.email || cliente.empresa.toLowerCase().replace(/[^a-z0-9]/g, '') + '@panel.cliente').trim();
  const panelPassword = password || Math.random().toString(36).slice(2, 10);

  try {
    const fetchUrl = process.env.PANEL_API_URL || 'http://localhost:3001';
    const apiKey = process.env.PANEL_API_KEY;

    const response = await fetch(`${fetchUrl}/api/businesses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ name: cliente.empresa, contact: cliente.contacto, phone: cliente.telefono || cliente.whatsapp, email, password: panelPassword })
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: 'Panel Cliente respondió con error: ' + text.slice(0, 200) });
    }
    const result = await response.json();
    if (!result.success) return res.status(400).json({ error: result.error });
    db.setClientePanel(cliente.id, result.id, email, panelPassword);
    res.json({ success: true, email, id: result.id });
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
      if (!r.ok) {
        const text = await r.text();
        return res.status(502).json({ error: 'Panel Cliente respondió con error: ' + text.slice(0, 200) });
      }
      const result = await r.json();
      if (!result.success) return res.status(400).json({ error: result.error || 'Error al actualizar en Panel Cliente' });
    } catch (err) {
      return res.status(500).json({ error: 'Error al conectar con Panel Cliente: ' + err.message });
    }
  }
  db.setClientePanel(cliente.id, cliente.panel_id || 0, email, password);
  res.json({ success: true, email });
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

const server = app.listen(PORT, () => {
  console.log(`\n  Impulso Digital CRM corriendo en:`);
  console.log(`  → http://localhost:${PORT}\n`);
});

function gracefulShutdown(signal) {
  console.log(`[server] Recibido ${signal}, cerrando graceful...`);
  server.close(() => {
    console.log('[server] Servidor cerrado');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[server] Forzando cierre por timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
