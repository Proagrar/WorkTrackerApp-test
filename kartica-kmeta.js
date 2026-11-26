import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Kartica kmeta (admin-only tab) — admin tool for ONE farmer: edit their
// basic contact data (reuses app.js's existing "Uredi stranko" modal via
// a window.* bridge, see below) and manage (add/edit/delete) their
// GERKs/fields in a dense, Excel-like table. Not an analytics dashboard —
// Matej, 2026-11-26: "osredotoči se na urejanje... prisotnost podatkov,
// statusi, in podobno", table "kompakten, kot tabela v Excelu". See
// project_kartica_kmeta_dashboard memory for how this evolved from the
// earlier read-only dashboard pass. Own client/state, same reasoning as
// fertilization.js/planning.js: app.js is already huge and only needs to
// show/hide #panelKartica.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CUSTOMER_COLS = 'id, naziv, company_name, contact_name, email, phone, '
  + 'address_street, address_post_code, address_city, vat_number, region, country';

const els = {
  tab: document.getElementById('tabKartica'),
  customerCount: document.getElementById('karticaCustomerCount'),
  search: document.getElementById('karticaSearch'),
  filterHasOrder: document.getElementById('karticaFilterHasOrder'),
  customerList: document.getElementById('karticaCustomerList'),
  customerInfo: document.getElementById('karticaCustomerInfo'),
  mapEl: document.getElementById('karticaMap'),
  fieldsToolbar: document.getElementById('karticaFieldsToolbar'),
  fieldForm: document.getElementById('karticaFieldForm'),
  fieldTableBody: document.getElementById('karticaFieldTableBody'),
  extra: document.getElementById('karticaExtra'),
};

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const numFmt = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 2 });
function fmtHa(v) { return numFmt.format(Number(v) || 0); }
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
}
function customerName(c) { return c ? (c.naziv || c.company_name || '—') : '—'; }
function initials(name) {
  return (name || '').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

const STATUS_LABEL = { cona: 'Cona vzorčenja', samo_meja: 'Samo uradna meja', brez_meje: 'Brez meje' };
const STATUS_CLASS = { cona: 'kartica-boundary-badge--cona', samo_meja: 'kartica-boundary-badge--meja', brez_meje: 'kartica-boundary-badge--brez' };
const BOUNDARY_COLOR = { cona: '#16A34A', samo_meja: '#1C4592', brez_meje: '#DC2626' };
// Same status values/labels as the work-order list (migration_work_orders.sql
// chk_status) — reuses the existing .wo-status-badge pill, same colors.
const WO_STATUS_CLASS = { 'Plan': 'wo-status--plan', 'V delu': 'wo-status--delo', 'Izvedeno': 'wo-status--izvedeno', 'Izdan Račun': 'wo-status--racun' };
// A simple, named threshold for the "Lab. analiza" column's overdue tag —
// not hidden magic. Adjust here if "overdue" should mean something else.
const STALE_ANALYSIS_YEARS = 2;

let loaded = false;
let customers = [];                 // [{id, naziv, company_name, contact_name, email, phone, address_*, vat_number, region, country}]
let fieldsByCustomer = new Map();   // customer_id -> [{id, cadastre_id, name, area_ha, onesoil_field_uuid, onesoil_checked_at}]
let boundaryCache = new Map();      // customer_id -> Map(field_id -> {status, geojson})
let declCache = new Map();          // customer_id -> Map(field_id -> field_declarations row)
let analyticsCache = new Map();     // customer_id -> { orders, fieldAnalytics: Map(field_id -> {latest, history}), documents }
let onesoilChecking = new Set();    // field_id currently mid-check (transient UI state only)
let customersWithOrder = new Set(); // customer_id with at least one (non-deleted) delovni_nalog

let selectedCustomerId = null;
let selectedFieldId = null;
let query = '';
let filterHasOrder = true; // "Z delovnim nalogom" checkbox — on by default

let map = null;
let mapLayer = null;                // L.layerGroup, cleared+rebuilt per customer
const fieldLayers = new Map();      // field_id -> leaflet layer, for the current customer

// ── Loading ──────────────────────────────────────────────────
async function loadKartica() {
  if (loaded) return;
  loaded = true;
  els.customerList.innerHTML = `<div class="state-loading"><div class="spinner"></div></div>`;

  const [{ data: custs, error: cErr }, { data: flds, error: fErr }, { data: orders, error: oErr }] = await Promise.all([
    supabase.from('customers').select(CUSTOMER_COLS).is('deleted_at', null).order('naziv'),
    supabase.from('fields').select('id, customer_id, cadastre_id, name, area_ha, onesoil_field_uuid, onesoil_checked_at').is('deleted_at', null),
    supabase.from('delovni_nalogi').select('stranka_id').is('deleted_at', null),
  ]);
  if (cErr || fErr || oErr) {
    els.customerList.innerHTML = `<p class="state-empty-inline">Napaka pri nalaganju.</p>`;
    return;
  }

  customers = custs ?? [];
  fieldsByCustomer = new Map();
  for (const f of (flds ?? [])) {
    if (!fieldsByCustomer.has(f.customer_id)) fieldsByCustomer.set(f.customer_id, []);
    fieldsByCustomer.get(f.customer_id).push(f);
  }
  customersWithOrder = new Set((orders ?? []).map(o => o.stranka_id).filter(Boolean));

  renderCustomerList();
  const first = filteredCustomers()[0];
  if (first) selectCustomer(first.id);
}

// ── Column 1: customers ──────────────────────────────────────
function filteredCustomers() {
  const q = query.trim().toLowerCase();
  let list = customers;
  if (filterHasOrder) list = list.filter(c => customersWithOrder.has(c.id));
  if (q) list = list.filter(c => customerName(c).toLowerCase().includes(q));
  return list;
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

els.filterHasOrder.checked = filterHasOrder;
els.filterHasOrder.addEventListener('change', () => {
  filterHasOrder = els.filterHasOrder.checked;
  renderCustomerList();
});

// Reached from app.js's "Uredi stranko" modal after a successful save
// (window.refreshKarticaCustomer?.(id) there) — re-fetch just this one
// row rather than the whole customer list.
window.refreshKarticaCustomer = async function (customerId) {
  const { data } = await supabase.from('customers').select(CUSTOMER_COLS).eq('id', customerId).single();
  if (!data) return;
  const idx = customers.findIndex(c => c.id === customerId);
  if (idx >= 0) customers[idx] = data; else customers.push(data);
  customers.sort((a, b) => customerName(a).localeCompare(customerName(b)));
  renderCustomerList();
  if (selectedCustomerId === customerId) renderCustomerInfo();
};

// ── Upper-left quarter: customer info + edit ─────────────────
function renderCustomerInfo() {
  const customer = customers.find(c => c.id === selectedCustomerId);
  if (!customer) { els.customerInfo.innerHTML = ''; return; }

  const lines = [];
  if (customer.contact_name) lines.push(customer.contact_name);
  if (customer.phone) lines.push(`📞 ${customer.phone}`);
  if (customer.email) lines.push(`✉ ${customer.email}`);
  const addr = [customer.address_street, customer.address_post_code, customer.address_city].filter(Boolean).join(', ');
  if (addr) lines.push(addr);
  if (customer.vat_number) lines.push(`ID za DDV: ${customer.vat_number}`);
  const regionLine = [customer.region, customer.country].filter(Boolean).join(', ');
  if (regionLine) lines.push(regionLine);

  els.customerInfo.innerHTML = `
    <div class="kartica-customer-info-head">
      <h2 class="kartica-customer-info-name">${esc(customerName(customer))}</h2>
      <button type="button" class="btn btn-ghost btn-sm" data-action="edit-customer">✎ Uredi</button>
    </div>
    ${lines.length ? lines.map(l => `<p class="kartica-customer-info-row">${esc(l)}</p>`).join('') : `<p class="kartica-empty-note">Ni dodatnih podatkov.</p>`}`;

  els.customerInfo.querySelector('[data-action="edit-customer"]')
    ?.addEventListener('click', () => window.openEditCustomerModal?.(selectedCustomerId));
}

// ── Per-customer analytics (lab results, work orders, documents) ────
// Fetched once per customer, cached — mirrors the chain fertilization.js
// already reads for "Analize tal": delovni_nalogi → delovni_nalogi_gerki
// (→ field_id) → delovni_nalogi_vzorci (sample) → lab_soil_result, plus
// the vzorec_id-or-sample_no fallback already used there
// (fertilization.js:1916-1919) and the "newest by analysis_date" sort
// already used there (fertilization.js:1929).
async function loadCustomerAnalytics(customerId) {
  if (analyticsCache.has(customerId)) return analyticsCache.get(customerId);

  const { data: orders } = await supabase
    .from('delovni_nalogi')
    .select('id, stevilka, status, tip_storitve, ustvarjen, '
      + 'delovni_nalogi_gerki(id, field_id, kolicina_ha, delovni_nalogi_vzorci(id, sample_no))')
    .eq('stranka_id', customerId)
    .is('deleted_at', null);

  const vzorecIds = [];
  const sampleNos = [];
  const vzorecToField = new Map();
  const sampleNoToField = new Map();
  for (const o of (orders ?? [])) {
    for (const g of (o.delovni_nalogi_gerki ?? [])) {
      for (const v of (g.delovni_nalogi_vzorci ?? [])) {
        if (v.id) { vzorecIds.push(v.id); vzorecToField.set(v.id, g.field_id); }
        if (v.sample_no) { sampleNos.push(v.sample_no); sampleNoToField.set(v.sample_no, g.field_id); }
      }
    }
  }

  const labCols = 'vzorec_id, sample_no, ph_kcl, p2o5, k2o, humus_pct, analysis_date, lab_import_file(file_name, imported_at)';
  const [byVzorec, bySample] = await Promise.all([
    vzorecIds.length ? supabase.from('lab_soil_result').select(labCols).in('vzorec_id', vzorecIds) : Promise.resolve({ data: [] }),
    sampleNos.length ? supabase.from('lab_soil_result').select(labCols).in('sample_no', sampleNos).is('vzorec_id', null) : Promise.resolve({ data: [] }),
  ]);
  const labRows = [...(byVzorec.data ?? []), ...(bySample.data ?? [])];

  const byField = new Map(); // field_id -> lab rows
  const docMap = new Map();  // file_name -> imported_at
  for (const row of labRows) {
    const fieldId = (row.vzorec_id && vzorecToField.get(row.vzorec_id)) || sampleNoToField.get(row.sample_no);
    if (fieldId) {
      if (!byField.has(fieldId)) byField.set(fieldId, []);
      byField.get(fieldId).push(row);
    }
    if (row.lab_import_file?.file_name) docMap.set(row.lab_import_file.file_name, row.lab_import_file.imported_at);
  }

  const fieldAnalytics = new Map();
  for (const [fieldId, rows] of byField) {
    const sorted = [...rows].sort((a, b) => String(b.analysis_date ?? '').localeCompare(String(a.analysis_date ?? '')));
    fieldAnalytics.set(fieldId, { latest: sorted[0] ?? null, history: sorted });
  }

  const documents = [...docMap.entries()]
    .map(([file_name, imported_at]) => ({ file_name, imported_at }))
    .sort((a, b) => String(b.imported_at ?? '').localeCompare(String(a.imported_at ?? '')));

  const result = { orders: orders ?? [], fieldAnalytics, documents };
  analyticsCache.set(customerId, result);
  return result;
}

function latestOrderForField(fieldId, analytics) {
  if (!analytics) return null;
  const matches = analytics.orders.filter(o => (o.delovni_nalogi_gerki ?? []).some(g => g.field_id === fieldId));
  if (!matches.length) return null;
  return [...matches].sort((a, b) => String(b.ustvarjen ?? '').localeCompare(String(a.ustvarjen ?? '')))[0];
}

// ── Column 2: selected customer ──────────────────────────────
async function selectCustomer(customerId) {
  selectedCustomerId = customerId;
  selectedFieldId = null;
  renderCustomerList();
  renderCustomerInfo();
  closeFieldForm();

  const fields = fieldsByCustomer.get(customerId) || [];
  els.fieldTableBody.innerHTML = `<tr><td colspan="9"><div class="state-loading"><div class="spinner"></div></div></td></tr>`;
  els.extra.innerHTML = '';
  mapLayer?.clearLayers();

  if (!fields.length) {
    renderFieldTable();
    renderExtra();
    return;
  }

  const year = new Date().getFullYear();
  const needsBoundary = !boundaryCache.has(customerId);
  const needsDecl = !declCache.has(customerId);
  const [geomResult, declResult] = await Promise.all([
    needsBoundary ? supabase.rpc('get_customer_field_geometry', { p_customer_id: customerId }) : Promise.resolve({ data: null }),
    needsDecl ? supabase.from('field_declarations').select('*').eq('customer_id', customerId).eq('year', year) : Promise.resolve({ data: null }),
    loadCustomerAnalytics(customerId), // caches itself; read back via analyticsCache
  ]);

  if (needsBoundary) {
    const m = new Map();
    for (const row of (geomResult.data ?? [])) m.set(row.field_id, { status: row.status, geojson: row.geojson, areaHa: row.area_ha });
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

  renderFieldTable();
  renderMap();
  renderExtra();
  selectField(fields[0].id);
}

// ── Dense GERK table (the main content) ──────────────────────
function renderFieldTable() {
  const fields = fieldsByCustomer.get(selectedCustomerId) || [];
  const statusMap = boundaryCache.get(selectedCustomerId) || new Map();
  // fields.area_ha is often stale/unset (Matej, 2026-11-26: showed 0 while
  // the matching work order correctly showed 5.09 ha) — prefer the real
  // area computed from the same resolved geometry the boundary badge/map
  // already use (get_customer_field_geometry's area_ha), falling back to
  // fields.area_ha only when there's no geometry at all ('brez_meje').
  const resolvedHa = (f) => statusMap.get(f.id)?.areaHa ?? f.area_ha;
  const totalHa = fields.reduce((s, f) => s + (Number(resolvedHa(f)) || 0), 0);
  els.fieldsToolbar.innerHTML = `
    <h2>${fields.length} GERK-ov · ${fmtHa(totalHa)} ha</h2>
    <button type="button" class="btn btn-secondary btn-sm" data-action="add-field">+ Dodaj GERK</button>`;
  els.fieldsToolbar.querySelector('[data-action="add-field"]').addEventListener('click', () => openFieldForm(null));

  if (!fields.length) {
    els.fieldTableBody.innerHTML = `<tr><td colspan="9" class="kartica-empty-note">Ta stranka nima evidentiranih polj.</td></tr>`;
    return;
  }

  const declMap = declCache.get(selectedCustomerId) || new Map();
  const analytics = analyticsCache.get(selectedCustomerId);

  els.fieldTableBody.innerHTML = fields.map(f => {
    const st = statusMap.get(f.id)?.status || 'brez_meje';
    const crop = declMap.get(f.id)?.crop_current || '—';
    const latest = analytics?.fieldAnalytics.get(f.id)?.latest;

    let labHtml = '—';
    if (latest?.analysis_date) {
      const ageYears = (Date.now() - new Date(latest.analysis_date).getTime()) / (365.25 * 86400000);
      const staleTag = ageYears > STALE_ANALYSIS_YEARS
        ? ` <span class="kartica-boundary-badge kartica-boundary-badge--brez" title="Starejša od ${STALE_ANALYSIS_YEARS} let">zastarela</span>`
        : '';
      labHtml = `✓ ${fmtDate(latest.analysis_date)}${staleTag}`;
    }

    const lastOrder = latestOrderForField(f.id, analytics);
    const orderHtml = lastOrder
      ? `<span class="wo-status-badge ${WO_STATUS_CLASS[lastOrder.status] || ''}">${esc(lastOrder.status)}</span>`
      : '—';

    let oneSoilHtml;
    if (onesoilChecking.has(f.id)) {
      oneSoilHtml = `<span class="kartica-onesoil-pill kartica-onesoil-pill--checking">…</span>`;
    } else if (f.onesoil_field_uuid) {
      oneSoilHtml = `<span class="kartica-onesoil-pill kartica-onesoil-pill--found">✓</span>`;
    } else if (f.onesoil_checked_at) {
      oneSoilHtml = `<span class="kartica-onesoil-pill kartica-onesoil-pill--not-found">✗</span> <button type="button" class="kartica-table-btn" data-action="onesoil-check" data-field-id="${esc(f.id)}" title="Preveri znova">↻</button>`;
    } else {
      oneSoilHtml = `<button type="button" class="kartica-table-btn" data-action="onesoil-check" data-field-id="${esc(f.id)}" title="Preveri v OneSoil">? Preveri</button>`;
    }

    const active = f.id === selectedFieldId;
    return `
      <tr data-field-id="${esc(f.id)}"${active ? ' style="background:var(--blue-50)"' : ''}>
        <td>${esc(f.cadastre_id || '—')}</td>
        <td>${esc(f.name || '—')}</td>
        <td class="kartica-num">${fmtHa(resolvedHa(f))}</td>
        <td>${esc(crop)}</td>
        <td><span class="kartica-boundary-badge ${STATUS_CLASS[st]}">${STATUS_LABEL[st]}</span></td>
        <td>${labHtml}</td>
        <td>${orderHtml}</td>
        <td>${oneSoilHtml}</td>
        <td class="kartica-actions">
          <button type="button" class="kartica-table-btn" data-action="edit-field" data-field-id="${esc(f.id)}" title="Uredi">✎</button>
          <button type="button" class="kartica-table-btn kartica-table-btn--danger" data-action="delete-field" data-field-id="${esc(f.id)}" title="Izbriši">🗑</button>
        </td>
      </tr>`;
  }).join('');

  els.fieldTableBody.querySelectorAll('tr[data-field-id]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return; // action buttons handle their own click
      selectField(tr.dataset.fieldId);
    });
  });
  els.fieldTableBody.querySelectorAll('[data-action="edit-field"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFieldForm(fields.find(f => f.id === btn.dataset.fieldId));
    });
  });
  els.fieldTableBody.querySelectorAll('[data-action="delete-field"]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteField(btn.dataset.fieldId); });
  });
  els.fieldTableBody.querySelectorAll('[data-action="onesoil-check"]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); checkOneSoil(btn.dataset.fieldId); });
  });
}

