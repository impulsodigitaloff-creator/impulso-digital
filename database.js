const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'impulso-digital.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at DATETIME DEFAULT (datetime('now', '-3 hours'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa TEXT NOT NULL,
    contacto TEXT DEFAULT '',
    telefono TEXT DEFAULT '',
    whatsapp TEXT DEFAULT '',
    email TEXT DEFAULT '',
    dominio TEXT DEFAULT '',
    hosting TEXT DEFAULT '',
    fecha_inicio TEXT DEFAULT '',
    fecha_vencimiento TEXT DEFAULT '',
    monto_mensual REAL DEFAULT 0,
    estado TEXT DEFAULT 'Activo',
    responsable TEXT DEFAULT 'Augusto',
    notas TEXT DEFAULT '',
    panel_id INTEGER DEFAULT NULL,
    panel_email TEXT DEFAULT '',
    panel_password TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    updated_at DATETIME DEFAULT (datetime('now', '-3 hours'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    monto REAL NOT NULL,
    mes_correspondiente TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );



  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mimetype TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now', '-3 hours')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
`);

const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (userCount.count === 0) {
  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const ins = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
  ins.run('augusto', hash('admin123'), 'admin');
  ins.run('socio', hash('socio123'), 'admin');
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getAllClientes() {
  return db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
}

function getClienteById(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

function searchClientes(term) {
  const like = `%${term}%`;
  return db.prepare(
    `SELECT * FROM clients WHERE empresa LIKE ? OR contacto LIKE ? OR email LIKE ? OR dominio LIKE ? OR telefono LIKE ? ORDER BY created_at DESC`
  ).all(like, like, like, like, like);
}

function getClientesByEstado(estado) {
  return db.prepare('SELECT * FROM clients WHERE estado = ? ORDER BY created_at DESC').all(estado);
}

function createCliente(c) {
  const r = db.prepare(`INSERT INTO clients (empresa, contacto, telefono, whatsapp, email, dominio, hosting, fecha_inicio, fecha_vencimiento, monto_mensual, estado, responsable, notas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.empresa, c.contacto, c.telefono, c.whatsapp, c.email, c.dominio, c.hosting, c.fecha_inicio, c.fecha_vencimiento, c.monto_mensual, c.estado, c.responsable, c.notas);
  return r.lastInsertRowid;
}

function updateCliente(id, c) {
  db.prepare(`UPDATE clients SET empresa=?, contacto=?, telefono=?, whatsapp=?, email=?, dominio=?, hosting=?, fecha_inicio=?, fecha_vencimiento=?, monto_mensual=?, estado=?, responsable=?, notas=?, updated_at=(datetime('now', '-3 hours')) WHERE id=?`).run(c.empresa, c.contacto, c.telefono, c.whatsapp, c.email, c.dominio, c.hosting, c.fecha_inicio, c.fecha_vencimiento, c.monto_mensual, c.estado, c.responsable, c.notas, id);
}

function deleteCliente(id) {
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
}

function getPagosByCliente(clientId) {
  return db.prepare('SELECT * FROM payments WHERE client_id = ? ORDER BY created_at DESC').all(clientId);
}

function registrarPago(clientId, monto, mesCorrespondiente) {
  db.prepare('INSERT INTO payments (client_id, monto, mes_correspondiente) VALUES (?, ?, ?)').run(clientId, monto, mesCorrespondiente);
  const montoNum = parseFloat(monto);
  db.prepare('UPDATE clients SET monto_mensual = ? WHERE id = ?').run(montoNum, clientId);
}

function saveFiles(files) {
  const stmt = db.prepare('INSERT INTO files (client_id, filename, original_name, mimetype, size) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction((files) => {
    for (const f of files) {
      stmt.run(f.client_id, f.filename, f.original_name, f.mimetype, f.size);
    }
  });
  tx(files);
}

function getFilesByCliente(clientId) {
  return db.prepare('SELECT * FROM files WHERE client_id = ? ORDER BY created_at DESC').all(clientId);
}

function deleteFile(id) {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (f) {
    const p = path.join(__dirname, 'uploads', String(f.client_id), f.filename);
    try { fs.unlinkSync(p); } catch (e) {}
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
  }
}

function getDashboardStats() {
  const clientesActivos = db.prepare("SELECT COUNT(*) as c FROM clients WHERE estado = 'Activo'").get().c;
  const ingresosMensuales = db.prepare("SELECT COALESCE(SUM(monto_mensual), 0) as t FROM clients WHERE estado = 'Activo'").get().t;
  const clientesPorVencer = db.prepare("SELECT COUNT(*) as c FROM clients WHERE fecha_vencimiento != '' AND fecha_vencimiento BETWEEN date('now', '-3 hours') AND date('now', '-3 hours', '+7 days')").get().c;
  const pagosPendientes = db.prepare("SELECT COUNT(*) as c FROM clients WHERE estado = 'Pendiente'").get().c;
  const totalClientes = db.prepare("SELECT COUNT(*) as c FROM clients").get().c;
  return { clientesActivos, ingresosMensuales, clientesPorVencer, pagosPendientes, totalClientes };
}

function setClientePanel(id, panelId, panelEmail, panelPassword) {
  db.prepare('UPDATE clients SET panel_id=?, panel_email=?, panel_password=? WHERE id=?').run(panelId, panelEmail, panelPassword, id);
}

module.exports = {
  getUserByUsername,
  setClientePanel,
  getAllClientes,
  getClienteById,
  searchClientes,
  getClientesByEstado,
  createCliente,
  updateCliente,
  deleteCliente,
  getPagosByCliente,
  registrarPago,
  saveFiles,
  getFilesByCliente,
  deleteFile,
  getDashboardStats
};
