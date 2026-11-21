// ============================================================
//  EventSphere — frontend (static site + Supabase)
//  Auth, data and business rules live in Supabase (see supabase/schema.sql).
//  This file only talks to Supabase with the public anon key; every
//  permission is enforced in the database by Row Level Security.
// ============================================================
const CFG = window.EVENTSPHERE_CONFIG || {};
const CONFIGURED = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY &&
                      !/YOUR-PROJECT|YOUR_/i.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY));

let sb = null;
let currentUser = null;      // { user_id, role_id, full_name, email }
let currentPage = 'dashboard';
let allEvents   = [];
let editingEventId = null;
let editingVenueId = null;
let bookingTicketTypes = [];

const ROLE_NAMES = { 1: 'Administrator', 2: 'Organizer', 3: 'Participant' };
const isAdmin = () => currentUser?.role_id === 1;
const isStaff = () => currentUser?.role_id === 1 || currentUser?.role_id === 2;

// ============================================================
//  HELPERS
// ============================================================
// Escape anything that comes from the database before putting it in innerHTML.
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function toast(msg, type = 'success') {
  const icons = { success:'fa-check-circle', error:'fa-times-circle', warning:'fa-exclamation-triangle' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fas ${icons[type] || icons.success} ${type}"></i> <span></span>`;
  el.querySelector('span').textContent = msg;               // never innerHTML a message
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

// Turn a Supabase/Postgres error into something readable.
function errMsg(error) {
  const m = (error && (error.message || error.error_description)) || String(error || 'Something went wrong.');
  if (/row-level security|permission denied/i.test(m)) return 'You do not have permission to do that.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Cannot reach Supabase. Check your internet connection and config.js.';
  if (/duplicate key/i.test(m)) return 'That record already exists.';
  return m;
}

// Run a Supabase call; throw on error so callers can try/catch once.
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

async function safe(fn, fallback = 'Something went wrong.') {
  try { return await fn(); }
  catch (e) { console.error(e); toast(errMsg(e) || fallback, 'error'); return undefined; }
}

function formatCurrency(v) {
  const n = parseFloat(v) || 0;
  if (n === 0) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString();
}
function parseDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00') : new Date(d); }
function formatDate(d) {
  if (!d) return '—';
  return parseDate(d).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
}
function badgeHtml(status) {
  if (!status) return '';
  const s = String(status);
  return `<span class="badge badge-${esc(s)}">${esc(s.charAt(0).toUpperCase() + s.slice(1))}</span>`;
}
const emptyRow = (cols, text) => `<tr><td colspan="${cols}" style="text-align:center;color:var(--muted);padding:28px;">${esc(text)}</td></tr>`;

// ============================================================
//  AUTH
// ============================================================
function switchAuthTab(tab) {
  document.querySelectorAll('.login-tab').forEach((t, i) => t.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'register')));
  document.getElementById('loginForm').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
}

async function loadProfile(userId) {
  const p = await q(sb.from('profiles').select('user_id, role_id, full_name, email, is_active').eq('user_id', userId).maybeSingle());
  if (!p) throw new Error('Your profile was not found. Run supabase/schema.sql, then register again.');
  if (!p.is_active) { await sb.auth.signOut(); throw new Error('This account has been deactivated.'); }
  return p;
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const pass  = document.getElementById('loginPass').value;
  if (!email || !pass) { toast('Please enter email and password.', 'warning'); return; }
  await safe(async () => {
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) throw new Error(/confirm/i.test(error.message) ? 'Please confirm your email first (check your inbox).' : 'Invalid email or password.');
    currentUser = await loadProfile(data.user.id);
    initApp();
  });
}

async function doRegister() {
  const name  = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const pass  = document.getElementById('regPass').value;
  if (!name || !email || !pass) { toast('Name, email and password required.', 'warning'); return; }
  if (pass.length < 6) { toast('Password must be at least 6 characters.', 'warning'); return; }
  await safe(async () => {
    const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { full_name: name, phone } } });
    if (error) throw error;
    // Supabase hides "already registered" by returning a user with no identities.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new Error('Email already registered.');
    }
    document.getElementById('loginEmail').value = email;
    document.getElementById('loginPass').value = '';
    if (data.session) {                    // email confirmation disabled -> already signed in
      await sb.auth.signOut();
      toast('Registered! Please sign in.');
    } else {
      toast('Registered! Check your email to confirm, then sign in.');
    }
    switchAuthTab('login');
    document.getElementById('loginPass').focus();
  });
}

async function doLogout() {
  await sb.auth.signOut();
  currentUser = null;
  document.getElementById('mainApp').style.display   = 'none';
  document.getElementById('loginPage').style.display = 'flex';
  document.getElementById('loginPass').value = '';
  toast('Logged out successfully.');
}

