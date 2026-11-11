import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// "Sledenje naročilom" (admin-only tab) — track which sample (a GERK's
// segment == one delovni_nalogi_vzorci row) has been packed into which
// physical box, and send a box off to the lab. Own client and state, same
// reasoning as planning.js/fertilization.js: app.js is already huge and
// only needs to show/hide #panelSledenje. Data: sample_boxes +
// delovni_nalogi_vzorci.box_id (supabase/migration_sample_boxes.sql).
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const els = {
  tab: document.getElementById('tabSledenje'),
  subnavBtns: document.querySelectorAll('[data-sled-view]'),
  viewOrders: document.getElementById('sledViewOrders'),
  viewSegments: document.getElementById('sledViewSegments'),
  toolbarOrders: document.getElementById('sledToolbarOrders'),
  toolbarSegments: document.getElementById('sledToolbarSegments'),
  orderSearch: document.getElementById('sledOrderSearch'),
  orderRows: document.getElementById('sledOrderRows'),
  selectAllCb: document.getElementById('sledSelectAllCb'),
  selectionBar: document.getElementById('sledSelectionBar'),
  statusFilterBtn: document.getElementById('sledStatusFilterBtn'),
  statusFilterMenu: document.getElementById('sledStatusFilterMenu'),
  orderModal: document.getElementById('sledOrderModal'),
  orderModalClose: document.getElementById('sledOrderModalClose'),
  orderModalTitle: document.getElementById('sledOrderModalTitle'),
  orderGerks: document.getElementById('sledOrderGerks'),
  orderBoxesWrap: document.getElementById('sledOrderBoxesWrap'),
  orderBoxRows: document.getElementById('sledOrderBoxRows'),
  segSearch: document.getElementById('sledSegSearch'),
  segRows: document.getElementById('sledSegRows'),
  segSelectAllCb: document.getElementById('sledSegSelectAllCb'),
  segSelectionBar: document.getElementById('sledSegSelectionBar'),
  viewBoxes: document.getElementById('sledViewBoxes'),
  toolbarBoxes: document.getElementById('sledToolbarBoxes'),
  boxSearch: document.getElementById('sledBoxSearch'),
  boxRows: document.getElementById('sledBoxRows'),
};

// Same controlled list as app.js's SAMPLE_ACTIONS (sampling_note) — small
// local copy, same reasoning as the modal-animation/icon helpers above
// (not worth importing across modules for one array).
const SAMPLE_ACTIONS = ['ne pobereš', 'Zavržen', 'združi', 'združi_1', 'združi_2', 'združi_3', 'združi_4', 'združi_5', 'združi_6', 'združi_7', 'združi_8', 'združi_9', 'združi_10'];

