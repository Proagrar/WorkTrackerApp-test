import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Kartica kmeta (admin-only tab) — per-customer dashboard: their
// GERKs/fields, a 3-state "cona vzorčenja / samo uradna meja / brez meje"
// badge (get_customer_field_geometry RPC — same zone-wins-over-boundary
// priority the GERK SHP export already uses), a real Leaflet map of that
// geometry, and an on-demand OneSoil lookup via the onesoil-check Edge
// Function. Own client/state, same reasoning as fertilization.js/
// planning.js: app.js is already huge and only needs to show/hide
// #panelKartica.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const els = {
  tab: document.getElementById('tabKartica'),
  customerCount: document.getElementById('karticaCustomerCount'),
  search: document.getElementById('karticaSearch'),
  customerList: document.getElementById('karticaCustomerList'),
  fieldsHead: document.getElementById('karticaFieldsHead'),
  fieldList: document.getElementById('karticaFieldList'),
  mapEl: document.getElementById('karticaMap'),
  detail: document.getElementById('karticaDetail'),
};

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const numFmt = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 2 });
function fmtHa(v) { return numFmt.format(Number(v) || 0); }
function customerName(c) { return c ? (c.naziv || c.company_name || '—') : '—'; }
function initials(name) {
  return (name || '').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

const STATUS_LABEL = { cona: 'Cona vzorčenja', samo_meja: 'Samo uradna meja', brez_meje: 'Brez meje' };
const STATUS_CLASS = { cona: 'kartica-boundary-badge--cona', samo_meja: 'kartica-boundary-badge--meja', brez_meje: 'kartica-boundary-badge--brez' };
const BOUNDARY_COLOR = { cona: '#16A34A', samo_meja: '#1C4592', brez_meje: '#DC2626' };

let loaded = false;
let customers = [];                 // [{id, naziv, company_name, region, country}]
let fieldsByCustomer = new Map();   // customer_id -> [{id, cadastre_id, name, area_ha, onesoil_field_uuid, onesoil_checked_at}]
let boundaryCache = new Map();      // customer_id -> Map(field_id -> {status, geojson})
let declCache = new Map();          // customer_id -> Map(field_id -> field_declarations row)
let onesoilChecking = new Set();    // field_id currently mid-check (transient UI state only)

let selectedCustomerId = null;
let selectedFieldId = null;
let query = '';

let map = null;
let mapLayer = null;                // L.layerGroup, cleared+rebuilt per customer
const fieldLayers = new Map();      // field_id -> leaflet layer, for the current customer

// ── Loading ──────────────────────────────────────────────────
async function loadKartica() {
  if (loaded) return;
  loaded = true;
  els.customerList.innerHTML = `<div class="state-loading"><div class="spinner"></div></div>`;

  const [{ data: custs, error: cErr }, { data: flds, error: fErr }] = await Promise.all([
    supabase.from('customers').select('id, naziv, company_name, region, country').is('deleted_at', null).order('naziv'),
    supabase.from('fields').select('id, customer_id, cadastre_id, name, area_ha, onesoil_field_uuid, onesoil_checked_at').is('deleted_at', null),
  ]);
  if (cErr || fErr) {
    els.customerList.innerHTML = `<p class="state-empty-inline">Napaka pri nalaganju.</p>`;
    return;
  }

  customers = custs ?? [];
  fieldsByCustomer = new Map();
  for (const f of (flds ?? [])) {
    if (!fieldsByCustomer.has(f.customer_id)) fieldsByCustomer.set(f.customer_id, []);
    fieldsByCustomer.get(f.customer_id).push(f);
  }

  renderCustomerList();
  const first = filteredCustomers()[0];
  if (first) selectCustomer(first.id);
}

// ── Column 1: customers ──────────────────────────────────────
function filteredCustomers() {
  const q = query.trim().toLowerCase();
  return q ? customers.filter(c => customerName(c).toLowerCase().includes(q)) : customers;
}

function renderCustomerList() {
  const list = filteredCustomers();
  els.customerCount.textContent = `${list.length} od ${customers.length}`;
  if (!list.length) {
    els.customerList.innerHTML = `<p class="state-empty-inline">Ni rezultatov.</p>`;
    return;
  }
  els.customerList.innerHTML = list.map(c => {
    const flds = fieldsByCustomer.get(c.id) || [];
    const totalHa = flds.reduce((s, f) => s + (Number(f.area_ha) || 0), 0);
    const selected = c.id === selectedCustomerId;
    return `
      <button type="button" class="kartica-customer-row${selected ? ' kartica-customer-row--active' : ''}" data-customer-id="${esc(c.id)}">
        <span class="kartica-avatar">${esc(initials(customerName(c)))}</span>
        <span class="kartica-customer-text">
          <span class="kartica-customer-name">${esc(customerName(c))}</span>
          <span class="kartica-customer-meta">${flds.length} GERK · ${fmtHa(totalHa)} ha</span>
        </span>
      </button>`;
  }).join('');
  els.customerList.querySelectorAll('[data-customer-id]').forEach(btn => {
    btn.addEventListener('click', () => selectCustomer(btn.dataset.customerId));
  });
}

els.search.addEventListener('input', () => {
  query = els.search.value;
  renderCustomerList();
});

// ── Column 2/3: selected customer ────────────────────────────
async function selectCustomer(customerId) {
  selectedCustomerId = customerId;
  selectedFieldId = null;
  renderCustomerList();

  const fields = fieldsByCustomer.get(customerId) || [];
  const customer = customers.find(c => c.id === customerId);
  const totalHa = fields.reduce((s, f) => s + (Number(f.area_ha) || 0), 0);
  els.fieldsHead.innerHTML = `
    <h2 class="kartica-customer-title">${esc(customerName(customer))}</h2>
    <p class="kartica-subtext">${fields.length} GERK-ov${fields.length ? ' · ' + fmtHa(totalHa) + ' ha skupaj' : ''}</p>`;
  els.fieldList.innerHTML = `<div class="state-loading"><div class="spinner"></div></div>`;
  els.detail.innerHTML = '';
  mapLayer?.clearLayers();

  if (!fields.length) {
    els.fieldList.innerHTML = `<p class="state-empty-inline">Ta stranka nima evidentiranih polj.</p>`;
    return;
  }

  const year = new Date().getFullYear();
  const needsBoundary = !boundaryCache.has(customerId);
  const needsDecl = !declCache.has(customerId);
  const [geomResult, declResult] = await Promise.all([
    needsBoundary ? supabase.rpc('get_customer_field_geometry', { p_customer_id: customerId }) : Promise.resolve({ data: null }),
    needsDecl ? supabase.from('field_declarations').select('*').eq('customer_id', customerId).eq('year', year) : Promise.resolve({ data: null }),
  ]);

  if (needsBoundary) {
    const m = new Map();
    for (const row of (geomResult.data ?? [])) m.set(row.field_id, { status: row.status, geojson: row.geojson });
    boundaryCache.set(customerId, m);
  }
  if (needsDecl) {
    const m = new Map();
    for (const d of (declResult.data ?? [])) m.set(d.field_id, d);
    declCache.set(customerId, m);
  }

  // The admin may have already clicked a different customer while this
  // was loading — don't render stale data over their newer selection.
  if (selectedCustomerId !== customerId) return;

  renderFieldList();
  renderMap();
  selectField(fields[0].id);
}

function renderFieldList() {
  const fields = fieldsByCustomer.get(selectedCustomerId) || [];
  const statusMap = boundaryCache.get(selectedCustomerId) || new Map();
  els.fieldList.innerHTML = fields.map(f => {
    const st = statusMap.get(f.id)?.status || 'brez_meje';
    const selected = f.id === selectedFieldId;
    return `
      <button type="button" class="kartica-field-row${selected ? ' kartica-field-row--active' : ''}" data-field-id="${esc(f.id)}">
        <span class="kartica-field-top">
          <span class="kartica-field-code">${esc(f.cadastre_id || '—')}</span>
          <span class="kartica-field-ha">${fmtHa(f.area_ha)} ha</span>
        </span>
        <span class="kartica-field-name">${esc(f.name || '')}</span>
        <span class="kartica-boundary-badge ${STATUS_CLASS[st]}">${STATUS_LABEL[st]}</span>
      </button>`;
  }).join('');
  els.fieldList.querySelectorAll('[data-field-id]').forEach(btn => {
    btn.addEventListener('click', () => selectField(btn.dataset.fieldId));
  });
}

function selectField(fieldId) {
  selectedFieldId = fieldId;
  renderFieldList();
  highlightFieldOnMap(fieldId);
  renderDetail();
}

// ── Map (column 3) ───────────────────────────────────────────
function ensureMap() {
  if (map) return map;
  map = L.map(els.mapEl, { zoomControl: true });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }).addTo(map);
  mapLayer = L.layerGroup().addTo(map);
  return map;
}