function selectField(fieldId) {
  selectedFieldId = fieldId;
  highlightFieldOnMap(fieldId);
  renderFieldTable();
}

// ── Add / edit / delete a field ───────────────────────────────
function openFieldForm(field) {
  els.fieldForm.hidden = false;
  els.fieldForm.innerHTML = `
    <form class="kartica-field-form" id="karticaFieldFormEl">
      <div class="field">
        <label class="field-label">GERK koda</label>
        <input class="field-input" name="cadastre_id" required value="${esc(field?.cadastre_id || '')}">
      </div>
      <div class="field">
        <label class="field-label">Ime</label>
        <input class="field-input" name="name" required value="${esc(field?.name || '')}">
      </div>
      <div class="field">
        <label class="field-label">Ha</label>
        <input class="field-input" name="area_ha" type="number" step="0.01" min="0" value="${field?.area_ha ?? ''}">
      </div>
      <button type="submit" class="btn btn-primary btn-sm">${field ? 'Shrani' : 'Dodaj'}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-field-form">Prekliči</button>
      <span class="kartica-empty-note" id="karticaFieldFormError" hidden></span>
    </form>`;
  els.fieldForm.querySelector('[data-action="cancel-field-form"]').addEventListener('click', closeFieldForm);
  els.fieldForm.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveField(field?.id || null, new FormData(e.target));
  });
  els.fieldForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeFieldForm() {
  els.fieldForm.hidden = true;
  els.fieldForm.innerHTML = '';
}

