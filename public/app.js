let state = { currentView: 'dashboard', clients: [], editingId: null };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Error de conexión' }));
    throw new Error(err.error || 'Error del servidor');
  }
  return res.json();
}

function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function showView(view) {
  state.currentView = view;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  const titles = {
    dashboard: ['Dashboard', 'Resumen general de Impulso Digital'],
    clientes: ['Clientes', 'Gestión de clientes y pagos'],
    config: ['Configuración', 'Administrá los paneles de tus clientes']
  };
  document.getElementById('view-title').textContent = titles[view][0];
  document.getElementById('view-subtitle').textContent = titles[view][1];
  if (view === 'dashboard') renderDashboard();
  else if (view === 'clientes') renderClientes();
  else if (view === 'config') renderConfig();
  if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('open');
}

// ==================== AUTH ====================

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true; btn.textContent = 'Ingresando...';
  document.getElementById('login-error').classList.remove('show');
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('login-username').value,
        password: document.getElementById('login-password').value
      })
    });
    if (data.success) initApp(data.user);
  } catch (err) {
    const el = document.getElementById('login-error');
    el.textContent = err.message;
    el.classList.add('show');
  }
  btn.disabled = false; btn.textContent = 'Iniciar Sesión';
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  document.getElementById('app-view').classList.add('hidden');
  document.getElementById('login-view').style.display = 'flex';
});

async function checkSession() {
  try {
    const data = await api('/api/session');
    if (data.authenticated) initApp(data.user);
  } catch (e) { /* no session */ }
}

function initApp(user) {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('app-view').classList.remove('hidden');
  document.getElementById('sidebar-username').textContent = user.username;
  showView('dashboard');
}

// ==================== SIDEBAR ====================

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => showView(item.dataset.view));
});