function renderMap() {
  ensureMap();
  mapLayer.clearLayers();
  fieldLayers.clear();
  const fields = fieldsByCustomer.get(selectedCustomerId) || [];
  const statusMap = boundaryCache.get(selectedCustomerId) || new Map();
  const bounds = [];
  for (const f of fields) {
    const entry = statusMap.get(f.id);
    if (!entry?.geojson) continue;
    const color = BOUNDARY_COLOR[entry.status] || BOUNDARY_COLOR.brez_meje;
    const layer = L.geoJSON(entry.geojson, { style: { color: '#fff', weight: 2, fillColor: color, fillOpacity: .55 } })
      .bindTooltip(f.cadastre_id || f.name || '')
      .addTo(mapLayer);
    layer.on('click', () => selectField(f.id));
    fieldLayers.set(f.id, layer);
    bounds.push(layer.getBounds());
  }
  // The panel may have been hidden (0×0) until just now — same
  // invalidateSize()-after-a-frame reasoning as the other Leaflet maps
  // in app.js (ensureWoOverviewMap and friends).
  requestAnimationFrame(() => {
    map.invalidateSize();
    if (bounds.length) {
      let combined = bounds[0];
      for (const b of bounds.slice(1)) combined = combined.extend(b);
      map.fitBounds(combined, { padding: [30, 30], maxZoom: 16 });
    } else {
      map.setView([46.15, 14.99], 8); // Slovenia-wide fallback — no geometry at all
    }
  });
}

