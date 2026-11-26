import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Kartica kmeta (admin-only tab) — per-customer dashboard: their
// GERKs/fields, a 3-state "cona vzorčenja / samo uradna meja / brez meje"
// badge (get_customer_field_geometry RPC — same zone-wins-over-boundary
// priority the GERK SHP export already uses), a real Leaflet map of that
// geometry, an on-demand OneSoil lookup via the onesoil-check Edge
// Function, and a per-customer analytics block (recommendations, soil
// values, service history) built from data already in the schema
// (lab_soil_result, fert_settings/fert_lime_ph, delovni_nalogi*) — see
// project_kartica_kmeta_dashboard memory for what's real vs. placeholder
// and why. Own client/state, same reasoning as fertilization.js/
// planning.js: app.js is already huge and only needs to show/hide
// #panelKartica.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const els = {
  tab: document.getElementById('tabKartica'),
  customerCount: document.getElementById('karticaCustomerCount'),
  search: document.getElementById('karticaSearch'),
  filterHasOrder: document.getElementById('karticaFilterHasOrder'),
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
function fmtNum(v) { return v == null ? '—' : numFmt.format(Number(v)); }
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

const NUTRIENT_LABEL = { nizko: 'Nizko', optimalno: 'Optimalno', visoko: 'Visoko' };
const NUTRIENT_CLASS = { nizko: 'kartica-nutrient--nizko', optimalno: 'kartica-nutrient--optimalno', visoko: 'kartica-nutrient--visoko' };

// Same status values/labels as the work-order list (migration_work_orders.sql
// chk_status) — reuses the existing .wo-status-badge pill, same colors.
const WO_STATUS_CLASS = { 'Plan': 'wo-status--plan', 'V delu': 'wo-status--delo', 'Izvedeno': 'wo-status--izvedeno', 'Izdan Račun': 'wo-status--racun' };
const COMPLETED_STATUSES = ['Izvedeno', 'Izdan Račun'];
const UPCOMING_STATUSES = ['Plan', 'V delu'];
// A simple, named threshold — not hidden magic. Adjust here if "overdue"
// should mean something else; nothing else depends on this value.
const STALE_ANALYSIS_YEARS = 2;

let loaded = false;
let customers = [];                 // [{id, naziv, company_name, region, country}]
let fieldsByCustomer = new Map();   // customer_id -> [{id, cadastre_id, name, area_ha, onesoil_field_uuid, onesoil_checked_at}]
let boundaryCache = new Map();      // customer_id -> Map(field_id -> {status, geojson})
let declCache = new Map();          // customer_id -> Map(field_id -> field_declarations row)
let analyticsCache = new Map();     // customer_id -> { orders, fieldAnalytics: Map(field_id -> {latest, history}), documents }
let onesoilChecking = new Set();    // field_id currently mid-check (transient UI state only)
let customersWithOrder = new Set(); // customer_id with at least one (non-deleted) delovni_nalog