document.getElementById('mobile-toggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// ==================== DASHBOARD ====================

async function renderDashboard() {
  const el = document.getElementById('main-content');
  el.innerHTML = '<div class="spinner"></div>';
  document.getElementById('header-actions').innerHTML = '';

  try {
    const stats = await api('/api/dashboard');
    const clientes = await api('/api/clientes');

    const alertas = clientes.filter(c => c.fecha_vencimiento && c.estado === 'Activo' && c.proximoVencer !== null && c.proximoVencer <= 7);

    let alertHtml = '';
    if (alertas.length > 0) {
      alertHtml = '<div class="vencimiento-alertas">';
      alertHtml += '<h3 style="font-size:14px; font-weight:600; margin-bottom:12px; color:var(--warning);">⚠ Próximos a vencer</h3>';
      alertas.sort((a, b) => a.proximoVencer - b.proximoVencer);
      alertas.forEach(c => {
        const crit = c.proximoVencer <= 3 ? 'danger' : '';
        const cls = crit ? 'danger' : 'warning';
        alertHtml += `<div class="alerta-item ${cls}">
          <span class="alerta-icon">⏰</span>
          <span class="alerta-text"><strong>${c.empresa}</strong> — vence en ${c.proximoVencer} día${c.proximoVencer !== 1 ? 's' : ''}</span>
          <span class="alerta-dias ${crit ? 'critico' : ''}">${c.proximoVencer}d</span>
        </div>`;
      });
      alertHtml += '</div>';
    }

    const fmt = (n) => '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    el.innerHTML = `
      ${alertHtml}
      <div class="stats-grid">
        <div class="stat-card accent">
          <div class="stat-icon">👥</div>
          <div class="stat-value">${stats.clientesActivos}</div>
          <div class="stat-label">Clientes Activos</div>
        </div>
        <div class="stat-card success">
          <div class="stat-icon">💰</div>
          <div class="stat-value">${fmt(stats.ingresosMensuales)}</div>
          <div class="stat-label">Ingresos Mensuales</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-icon">⏰</div>
          <div class="stat-value">${stats.clientesPorVencer}</div>
          <div class="stat-label">Clientes por Vencer (7d)</div>
        </div>
        <div class="stat-card" style="border-left: 3px solid var(--danger);">
          <div class="stat-icon">📋</div>
          <div class="stat-value">${stats.pagosPendientes}</div>
          <div class="stat-label">Pagos Pendientes</div>
        </div>
      </div>
      <div class="stat-card" style="margin-top:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div class="stat-value" style="font-size:20px;">${stats.totalClientes}</div>
            <div class="stat-label">Total de Clientes Registrados</div>
          </div>
          <div style="font-size:40px; opacity:0.3;">📊</div>
        </div>
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>Error al cargar dashboard: ${err.message}</p></div>`;
  }
}

// ==================== CLIENTES ====================

async function renderClientes() {
  const el = document.getElementById('main-content');
  document.getElementById('header-actions').innerHTML = `<button class="btn btn-primary" onclick="nuevoCliente()">+ Nuevo Cliente</button>`;
  el.innerHTML = '<div class="spinner"></div>';

  try {
    state.clients = await api('/api/clientes');
    renderClientesTable(el);
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
  }
}

let currentFilter = '';
let currentSearch = '';

function renderClientesTable(el) {
  let data = state.clients;
  if (currentFilter) data = data.filter(c => c.estado === currentFilter);
  if (currentSearch) {
    const s = currentSearch.toLowerCase();
    data = data.filter(c =>
      c.empresa.toLowerCase().includes(s) ||
      c.contacto.toLowerCase().includes(s) ||
      c.email.toLowerCase().includes(s) ||
      c.dominio.toLowerCase().includes(s)
    );
  }

  const vencidas = data.filter(c => c.fecha_vencimiento && c.estado === 'Activo' && c.proximoVencer !== null && c.proximoVencer <= 7).length;

  const badge = document.getElementById('clientes-badge');
  if (vencidas > 0) { badge.textContent = vencidas; badge.style.display = ''; }
  else badge.style.display = 'none';

  const fmt = (n) => '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2 });

  const badgeEstado = (e) => {
    const map = { Activo: 'badge-activo', Pendiente: 'badge-pendiente', Suspendido: 'badge-suspendido', Vencido: 'badge-vencido' };
    return `<span class="badge ${map[e] || 'badge-pendiente'}">${e}</span>`;
  };

  const getAlert = (c) => {
    if (c.estado !== 'Activo' || !c.fecha_vencimiento || c.proximoVencer === null || c.proximoVencer > 7) return '';
    const d = c.proximoVencer;
    if (d <= 0) return '<span style="color:var(--danger);font-size:11px;">🔴 Vencido</span>';
    if (d <= 3) return `<span style="color:var(--danger);font-size:11px;">🔴 ${d}d</span>`;
    return `<span style="color:var(--warning);font-size:11px;">🟡 ${d}d</span>`;
  };

  const rows = data.map(c => `
    <tr>
      <td>
        <div class="cliente-info">
          <span class="cliente-name">${c.empresa}</span>
          <span class="cliente-contacto">${c.contacto || c.email || c.dominio ? (c.contacto || c.email || c.dominio) : 'Sin contacto'}</span>
        </div>
      </td>
      <td>${badgeEstado(c.estado)}</td>
      <td>
        ${c.fecha_vencimiento ? c.fecha_vencimiento : '—'}
        ${getAlert(c)}
      </td>
      <td><span style="font-weight:500;">${fmt(c.monto_mensual)}</span></td>
      <td><span style="font-size:12px;">${c.responsable}</span></td>
      <td>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-sm btn-secondary" onclick="editarCliente(${c.id})" title="Editar">✏️</button>
          <button class="btn btn-sm btn-success" onclick="verPagos(${c.id})" title="Pagos">💰</button>
          <button class="btn btn-sm btn-danger" onclick="eliminarCliente(${c.id})" title="Eliminar">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');

  el.innerHTML = `
    <div class="section-header">
      <div class="section-actions" style="flex:1;">
        <div class="search-box" style="flex:1;max-width:320px;">
          <span class="search-icon">🔍</span>
          <input type="text" id="search-input" placeholder="Buscar clientes..." value="${currentSearch}" oninput="buscarClientes()">
        </div>
        <div class="filter-group">
          <button class="filter-btn ${!currentFilter ? 'active' : ''}" onclick="filtrarClientes('')">Todos</button>
          <button class="filter-btn ${currentFilter === 'Activo' ? 'active' : ''}" onclick="filtrarClientes('Activo')">Activos</button>
          <button class="filter-btn ${currentFilter === 'Pendiente' ? 'active' : ''}" onclick="filtrarClientes('Pendiente')">Pendientes</button>
          <button class="filter-btn ${currentFilter === 'Suspendido' ? 'active' : ''}" onclick="filtrarClientes('Suspendido')">Suspendidos</button>
          <button class="filter-btn ${currentFilter === 'Vencido' ? 'active' : ''}" onclick="filtrarClientes('Vencido')">Vencidos</button>
        </div>
      </div>
    </div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Cliente</th>
            <th>Estado</th>
            <th>Vencimiento</th>
            <th>Monto</th>
            <th>Responsable</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="6"><div class="empty-state"><p>No se encontraron clientes</p></div></td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function buscarClientes() {
  currentSearch = document.getElementById('search-input').value;
  renderClientesTable(document.getElementById('main-content'));
}

function filtrarClientes(estado) {
  currentFilter = estado;
  renderClientesTable(document.getElementById('main-content'));
}

// ==================== CRUD CLIENTES ====================

function nuevoCliente() {
  state.editingId = null;
  document.getElementById('modal-cliente-title').textContent = 'Nuevo Cliente';
  document.getElementById('form-cliente').reset();
  document.getElementById('cliente-id').value = '';
  document.getElementById('c-estado').value = 'Activo';
  document.getElementById('c-responsable').value = 'Augusto';
  document.getElementById('archivos-section').style.display = 'none';
  document.getElementById('pagos-section').style.display = 'none';
  const ps = document.getElementById('panel-section'); if (ps) ps.style.display = 'none';
  openModal('modal-cliente');
}

async function editarCliente(id) {
  try {
    const c = await api(`/api/clientes/${id}`);
    state.editingId = id;
    document.getElementById('modal-cliente-title').textContent = 'Editar Cliente';
    document.getElementById('cliente-id').value = id;
    document.getElementById('c-empresa').value = c.empresa || '';
    document.getElementById('c-contacto').value = c.contacto || '';
    document.getElementById('c-telefono').value = c.telefono || '';
    document.getElementById('c-whatsapp').value = c.whatsapp || '';
    document.getElementById('c-email').value = c.email || '';
    document.getElementById('c-dominio').value = c.dominio || '';
    document.getElementById('c-hosting').value = c.hosting || '';
    document.getElementById('c-monto').value = c.monto_mensual || '';
    document.getElementById('c-fecha-inicio').value = c.fecha_inicio || '';
    document.getElementById('c-fecha-vencimiento').value = c.fecha_vencimiento || '';
    document.getElementById('c-estado').value = c.estado || 'Activo';
    document.getElementById('c-responsable').value = c.responsable || 'Augusto';
    document.getElementById('c-notas').value = c.notas || '';

    document.getElementById('archivos-section').style.display = 'block';
    document.getElementById('pagos-section').style.display = 'block';
    document.getElementById('file-upload').value = '';
    document.getElementById('file-upload').onchange = () => subirArchivos(id);
    document.getElementById('nuevo-pago-monto').value = c.monto_mensual || '';
    document.getElementById('nuevo-pago-mes').value = '';
    document.getElementById('nuevo-pago-monto').dataset.clientId = id;

    await cargarArchivos(id);
    await cargarPagos(id);
    openModal('modal-cliente');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function guardarCliente() {
  const data = {
    empresa: document.getElementById('c-empresa').value.trim(),
    contacto: document.getElementById('c-contacto').value.trim(),
    telefono: document.getElementById('c-telefono').value.trim(),
    whatsapp: document.getElementById('c-whatsapp').value.trim(),
    email: document.getElementById('c-email').value.trim(),
    dominio: document.getElementById('c-dominio').value.trim(),
    hosting: document.getElementById('c-hosting').value.trim(),
    monto_mensual: parseFloat(document.getElementById('c-monto').value) || 0,
    fecha_inicio: document.getElementById('c-fecha-inicio').value,
    fecha_vencimiento: document.getElementById('c-fecha-vencimiento').value,
    estado: document.getElementById('c-estado').value,
    responsable: document.getElementById('c-responsable').value,
    notas: document.getElementById('c-notas').value.trim()
  };

  if (!data.empresa) { toast('El nombre de la empresa es obligatorio', 'error'); return; }

  const btn = document.querySelector('#modal-cliente .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  try {
    if (state.editingId) {
      await api(`/api/clientes/${state.editingId}`, { method: 'PUT', body: JSON.stringify(data) });
      toast('Cliente actualizado correctamente', 'success');
    } else {
      await api('/api/clientes', { method: 'POST', body: JSON.stringify(data) });
      toast('Cliente creado correctamente', 'success');
    }
    closeModal('modal-cliente');
    renderClientes();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar Cliente'; }
  }
}

async function eliminarCliente(id) {
  if (!confirm('¿Estás seguro de eliminar este cliente? Esta acción no se puede deshacer.')) return;
  try {
    await api(`/api/clientes/${id}`, { method: 'DELETE' });
    toast('Cliente eliminado', 'success');
    renderClientes();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ==================== ARCHIVOS ====================

async function subirArchivos(clientId) {
  const input = document.getElementById('file-upload');
  if (!input.files.length) return;
  const formData = new FormData();
  for (const f of input.files) formData.append('archivos', f);
  try {
    const data = await fetch(`/api/clientes/${clientId}/archivos`, { method: 'POST', body: formData });
    const res = await data.json();
    if (res.success) { toast('Archivos subidos', 'success'); cargarArchivos(clientId); }
    else throw new Error(res.error);
  } catch (err) {
    toast(err.message, 'error');
  }
  input.value = '';
}

async function cargarArchivos(clientId) {
  try {
    const archivos = await api(`/api/clientes/${clientId}/archivos`);
    const el = document.getElementById('files-list');
    if (!archivos.length) { el.innerHTML = '<span style="font-size:13px;color:var(--text-muted);">Sin archivos adjuntos</span>'; return; }
    el.innerHTML = archivos.map(a => `
      <div class="file-item">
        <span>${a.mimetype.includes('pdf') ? '📄' : a.mimetype.includes('image') ? '🖼️' : '📎'}</span>
        <a href="${a.url}" target="_blank" title="${a.original_name}">${a.original_name.length > 20 ? a.original_name.slice(0, 20) + '...' : a.original_name}</a>
        <button class="btn btn-sm btn-danger" onclick="eliminarArchivo(${a.id}, ${clientId})" style="padding:2px 6px;font-size:10px;">✕</button>
      </div>
    `).join('');
  } catch (err) { /* ignore */ }
}

async function eliminarArchivo(id, clientId) {
  try {
    await api(`/api/archivos/${id}`, { method: 'DELETE' });
    toast('Archivo eliminado', 'success');
    cargarArchivos(clientId);
  } catch (err) { toast(err.message, 'error'); }
}

// ==================== PAGOS ====================

async function cargarPagos(clientId) {
  try {
    const pagos = await api(`/api/clientes/${clientId}/pagos`);
    const el = document.getElementById('pagos-list');
    if (!pagos.length) { el.innerHTML = '<span style="font-size:13px;color:var(--text-muted);">Sin pagos registrados</span>'; return; }
    el.innerHTML = pagos.map(p => `
      <div class="payment-item">
        <div class="payment-info">
          <span class="payment-monto">$${Number(p.monto).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
          <span class="payment-mes">${p.mes_correspondiente || '—'}</span>
        </div>
        <span class="payment-fecha">${new Date(p.created_at).toLocaleDateString('es-AR')}</span>
      </div>
    `).join('');
  } catch (err) { /* ignore */ }
}

async function registrarPago() {
  const monto = document.getElementById('nuevo-pago-monto').value;
  const mes = document.getElementById('nuevo-pago-mes').value;
  const clientId = document.getElementById('nuevo-pago-monto').dataset.clientId;
  if (!monto || !clientId) { toast('Ingresa el monto del pago', 'error'); return; }
  try {
    await api(`/api/clientes/${clientId}/pagos`, {
      method: 'POST',
      body: JSON.stringify({ monto: parseFloat(monto), mes_correspondiente: mes })
    });
    toast('Pago registrado', 'success');
    cargarPagos(clientId);
    document.getElementById('nuevo-pago-monto').value = '';
    document.getElementById('nuevo-pago-mes').value = '';
    renderClientes();
  } catch (err) { toast(err.message, 'error'); }
}

function verPagos(id) {
  editarCliente(id);
  setTimeout(() => {
    document.getElementById('pagos-section').scrollIntoView({ behavior: 'smooth' });
  }, 200);
}

// ==================== INIT ====================

// ==================== CONFIG (PANEL MANAGEMENT) ====================

async function renderConfig() {
  const el = document.getElementById('main-content');
  document.getElementById('header-actions').innerHTML = '';
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const clients = await api('/api/clientes');
    el.innerHTML = `
      <h2 style="font-size:18px;font-weight:600;margin-bottom:16px;">📱 Gestión de Paneles Cliente</h2>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">Generá links de acceso directo al panel para tus clientes.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;">
        ${clients.map(c => `
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px;">
            <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;">
              <div>
                <strong style="font-size:15px;">${c.empresa}</strong>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${c.contacto || ''} ${c.telefono || ''}</div>
              </div>
              ${c.panel_id
                ? '<span style="background:rgba(48,209,88,0.15);color:#30d158;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:500;">Panel activo</span>'
                : '<span style="background:rgba(255,214,10,0.15);color:#ffd60a;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:500;">Sin panel</span>'}
            </div>
            <div id="creds-${c.id}" style="font-size:13px;background:var(--bg-input);padding:10px 14px;border-radius:8px;margin-bottom:12px;${c.panel_email ? '' : 'display:none;'}">
              <div>📧 ${c.panel_email || ''}</div>
              <div>🔑 ${c.panel_password || ''}</div>
            </div>
            <div style="display:flex;gap:8px;">
              <button class="btn btn-sm btn-primary" onclick="abrirPanelSetup('${c.id}', '${c.empresa.replace(/'/g,"\\'")}', ${c.panel_id || 0})">🔑 Acceso</button>
              <button class="btn btn-sm btn-success" onclick="window.open('http://localhost:3001','_blank')">🔗 Ir al Panel</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
  }
}

function abrirPanelSetup(id, empresa, panelId) {
  const el = document.getElementById('ps-result');
  el.style.display = 'none';
  if (panelId) {
    // Ya tiene panel: mostrar link directamente
    api(`/api/clientes/${id}`).then(c => {
      document.getElementById('ps-client-id').value = id;
      document.getElementById('ps-email').value = c.panel_email;
      document.getElementById('ps-password').value = c.panel_password;
      document.getElementById('modal-panel-title').textContent = 'Acceso — ' + empresa;
      document.getElementById('ps-footer').style.display = 'flex';
      openModal('modal-panel-setup');
    });
  } else {
    document.getElementById('ps-client-id').value = id;
    document.getElementById('ps-email').value = empresa.toLowerCase().replace(/[^a-z0-9]/g,'') + '@panel.cliente';
    document.getElementById('ps-password').value = 'panel123';
    document.getElementById('modal-panel-title').textContent = 'Nuevo acceso — ' + empresa;
    document.getElementById('ps-footer').style.display = 'flex';
    openModal('modal-panel-setup');
  }
}

async function savePanelSetup() {
  const clienteId = document.getElementById('ps-client-id').value;
  const email = document.getElementById('ps-email').value.trim();
  const password = document.getElementById('ps-password').value.trim();
  if (!email || !password) { toast('Email y contraseña requeridos', 'error'); return; }

  const btn = document.querySelector('#modal-panel-setup .btn-primary');
  btn.disabled = true;
  try {
    // Get current client data to check if panel exists
    const client = await api(`/api/clientes/${clienteId}`);
    let result;
    if (client.panel_id) {
      btn.textContent = 'Actualizando...';
      result = await api(`/api/clientes/${clienteId}/panel`, { method: 'PUT', body: JSON.stringify({ email, password }) });
    } else {
      btn.textContent = 'Creando...';
      result = await api(`/api/clientes/${clienteId}/panel`, { method: 'POST', body: JSON.stringify({ email, password }) });
    }

    const link = 'http://localhost:3001/auto-login?email=' + encodeURIComponent(result.email || email) + '&password=' + encodeURIComponent(password);
    document.getElementById('ps-result-email').textContent = result.email || email;
    document.getElementById('ps-result-pass').textContent = password;
    document.getElementById('ps-result').style.display = 'block';
    document.getElementById('ps-footer').style.display = 'none';
    renderConfig();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

document.addEventListener('DOMContentLoaded', checkSession);

document.getElementById('file-upload').addEventListener('change', function() {
  const id = document.getElementById('cliente-id').value;
  if (id) subirArchivos(id);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
  }
});