let orders = [];
let boxes = [];
let mmInvoiceById = {}; // minimax_racun_id -> mm_issued_invoices row (admin-only read) — real Osnutek/Poslano/Plačano status
let currentOrderId = null;
let selectedOrderIds = new Set();
let selectedSegIds = new Set(); // Segmenti view — sample (delovni_nalogi_vzorci) ids
// Default (Matej, 2026-11-06): Izvedeno + Delno prejeta analiza + Analiza
// prejeta — the ones actually worth watching day to day; everything else
// requires explicitly widening the filter. Seeded from the checkboxes'
// own `checked` attribute in app.html, not hardcoded here, so the two
// stay in sync by construction.
let sledStatusFilterValues = new Set([...document.querySelectorAll('.sled-status-filter-cb:checked')].map(cb => cb.value));

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function customerName(c) {
  return c ? (c.naziv || c.company_name || '—') : '—';
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
}
// d. m. yyyy for a plain DATE column (analysis_date) —
// split the string directly instead of `new Date(iso)`, which parses a
// bare date as UTC midnight and can shift a day under local time.
function fmtPlainDate(isoDate) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(d, 10)}. ${parseInt(m, 10)}. ${y}`;
}
function earliest(dates) { return dates.length ? dates.slice().sort()[0] : null; }
function latest(dates) { return dates.length ? dates.slice().sort().at(-1) : null; }

// Same fade/slide modal open-close as app.js's showModalAnimated/
// hideModalAnimated — small local copy, not worth importing across modules
// for four lines (same reasoning as planning.js).
const MODAL_CLOSE_MS = 300;
function showModal(el) {
  el.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('modal-backdrop--visible')));
}
function hideModal(el) {
  el.classList.remove('modal-backdrop--visible');
  setTimeout(() => { el.hidden = true; }, MODAL_CLOSE_MS);
}

// Same two icons as app.js's WLG_SEL_ICON_CLOSE/WLG_SEL_ICON_DOWNLOAD —
// small local copy for the same reason as the modal helpers above.
const SEL_ICON_CLOSE = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><line x1="4" y1="4" x2="16" y2="16" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><line x1="16" y1="4" x2="4" y2="16" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`;
const SEL_ICON_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M4 14v1.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SEL_ICON_PRINT = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6 7V3.5h8V7M6 14.5H4.5A1.5 1.5 0 0 1 3 13V9a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 17 9v4a1.5 1.5 0 0 1-1.5 1.5H14M6 12h8v4.5H6z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function csvField(value) {
  const s = value == null ? '' : String(value);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Data ─────────────────────────────────────────────────────────
const LAB_COLS = 'id, lab_sample_code, analysis_date, ph_kcl, ka, caco3_pct, humus_pct, no3_no2_n, p2o5, k2o, mg, na, zn, cu, mn, salts_pct, so4_s, fe, notes';

async function loadAll() {
  els.orderRows.innerHTML = `<tr><td colspan="12" class="fert-empty">Nalaganje …</td></tr>`;
  const [{ data: orderData, error: orderError }, { data: boxData, error: boxError }, { data: mmInvoices }] = await Promise.all([
    supabase.from('delovni_nalogi')
      .select(`id, stevilka, status, ustvarjen, deleted_at, racun_zahtevan_at, racun_napaka,
        minimax_racun_id, minimax_racun_stevilka, minimax_racun_status, datum_vzorcenja,
        zakljucen_brez_racuna_at, opomba_zakljucek,
        customers(naziv, company_name, minimax_customer_id, vat_number), profiles(full_name),
        delovni_nalogi_gerki(id, gerk_code, kolicina_ha, field_id, fields(name),
          delovni_nalogi_vzorci(id, sample_no, box_id, sampling_note, area_ha, sample_boxes(id, label, status, sent_at), lab_soil_result(${LAB_COLS})))`)
      .is('deleted_at', null)
      .order('ustvarjen', { ascending: false }),
    supabase.from('sample_boxes').select('*').order('created_at', { ascending: false }),
    // Admin-only RLS — a non-admin session just gets an empty result.
    supabase.from('mm_issued_invoices').select('minimax_id, document_status, payment_status, year, invoice_number'),
  ]);
  const error = orderError || boxError;
  if (error) {
    els.orderRows.innerHTML = `<tr><td colspan="12" class="fert-empty fert-error">Napaka pri nalaganju: ${esc(error.message)}</td></tr>`;
    return;
  }
  orders = orderData ?? [];
  boxes = boxData ?? [];
  mmInvoiceById = Object.fromEntries((mmInvoices ?? []).map((inv) => [inv.minimax_id, inv]));
  for (const id of selectedOrderIds) if (!orders.some(o => o.id === id)) selectedOrderIds.delete(id);
  const allSegIds = new Set(allSegmentRows().map(r => r.sample.id));
  for (const id of selectedSegIds) if (!allSegIds.has(id)) selectedSegIds.delete(id);
  renderOrders();
  renderSegmentRows();
  renderBoxesList();
  updateSledSelectionBar();
  updateSledSegSelectionBar();
}

// ── Sample-pipeline status ────────────────────────────────────────
// Statuses deliberately link up with the work order's own status (Matej,
// 2026-11-06): Plan/V delu are shown as-is (nothing to track yet); once
// the order is Izvedeno (or already invoiced), the label switches to this
// packing/shipping/lab pipeline, driven purely by the segments' own
// box_id/box.status/lab_soil_result — nothing stored on the order itself.
function allSegments(order) {
  return (order.delovni_nalogi_gerki || []).flatMap(g =>
    (g.delovni_nalogi_vzorci || []).map(s => ({ ...s, gerk_code: g.gerk_code })));
}
function segmentBoxed(seg) { return !!seg.box_id; }
function segmentSent(seg) { return seg.sample_boxes?.status === 'Poslano'; }
function segmentHasResult(seg) { return !!seg.lab_soil_result?.length; }
function segmentSkipped(seg) { return seg.sampling_note === 'ne pobereš'; }

// "Datum vzorčenja" = when work on this order's first field actually
// began — stored on delovni_nalogi.datum_vzorcenja, kept in sync by a DB
// trigger (see migration_datum_vzorcenja.sql) rather than recomputed here.
function firstFieldStart(order) {
  return order.datum_vzorcenja || null;
}

const PIPELINE_BADGE = {
  'Plan': 'fert-badge--neutral',
  'V delu': 'fert-badge--warn',
  'Izvedeno': 'fert-badge--neutral',
  'Pakiranje vzorcev': 'fert-badge--warn',
  'Pripravljeni na pošiljanje': 'fert-badge--ok',
  'Poslani': 'fert-badge--sent',
  'Delno prejeta analiza': 'fert-badge--warn',
  'Analiza prejeta': 'fert-badge--ok',
};

// Full start-to-finish ladder, in order — the stepper below always has
// this many segments ("št. stageov prilagodi številu statusov"), filled
// up to and including the current status's position.
const STATUS_SEQUENCE = [
  'Plan', 'V delu', 'Izvedeno', 'Pakiranje vzorcev',
  'Pripravljeni na pošiljanje', 'Poslani', 'Delno prejeta analiza', 'Analiza prejeta',
];

function statusStepperSvg(label) {
  const n = STATUS_SEQUENCE.length;
  const idx = STATUS_SEQUENCE.indexOf(label);
  const filled = idx >= 0 ? idx + 1 : 0;
  const w = 10, gap = 2, h = 7;
  const totalW = n * w + (n - 1) * gap + 1;
  const rects = STATUS_SEQUENCE.map((_, i) => {
    const x = (i * (w + gap) + 0.5).toFixed(1);
    return i < filled
      ? `<rect x="${x}" y="0.5" width="${w}" height="${h}" rx="1.5" fill="#378ADD"/>`
      : `<rect x="${x}" y="0.5" width="${w}" height="${h}" rx="1.5" fill="#8C8C8C" fill-opacity="0.3" stroke="#8C8C8C"/>`;
  }).join('');
  return `<svg width="${totalW}" height="8" viewBox="0 0 ${totalW} 8" class="sled-status-stepper" role="img" aria-label="${esc(label)} (${filled}/${n})"><title>${esc(label)} (${filled}/${n})</title>${rects}</svg>`;
}

function orderStatusLabel(order) {
  // Plan/V delu: nothing sampling-related to show yet — the order's own
  // status IS the status. Izdan Račun is treated like Izvedeno (invoicing
  // can happen before or after sampling wraps up, doesn't gate it).
  if (order.status !== 'Izvedeno' && order.status !== 'Izdan Račun') return order.status;
  // A segment marked "ne vzorčimo" never gets a box/result and shouldn't
  // hold the whole order back — it's excluded from the pipeline entirely
  // (Matej, 2026-11-06): "Analiza prejeta" only needs every SAMPLED
  // segment to have a result, not literally every segment on the order.
  const segs = allSegments(order).filter(s => !segmentSkipped(s));
  if (!segs.length) return 'Izvedeno';
  const n = segs.length;
  const results = segs.filter(segmentHasResult).length;
  if (results === n) return 'Analiza prejeta';
  if (results > 0) return 'Delno prejeta analiza';
  const sent = segs.filter(segmentSent).length;
  if (sent === n) return 'Poslani';
  const boxed = segs.filter(segmentBoxed).length;
  if (boxed === n) return 'Pripravljeni na pošiljanje';
  if (boxed > 0) return 'Pakiranje vzorcev';
  return 'Izvedeno';
}

// Invoice/payment status (Matej, 2026-11-09) — a second, independent line
// shown next to the sample-pipeline status above: Račun ni izdan / Osnutek
// računa / Račun poslan / Račun plačan. Poslano/Plačano come from the live
// Minimax mirror (mm_issued_invoices.payment_status), not just whatever
// this app last wrote — a payment made directly in Minimax shows up here
// without any app-side action. The "Pripravi račun" trigger itself lives
// in the main Delovni Nalogi list now, not here — this is read-only status.
function invoiceStatusLabel(order) {
  // "Zaključi brez računa" (Matej, 2026-11-11) — a terminal state, never
  // touches minimax_racun_*/racun_zahtevan_at, so it's checked first.
  if (order.zakljucen_brez_racuna_at) return 'Zaključeno brez računa';
  const inv = order.minimax_racun_id ? mmInvoiceById[order.minimax_racun_id] : null;
  if (inv) {
    if (inv.document_status === 'O') return 'Osnutek računa';
    if (inv.payment_status === 'Placan') return 'Račun plačan';
    return 'Račun poslan';
  }
  // Mirror doesn't have it yet (sync lag) — fall back to this app's own
  // last-written status.
  if (order.minimax_racun_status === 'izstavljen') return 'Račun poslan';
  if (order.minimax_racun_status === 'storniran') return 'Račun storniran';
  if (order.minimax_racun_status === 'osnutek') return 'Osnutek računa';
  return 'Račun ni izdan';
}
const INVOICE_BADGE = {
  'Račun ni izdan': 'fert-badge--neutral',
  'Osnutek računa': 'fert-badge--warn',
  'Račun poslan': 'fert-badge--sent',
  'Račun plačan': 'fert-badge--ok',
  'Račun storniran': 'fert-badge--neutral',
  'Zaključeno brez računa': 'fert-badge--neutral',
};

// Icon-only trigger/retry/cancel (Matej, 2026-11-09: "samo ikono") — this
// tab is already admin-only at the app.js level (the tab button itself is
// hidden otherwise), so no separate admin check here. The actual write
// logic (review modal, retry, cancel) lives in app.js — reached through
// the window.* bridge it sets up — so it stays the single source of truth
// for what "Pripravi račun" actually does, not duplicated here.
function invoiceActionIcon(order) {
  if (order.zakljucen_brez_racuna_at) {
    const title = order.opomba_zakljucek ? `Zaključeno brez računa: ${order.opomba_zakljucek} — klikni za preklic` : 'Zaključeno brez računa — klikni za preklic';
    return `<button type="button" class="wo-invoice-btn wo-invoice-btn--pending" data-action="sled-invoice-cancel-no-invoice" data-id="${esc(order.id)}" title="${esc(title)}" aria-label="Zaključeno brez računa, prekliči">↺</button>`;
  }
  if (order.racun_napaka) {
    return `<button type="button" class="wo-invoice-btn wo-invoice-btn--error" data-action="sled-invoice-retry" data-id="${esc(order.id)}" title="${esc(order.racun_napaka)} — klikni za ponovni poskus" aria-label="Napaka pri računu, ponovno poskusi">⚠</button>`;
  }
  if (order.racun_zahtevan_at && !order.minimax_racun_id) {
    return `<button type="button" class="wo-invoice-btn wo-invoice-btn--pending" data-action="sled-invoice-cancel" data-id="${esc(order.id)}" title="Račun v pripravi — klikni za preklic" aria-label="Račun v pripravi, prekliči">⏳</button>`;
  }
  const eligible = (order.status === 'Izvedeno' || order.status === 'Izdan Račun') && !order.deleted_at && !order.minimax_racun_id && !order.racun_zahtevan_at;
  if (eligible) {
    return `<button type="button" class="wo-invoice-btn" data-action="sled-invoice-request" data-id="${esc(order.id)}" title="Pripravi račun" aria-label="Pripravi račun">🧾</button>`;
  }
  return '';
}

// ── Status filter (multi-select — same button+checklist pattern as the
// Delovni Nalogi list's own woStatusFilterBtn/woStatusFilterMenu) ──────
function updateStatusFilterBtnLabel() {
  const n = sledStatusFilterValues.size;
  els.statusFilterBtn.textContent = n === 0 ? 'Vsi statusi' : n === 1 ? [...sledStatusFilterValues][0] : `${n} statusi`;
}
els.statusFilterBtn.addEventListener('click', e => {
  e.stopPropagation();
  els.statusFilterMenu.hidden = !els.statusFilterMenu.hidden;
});
els.statusFilterMenu.addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => { els.statusFilterMenu.hidden = true; });
els.statusFilterMenu.querySelectorAll('.sled-status-filter-cb').forEach(cb => {
  cb.addEventListener('change', () => {
    if (cb.checked) sledStatusFilterValues.add(cb.value);
    else sledStatusFilterValues.delete(cb.value);
    updateStatusFilterBtnLabel();
    renderOrders();
  });
});
updateStatusFilterBtnLabel();