async function saveField(fieldId, formData) {
  const errorEl = document.getElementById('karticaFieldFormError');
  const cadastreId = String(formData.get('cadastre_id') || '').trim();
  const name = String(formData.get('name') || '').trim();
  const areaHaRaw = formData.get('area_ha');
  const areaHa = areaHaRaw ? Number(areaHaRaw) : null;
  if (!cadastreId || !name) {
    errorEl.hidden = false;
    errorEl.textContent = 'GERK koda in ime sta obvezna.';
    return;
  }

  const { error } = await supabase.rpc('admin_upsert_field', {
    p_field_id: fieldId,
    p_customer_id: selectedCustomerId,
    p_cadastre_id: cadastreId,
    p_name: name,
    p_area_ha: areaHa,
  });
  if (error) {
    errorEl.hidden = false;
    errorEl.textContent = error.message;
    return;
  }
  closeFieldForm();
  await refreshCustomerFields(selectedCustomerId);
}

async function deleteField(fieldId) {
  const field = (fieldsByCustomer.get(selectedCustomerId) || []).find(f => f.id === fieldId);
  if (!confirm(`Izbrišem GERK ${field?.cadastre_id || ''}${field?.name ? ' — ' + field.name : ''}?`)) return;
  const { error } = await supabase.rpc('admin_delete_field', { p_field_id: fieldId });
  if (error) { alert('Napaka pri brisanju: ' + error.message); return; }
  await refreshCustomerFields(selectedCustomerId);
}