function applyRoleUI() {
  document.querySelectorAll('.staff-only').forEach(el => { el.style.display = isStaff() ? '' : 'none'; });
  document.querySelectorAll('.admin-only').forEach(el => { el.style.display = isAdmin() ? '' : 'none'; });
}

function initApp() {
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('mainApp').style.display   = 'flex';

  const name = currentUser.full_name || currentUser.email;
  document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();
  document.getElementById('sidebarName').textContent   = name;
  document.getElementById('sidebarRole').textContent   = ROLE_NAMES[currentUser.role_id] || 'User';
  document.getElementById('dashName').textContent      = name.split(' ')[0];
  document.getElementById('dashDate').textContent = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  applyRoleUI();
  showPage('dashboard', document.querySelector('.nav-item'));
  loadEventsCount();
}

// ============================================================
//  NAVIGATION
// ============================================================
function showPage(name, navEl) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  if (navEl && !navEl.dataset.page) navEl.classList.add('active');

  const titles = { dashboard:'Dashboard', events:'Events', venues:'Venues', categories:'Categories', bookings:'Bookings', payments:'Payments', users:'Users', reports:'Reports' };
  document.getElementById('pageTitle').textContent = titles[name] || name;
  currentPage = name;

  const loaders = {
    dashboard: loadDashboard, events: () => loadEvents(), venues: loadVenues, categories: loadCategories,
    bookings: loadBookings, payments: loadPayments, users: loadUsers,
    reports: () => loadReport('overview', document.querySelector('#page-reports .filter-chip')),
  };
  if (loaders[name]) loaders[name]();
}

function refreshCurrentPage() { showPage(currentPage, null); }

function openAddModal() {
  const modals = { events:'eventModal', venues:'venueModal', bookings:'bookingModal' };
  const id = modals[currentPage];
  if (!id) { toast('Open Events, Venues or Bookings to add something.', 'warning'); return; }
  if ((id === 'eventModal' || id === 'venueModal') && !isStaff()) { toast('Only organizers and admins can do that.', 'warning'); return; }
  if (id === 'eventModal') return openEventModal();
  if (id === 'venueModal') return openVenueModal();
  openModal(id);
}