function highlightFieldOnMap(fieldId) {
  for (const [id, layer] of fieldLayers) {
    const isSelected = id === fieldId;
    layer.setStyle({ weight: isSelected ? 4 : 2, color: isSelected ? '#1C1C1E' : '#fff' });
    if (isSelected) layer.bringToFront();
  }
}

// ── Detail panel ─────────────────────────────────────────────
function renderDetail() {
  const fields = fieldsByCustomer.get(selectedCustomerId) || [];
  const field = fields.find(f => f.id === selectedFieldId);
  if (!field) { els.detail.innerHTML = ''; return; }

  const st = (boundaryCache.get(selectedCustomerId) || new Map()).get(field.id)?.status || 'brez_meje';
  const decl = (declCache.get(selectedCustomerId) || new Map()).get(field.id);
  const crop = decl?.crop_current || 'ni deklaracije';

  let oneSoilHtml;
  if (onesoilChecking.has(field.id)) {
    oneSoilHtml = `<span class="kartica-onesoil-pill kartica-onesoil-pill--checking">Preverjam…</span>`;
  } else if (field.onesoil_field_uuid) {
    oneSoilHtml = `<span class="kartica-onesoil-pill kartica-onesoil-pill--found">✓ Najdeno v OneSoil</span>`;
  } else if (field.onesoil_checked_at) {
    oneSoilHtml = `
      <span class="kartica-onesoil-pill kartica-onesoil-pill--not-found">Ni najdeno v OneSoil</span>
      <button type="button" class="btn btn-ghost btn-sm" data-action="onesoil-check" data-field-id="${esc(field.id)}">Preveri znova</button>`;
  } else {
    oneSoilHtml = `
      <span class="kartica-onesoil-pill kartica-onesoil-pill--unknown">Ni preverjeno</span>
      <button type="button" class="btn btn-ghost btn-sm" data-action="onesoil-check" data-field-id="${esc(field.id)}">Preveri zdaj</button>`;
  }

  els.detail.innerHTML = `
    <div class="kartica-detail-head">
      <div>
        <p class="kartica-eyebrow">Izbran GERK</p>
        <h3 class="kartica-detail-title">${esc(field.cadastre_id || '—')} — ${esc(field.name || '')}</h3>
        <p class="kartica-subtext">Kultura (deklaracija): ${esc(crop)}</p>
      </div>
      <span class="kartica-detail-ha">${fmtHa(field.area_ha)} ha</span>
    </div>
    <div class="kartica-detail-grid">
      <div class="kartica-detail-tile">
        <p class="kartica-detail-tile-label">Meja / SHP</p>
        <span class="kartica-boundary-badge ${STATUS_CLASS[st]}">${STATUS_LABEL[st]}</span>
      </div>
      <div class="kartica-detail-tile">
        <p class="kartica-detail-tile-label">OneSoil</p>
        <div class="kartica-onesoil-row">${oneSoilHtml}</div>
      </div>
    </div>`;

  els.detail.querySelector('[data-action="onesoil-check"]')
    ?.addEventListener('click', (e) => checkOneSoil(e.currentTarget.dataset.fieldId));
}

async function checkOneSoil(fieldId) {
  onesoilChecking.add(fieldId);
  renderDetail();
  try {
    const { data, error } = await supabase.functions.invoke('onesoil-check', { body: { field_id: fieldId } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    const field = (fieldsByCustomer.get(selectedCustomerId) || []).find(f => f.id === fieldId);
    if (field) {
      field.onesoil_field_uuid = data.found ? data.field_user_season_uuid : null;
      field.onesoil_checked_at = new Date().toISOString();
    }
  } catch (e) {
    alert('Napaka pri preverjanju OneSoil: ' + (e.message || e));
  } finally {
    onesoilChecking.delete(fieldId);
    renderDetail();
  }
}

// app.js's switchTab() shows/hides #panelKartica itself — this module only
// needs to know when the tab becomes visible for the first time, to
// lazy-load its data (same pattern as fertilization.js/planning.js).
els.tab.addEventListener('click', loadKartica);