// Re-fetches this customer's fields + their boundary/geometry + analytics
// after an add/edit/delete — the cached Maps are keyed by customer, not
// by field, so they're simplest to just drop and rebuild for this one
// customer rather than patch in place.
async function refreshCustomerFields(customerId) {
  const { data: flds } = await supabase.from('fields')
    .select('id, customer_id, cadastre_id, name, area_ha, onesoil_field_uuid, onesoil_checked_at')
    .eq('customer_id', customerId).is('deleted_at', null);
  fieldsByCustomer.set(customerId, flds ?? []);
  boundaryCache.delete(customerId);
  analyticsCache.delete(customerId);

  const { data: geom } = await supabase.rpc('get_customer_field_geometry', { p_customer_id: customerId });
  const m = new Map();
  for (const row of (geom ?? [])) m.set(row.field_id, { status: row.status, geojson: row.geojson, areaHa: row.area_ha });
  boundaryCache.set(customerId, m);
  await loadCustomerAnalytics(customerId);

  if (selectedCustomerId !== customerId) return;
  if (!(fieldsByCustomer.get(customerId) || []).some(f => f.id === selectedFieldId)) selectedFieldId = null;
  renderCustomerList(); // GERK count/ha per customer row may have changed
  renderFieldTable();
  renderMap();
  renderExtra();
}

