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