// ── Naročila view ──────────────────────────────────────────────
function filteredOrders() {
  const q = els.orderSearch.value.trim().toLowerCase();
  return orders.filter(o => {
    if (q) {
      // GERK codes aren't shown as their own column, but still searchable —
      // matches the main Delovni Nalogi list's search, which also looks
      // past what's visibly printed in the row.
      const gerkCodes = (o.delovni_nalogi_gerki || []).map(g => g.gerk_code).join(' ');
      const hay = `${o.stevilka ?? ''} ${customerName(o.customers)} ${gerkCodes}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (sledStatusFilterValues.size && !sledStatusFilterValues.has(orderStatusLabel(o))) return false;
    return true;
  });
}

function renderOrders() {
  const rows = filteredOrders();
  if (!rows.length) {
    els.orderRows.innerHTML = `<tr><td colspan="12" class="fert-empty">${orders.length ? 'Ni zadetkov.' : 'Ni naročil.'}</td></tr>`;
    updateSelectAllState([]);
    return;
  }
  els.orderRows.innerHTML = rows.map(o => {
    const segs = allSegments(o);
    const gerkCount = (o.delovni_nalogi_gerki || []).length;
    const totalHa = (o.delovni_nalogi_gerki || []).reduce((s, g) => s + (Number(g.kolicina_ha) || 0), 0);
    const samplingDate = firstFieldStart(o);
    const sendingDate = latest(segs.map(s => s.sample_boxes?.sent_at).filter(Boolean));
    const receivedDate = earliest(segs.flatMap(s => (s.lab_soil_result || []).map(r => r.analysis_date)).filter(Boolean));
    const label = orderStatusLabel(o);
    const cls = PIPELINE_BADGE[label] ?? 'fert-badge--neutral';
    const invLabel = invoiceStatusLabel(o);
    const invCls = INVOICE_BADGE[invLabel] ?? 'fert-badge--neutral';
    return `<tr data-open-order="${esc(o.id)}">
      <td><input type="checkbox" class="sled-select-cb" data-id="${esc(o.id)}" aria-label="Izberi nalog" ${selectedOrderIds.has(o.id) ? 'checked' : ''}></td>
      <td>${esc(o.stevilka)}</td>
      <td class="fert-strong sled-customer-cell" title="${esc(customerName(o.customers))}">${esc(customerName(o.customers))}</td>
      <td class="fert-num">${gerkCount}</td>
      <td class="fert-num">${segs.length}</td>
      <td class="fert-num">${totalHa > 0 ? totalHa.toFixed(2) : '—'}</td>
      <td>${samplingDate ? fmtDate(samplingDate) : '—'}</td>
      <td>${sendingDate ? fmtDate(sendingDate) : '—'}</td>
      <td>${fmtPlainDate(receivedDate)}</td>
      <td><div class="sled-status-cell">
        ${statusStepperSvg(label)}<span class="fert-badge ${cls}">${esc(label)}</span>
      </div></td>
      <td><span class="fert-badge ${invCls}">${esc(invLabel)}</span></td>
      <td class="sled-invoice-icon-col">${invoiceActionIcon(o)}</td>
    </tr>`;
  }).join('');
  updateSelectAllState(rows.map(o => o.id));
}

els.orderSearch.addEventListener('input', renderOrders);
// Row click opens the order (checkbox + invoice-icon clicks are handled
// separately and must not also trigger this).
els.orderRows.addEventListener('click', e => {
  if (e.target.closest('.sled-select-cb')) return;
  const requestBtn = e.target.closest('[data-action="sled-invoice-request"]');
  if (requestBtn) {
    const o = orders.find(x => x.id === requestBtn.dataset.id);
    if (o) window.openInvoicePreviewModal?.(o);
    return;
  }
  const retryBtn = e.target.closest('[data-action="sled-invoice-retry"]');
  if (retryBtn) {
    const o = orders.find(x => x.id === retryBtn.dataset.id);
    if (o) window.retryInvoiceRequest?.(o);
    return;
  }
  const cancelBtn = e.target.closest('[data-action="sled-invoice-cancel"]');
  if (cancelBtn) {
    const o = orders.find(x => x.id === cancelBtn.dataset.id);
    if (o) window.cancelInvoiceRequest?.(o);
    return;
  }
  const cancelNoInvoiceBtn = e.target.closest('[data-action="sled-invoice-cancel-no-invoice"]');
  if (cancelNoInvoiceBtn) {
    const o = orders.find(x => x.id === cancelNoInvoiceBtn.dataset.id);
    if (o) window.cancelCloseWithoutInvoice?.(o);
    return;
  }
  const row = e.target.closest('tr[data-open-order]');
  if (row) openOrderModal(row.dataset.openOrder);
});
els.orderRows.addEventListener('change', e => {
  const cb = e.target.closest('.sled-select-cb');
  if (!cb) return;
  if (cb.checked) selectedOrderIds.add(cb.dataset.id);
  else selectedOrderIds.delete(cb.dataset.id);
  updateSledSelectionBar();
  updateSelectAllState(filteredOrders().map(o => o.id));
});

// ── Naročila / Segmenti preklop ───────────────────────────────
els.subnavBtns.forEach(btn => btn.addEventListener('click', () => {
  els.subnavBtns.forEach(b => {
    b.classList.toggle('fert-subnav-btn--active', b === btn);
    b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
  });
  const view = btn.dataset.sledView;
  els.viewOrders.hidden = view !== 'orders';
  els.viewSegments.hidden = view !== 'segments';
  els.viewBoxes.hidden = view !== 'boxes';
  els.toolbarOrders.hidden = view !== 'orders';
  els.toolbarSegments.hidden = view !== 'segments';
  els.toolbarBoxes.hidden = view !== 'boxes';
}));

// ── Segmenti view — obrnjena perspektiva: en delovni_nalogi_vzorci vrstica
// na vrstico namesto enega naloga (Matej, 2026-11-11). Kompakten seznam,
// stolpce bomo še dodajali. ──────────────────────────────────────
function allSegmentRows() {
  const rows = [];
  for (const o of orders) {
    for (const g of (o.delovni_nalogi_gerki || [])) {
      for (const s of (g.delovni_nalogi_vzorci || [])) rows.push({ sample: s, gerk: g, order: o });
    }
  }
  return rows;
}
function filteredSegmentRows() {
  const q = els.segSearch.value.trim().toLowerCase();
  const rows = allSegmentRows();
  if (!q) return rows;
  return rows.filter(({ sample: s, gerk: g, order: o }) => {
    const hay = `${o.stevilka ?? ''} ${customerName(o.customers)} ${g.gerk_code ?? ''} ${g.fields?.name ?? ''} ${s.sample_no ?? ''}`.toLowerCase();
    return hay.includes(q);
  });
}
function renderSegmentRows() {
  const rows = filteredSegmentRows();
  if (!rows.length) {
    els.segRows.innerHTML = `<tr><td colspan="8" class="fert-empty">${orders.length ? 'Ni zadetkov.' : 'Ni naročil.'}</td></tr>`;
    updateSegSelectAllState([]);
    return;
  }
  els.segRows.innerHTML = rows.map(({ sample: s, gerk: g, order: o }) => {
    // Ha is the segment's own area_ha — deliberately NOT a fallback to the
    // GERK's kolicina_ha (Matej, 2026-11-11): a GERK split into several
    // segments has one ha per segment, not the whole GERK's.
    const ha = s.area_ha != null ? Number(s.area_ha) : null;
    const opts = ['<option value="">—</option>']
      .concat(SAMPLE_ACTIONS.map(a => `<option value="${esc(a)}"${s.sampling_note === a ? ' selected' : ''}>${esc(a)}</option>`))
      .join('');
    // Box assignment frozen once shipped/resulted — same rule as the order
    // modal's own segment rows (renderOrderGerks' `locked`).
    const locked = segmentSent(s) || segmentHasResult(s);
    return `<tr data-open-order="${esc(o.id)}">
      <td><input type="checkbox" class="sled-seg-select-cb" data-id="${esc(s.id)}" aria-label="Izberi segment" ${selectedSegIds.has(s.id) ? 'checked' : ''}></td>
      <td class="fert-strong">${esc(s.sample_no)}</td>
      <td class="fert-num">${ha != null ? ha.toFixed(2) : '—'}</td>
      <td>${esc(g.gerk_code)}</td>
      <td>${esc(g.fields?.name ?? '—')}</td>
      <td title="${esc(customerName(o.customers))}">${esc(customerName(o.customers))}</td>
      <td><select class="sample-field-input sled-seg-vzorcenje" data-sample-id="${esc(s.id)}">${opts}</select></td>
      <td><select class="sample-field-input sled-seg-box-select" data-box-select="${esc(s.id)}" ${locked ? 'disabled' : ''}>${boxSelectHtml(s)}</select></td>
    </tr>`;
  }).join('');
  updateSegSelectAllState(rows.map(r => r.sample.id));
}
els.segSearch.addEventListener('input', renderSegmentRows);
// Row click opens the segment's own order (same modal as the Naročila
// view) — the checkbox and the Vzorčenje/Pošiljka <select>s must not also
// trigger it.
els.segRows.addEventListener('click', e => {
  if (e.target.closest('.sled-seg-select-cb, .sled-seg-vzorcenje, .sled-seg-box-select')) return;
  const row = e.target.closest('tr[data-open-order]');
  if (row) openOrderModal(row.dataset.openOrder);
});
els.segRows.addEventListener('change', async e => {
  const selectCb = e.target.closest('.sled-seg-select-cb');
  if (selectCb) {
    if (selectCb.checked) selectedSegIds.add(selectCb.dataset.id);
    else selectedSegIds.delete(selectCb.dataset.id);
    updateSledSegSelectionBar();
    updateSegSelectAllState(filteredSegmentRows().map(r => r.sample.id));
    return;
  }
  const vzorcenjeSel = e.target.closest('.sled-seg-vzorcenje');
  if (vzorcenjeSel) {
    const sampleId = vzorcenjeSel.dataset.sampleId;
    const value = vzorcenjeSel.value || null;
    const sample = allSegmentRows().find(r => r.sample.id === sampleId)?.sample;
    vzorcenjeSel.disabled = true;
    try {
      const { error } = await supabase.from('delovni_nalogi_vzorci').update({ sampling_note: value }).eq('id', sampleId);
      if (error) throw error;
      if (sample) sample.sampling_note = value;
    } catch (err) {
      alert(err.message || 'Napaka pri shranjevanju.');
      if (sample) vzorcenjeSel.value = sample.sampling_note || '';
    } finally {
      vzorcenjeSel.disabled = false;
    }
    return;
  }
  const boxSel = e.target.closest('[data-box-select]');
  if (!boxSel) return;
  const segId = boxSel.dataset.boxSelect;
  if (boxSel.value === '__new__') {
    const label = prompt('Oznaka nove škatle (pošiljke):');
    if (!label || !label.trim()) { renderSegmentRows(); return; }
    const box = await createBox(label.trim());
    if (box) await assignSegmentToBox(segId, box.id);
    else renderSegmentRows();
    return;
  }
  await assignSegmentToBox(segId, boxSel.value || null);
});

// ── Selection + bulk export (mirrors app.js's work-order selection bar —
// same .wlg-selection-bar/.wlg-sel-* markup/CSS, own instance) ────────
function updateSelectAllState(visibleIds) {
  const checkedCount = visibleIds.filter(id => selectedOrderIds.has(id)).length;
  els.selectAllCb.checked = visibleIds.length > 0 && checkedCount === visibleIds.length;
  els.selectAllCb.indeterminate = checkedCount > 0 && checkedCount < visibleIds.length;
}
els.selectAllCb.addEventListener('click', () => {
  const visible = filteredOrders();
  const anySelected = visible.some(o => selectedOrderIds.has(o.id));
  if (anySelected) visible.forEach(o => selectedOrderIds.delete(o.id));
  else visible.forEach(o => selectedOrderIds.add(o.id));
  renderOrders();
  updateSledSelectionBar();
});

function buildSledSelectionBar() {
  els.selectionBar.setAttribute('role', 'toolbar');
  els.selectionBar.setAttribute('aria-label', 'Skupinska dejanja za izbrana naročila');
  els.selectionBar.innerHTML = `
    <span class="wlg-sel-summary"></span>
    <button type="button" class="wlg-sel-close" data-action="sled-sel-close" aria-label="Prekliči izbiro" title="Prekliči izbiro">${SEL_ICON_CLOSE}</button>
    <span class="wlg-sel-sep" aria-hidden="true"></span>
    <div class="wlg-sel-actions">
      <button type="button" class="wlg-sel-action" data-action-id="sled-sel-export" aria-label="Izvozi izbrana naročila v Excel" title="Izvozi izbrana naročila v Excel">
        ${SEL_ICON_DOWNLOAD}<span class="wlg-sel-action-label">Izvozi</span>
      </button>
      <button type="button" class="wlg-sel-action" data-action-id="sled-sel-print" aria-label="Natisni škatle izbranih naročil" title="Natisni škatle izbranih naročil (ena škatla = ena stran)">
        ${SEL_ICON_PRINT}<span class="wlg-sel-action-label">Natisni</span>
      </button>
    </div>`;
  els.selectionBar.querySelector('[data-action="sled-sel-close"]').addEventListener('click', clearSelection);
  els.selectionBar.querySelector('[data-action-id="sled-sel-export"]').addEventListener('click', exportSelectedOrders);
  els.selectionBar.querySelector('[data-action-id="sled-sel-print"]').addEventListener('click', printSelectedBoxes);
}
buildSledSelectionBar();

function updateSledSelectionBar() {
  const n = selectedOrderIds.size;
  els.selectionBar.classList.toggle('wlg-selection-bar--visible', n > 0);
  if (n === 0) return;
  const summaryEl = els.selectionBar.querySelector('.wlg-sel-summary');
  if (summaryEl) summaryEl.textContent = `${n} ${n === 1 ? 'izbrano' : 'izbranih'}`;
}
function clearSelection() {
  selectedOrderIds = new Set();
  els.orderRows.querySelectorAll('.sled-select-cb').forEach(cb => { cb.checked = false; });
  updateSledSelectionBar();
  updateSelectAllState(filteredOrders().map(o => o.id));
}

// ── Segmenti: selection + bulk Vzorčenje/Pošiljka (Matej, 2026-11-11) ──
function updateSegSelectAllState(visibleIds) {
  const checkedCount = visibleIds.filter(id => selectedSegIds.has(id)).length;
  els.segSelectAllCb.checked = visibleIds.length > 0 && checkedCount === visibleIds.length;
  els.segSelectAllCb.indeterminate = checkedCount > 0 && checkedCount < visibleIds.length;
}
els.segSelectAllCb.addEventListener('click', () => {
  const visible = filteredSegmentRows().map(r => r.sample.id);
  const anySelected = visible.some(id => selectedSegIds.has(id));
  if (anySelected) visible.forEach(id => selectedSegIds.delete(id));
  else visible.forEach(id => selectedSegIds.add(id));
  renderSegmentRows();
  updateSledSegSelectionBar();
});

// Placeholder-first <select>s — the bar applies a bulk change on `change`
// and immediately resets to the placeholder, rather than showing a value
// that wouldn't make sense once segments differ from each other.
function bulkVzorcenjeSelectHtml() {
  return ['<option value="__placeholder__" selected disabled>Nastavi vzorčenje…</option>', '<option value="__clear__">—</option>']
    .concat(SAMPLE_ACTIONS.map(a => `<option value="${esc(a)}">${esc(a)}</option>`))
    .join('');
}
function bulkBoxSelectHtml() {
  const openBoxes = boxes.filter(b => b.status === 'Odprta');
  return ['<option value="__placeholder__" selected disabled>Dodeli pošiljko…</option>', '<option value="__clear__">— brez škatle —</option>']
    .concat(openBoxes.map(b => `<option value="${esc(b.id)}">${esc(b.label)}</option>`))
    .concat([`<option value="__new__">+ Nova škatla…</option>`])
    .join('');
}
async function bulkSetVzorcenje(value) {
  const ids = [...selectedSegIds];
  if (!ids.length) return;
  const { error } = await supabase.from('delovni_nalogi_vzorci').update({ sampling_note: value }).in('id', ids);
  if (error) { alert('Napaka pri shranjevanju: ' + error.message); return; }
  for (const id of ids) {
    const sample = allSegmentRows().find(r => r.sample.id === id)?.sample;
    if (sample) sample.sampling_note = value;
  }
  renderSegmentRows();
}
async function bulkAssignBox(boxId) {
  // Same lock rule as a single row's own box <select> — already-sent or
  // already-resulted segments are silently left out of the bulk change.
  const all = allSegmentRows();
  const ids = [...selectedSegIds].filter(id => {
    const s = all.find(r => r.sample.id === id)?.sample;
    return s && !(segmentSent(s) || segmentHasResult(s));
  });
  if (!ids.length) { alert('Noben izbran segment ni na voljo za spremembo pošiljke (že poslan ali ima rezultat analize).'); return; }
  const { error } = await supabase.from('delovni_nalogi_vzorci').update({ box_id: boxId }).in('id', ids);
  if (error) { alert('Napaka pri dodeljevanju pošiljke: ' + error.message); return; }
  const boxObj = boxId ? (boxes.find(b => b.id === boxId) ?? null) : null;
  for (const id of ids) {
    const sample = all.find(r => r.sample.id === id)?.sample;
    if (sample) { sample.box_id = boxId; sample.sample_boxes = boxObj; }
  }
  renderSegmentRows();
  renderOrders();
  renderBoxesList();
  if (currentOrderId) renderOrderModal(orders.find(o => o.id === currentOrderId));
}

function buildSledSegSelectionBar() {
  els.segSelectionBar.setAttribute('role', 'toolbar');
  els.segSelectionBar.setAttribute('aria-label', 'Skupinska dejanja za izbrane segmente');
  els.segSelectionBar.innerHTML = `
    <span class="wlg-sel-summary"></span>
    <button type="button" class="wlg-sel-close" data-action="sled-seg-sel-close" aria-label="Prekliči izbiro" title="Prekliči izbiro">${SEL_ICON_CLOSE}</button>
    <span class="wlg-sel-sep" aria-hidden="true"></span>
    <div class="wlg-sel-actions">
      <select id="segBulkVzorcenje" class="field-input sled-bulk-select" aria-label="Nastavi vzorčenje za izbrane segmente">${bulkVzorcenjeSelectHtml()}</select>
      <select id="segBulkBox" class="field-input sled-bulk-select" aria-label="Dodeli pošiljko izbranim segmentom">${bulkBoxSelectHtml()}</select>
    </div>`;
  els.segSelectionBar.querySelector('[data-action="sled-seg-sel-close"]').addEventListener('click', clearSegSelection);
  els.segSelectionBar.querySelector('#segBulkVzorcenje').addEventListener('change', async e => {
    const v = e.target.value;
    if (v === '__placeholder__') return;
    await bulkSetVzorcenje(v === '__clear__' ? null : v);
    e.target.value = '__placeholder__';
  });
  els.segSelectionBar.querySelector('#segBulkBox').addEventListener('change', async e => {
    const v = e.target.value;
    if (v === '__placeholder__') return;
    let boxId = null;
    if (v === '__new__') {
      const label = prompt('Oznaka nove škatle (pošiljke):');
      if (!label || !label.trim()) { e.target.value = '__placeholder__'; return; }
      const box = await createBox(label.trim());
      if (!box) { e.target.value = '__placeholder__'; return; }
      boxId = box.id;
    } else if (v !== '__clear__') {
      boxId = v;
    }
    await bulkAssignBox(boxId);
    e.target.value = '__placeholder__';
  });
}

function updateSledSegSelectionBar() {
  const n = selectedSegIds.size;
  els.segSelectionBar.classList.toggle('wlg-selection-bar--visible', n > 0);
  if (n === 0) return;
  buildSledSegSelectionBar(); // rebuilt each time — box list may have changed
  const summaryEl = els.segSelectionBar.querySelector('.wlg-sel-summary');
  if (summaryEl) summaryEl.textContent = `${n} ${n === 1 ? 'izbran' : 'izbranih'}`;
}
function clearSegSelection() {
  selectedSegIds = new Set();
  els.segRows.querySelectorAll('.sled-seg-select-cb').forEach(cb => { cb.checked = false; });
  updateSledSegSelectionBar();
  updateSegSelectAllState(filteredSegmentRows().map(r => r.sample.id));
}

// Izvoz (CSV, odpre se v Excelu) — en vzorec = ena vrstica, samo za
// trenutno izbrana naročila. Isti stolpci kot Delovni Nalogi izvoz
// (exportSelectedWorkOrdersToExcel v app.js), plus vsi laboratorijski
// stolpci na koncu (Matej, 2026-11-10: "izvoz tam naj bo identičen, le
// da ima dodane vse laboratorijske rezultate").
const LAB_EXPORT_COLS = [
  ['lab_sample_code', 'Lab. koda'], ['analysis_date', 'Datum analize'],
  ['ph_kcl', 'pH (KCl)'], ['ka', 'KA'], ['caco3_pct', 'CaCO3 %'], ['humus_pct', 'Humus %'],
  ['no3_no2_n', 'NO3+NO2-N'], ['p2o5', 'P2O5'], ['k2o', 'K2O'], ['mg', 'Mg'], ['na', 'Na'],
  ['zn', 'Zn'], ['cu', 'Cu'], ['mn', 'Mn'], ['salts_pct', 'Soli %'], ['so4_s', 'SO4-S'], ['fe', 'Fe'], ['notes', 'Opomba'],
];
// Same dot->comma fix as app.js's csvHa — a plain "8.23" opens in Excel
// as a misparsed date without it.
function csvHa(value) {
  return value == null ? '' : Number(value).toFixed(2).replace('.', ',');
}
function exportSelectedOrders() {
  const rows = orders.filter(o => selectedOrderIds.has(o.id));
  if (!rows.length) return;
  const header = ['Št. naloga', 'Datum', 'Status', 'Izvajalec', 'GERK', 'Ha', 'Ime gerka', 'Segment', 'Vzorčenje', 'Stranka', ...LAB_EXPORT_COLS.map(c => c[1])];
  const lines = [header.map(csvField).join(';')];
  for (const o of rows) {
    const datum = o.ustvarjen ? fmtDate(o.ustvarjen) : '';
    const stranka = customerName(o.customers);
    const izvajalec = o.profiles?.full_name || '';
    const base = [o.stevilka || '', datum, o.status || '', izvajalec];
    for (const g of (o.delovni_nalogi_gerki || [])) {
      const segments = [...(g.delovni_nalogi_vzorci || [])].sort((a, b) => (parseInt(a.sample_no, 10) || 0) - (parseInt(b.sample_no, 10) || 0));
      const gHa = g.kolicina_ha != null ? g.kolicina_ha : segments.reduce((sum, s) => sum + (Number(s.area_ha) || 0), 0);
      const imeGerka = g.fields?.name || '';
      const gerkBase = [...base, g.gerk_code || '', csvHa(gHa), imeGerka];
      if (!segments.length) {
        lines.push([...gerkBase, '', '', stranka, ...LAB_EXPORT_COLS.map(() => '')].map(csvField).join(';'));
        continue;
      }
      for (const s of segments) {
        const results = s.lab_soil_result?.length ? s.lab_soil_result : [null];
        for (const r of results) {
          const line = [...gerkBase, s.sample_no || '', s.sampling_note || '', stranka, ...LAB_EXPORT_COLS.map(([key]) => (r ? (r[key] ?? '') : ''))];
          lines.push(line.map(csvField).join(';'));
        }
      }
    }
  }
  const csv = '﻿' + lines.join('\r\n');
  downloadTextFile(`sledenje_narocilom_${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
}

// ── Nalog — modal: GERK groups, segment rows (št. segmenta, status, ali
// vzorčimo, škatla) + spodaj škatle, ki jih ta nalog uporablja ───────
function boxSelectHtml(seg) {
  const openBoxes = boxes.filter(b => b.status === 'Odprta');
  const options = [`<option value="">— brez škatle —</option>`]
    .concat(openBoxes.map(b => `<option value="${esc(b.id)}" ${b.id === seg.box_id ? 'selected' : ''}>${esc(b.label)}</option>`));
  // a segment already in a box that's since been sent isn't in openBoxes —
  // still show it as the selected option so the dropdown isn't blank.
  if (seg.box_id && !openBoxes.some(b => b.id === seg.box_id)) {
    const b = boxes.find(x => x.id === seg.box_id);
    options.push(`<option value="${esc(seg.box_id)}" selected>${esc(b?.label ?? '?')} (${esc(b?.status ?? '')})</option>`);
  }
  options.push(`<option value="__new__">+ Nova škatla…</option>`);
  return options.join('');
}

function segmentLabel(seg) {
  if (segmentHasResult(seg)) return 'Analiza prejeta';
  if (segmentSent(seg)) return 'Poslano';
  if (segmentBoxed(seg)) return 'V škatli';
  return 'Ni v škatli';
}
function segmentBadgeClass(seg) {
  if (segmentHasResult(seg)) return 'fert-badge--ok';
  if (segmentSent(seg)) return 'fert-badge--sent';
  if (segmentBoxed(seg)) return 'fert-badge--warn';
  return 'fert-badge--neutral';
}

function renderOrderGerks(order) {
  const gerks = order.delovni_nalogi_gerki || [];
  const groups = gerks.map(g => {
    const segs = g.delovni_nalogi_vzorci || [];
    if (!segs.length) return '';
    return `<div class="sled-gerk-group">
      <h4 class="sled-gerk-title">GERK ${esc(g.gerk_code || '—')}</h4>
      ${segs.map(s => {
        const locked = segmentSent(s) || segmentHasResult(s); // box assignment frozen once shipped
        // Red flag: still being sampled, no result yet, and not even sent
        // — once sent there's nothing wrong with still waiting on a result
        // (Matej, 2026-11-06: "poslano ne, ne more biti poslan").
        const flagNoResult = !segmentSkipped(s) && !segmentHasResult(s) && !segmentSent(s);
        return `<div class="sled-seg-row" data-seg-id="${esc(s.id)}">
          <span class="sled-seg-sample">${esc(s.sample_no)}</span>
          <span class="fert-badge ${segmentBadgeClass(s)}">${esc(segmentLabel(s))}</span>
          ${flagNoResult ? '<span class="fert-badge fert-badge--danger">⚠ Ni rezultata analize</span>' : ''}
          <label class="sled-seg-sampling"><input type="checkbox" data-sampling-toggle="${esc(s.id)}" ${segmentSkipped(s) ? '' : 'checked'}> Vzorčimo</label>
          <select class="field-input sled-seg-box-select" data-box-select="${esc(s.id)}" ${locked ? 'disabled' : ''}>${boxSelectHtml(s)}</select>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
  els.orderGerks.innerHTML = groups || '<p class="fert-hint">Ta nalog nima GERK segmentov (vzorcev).</p>';
}

// Only the boxes actually used by this order's own segments — not a
// global box browser (Matej, 2026-11-06: no separate "Škatle" surface).
function renderOrderBoxes(order) {
  const segs = allSegments(order);
  const boxIds = [...new Set(segs.map(s => s.box_id).filter(Boolean))];
  els.orderBoxesWrap.hidden = boxIds.length === 0;
  if (!boxIds.length) return;
  els.orderBoxRows.innerHTML = boxIds.map(boxId => {
    const box = boxes.find(b => b.id === boxId);
    if (!box) return '';
    const nHere = segs.filter(s => s.box_id === boxId).length;
    const statusBadge = box.status === 'Poslano'
      ? `<span class="fert-badge fert-badge--sent">Poslano</span>`
      : `<span class="fert-badge fert-badge--warn">Odprta</span>`;
    const actions = [`<button type="button" class="btn btn-secondary btn-sm" data-print-box="${esc(box.id)}">Natisni</button>`];
    if (box.status === 'Odprta') actions.push(`<button type="button" class="btn btn-primary btn-sm" data-send-box="${esc(box.id)}">Zaključi in pošlji</button>`);
    return `<tr>
      <td class="fert-strong">${esc(box.label)}</td>
      <td>${statusBadge}</td>
      <td class="fert-num">${nHere}</td>
      <td>${box.sent_at ? fmtDate(box.sent_at) : '—'}</td>
      <td><div class="sled-row-actions">${actions.join('')}</div></td>
    </tr>`;
  }).join('');
}

function renderOrderModal(order) {
  els.orderModalTitle.textContent = `Nalog ${order.stevilka ?? ''} · ${customerName(order.customers)}`;
  renderOrderGerks(order);
  renderOrderBoxes(order);
}

function openOrderModal(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order) return;
  currentOrderId = orderId;
  renderOrderModal(order);
  showModal(els.orderModal);
}
function closeOrderModal() {
  hideModal(els.orderModal);
  currentOrderId = null;
}
els.orderModalClose.addEventListener('click', closeOrderModal);
els.orderModal.addEventListener('click', e => { if (e.target === els.orderModal) closeOrderModal(); });

function findSegment(segId) {
  for (const o of orders) for (const g of (o.delovni_nalogi_gerki || [])) {
    const seg = (g.delovni_nalogi_vzorci || []).find(s => s.id === segId);
    if (seg) return seg;
  }
  return null;
}

els.orderGerks.addEventListener('change', async e => {
  const toggle = e.target.closest('[data-sampling-toggle]');
  if (toggle) return setSamplingFlag(toggle.dataset.samplingToggle, toggle.checked);
  const sel = e.target.closest('[data-box-select]');
  if (!sel) return;
  const segId = sel.dataset.boxSelect;
  if (sel.value === '__new__') {
    const label = prompt('Oznaka nove škatle:');
    if (!label || !label.trim()) { renderOrderGerks(orders.find(o => o.id === currentOrderId)); return; }
    const box = await createBox(label.trim());
    if (box) await assignSegmentToBox(segId, box.id);
    else renderOrderGerks(orders.find(o => o.id === currentOrderId));
    return;
  }
  await assignSegmentToBox(segId, sel.value || null);
});

async function setSamplingFlag(segId, isSampling) {
  const value = isSampling ? null : 'ne pobereš';
  const { error } = await supabase.from('delovni_nalogi_vzorci').update({ sampling_note: value }).eq('id', segId);
  if (error) { alert('Napaka: ' + error.message); return; }
  const seg = findSegment(segId);
  if (seg) seg.sampling_note = value;
}

async function assignSegmentToBox(segId, boxId) {
  const { error } = await supabase.from('delovni_nalogi_vzorci').update({ box_id: boxId }).eq('id', segId);
  if (error) { alert('Napaka pri dodeljevanju škatle: ' + error.message); return; }
  const seg = findSegment(segId);
  if (seg) { seg.box_id = boxId; seg.sample_boxes = boxId ? (boxes.find(b => b.id === boxId) ?? null) : null; }
  if (currentOrderId) renderOrderModal(orders.find(o => o.id === currentOrderId));
  renderSegmentRows();
  renderBoxesList();
}

async function createBox(label) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from('sample_boxes').insert({ label, created_by: user?.id ?? null }).select('*').single();
  if (error) { alert('Napaka pri ustvarjanju škatle: ' + error.message); return null; }
  boxes.unshift(data);
  return data;
}

// ── Škatle v tem nalogu — Natisni / Zaključi in pošlji — deluje na
// globalni škatli (lahko vsebuje vzorce iz drugih naročil), samo odprta
// od tod, znotraj modala enega naloga (Matej, 2026-11-06: ni več ločenega
// zavihka/modala za vse škatle). ───────────────────────────────────
function samplesInBox(boxId) {
  return orders.flatMap(o => allSegments(o)
    .filter(s => s.box_id === boxId)
    .map(s => ({ ...s, stevilka: o.stevilka, stranka: customerName(o.customers) })));
}

// Shared by both box tables — the per-order one inside #sledOrderModal and
// the global "Škatle" subview (Matej, 2026-11-11: "morda rabimo še ločen
// podzavihek — urejanje škatle") — same actions either way, since a box can
// span several orders regardless of which table you clicked it from.
async function handleBoxRowClick(e) {
  const sendBtn = e.target.closest('[data-send-box]');
  if (sendBtn) {
    const box = boxes.find(b => b.id === sendBtn.dataset.sendBox);
    if (!box) return;
    const n = samplesInBox(box.id).length;
    if (!confirm(`Zaključiti in poslati škatlo "${box.label}" (${n} vzorcev skupaj, lahko iz več naročil) laboratoriju?`)) return;
    const { data: { user } } = await supabase.auth.getUser();
    const sentAt = new Date().toISOString();
    const { error } = await supabase.from('sample_boxes').update({ status: 'Poslano', sent_at: sentAt, sent_by: user?.id ?? null }).eq('id', box.id);
    if (error) { alert('Napaka: ' + error.message); return; }
    box.status = 'Poslano';
    box.sent_at = sentAt;
    for (const o of orders) for (const g of (o.delovni_nalogi_gerki || [])) for (const s of (g.delovni_nalogi_vzorci || [])) {
      if (s.box_id === box.id) s.sample_boxes = box;
    }
    renderOrders();
    renderSegmentRows();
    renderBoxesList();
    if (currentOrderId) renderOrderModal(orders.find(o => o.id === currentOrderId));
    return;
  }
  const printBtn = e.target.closest('[data-print-box]');
  if (printBtn) printBox(boxes.find(b => b.id === printBtn.dataset.printBox));
}
els.orderBoxRows.addEventListener('click', handleBoxRowClick);

// ── Škatle view — every box, any order, not scoped to one nalog (Matej,
// 2026-11-11). Same row shape as renderOrderBoxes' table, just over all of
// `boxes` instead of one order's box_ids. ───────────────────────────────
function filteredBoxesList() {
  const q = els.boxSearch.value.trim().toLowerCase();
  if (!q) return boxes;
  return boxes.filter(b => (b.label || '').toLowerCase().includes(q));
}
function renderBoxesList() {
  const rows = filteredBoxesList();
  if (!rows.length) {
    els.boxRows.innerHTML = `<tr><td colspan="5" class="fert-empty">${boxes.length ? 'Ni zadetkov.' : 'Ni škatel.'}</td></tr>`;
    return;
  }
  els.boxRows.innerHTML = rows.map(box => {
    const n = samplesInBox(box.id).length;
    const statusBadge = box.status === 'Poslano'
      ? `<span class="fert-badge fert-badge--sent">Poslano</span>`
      : `<span class="fert-badge fert-badge--warn">Odprta</span>`;
    const actions = [`<button type="button" class="btn btn-secondary btn-sm" data-print-box="${esc(box.id)}">Natisni</button>`];
    if (box.status === 'Odprta') actions.push(`<button type="button" class="btn btn-primary btn-sm" data-send-box="${esc(box.id)}">Zaključi in pošlji</button>`);
    return `<tr>
      <td class="fert-strong">${esc(box.label)}</td>
      <td>${statusBadge}</td>
      <td class="fert-num">${n}</td>
      <td>${box.sent_at ? fmtDate(box.sent_at) : '—'}</td>
      <td><div class="sled-row-actions">${actions.join('')}</div></td>
    </tr>`;
  }).join('');
}
els.boxSearch.addEventListener('input', renderBoxesList);
els.boxRows.addEventListener('click', handleBoxRowClick);

// One box = printBoxes([box]); bulk print (selection action bar) reuses
// the same page markup, one per box, each on its own printed page — the
// browser's own "Save as PDF" in the print dialog is the "pripravi PDF"
// step (no server-side PDF generation needed for a simple tabular sheet).
function printBox(box) {
  if (box) printBoxes([box]);
}

function boxPageHtml(box, isLast) {
  const items = samplesInBox(box.id).sort((a, b) =>
    (a.stevilka || '').localeCompare(b.stevilka || '', 'sl', { numeric: true }) || (a.gerk_code || '').localeCompare(b.gerk_code || '', 'sl'));
  return `<section class="sled-print-page"${isLast ? '' : ' style="page-break-after: always;"'}>
<h1>Škatla: ${esc(box.label)}</h1>
<p class="meta">Status: ${esc(box.status)} · ${items.length} vzorcev · natisnjeno ${new Date().toLocaleString('sl-SI')}</p>
<table><thead><tr><th>#</th><th>Nalog</th><th>Stranka</th><th>GERK</th><th>Vzorec</th></tr></thead>
<tbody>${items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.stevilka)}</td><td>${esc(it.stranka)}</td><td>${esc(it.gerk_code)}</td><td>${esc(it.sample_no)}</td></tr>`).join('')}</tbody>
</table>
</section>`;
}

function printBoxes(boxList) {
  if (!boxList.length) return;
  const win = window.open('', '_blank');
  if (!win) { alert('Brskalnik je blokiral novo okno — dovoli pojavna okna za to stran.'); return; }
  const title = boxList.length === 1 ? `Škatla ${boxList[0].label}` : `${boxList.length} škatel`;
  const pages = boxList.map((box, i) => boxPageHtml(box, i === boxList.length - 1)).join('');
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.meta { color: #555; margin: 0 0 20px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; }
  th { background: #eee; }
</style></head><body>
${pages}
<script>window.onload = () => window.print();<\/script>
</body></html>`);
  win.document.close();
}

// "Natisni" on the selection bar — every box used by the SELECTED orders'
// own segments, one page per box, full contents of each (same as opening
// it from inside an order — a box can hold samples from other orders too).
function printSelectedBoxes() {
  const selected = orders.filter(o => selectedOrderIds.has(o.id));
  const boxIds = [...new Set(selected.flatMap(o => allSegments(o).map(s => s.box_id).filter(Boolean)))];
  if (!boxIds.length) { alert('Izbrana naročila nimajo nobenega vzorca v škatli.'); return; }
  const boxList = boxIds.map(id => boxes.find(b => b.id === id)).filter(Boolean);
  printBoxes(boxList);
}

// app.js's switchTab() shows/hides #panelSledenje itself — this just
// (re)loads fresh data every time the tab is opened, same as every other
// admin tab's own click listener on the same button (fertilization.js,
// planning.js).
els.tab.addEventListener('click', loadAll);

// Lets app.js's openInvoicePreviewModal/retryInvoiceRequest/
// cancelInvoiceRequest (the "Pripravi račun" review modal + actions,
// triggered here via the icon in invoiceActionIcon()) refresh this list
// after a successful write, without app.js knowing anything about this
// module — set as soon as this module loads (script order in app.html
// guarantees app.js's own window.* assignments run first).
window.sledenjeRefreshOrders = loadAll;