// ── Collapsed "Pretekle storitve in dokumenti" ───────────────
function renderExtra() {
  const analytics = analyticsCache.get(selectedCustomerId);
  if (!analytics) { els.extra.innerHTML = ''; return; }

  const timeline = [...analytics.orders].sort((a, b) => String(b.ustvarjen ?? '').localeCompare(String(a.ustvarjen ?? '')));

  els.extra.innerHTML = `
    <div class="kartica-extra-grid">
      <div>
        <p class="kartica-section-title">Pretekle storitve</p>
        ${timeline.length ? `
          <table class="kartica-timeline-table">
            <thead><tr><th>Nalog</th><th>Storitev</th><th>Status</th><th>Datum</th></tr></thead>
            <tbody>${timeline.map(t => `
              <tr>
                <td>${esc(t.stevilka)}</td>
                <td>${esc(t.tip_storitve || '—')}</td>
                <td><span class="wo-status-badge ${WO_STATUS_CLASS[t.status] || ''}">${esc(t.status)}</span></td>
                <td>${t.ustvarjen ? fmtDate(t.ustvarjen) : '—'}</td>
              </tr>`).join('')}</tbody>
          </table>` : `<p class="kartica-empty-note">Ni delovnih nalogov za to stranko.</p>`}
      </div>
      <div>
        <p class="kartica-section-title">Dokumenti</p>
        ${analytics.documents.length ? `<div class="kartica-doc-list">${analytics.documents.map(d => `
          <div class="kartica-doc-row"><span>${esc(d.file_name)}</span><span>${d.imported_at ? fmtDate(d.imported_at) : ''}</span></div>`).join('')}</div>`
          : `<p class="kartica-empty-note">Ni uvoženih dokumentov.</p>`}
      </div>
    </div>`;
}