// Global, fetched once — the same thresholds Izračun gnojila already uses
// (fert_settings/fert_lime_ph), reused here to classify a lab result
// instead of re-deriving fertilizer need from it.
let fertThresholds = null; // {target_p2o5, target_k2o, p_low_max, p_optimal_max, p_high_max, k_low_max, k_optimal_max, k_high_max}
let limePhRows = [];       // [{ph_from, ph_to, kg_per_ha}], ordered by ph_from

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

  const [
    { data: custs, error: cErr },
    { data: flds, error: fErr },
    { data: orders, error: oErr },
    { data: settings },
    { data: lime },
  ] = await Promise.all([
    supabase.from('customers').select('id, naziv, company_name, region, country').is('deleted_at', null).order('naziv'),
    supabase.from('fields').select('id, customer_id, cadastre_id, name, area_ha, onesoil_field_uuid, onesoil_checked_at').is('deleted_at', null),
    supabase.from('delovni_nalogi').select('stranka_id').is('deleted_at', null),
    supabase.from('fert_settings').select('target_p2o5, target_k2o, p_low_max, p_optimal_max, p_high_max, k_low_max, k_optimal_max, k_high_max').eq('is_active', true).maybeSingle(),
    supabase.from('fert_lime_ph').select('ph_from, ph_to, kg_per_ha').order('ph_from'),
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
  fertThresholds = settings || null;
  limePhRows = lime ?? [];

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

// ── Per-customer analytics (lab results, work orders, recommendations) ──
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
    .select('id, stevilka, status, tip_storitve, ustvarjen, delovni_nalogi_planiranje(plan_date), '
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

function classifyNutrient(value, lowMax, optimalMax) {
  if (value == null || lowMax == null || optimalMax == null) return null;
  if (value <= lowMax) return 'nizko';
  if (value <= optimalMax) return 'optimalno';
  return 'visoko';
}

// fert_lime_ph has no pH "optimal range" as such, only "how much lime does
// this pH need" — kg_per_ha === 0 is the closest thing to "v redu".
function limeRowFor(value) {
  if (value == null || !limePhRows.length) return null;
  return limePhRows.find(r => (r.ph_from == null || value >= r.ph_from) && (r.ph_to == null || value <= r.ph_to)) || null;
}

// Real recommendations only — pH/P2O5/K2O out of range (against the same
// fert_settings/fert_lime_ph thresholds Izračun gnojila uses) and a stale-
// or-missing analysis flag. No NDVI-anomaly rule: we have no NDVI data.
function fieldRecommendations(fieldId, analytics) {
  const recs = [];
  const latest = analytics.fieldAnalytics.get(fieldId)?.latest;
  if (!latest) {
    recs.push({ severity: 'medium', text: 'Še ni analize tal za to polje — priporočamo vzorčenje.' });
    return recs;
  }
  if (fertThresholds) {
    if (classifyNutrient(latest.p2o5, fertThresholds.p_low_max, fertThresholds.p_optimal_max) === 'nizko') {
      recs.push({ severity: 'high', text: `Nizka vsebnost P₂O₅ (${fmtNum(latest.p2o5)} mg/kg).` });
    }
    if (classifyNutrient(latest.k2o, fertThresholds.k_low_max, fertThresholds.k_optimal_max) === 'nizko') {
      recs.push({ severity: 'high', text: `Nizka vsebnost K₂O (${fmtNum(latest.k2o)} mg/kg).` });
    }
  }
  const limeRow = limeRowFor(latest.ph_kcl);
  if (limeRow && Number(limeRow.kg_per_ha) > 0) {
    recs.push({ severity: 'medium', text: `Nizek pH (${fmtNum(latest.ph_kcl)}) — priporočeno apnenje (~${fmtNum(limeRow.kg_per_ha)} kg/ha).` });
  }
  if (latest.analysis_date) {
    const ageYears = (Date.now() - new Date(latest.analysis_date).getTime()) / (365.25 * 86400000);
    if (ageYears > STALE_ANALYSIS_YEARS) {
      recs.push({ severity: 'low', text: `Zadnja analiza tal je stara ${Math.floor(ageYears)}+ let — priporočamo ponovno vzorčenje.` });
    }
  }
  return recs;
}

function upcomingActivities(analytics) {
  return analytics.orders
    .filter(o => UPCOMING_STATUSES.includes(o.status))
    .map(o => ({ stevilka: o.stevilka, status: o.status, tip: o.tip_storitve, planDate: o.delovni_nalogi_planiranje?.[0]?.plan_date || null }))
    .sort((a, b) => (a.planDate || '9999-99-99').localeCompare(b.planDate || '9999-99-99'));
}

function servicesTimeline(analytics) {
  return [...analytics.orders]
    .sort((a, b) => String(b.ustvarjen ?? '').localeCompare(String(a.ustvarjen ?? '')))
    .map(o => ({ stevilka: o.stevilka, tip: o.tip_storitve, status: o.status, date: o.ustvarjen }));
}

// Farm-level stats for the selected customer — all real, derived from
// data already fetched (no separate aggregate query).
function customerStats(customerId, analytics) {
  const fields = fieldsByCustomer.get(customerId) || [];
  const totalHa = fields.reduce((s, f) => s + (Number(f.area_ha) || 0), 0);
  const boundaryMap = boundaryCache.get(customerId) || new Map();

  const completedFieldIds = new Set();
  for (const o of analytics.orders) {
    if (!COMPLETED_STATUSES.includes(o.status)) continue;
    for (const g of (o.delovni_nalogi_gerki ?? [])) if (g.field_id) completedFieldIds.add(g.field_id);
  }

  let analyzedHa = 0, coverageServiceHa = 0, coneHa = 0, attentionCount = 0;
  for (const f of fields) {
    const ha = Number(f.area_ha) || 0;
    if (analytics.fieldAnalytics.has(f.id)) analyzedHa += ha;
    if (completedFieldIds.has(f.id)) coverageServiceHa += ha;
    if (boundaryMap.get(f.id)?.status === 'cona') coneHa += ha;
    if (fieldRecommendations(f.id, analytics).length) attentionCount++;
  }

  return {
    totalHa,
    analyzedPct: totalHa ? Math.round((analyzedHa / totalHa) * 100) : 0,
    conePct: totalHa ? Math.round((coneHa / totalHa) * 100) : 0,
    serviceCoveragePct: totalHa ? Math.round((coverageServiceHa / totalHa) * 100) : 0,
    completedCount: analytics.orders.filter(o => COMPLETED_STATUSES.includes(o.status)).length,
    attentionCount,
  };
}

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
    loadCustomerAnalytics(customerId), // caches itself; result read back via analyticsCache in render
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
// GERK in the list (Matej, 2026-11-26). Falls back to the whole customer's
// extent (no field selected, or the selected one has no geometry) and
// finally to a Slovenia-wide view (customer has no geometry at all).
function focusFieldOnMap(fieldId) {
  if (!map) return;
  const layer = fieldLayers.get(fieldId);
  if (layer) {
    map.fitBounds(layer.getBounds(), { padding: [60, 60], maxZoom: 17 });
    return;
  }
  if (fieldLayers.size) {
    let combined = null;
    for (const l of fieldLayers.values()) combined = combined ? combined.extend(l.getBounds()) : l.getBounds();
    map.fitBounds(combined, { padding: [30, 30], maxZoom: 16 });
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

// ── Detail panel tile helpers ────────────────────────────────
function nutrientTile(label, value, unit, lowMax, optimalMax, highMax) {
  const cls = classifyNutrient(value, lowMax, optimalMax);
  const badge = cls ? `<span class="kartica-nutrient-badge ${NUTRIENT_CLASS[cls]}">${NUTRIENT_LABEL[cls]}</span>` : '';
  let bar = '';
  if (value != null && lowMax != null && optimalMax != null && highMax != null) {
    const scale = Math.max(highMax * 1.15, value * 1.1, 1);
    const lowPct = Math.min(100, (lowMax / scale) * 100);
    const optPct = Math.max(0, Math.min(100 - lowPct, (optimalMax / scale) * 100 - lowPct));
    const highPct = Math.max(0, 100 - lowPct - optPct);
    const markerPct = Math.min(100, Math.max(0, (value / scale) * 100));
    bar = `
      <div class="kartica-nutrient-bar">
        <span class="kartica-nutrient-bar-seg" style="width:${lowPct}%; background:var(--error-bg)"></span>
        <span class="kartica-nutrient-bar-seg" style="width:${optPct}%; background:var(--success-bg)"></span>
        <span class="kartica-nutrient-bar-seg" style="width:${highPct}%; background:var(--warning-bg)"></span>
        <span class="kartica-nutrient-bar-marker" style="left:${markerPct}%"></span>
      </div>`;
  }
  return `
    <div class="kartica-nutrient-tile">
      <p class="kartica-detail-tile-label">${esc(label)}</p>
      <p class="kartica-nutrient-value">${value != null ? fmtNum(value) + (unit ? ' ' + unit : '') : '—'}</p>
      ${badge}${bar}
    </div>`;
}

function phTile(value) {
  const row = limeRowFor(value);
  let badge = '', note = '';
  if (row) {
    const ok = Number(row.kg_per_ha) <= 0;
    badge = `<span class="kartica-nutrient-badge ${ok ? 'kartica-nutrient--optimalno' : 'kartica-nutrient--nizko'}">${ok ? 'V redu' : 'Potrebno apnenje'}</span>`;
    if (!ok) note = `<p class="kartica-detail-tile-label" style="margin-top:4px">~${fmtNum(row.kg_per_ha)} kg/ha CaCO₃</p>`;
  }
  return `
    <div class="kartica-nutrient-tile">
      <p class="kartica-detail-tile-label">pH (KCl)</p>
      <p class="kartica-nutrient-value">${value != null ? fmtNum(value) : '—'}</p>
      ${badge}${note}
    </div>`;
}

function plainTile(label, value, unit) {
  return `
    <div class="kartica-nutrient-tile">
      <p class="kartica-detail-tile-label">${esc(label)}</p>
      <p class="kartica-nutrient-value">${value != null ? fmtNum(value) + (unit ? ' ' + unit : '') : '—'}</p>
    </div>`;
}

function placeholderTile(label, reason) {
  return `<div class="kartica-placeholder"><strong>${esc(label)}</strong><span>${esc(reason)}</span></div>`;
}

// ── Detail panel (customer analytics + selected field) ───────
function renderDetail() {
  const fields = fieldsByCustomer.get(selectedCustomerId) || [];
  const field = fields.find(f => f.id === selectedFieldId);
  const analytics = analyticsCache.get(selectedCustomerId);
  if (!field || !analytics) { els.detail.innerHTML = ''; return; }

  const customer = customers.find(c => c.id === selectedCustomerId);
  const stats = customerStats(selectedCustomerId, analytics);

  const st = (boundaryCache.get(selectedCustomerId) || new Map()).get(field.id)?.status || 'brez_meje';
  const decl = (declCache.get(selectedCustomerId) || new Map()).get(field.id);
  const crop = decl?.crop_current || 'ni deklaracije';
  const latest = analytics.fieldAnalytics.get(field.id)?.latest || null;

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

  const recs = [];
  for (const f of fields) recs.push(...fieldRecommendations(f.id, analytics).map(r => ({ ...r, field: f })));
  const sevOrder = { high: 0, medium: 1, low: 2 };
  recs.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  const upcoming = upcomingActivities(analytics);
  const timeline = servicesTimeline(analytics);

  els.detail.innerHTML = `
    <div class="kartica-section">
      <p class="kartica-section-title">Pregled stranke — ${esc(customerName(customer))}</p>
      <div class="kartica-stat-row">
        <div class="kartica-stat-tile"><p class="kartica-stat-value">${fmtHa(stats.totalHa)} ha</p><p class="kartica-stat-label">Skupna površina</p></div>
        <div class="kartica-stat-tile"><p class="kartica-stat-value">${stats.analyzedPct}%</p><p class="kartica-stat-label">Analizirano tal</p></div>
        <div class="kartica-stat-tile"><p class="kartica-stat-value">${stats.conePct}%</p><p class="kartica-stat-label">Precizno kmetijstvo (cona)</p></div>
        <div class="kartica-stat-tile"><p class="kartica-stat-value">${stats.completedCount}</p><p class="kartica-stat-label">Zaključene storitve</p></div>
        <div class="kartica-stat-tile"><p class="kartica-stat-value">${stats.attentionCount}</p><p class="kartica-stat-label">Zahteva pozornost</p></div>
      </div>
    </div>

    <div class="kartica-section">
      <p class="kartica-section-title">Priporočila${recs.length ? ` (${recs.length})` : ''}</p>
      ${recs.length ? `<div class="kartica-rec-list">${recs.map(r => `
        <div class="kartica-rec kartica-rec--${r.severity}">
          <span class="kartica-rec-sev"></span>
          <span class="kartica-rec-text"><strong>${esc(r.field.cadastre_id || r.field.name || '')}</strong> — ${esc(r.text)}</span>
          <span class="kartica-rec-action" title="Potreben delovni tok za naročanje storitev, ki ga še nimamo">Kontaktiraj agronoma</span>
        </div>`).join('')}</div>` : `<p class="kartica-empty-note">Ni zaznanih priporočil.</p>`}
    </div>

    <div class="kartica-section">
      <p class="kartica-section-title">Prihajajoče aktivnosti</p>
      ${upcoming.length ? `<div class="kartica-doc-list">${upcoming.map(u => `
        <div class="kartica-doc-row"><span>${esc(u.stevilka)} — ${esc(u.tip || '—')}</span><span>${u.planDate ? fmtDate(u.planDate) : 'odprto'}</span></div>`).join('')}</div>`
        : `<p class="kartica-empty-note">Ni odprtih delovnih nalogov.</p>`}
    </div>

    <div class="kartica-section">
      <p class="kartica-section-title">Izbran GERK</p>
      <div class="kartica-detail-head">
        <div>
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
        ${fertThresholds
          ? nutrientTile('P₂O₅', latest?.p2o5, 'mg/kg', fertThresholds.p_low_max, fertThresholds.p_optimal_max, fertThresholds.p_high_max)
          : placeholderTile('P₂O₅', 'Ni nastavljenih mejnih vrednosti')}
        ${fertThresholds
          ? nutrientTile('K₂O', latest?.k2o, 'mg/kg', fertThresholds.k_low_max, fertThresholds.k_optimal_max, fertThresholds.k_high_max)
          : placeholderTile('K₂O', 'Ni nastavljenih mejnih vrednosti')}
        ${phTile(latest?.ph_kcl)}
        ${plainTile('Organska snov', latest?.humus_pct, '%')}
        ${placeholderTile('NDVI', 'Potrebna povezava z OneSoil')}
        ${placeholderTile('Produktivnost', 'Potrebna povezava z OneSoil')}
        ${placeholderTile('Sestava tal', 'Te analize še ne izvajamo')}
        ${placeholderTile('Dejanski pridelek', 'Podatkov o pridelku še ne zbiramo')}
      </div>
      <p class="kartica-empty-note">${latest?.analysis_date ? `Zadnja analiza: ${fmtDate(latest.analysis_date)}` : 'Ni analize tal za to polje.'}</p>
    </div>

    <div class="kartica-section">
      <p class="kartica-section-title">Pretekle storitve</p>
      ${timeline.length ? `
        <table class="kartica-timeline-table">
          <thead><tr><th>Nalog</th><th>Storitev</th><th>Status</th><th>Datum</th></tr></thead>
          <tbody>${timeline.map(t => `
            <tr>
              <td>${esc(t.stevilka)}</td>
              <td>${esc(t.tip || '—')}</td>
              <td><span class="wo-status-badge ${WO_STATUS_CLASS[t.status] || ''}">${esc(t.status)}</span></td>
              <td>${t.date ? fmtDate(t.date) : '—'}</td>
            </tr>`).join('')}</tbody>
        </table>` : `<p class="kartica-empty-note">Ni delovnih nalogov za to stranko.</p>`}
    </div>

    <div class="kartica-section">
      <p class="kartica-section-title">Dokumenti</p>
      ${analytics.documents.length ? `<div class="kartica-doc-list">${analytics.documents.map(d => `
        <div class="kartica-doc-row"><span>${esc(d.file_name)}</span><span>${d.imported_at ? fmtDate(d.imported_at) : ''}</span></div>`).join('')}</div>`
        : `<p class="kartica-empty-note">Ni uvoženih dokumentov.</p>`}
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
