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
};

let orders = [];
let boxes = [];
let currentOrderId = null;
let selectedOrderIds = new Set();
let sledStatusFilterValues = new Set(); // empty = no filter, show all statuses

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
  els.orderRows.innerHTML = `<tr><td colspan="10" class="fert-empty">Nalaganje …</td></tr>`;
  const [{ data: orderData, error: orderError }, { data: boxData, error: boxError }] = await Promise.all([
    supabase.from('delovni_nalogi')
      .select(`id, stevilka, status, customers(naziv, company_name),
        delovni_nalogi_gerki(id, gerk_code, kolicina_ha,
          delovni_nalogi_vzorci(id, sample_no, box_id, sampling_note, sample_boxes(id, label, status, sent_at), lab_soil_result(${LAB_COLS}))),
        work_logs(work_log_gerks(start_time))`)
      .is('deleted_at', null)
      .order('ustvarjen', { ascending: false }),
    supabase.from('sample_boxes').select('*').order('created_at', { ascending: false }),
  ]);
  const error = orderError || boxError;
  if (error) {
    els.orderRows.innerHTML = `<tr><td colspan="10" class="fert-empty fert-error">Napaka pri nalaganju: ${esc(error.message)}</td></tr>`;
    return;
  }
  orders = orderData ?? [];
  boxes = boxData ?? [];
  for (const id of selectedOrderIds) if (!orders.some(o => o.id === id)) selectedOrderIds.delete(id);
  renderOrders();
  updateSledSelectionBar();
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
// began (Matej, 2026-11-06) — the earliest work_log_gerks.start_time
// across every work_logs row tied to this order, not a per-segment field.
function firstFieldStart(order) {
  const times = (order.work_logs || []).flatMap(wl => (wl.work_log_gerks || []).map(g => g.start_time)).filter(Boolean);
  return earliest(times);
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
  const segs = allSegments(order);
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

// ── Naročila view ──────────────────────────────────────────────
function filteredOrders() {
  const q = els.orderSearch.value.trim().toLowerCase();
  return orders.filter(o => {
    if (q) {
      const hay = `${o.stevilka ?? ''} ${customerName(o.customers)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (sledStatusFilterValues.size && !sledStatusFilterValues.has(orderStatusLabel(o))) return false;
    return true;
  });
}

function renderOrders() {
  const rows = filteredOrders();
  if (!rows.length) {
    els.orderRows.innerHTML = `<tr><td colspan="10" class="fert-empty">${orders.length ? 'Ni zadetkov.' : 'Ni naročil.'}</td></tr>`;
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
    return `<tr data-open-order="${esc(o.id)}">
      <td><input type="checkbox" class="sled-select-cb" data-id="${esc(o.id)}" aria-label="Izberi nalog" ${selectedOrderIds.has(o.id) ? 'checked' : ''}></td>
      <td>${esc(o.stevilka)}</td>
      <td class="fert-strong fert-wrap">${esc(customerName(o.customers))}</td>
      <td class="fert-num">${gerkCount}</td>
      <td class="fert-num">${segs.length}</td>
      <td class="fert-num">${totalHa > 0 ? totalHa.toFixed(2) : '—'}</td>
      <td>${samplingDate ? fmtDate(samplingDate) : '—'}</td>
      <td>${sendingDate ? fmtDate(sendingDate) : '—'}</td>
      <td>${fmtPlainDate(receivedDate)}</td>
      <td><div class="sled-status-cell"><span class="fert-badge ${cls}">${esc(label)}</span>${statusStepperSvg(label)}</div></td>
    </tr>`;
  }).join('');
  updateSelectAllState(rows.map(o => o.id));
}

els.orderSearch.addEventListener('input', renderOrders);
// Row click opens the order (checkbox clicks are handled separately and
// must not also trigger this — stopped by checking the checkbox first).
els.orderRows.addEventListener('click', e => {
  if (e.target.closest('.sled-select-cb')) return;
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

// Izvoz (CSV, odpre se v Excelu) — en vzorec = ena vrstica, samo za
// trenutno izbrana naročila (Nalog, Stranka, GERK, Segment + vsi
// laboratorijski stolpci).
const LAB_EXPORT_COLS = [
  ['lab_sample_code', 'Lab. koda'], ['analysis_date', 'Datum analize'],
  ['ph_kcl', 'pH (KCl)'], ['ka', 'KA'], ['caco3_pct', 'CaCO3 %'], ['humus_pct', 'Humus %'],
  ['no3_no2_n', 'NO3+NO2-N'], ['p2o5', 'P2O5'], ['k2o', 'K2O'], ['mg', 'Mg'], ['na', 'Na'],
  ['zn', 'Zn'], ['cu', 'Cu'], ['mn', 'Mn'], ['salts_pct', 'Soli %'], ['so4_s', 'SO4-S'], ['fe', 'Fe'], ['notes', 'Opomba'],
];
function exportSelectedOrders() {
  const rows = orders.filter(o => selectedOrderIds.has(o.id));
  if (!rows.length) return;
  const header = ['Nalog', 'Stranka', 'GERK', 'Segment', ...LAB_EXPORT_COLS.map(c => c[1])];
  const lines = [header.map(csvField).join(';')];
  for (const o of rows) {
    const stranka = customerName(o.customers);
    for (const g of (o.delovni_nalogi_gerki || [])) {
      for (const s of (g.delovni_nalogi_vzorci || [])) {
        const results = s.lab_soil_result?.length ? s.lab_soil_result : [null];
        for (const r of results) {
          const line = [o.stevilka || '', stranka, g.gerk_code || '', s.sample_no || '', ...LAB_EXPORT_COLS.map(([key]) => (r ? (r[key] ?? '') : ''))];
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
        return `<div class="sled-seg-row" data-seg-id="${esc(s.id)}">
          <span class="sled-seg-sample">${esc(s.sample_no)}</span>
          <span class="fert-badge ${segmentBadgeClass(s)}">${esc(segmentLabel(s))}</span>
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

els.orderBoxRows.addEventListener('click', async e => {
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
    if (currentOrderId) renderOrderModal(orders.find(o => o.id === currentOrderId));
    return;
  }
  const printBtn = e.target.closest('[data-print-box]');
  if (printBtn) printBox(boxes.find(b => b.id === printBtn.dataset.printBox));
});

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