// ── Map (top-right quarter) ───────────────────────────────────
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
  for (const f of fields) {
    const entry = statusMap.get(f.id);
    if (!entry?.geojson) continue;
    const color = BOUNDARY_COLOR[entry.status] || BOUNDARY_COLOR.brez_meje;
    const layer = L.geoJSON(entry.geojson, { style: { color: '#fff', weight: 2, fillColor: color, fillOpacity: .55 } })
      .bindTooltip(f.cadastre_id || f.name || '')
      .addTo(mapLayer);
    layer.on('click', () => selectField(f.id));
    fieldLayers.set(f.id, layer);
  }
  // The panel may have been hidden (0×0) until just now — same
  // invalidateSize()-after-a-frame reasoning as the other Leaflet maps
  // in app.js (ensureWoOverviewMap and friends). Re-focus afterwards too:
  // selectField() (called right after renderMap() on a customer switch)
  // already tried to focus, but before this invalidateSize() the map's
  // size/bounds math can be stale.
  requestAnimationFrame(() => {
    map.invalidateSize();
    focusFieldOnMap(selectedFieldId);
  });
}

// Pans/zooms the map to one field's own geometry — the point of clicking a
// GERK row (Matej, 2026-11-26). Falls back to the whole customer's extent
// (no field selected, or the selected one has no geometry) and finally to
// a Slovenia-wide view (customer has no geometry at all).
function focusFieldOnMap(fieldId) {
  if (!map) return;
  const layer = fieldLayers.get(fieldId);
  if (layer) {
    map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 17 });
    return;
  }
  if (fieldLayers.size) {
    let combined = null;
    for (const l of fieldLayers.values()) combined = combined ? combined.extend(l.getBounds()) : l.getBounds();
    map.fitBounds(combined, { padding: [20, 20], maxZoom: 16 });
  } else {
    map.setView([46.15, 14.99], 8); // Slovenia-wide fallback — no geometry at all
  }
}

function highlightFieldOnMap(fieldId) {
  for (const [id, layer] of fieldLayers) {
    const isSelected = id === fieldId;
    layer.setStyle({ weight: isSelected ? 4 : 2, color: isSelected ? '#1C1C1E' : '#fff' });
    if (isSelected) layer.bringToFront();
  }
  focusFieldOnMap(fieldId);
}

// ── OneSoil on-demand check ───────────────────────────────────
async function checkOneSoil(fieldId) {
  onesoilChecking.add(fieldId);
  renderFieldTable();
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
    renderFieldTable();
  }
}

// app.js's switchTab() shows/hides #panelKartica itself — this module only
// needs to know when the tab becomes visible for the first time, to
// lazy-load its data (same pattern as fertilization.js/planning.js).
els.tab.addEventListener('click', loadKartica);
