require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Validación de variables críticas
const requiredEnv = ['SESSION_SECRET', 'PANEL_API_KEY'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`[server] FATAL: ${key} no está configurado. El servidor no puede iniciar.`);
    process.exit(1);
  }
}

const AUTOLOGIN_SECRET = process.env.AUTOLOGIN_SECRET || process.env.PANEL_API_KEY;

app.set('trust proxy', ['loopback', 'linklocal']);

// Security headers básicos
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Servir archivos subidos solo a usuarios autenticados
app.get('/uploads/:clientId/:filename', requireAuth, (req, res) => {
  const clientId = validateId(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: 'ID inválido' });
  const filePath = path.join(UPLOADS_DIR, String(clientId), path.basename(req.params.filename));
  if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) {
    return res.status(400).json({ error: 'Ruta inválida' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.sendFile(filePath);
});

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

app.use(session({
  secret: sessionSecret,
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

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Requiere rol de administrador' });
  }
  next();
}

function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

function validateEmail(email) {
  if (typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function validateId(param) {
  const id = parseInt(param, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function validateEstado(estado) {
  return ['Activo', 'Pendiente', 'Suspendido', 'Vencido'].includes(estado);
}

function generateAutoLoginToken(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 5 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTOLOGIN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
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
  if (attempts && now - attempts.last > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
  }
  if (attempts && attempts.count >= MAX_LOGIN_ATTEMPTS && now - attempts.last < LOGIN_WINDOW_MS) {
    return res.status(429).json({ error: 'Demasiados intentos. Probá más tarde.' });
  }
  const user = db.getUserByUsername(cleanUser);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const current = loginAttempts.get(key) || { count: 0, first: now, last: now };
    if (now - current.last > LOGIN_WINDOW_MS) {
      current.count = 1;
      current.first = now;
    } else {
      current.count += 1;
    }
    current.last = now;
    loginAttempts.set(key, current);
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  loginAttempts.delete(key);
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role || 'admin';
  res.json({ success: true, user: { id: user.id, username: user.username, role: req.session.role } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Error al cerrar sesión' });
    res.clearCookie('id.sid');
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

function normalizeCliente(body) {
  const monto = parseFloat(body.monto_mensual);
  return {
    empresa: sanitizeString(body.empresa, 100),
    contacto: sanitizeString(body.contacto, 100),
    telefono: sanitizeString(body.telefono, 50),
    whatsapp: sanitizeString(body.whatsapp, 50),
    email: body.email ? sanitizeString(body.email, 100).toLowerCase() : '',
    dominio: sanitizeString(body.dominio, 100),
    hosting: sanitizeString(body.hosting, 100),
    fecha_inicio: sanitizeString(body.fecha_inicio, 20),
    fecha_vencimiento: sanitizeString(body.fecha_vencimiento, 20),
    monto_mensual: Number.isFinite(monto) && monto >= 0 ? monto : 0,
    estado: validateEstado(body.estado) ? body.estado : 'Activo',
    responsable: sanitizeString(body.responsable, 100),
    notas: sanitizeString(body.notas, 2000)
  };
}

app.post('/api/clientes', requireAuth, (req, res) => {
  const c = normalizeCliente(req.body);
  if (!c.empresa) return res.status(400).json({ error: 'Nombre de empresa requerido' });
  if (c.email && !validateEmail(c.email)) return res.status(400).json({ error: 'Email inválido' });
  const id = db.createCliente(c);
  res.json({ success: true, id });
});

app.put('/api/clientes/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const existing = db.getClienteById(id);
  if (!existing) return res.status(404).json({ error: 'Cliente no encontrado' });
  const c = normalizeCliente(req.body);
  if (!c.empresa) return res.status(400).json({ error: 'Nombre de empresa requerido' });
  if (c.email && !validateEmail(c.email)) return res.status(400).json({ error: 'Email inválido' });
  db.updateCliente(id, c);
  res.json({ success: true });
});

app.delete('/api/clientes/:id', requireAuth, requireAdmin, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const existing = db.getClienteById(id);
  if (!existing) return res.status(404).json({ error: 'Cliente no encontrado' });
  // Borrar archivos físicos del cliente
  const files = db.getFilesByCliente(id);
  for (const f of files) {
    const fp = path.join(UPLOADS_DIR, String(id), path.basename(f.filename));
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) { console.error('[server] Error borrando archivo:', e.message); }
  }
  const clientDir = path.join(UPLOADS_DIR, String(id));
  try { if (fs.existsSync(clientDir)) fs.rmSync(clientDir, { recursive: true, force: true }); } catch (e) { console.error('[server] Error borrando directorio:', e.message); }
  db.deleteCliente(id);
  res.json({ success: true });
});

app.get('/api/clientes/:id/pagos', requireAuth, (req, res) => {
  const pagos = db.getPagosByCliente(req.params.id);
  res.json(pagos);
});

app.post('/api/clientes/:id/pagos', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const cliente = db.getClienteById(id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const monto = parseFloat(req.body.monto);
  if (!Number.isFinite(monto) || monto <= 0) return res.status(400).json({ error: 'Monto debe ser un número positivo' });
  const mes_correspondiente = sanitizeString(req.body.mes_correspondiente, 20);
  db.registrarPago(id, monto, mes_correspondiente);
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
  const fileId = validateId(req.params.id);
  if (!fileId) return res.status(400).json({ error: 'ID inválido' });
  const f = db.getFileById(fileId);
  if (!f) return res.status(404).json({ error: 'Archivo no encontrado' });
  const filePath = path.join(UPLOADS_DIR, String(f.client_id), path.basename(f.filename));
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { console.error('[server] Error borrando archivo físico:', e.message); }
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
  if (email && !validateEmail(email)) return res.status(400).json({ error: 'Email inválido' });
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
    db.setClientePanel(cliente.id, result.id, email);
    res.json({ success: true, email, id: result.id, password: panelPassword });
  } catch (err) {
    res.status(500).json({ error: 'Error al conectar con Panel Cliente: ' + err.message });
  }
});

// Panel Cliente: actualizar email de acceso
app.put('/api/clientes/:id/panel', requireAuth, async (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const cliente = db.getClienteById(id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  if (!validateEmail(email)) return res.status(400).json({ error: 'Email inválido' });
  // Si tiene panel_id, actualizar también en panelcliente
  if (cliente.panel_id) {
    try {
      const fetchUrl = process.env.PANEL_API_URL || 'http://localhost:3001';
      const apiKey = process.env.PANEL_API_KEY;
      const r = await fetch(`${fetchUrl}/api/businesses/${cliente.panel_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ name: cliente.empresa, contact: cliente.contacto, phone: cliente.telefono || cliente.whatsapp, email })
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
  db.setClientePanel(cliente.id, cliente.panel_id || null, email);
  res.json({ success: true, email });
});

// Generar token de autologin seguro para panelcliente
app.post('/api/clientes/:id/panel-token', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const cliente = db.getClienteById(id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (!cliente.panel_id || !cliente.panel_email) return res.status(400).json({ error: 'El cliente no tiene panel configurado' });
  const token = generateAutoLoginToken(cliente.panel_email);
  res.json({ success: true, token, panelUrl: process.env.PANEL_API_URL || 'http://localhost:3001' });
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