// ============================================================
//  MODALS
// ============================================================
function openModal(id) {
  document.getElementById(id).classList.add('open');
  if (id === 'bookingModal') return populateBookingModal();
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ============================================================
//  DASHBOARD
// ============================================================
async function loadDashboard() {
  const d = await safe(() => q(sb.rpc('dashboard_data')));
  if (!d) return;
  const s = d.stats;

  document.getElementById('statEvents').textContent          = s.total_events;
  document.getElementById('statEventsPublished').textContent = `${s.published_events} published`;
  document.getElementById('statUsers').textContent           = isAdmin() ? s.total_users : '—';
  document.getElementById('statParticipants').textContent    = isAdmin() ? `${s.total_participants} participants` : 'Admin only';
  document.getElementById('statBookings').textContent        = s.total_bookings;
  document.getElementById('statConfirmed').textContent       = `${s.confirmed_bookings} confirmed`;
  document.getElementById('statRevenue').textContent         = formatCurrency(s.total_revenue);
  document.getElementById('statMonthRevenue').textContent    = `This month: ${formatCurrency(s.monthly_revenue)}`;

  renderRevenueChart(d.revenue_chart);
  renderDonutChart(d.category_chart);

  const upcoming = d.upcoming || [];
  document.getElementById('upcomingEventsTable').innerHTML = upcoming.length ? upcoming.map(e => `
    <tr>
      <td><span style="font-weight:600;">${esc(e.title)}</span></td>
      <td>${formatDate(e.event_date)}</td>
      <td><span style="color:var(--accent);">${esc(e.available_seats)}</span></td>
      <td>${e.ticket_price > 0 ? 'PKR ' + Number(e.ticket_price).toLocaleString() : '<span style="color:var(--success);">Free</span>'}</td>
    </tr>`).join('') : emptyRow(4, 'No events in the next 30 days.');

  const recent = d.recent_bookings || [];
  document.getElementById('recentBookingsTable').innerHTML = recent.length ? recent.map(b => `
    <tr>
      <td><code style="font-size:12px;color:var(--accent);">${esc(b.booking_ref)}</code></td>
      <td>${esc(b.full_name)}</td>
      <td>${formatCurrency(b.total_amount)}</td>
      <td>${badgeHtml(b.status)}</td>
    </tr>`).join('') : emptyRow(4, 'No bookings yet.');
}

function renderRevenueChart(data) {
  const box = document.getElementById('revenueChart');
  if (!data || !data.length) { box.innerHTML = '<div class="empty-state"><i class="fas fa-chart-bar"></i><p>No data</p></div>'; return; }
  const max = Math.max(...data.map(d => parseFloat(d.revenue) || 0), 1);
  box.innerHTML = data.map(d => {
    const h = Math.max(4, ((parseFloat(d.revenue) || 0) / max) * 140);
    return `<div class="chart-bar-wrap">
      <div class="chart-bar" style="height:${h}px;" title="PKR ${esc(d.revenue)}"></div>
      <div class="chart-bar-label">${esc((d.month || '').substring(0, 3))}</div>
    </div>`;
  }).join('');
}

function renderDonutChart(data) {
  const canvas = document.getElementById('donutCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 130, 130);
  const legend = document.getElementById('donutLegend');
  const rows = (data || []).filter(d => parseInt(d.count) > 0);
  if (!rows.length) { legend.innerHTML = '<span style="color:var(--muted);font-size:13px;">No events yet</span>'; return; }

  const colors = ['#7c6ef5','#e066a0','#29d9b0','#f5a623','#3b82f6','#f97316','#ec4899','#14b8a6'];
  const total = rows.reduce((s, d) => s + (parseInt(d.count) || 0), 0) || 1;
  let start = -Math.PI / 2;
  rows.forEach((d, i) => {
    const slice = (parseInt(d.count) || 0) / total * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(65, 65); ctx.arc(65, 65, 55, start, start + slice); ctx.closePath();
    ctx.fillStyle = colors[i % colors.length]; ctx.fill();
    start += slice;
  });
  ctx.beginPath(); ctx.arc(65, 65, 32, 0, Math.PI * 2);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#111220'; ctx.fill();
  ctx.fillStyle = '#e8eaf6'; ctx.font = 'bold 16px Syne, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(total, 65, 65);

  legend.innerHTML = rows.slice(0, 5).map((d, i) => `
    <div class="legend-item">
      <div class="legend-dot" style="background:${colors[i % colors.length]};"></div>
      <span>${esc(d.name)} <span style="color:var(--muted);font-size:11px;">(${esc(d.count)})</span></span>
    </div>`).join('');
}

// ============================================================
//  EVENTS
// ============================================================
const EVENT_SELECT = '*, categories(name, color_hex), venues(name, city)';
function flattenEvent(e) {
  return { ...e, category: e.categories?.name || '—', color_hex: e.categories?.color_hex, venue: e.venues?.name || '—', city: e.venues?.city || '' };
}

async function loadEvents() {
  const data = await safe(() => q(sb.from('events').select(EVENT_SELECT).order('event_date', { ascending: true }).limit(200)));
  if (!data) return;
  allEvents = data.map(flattenEvent);
  document.getElementById('eventsCount').textContent = allEvents.length;
  const active = document.querySelector('#page-events .filter-chip.active');
  const status = active?.dataset.status || 'all';
  renderEvents(status === 'all' ? allEvents : allEvents.filter(e => e.status === status));
}

async function loadEventsCount() {
  const { count } = await sb.from('events').select('event_id', { count: 'exact', head: true });
  document.getElementById('eventsCount').textContent = count ?? '—';
}

const GRADIENTS = {
  '#6366f1': 'linear-gradient(135deg,#312e81,#6366f1)', '#f59e0b': 'linear-gradient(135deg,#78350f,#f59e0b)',
  '#14b8a6': 'linear-gradient(135deg,#134e4a,#14b8a6)', '#f97316': 'linear-gradient(135deg,#7c2d12,#f97316)',
  '#8b5cf6': 'linear-gradient(135deg,#4c1d95,#8b5cf6)', '#ec4899': 'linear-gradient(135deg,#831843,#ec4899)',
  '#10b981': 'linear-gradient(135deg,#064e3b,#10b981)', '#3b82f6': 'linear-gradient(135deg,#1e3a8a,#3b82f6)',
};

function canEditEvent(e) { return isAdmin() || (currentUser?.role_id === 2 && e.organizer_id === currentUser.user_id); }

function renderEvents(events) {
  const grid = document.getElementById('eventsGrid');
  if (!events.length) {
    grid.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-times"></i><p>No events found.</p></div>';
    return;
  }
  const soldPct = e => Math.round(((e.total_seats - e.available_seats) / Math.max(e.total_seats, 1)) * 100);

  grid.innerHTML = events.map(e => {
    const color = /^#[0-9a-fA-F]{6}$/.test(e.color_hex || '') ? e.color_hex : '#7c6ef5';
    const soldOut = e.available_seats <= 0;
    return `
    <div class="event-card">
      <div class="event-banner" style="background:${GRADIENTS[color] || 'linear-gradient(135deg,#312e81,#6366f1)'};">
        <div class="event-category-tag" style="color:${color};">${esc(e.category)}</div>
        <div style="position:absolute;top:12px;right:12px;">${badgeHtml(e.status)}</div>
      </div>
      <div class="event-body">
        <div class="event-title">${esc(e.title)}</div>
        <div class="event-meta">
          <div class="event-meta-item"><i class="fas fa-calendar"></i>${formatDate(e.event_date)}</div>
          <div class="event-meta-item"><i class="fas fa-clock"></i>${esc(e.start_time?.substring(0, 5))} – ${esc(e.end_time?.substring(0, 5))}</div>
          <div class="event-meta-item"><i class="fas fa-map-marker-alt"></i>${esc(e.venue)}${e.city ? ', ' + esc(e.city) : ''}</div>
          <div class="event-meta-item"><i class="fas fa-chair"></i>${esc(e.available_seats)} seats left</div>
        </div>
        <div class="seats-bar">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:5px;">
            <span>${soldPct(e)}% filled</span><span>${e.total_seats - e.available_seats}/${esc(e.total_seats)}</span>
          </div>
          <div class="seats-bar-track"><div class="seats-bar-fill" style="width:${soldPct(e)}%;"></div></div>
        </div>
        <div class="event-footer">
          <div class="event-price">
            ${e.ticket_price > 0 ? 'PKR ' + Number(e.ticket_price).toLocaleString() : '<span style="color:var(--success);">Free</span>'}
            ${e.ticket_price > 0 ? '<small>/ticket</small>' : ''}
          </div>
          <div style="display:flex;gap:8px;">
            ${canEditEvent(e) ? `<button class="btn btn-outline btn-sm" title="Edit" onclick="editEvent(${Number(e.event_id)})"><i class="fas fa-edit"></i></button>` : ''}
            ${e.status === 'published' && !soldOut ? `<button class="btn btn-primary btn-sm" onclick="bookEvent(${Number(e.event_id)})"><i class="fas fa-ticket-alt"></i> Book</button>` : ''}
            ${e.status === 'published' && soldOut ? '<span class="badge badge-cancelled">Sold out</span>' : ''}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function filterEvents(status, el) {
  document.querySelectorAll('#page-events .filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderEvents(status === 'all' ? allEvents : allEvents.filter(e => e.status === status));
}

async function populateEventModal() {
  const [cats, venues] = await Promise.all([
    q(sb.from('categories').select('category_id, name').order('name')),
    q(sb.from('venues').select('venue_id, name, city').eq('is_active', true).order('name')),
  ]);
  document.getElementById('evCategory').innerHTML = '<option value="">Select category…</option>' + cats.map(c => `<option value="${c.category_id}">${esc(c.name)}</option>`).join('');
  document.getElementById('evVenue').innerHTML    = '<option value="">Select venue…</option>'    + venues.map(v => `<option value="${v.venue_id}">${esc(v.name)} (${esc(v.city)})</option>`).join('');
}

function resetEventForm() {
  ['evTitle', 'evDate', 'evSeats', 'evPrice', 'evStart', 'evEnd', 'evDesc'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('evStatus').value = 'draft';
}

async function openEventModal(ev = null) {
  editingEventId = ev ? ev.event_id : null;
  document.getElementById('eventModalTitle').textContent = ev ? 'Edit Event' : 'Create New Event';
  document.getElementById('eventSaveLabel').textContent  = ev ? 'Save Changes' : 'Save Event';
  resetEventForm();
  document.getElementById('eventModal').classList.add('open');
  await safe(populateEventModal);
  if (ev) {
    document.getElementById('evTitle').value    = ev.title;
    document.getElementById('evCategory').value = ev.category_id;
    document.getElementById('evVenue').value    = ev.venue_id;
    document.getElementById('evDate').value     = ev.event_date;
    document.getElementById('evStart').value    = (ev.start_time || '').substring(0, 5);
    document.getElementById('evEnd').value      = (ev.end_time || '').substring(0, 5);
    document.getElementById('evSeats').value    = ev.total_seats;
    document.getElementById('evPrice').value    = ev.ticket_price;
    document.getElementById('evStatus').value   = ev.status;
    document.getElementById('evDesc').value     = ev.description || '';
  }
}

async function submitEvent() {
  const body = {
    title:        document.getElementById('evTitle').value.trim(),
    category_id:  Number(document.getElementById('evCategory').value),
    venue_id:     Number(document.getElementById('evVenue').value),
    event_date:   document.getElementById('evDate').value,
    start_time:   document.getElementById('evStart').value,
    end_time:     document.getElementById('evEnd').value,
    total_seats:  parseInt(document.getElementById('evSeats').value, 10),
    ticket_price: parseFloat(document.getElementById('evPrice').value || '0'),
    status:       document.getElementById('evStatus').value,
    description:  document.getElementById('evDesc').value.trim() || null,
  };

  if (!body.title || !body.category_id || !body.venue_id || !body.event_date || !body.start_time || !body.end_time || !(body.total_seats > 0)) {
    toast('Please fill all required fields.', 'warning'); return;
  }
  if (body.end_time <= body.start_time) { toast('End time must be after start time.', 'warning'); return; }
  if (!(body.ticket_price >= 0)) { toast('Ticket price cannot be negative.', 'warning'); return; }

  await safe(async () => {
    if (editingEventId) {
      await q(sb.from('events').update(body).eq('event_id', editingEventId));
      toast('Event updated!');
    } else {
      await q(sb.from('events').insert({ ...body, organizer_id: currentUser.user_id }));
      toast('Event created successfully!');
    }
    closeModal('eventModal');
    loadEvents(); loadEventsCount();
  });
}

function editEvent(id) {
  const ev = allEvents.find(e => e.event_id === id);
  if (ev) openEventModal(ev);
}

function bookEvent(id) { openModal('bookingModal'); populateBookingModal(id); }

// ============================================================
//  VENUES
// ============================================================
let venuesCache = [];
async function loadVenues() {
  const venues = await safe(() => q(sb.from('venues').select('*').eq('is_active', true).order('name')));
  if (!venues) return;
  venuesCache = venues;
  document.getElementById('venuesTable').innerHTML = venues.length ? venues.map(v => `
    <tr>
      <td><strong>${esc(v.name)}</strong></td>
      <td>${esc(v.city)}</td>
      <td>${Number(v.capacity).toLocaleString()}</td>
      <td>${esc(v.contact_info) || '—'}</td>
      <td style="max-width:200px;font-size:12px;color:var(--muted);">${esc(v.facilities) || '—'}</td>
      <td>${isAdmin() ? `
        <button class="btn btn-outline btn-sm" title="Edit" onclick="editVenue(${Number(v.venue_id)})"><i class="fas fa-edit"></i></button>
        <button class="btn btn-danger btn-sm" style="margin-left:4px;" title="Deactivate" onclick="deleteVenue(${Number(v.venue_id)})"><i class="fas fa-trash"></i></button>` : '—'}</td>
    </tr>`).join('') : emptyRow(6, 'No venues yet.');
}

function openVenueModal(v = null) {
  editingVenueId = v ? v.venue_id : null;
  document.getElementById('venueModalTitle').textContent = v ? 'Edit Venue' : 'Add New Venue';
  document.getElementById('vnName').value       = v?.name || '';
  document.getElementById('vnCity').value       = v?.city || '';
  document.getElementById('vnCap').value        = v?.capacity || '';
  document.getElementById('vnAddr').value       = v?.address || '';
  document.getElementById('vnContact').value    = v?.contact_info || '';
  document.getElementById('vnCountry').value    = v?.country || 'Pakistan';
  document.getElementById('vnFacilities').value = v?.facilities || '';
  document.getElementById('venueModal').classList.add('open');
}
function editVenue(id) { const v = venuesCache.find(x => x.venue_id === id); if (v) openVenueModal(v); }

async function submitVenue() {
  const body = {
    name:         document.getElementById('vnName').value.trim(),
    city:         document.getElementById('vnCity').value.trim(),
    capacity:     parseInt(document.getElementById('vnCap').value, 10),
    address:      document.getElementById('vnAddr').value.trim(),
    contact_info: document.getElementById('vnContact').value.trim() || null,
    country:      document.getElementById('vnCountry').value.trim() || 'Pakistan',
    facilities:   document.getElementById('vnFacilities').value.trim() || null,
  };
  if (!body.name || !body.city || !body.address || !(body.capacity > 0)) {
    toast('Name, city, address and capacity are required.', 'warning'); return;
  }
  await safe(async () => {
    if (editingVenueId) { await q(sb.from('venues').update(body).eq('venue_id', editingVenueId)); toast('Venue updated!'); }
    else                { await q(sb.from('venues').insert(body)); toast('Venue added!'); }
    closeModal('venueModal');
    loadVenues();
  });
}

async function deleteVenue(id) {
  if (!confirm('Deactivate this venue?')) return;
  await safe(async () => {
    await q(sb.from('venues').update({ is_active: false }).eq('venue_id', id));
    toast('Venue deactivated.');
    loadVenues();
  });
}

// ============================================================
//  CATEGORIES
// ============================================================
async function loadCategories() {
  const cats = await safe(() => q(sb.from('categories').select('*').order('name')));
  if (!cats) return;
  const icons = { microphone:'fas fa-microphone', tool:'fas fa-tools', music:'fas fa-music', trophy:'fas fa-trophy', image:'fas fa-images', book:'fas fa-book', users:'fas fa-users', code:'fas fa-code', tag:'fas fa-tag' };
  document.getElementById('categoriesGrid').innerHTML = cats.map(c => `
    <div class="card" style="border-left:4px solid ${esc(c.color_hex)};">
      <div style="display:flex;align-items:center;gap:16px;">
        <div style="width:48px;height:48px;border-radius:12px;background:${esc(c.color_hex)}22;display:flex;align-items:center;justify-content:center;color:${esc(c.color_hex)};font-size:20px;">
          <i class="${icons[c.icon] || 'fas fa-tag'}"></i>
        </div>
        <div>
          <div style="font-weight:700;font-family:var(--font-head);">${esc(c.name)}</div>
          <div style="font-size:12px;color:var(--muted);">Category #${esc(c.category_id)}</div>
        </div>
      </div>
    </div>`).join('');
}

// ============================================================
//  BOOKINGS
// ============================================================
async function loadBookings() {
  const bookings = await safe(() => q(sb.from('bookings')
    .select('*, profiles(full_name, email), events(title, event_date), ticket_types(type_name)')
    .order('booked_at', { ascending: false })));
  if (!bookings) return;

  document.getElementById('bookingsTable').innerHTML = bookings.length ? bookings.map(b => {
    const canCancel = ['pending', 'confirmed'].includes(b.status);
    const action = isStaff()
      ? `<select class="form-control" style="padding:5px 8px;font-size:12px;width:120px;" onchange="updateBookingStatus(${Number(b.booking_id)}, this.value)">
           ${['pending', 'confirmed', 'cancelled', 'attended'].map(s => `<option value="${s}" ${b.status === s ? 'selected' : ''}>${s}</option>`).join('')}
         </select>`
      : (canCancel ? `<button class="btn btn-danger btn-sm" onclick="updateBookingStatus(${Number(b.booking_id)}, 'cancelled')">Cancel</button>` : '—');
    return `
    <tr>
      <td><code style="color:var(--accent);font-size:12px;">${esc(b.booking_ref)}</code></td>
      <td>
        <div style="font-weight:600;">${esc(b.profiles?.full_name || '—')}</div>
        <div style="font-size:12px;color:var(--muted);">${esc(b.profiles?.email || '')}</div>
      </td>
      <td>
        <div>${esc(b.events?.title || '—')}</div>
        <div style="font-size:12px;color:var(--muted);">${formatDate(b.events?.event_date)}</div>
      </td>
      <td>${esc(b.num_tickets)} × ${esc(b.ticket_types?.type_name || 'General')}</td>
      <td><strong>${formatCurrency(b.total_amount)}</strong></td>
      <td>${badgeHtml(b.status)}</td>
      <td style="font-size:12px;color:var(--muted);">${formatDateTime(b.booked_at)}</td>
      <td>${action}</td>
    </tr>`;
  }).join('') : emptyRow(8, 'No bookings yet.');
}

async function populateBookingModal(preselectId = null) {
  const events = await safe(() => q(sb.from('events').select('event_id, title, event_date, available_seats')
    .eq('status', 'published').gte('event_date', new Date().toISOString().slice(0, 10)).order('event_date')));
  if (!events) return;
  document.getElementById('bkEvent').innerHTML = '<option value="">Choose an event…</option>' +
    events.map(e => `<option value="${e.event_id}">${esc(e.title)} (${formatDate(e.event_date)}) — ${esc(e.available_seats)} left</option>`).join('');
  document.getElementById('bkNum').value = 1;
  if (preselectId) document.getElementById('bkEvent').value = String(preselectId);
  await loadTicketTypes();
}

async function loadTicketTypes() {
  const eventId = document.getElementById('bkEvent').value;
  const sel = document.getElementById('bkTicket');
  bookingTicketTypes = [];
  sel.innerHTML = '<option value="">Standard ticket</option>';
  if (!eventId) return;
  const tts = await safe(() => q(sb.from('ticket_types').select('*').eq('event_id', eventId).order('price')));
  if (!tts) return;
  bookingTicketTypes = tts.filter(t => t.quantity - t.sold > 0);
  sel.innerHTML = '<option value="">Standard ticket</option>' + bookingTicketTypes.map(t =>
    `<option value="${t.ticket_type_id}">${esc(t.type_name)} — PKR ${Number(t.price).toLocaleString()} (${t.quantity - t.sold} left)</option>`).join('');
}

async function submitBooking() {
  const eventId = Number(document.getElementById('bkEvent').value);
  const num     = parseInt(document.getElementById('bkNum').value, 10);
  const method  = document.getElementById('bkMethod').value;
  const ttId    = document.getElementById('bkTicket').value;
  if (!eventId) { toast('Please select an event.', 'warning'); return; }
  if (!(num >= 1 && num <= 10)) { toast('Choose between 1 and 10 tickets.', 'warning'); return; }

  await safe(async () => {
    const r = await q(sb.rpc('create_booking', {
      p_event_id: eventId, p_num_tickets: num, p_ticket_type_id: ttId ? Number(ttId) : null, p_method: method,
    }));
    toast(`Booking created! Ref: ${r?.booking_ref || '—'}${r?.status === 'pending' ? ' (awaiting payment confirmation)' : ''}`);
    closeModal('bookingModal');
    if (currentPage === 'bookings') loadBookings(); else showPage('bookings', null);
  });
}

async function updateBookingStatus(id, status) {
  if (status === 'cancelled' && !confirm('Cancel this booking? This cannot be undone.')) { loadBookings(); return; }
  const ok = await safe(async () => { await q(sb.rpc('update_booking_status', { p_booking_id: id, p_status: status })); return true; });
  if (ok) toast('Status updated.');
  loadBookings();
}

// ============================================================
//  PAYMENTS
// ============================================================
async function loadPayments() {
  const payments = await safe(() => q(sb.from('payments')
    .select('*, bookings(booking_ref, profiles(full_name), events(title))')
    .order('created_at', { ascending: false })));
  if (!payments) return;
  document.getElementById('paymentsTable').innerHTML = payments.length ? payments.map(p => `
    <tr>
      <td><code style="color:var(--accent);font-size:12px;">${esc(p.bookings?.booking_ref)}</code></td>
      <td>${esc(p.bookings?.profiles?.full_name || '—')}</td>
      <td style="font-size:13px;">${esc(p.bookings?.events?.title || '—')}</td>
      <td><strong>${formatCurrency(p.amount)}</strong></td>
      <td><span class="badge" style="background:rgba(124,110,245,0.1);color:var(--accent);">${esc(String(p.method || '').replace('_', ' '))}</span></td>
      <td>${badgeHtml(p.status)}</td>
      <td style="font-size:12px;color:var(--muted);">${p.paid_at ? formatDateTime(p.paid_at) : '—'}</td>
    </tr>`).join('') : emptyRow(7, 'No payments yet.');
}

// ============================================================
//  USERS (admin)
// ============================================================
async function loadUsers() {
  const users = await safe(() => q(sb.rpc('admin_list_users')));
  if (!users) return;
  document.getElementById('usersTable').innerHTML = users.map(u => {
    const me = u.user_id === currentUser.user_id;
    return `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">${esc((u.full_name || '?').charAt(0).toUpperCase())}</div>
          <strong>${esc(u.full_name)}</strong>
        </div>
      </td>
      <td style="font-size:13px;">${esc(u.email)}</td>
      <td style="font-size:13px;color:var(--muted);">${esc(u.phone) || '—'}</td>
      <td>
        <select class="form-control" style="padding:5px 8px;font-size:12px;width:120px;" ${me ? 'disabled' : ''} onchange="setUserRole('${esc(u.user_id)}', this.value)">
          ${[[1, 'admin'], [2, 'organizer'], [3, 'participant']].map(([id, n]) => `<option value="${id}" ${u.role_id === id ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </td>
      <td style="text-align:center;">${esc(u.total_bookings)}</td>
      <td>${u.is_active ? '<span class="badge badge-published">Active</span>' : '<span class="badge badge-cancelled">Inactive</span>'}</td>
      <td style="font-size:12px;color:var(--muted);">${formatDate(u.created_at)}</td>
      <td>${me ? '—' : (u.is_active
        ? `<button class="btn btn-danger btn-sm" title="Deactivate" onclick="setUserActive('${esc(u.user_id)}', false)"><i class="fas fa-ban"></i></button>`
        : `<button class="btn btn-outline btn-sm" title="Reactivate" onclick="setUserActive('${esc(u.user_id)}', true)"><i class="fas fa-undo"></i></button>`)}</td>
    </tr>`;
  }).join('');
}

async function setUserRole(userId, roleId) {
  const ok = await safe(async () => { await q(sb.rpc('admin_update_user', { p_user_id: userId, p_role_id: Number(roleId) })); return true; });
  if (ok) toast('Role updated.');
  loadUsers();
}

async function setUserActive(userId, active) {
  if (!active && !confirm('Deactivate this user? They will no longer be able to log in or book.')) return;
  const ok = await safe(async () => { await q(sb.rpc('admin_update_user', { p_user_id: userId, p_is_active: active })); return true; });
  if (ok) toast(active ? 'User reactivated.' : 'User deactivated.');
  loadUsers();
}

// ============================================================
//  REPORTS (admin)
// ============================================================
async function loadReport(type, el) {
  if (el) {
    document.querySelectorAll('#page-reports .filter-chip').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
  }
  const data = await safe(() => q(sb.rpc('get_report', { p_type: type })));
  if (!data) return;
  const box = document.getElementById('reportsContent');
  const table = (head, rows) => `<div class="table-wrapper"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || emptyRow(head.length, 'No data yet.')}</tbody></table></div>`;

  if (type === 'overview') {
    const statusTable = (title, rows) => `
      <div class="table-wrapper">
        <div class="table-header"><span class="table-title">${title}</span></div>
        <table><thead><tr><th>Status</th><th>Count</th></tr></thead>
        <tbody>${(rows || []).map(r => `<tr><td>${badgeHtml(r.status)}</td><td>${esc(r.count)}</td></tr>`).join('') || emptyRow(2, 'No data yet.')}</tbody></table>
      </div>`;
    box.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);">
        <div class="stat-card"><div class="stat-icon"><i class="fas fa-chart-pie"></i></div><div class="stat-value">PKR ${formatCurrency(data.revenue_month)}</div><div class="stat-label">This Month Revenue</div></div>
        <div class="stat-card"><div class="stat-icon"><i class="fas fa-building"></i></div><div class="stat-value">${esc(data.top_venue?.name || '—')}</div><div class="stat-label">Top Venue</div></div>
        <div class="stat-card"><div class="stat-icon"><i class="fas fa-rupee-sign"></i></div><div class="stat-value">PKR ${formatCurrency(data.revenue_today)}</div><div class="stat-label">Revenue Today</div></div>
      </div>
      <div class="grid-2" style="margin-top:20px;">
        ${statusTable('Bookings by Status', data.bookings_by_status)}
        ${statusTable('Events by Status', data.events_by_status)}
      </div>`;
  } else if (type === 'top_events') {
    box.innerHTML = table(['Event', 'Bookings', 'Seats Sold', 'Revenue'],
      data.map(e => `<tr><td><strong>${esc(e.title)}</strong></td><td>${esc(e.total_bookings)}</td><td>${esc(e.seats_sold)}</td><td>${formatCurrency(e.total_revenue)}</td></tr>`).join(''));
  } else if (type === 'revenue') {
    box.innerHTML = table(['Month', 'Transactions', 'Revenue (PKR)'],
      data.map(r => `<tr><td>${esc(r.month)}</td><td>${esc(r.transactions)}</td><td><strong>${formatCurrency(r.revenue)}</strong></td></tr>`).join(''));
  } else if (type === 'payments') {
    box.innerHTML = table(['Payment Method', 'Transactions', 'Total Amount (PKR)'],
      data.map(r => `<tr><td><span class="badge badge-confirmed">${esc(String(r.method).replace('_', ' '))}</span></td><td>${esc(r.count)}</td><td><strong>${formatCurrency(r.total)}</strong></td></tr>`).join(''));
  }
}

// ============================================================
//  SEARCH (filters the Events page)
// ============================================================
let searchTimer;
function handleGlobalSearch(val) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (currentPage !== 'events') return;
    const v = val.trim().toLowerCase();
    renderEvents(!v ? allEvents : allEvents.filter(e =>
      e.title.toLowerCase().includes(v) || (e.category || '').toLowerCase().includes(v) || (e.city || '').toLowerCase().includes(v)));
  }, 250);
}

// ============================================================
//  INIT
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
  });
  document.querySelectorAll('#loginForm input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); }));
  document.querySelectorAll('#registerForm input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); }));
  document.getElementById('dashDate').textContent = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  if (!CONFIGURED || !window.supabase) {
    document.getElementById('configBanner').style.display = 'block';
    document.querySelectorAll('#loginPage button').forEach(b => { b.disabled = true; });
    return;
  }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  // Restore an existing session after a page refresh.
  try {
    const { data } = await sb.auth.getSession();
    if (data.session) { currentUser = await loadProfile(data.session.user.id); initApp(); }
  } catch (e) { console.error(e); toast(errMsg(e), 'error'); }
});
