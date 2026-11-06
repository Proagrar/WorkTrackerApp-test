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
  subnavBtns: [...document.querySelectorAll('[data-sled-view]')],
  views: {
    orders: document.getElementById('sledViewOrders'),
    boxes: document.getElementById('sledViewBoxes'),
  },
  exportBtn: document.getElementById('sledExportBtn'),
  newBoxBtn: document.getElementById('sledNewBoxBtn'),
  orderSearch: document.getElementById('sledOrderSearch'),
  orderMode: document.getElementById('sledOrderMode'),
  orderRows: document.getElementById('sledOrderRows'),
  boxRows: document.getElementById('sledBoxRows'),
  orderModal: document.getElementById('sledOrderModal'),
  orderModalClose: document.getElementById('sledOrderModalClose'),
  orderModalTitle: document.getElementById('sledOrderModalTitle'),
  orderGerks: document.getElementById('sledOrderGerks'),
};

let currentView = 'orders';
let orders = [];
let boxes = [];
let currentOrderId = null;

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
  els.orderRows.innerHTML = `<tr><td colspan="8" class="fert-empty">Nalaganje …</td></tr>`;
  const [{ data: orderData, error: orderError }, { data: boxData, error: boxError }] = await Promise.all([
    supabase.from('delovni_nalogi')
      .select(`id, stevilka, status, customers(naziv, company_name),
        delovni_nalogi_gerki(id, gerk_code,
          delovni_nalogi_vzorci(id, sample_no, box_id, sample_boxes(id, label, status), lab_soil_result(${LAB_COLS})))`)
      .is('deleted_at', null)
      .order('ustvarjen', { ascending: false }),
    supabase.from('sample_boxes').select('*').order('created_at', { ascending: false }),
  ]);
  const error = orderError || boxError;
  if (error) {
    els.orderRows.innerHTML = `<tr><td colspan="8" class="fert-empty fert-error">Napaka pri nalaganju: ${esc(error.message)}</td></tr>`;
    return;
  }
  orders = orderData ?? [];
  boxes = boxData ?? [];
  renderCurrentView();
}

// ── Sample-pipeline stage (per segment / per order) ───────────────
const STAGE_LABELS = ['Ni v škatli', 'V škatli', 'Poslano laboratoriju', 'Prejeti lab. rezultati'];
const STAGE_KEYS = ['none', 'boxed', 'sent', 'results'];

function allSegments(order) {
  return (order.delovni_nalogi_gerki || []).flatMap(g =>
    (g.delovni_nalogi_vzorci || []).map(s => ({ ...s, gerk_code: g.gerk_code })));
}
function segmentStage(seg) {
  if (seg.lab_soil_result?.length) return 3;
  if (seg.sample_boxes?.status === 'Poslano') return 2;
  if (seg.box_id) return 1;
  return 0;
}
function orderStageRange(order) {
  const segs = allSegments(order);
  if (!segs.length) return null;
  const stages = segs.map(segmentStage);
  return { min: Math.min(...stages), max: Math.max(...stages), segs };
}
function orderStatusLabel(order) {
  const range = orderStageRange(order);
  if (!range) return 'Brez vzorcev';
  return range.min === range.max ? STAGE_LABELS[range.min] : `${STAGE_LABELS[range.min]} → ${STAGE_LABELS[range.max]}`;
}
function stageBadgeClass(stage) {
  return ['fert-badge--neutral', 'fert-badge--warn', 'fert-badge--sent', 'fert-badge--ok'][stage];
}

// ── Naročila view ──────────────────────────────────────────────
function filteredOrders() {
  const q = els.orderSearch.value.trim().toLowerCase();
  const mode = els.orderMode.value;
  return orders.filter(o => {
    if (q) {
      const hay = `${o.stevilka ?? ''} ${customerName(o.customers)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (mode !== 'all') {
      const range = orderStageRange(o);
      const idx = STAGE_KEYS.indexOf(mode);
      if (!range || !range.segs.some(s => segmentStage(s) === idx)) return false;
    }
    return true;
  });
}

function renderOrders() {
  const rows = filteredOrders();
  if (!rows.length) {
    els.orderRows.innerHTML = `<tr><td colspan="8" class="fert-empty">${orders.length ? 'Ni zadetkov.' : 'Ni naročil.'}</td></tr>`;
    return;
  }
  els.orderRows.innerHTML = rows.map(o => {
    const segs = allSegments(o);
    const boxed = segs.filter(s => segmentStage(s) >= 1).length;
    const sent = segs.filter(s => segmentStage(s) >= 2).length;
    const results = segs.filter(s => segmentStage(s) >= 3).length;
    const range = orderStageRange(o);
    const label = orderStatusLabel(o);
    // mixed-progress orders (min !== max) are shown with the lowest
    // (least-advanced) stage's color — that's the one still needing work.
    const cls = range ? stageBadgeClass(range.min) : 'fert-badge--neutral';
    return `<tr>
      <td>${esc(o.stevilka)}</td>
      <td class="fert-strong fert-wrap">${esc(customerName(o.customers))}</td>
      <td class="fert-num">${segs.length}</td>
      <td class="fert-num">${boxed}</td>
      <td class="fert-num">${sent}</td>
      <td class="fert-num">${results}</td>
      <td><span class="fert-badge ${cls}">${esc(label)}</span></td>
      <td><button type="button" class="btn btn-secondary btn-sm" data-open-order="${esc(o.id)}">Odpri</button></td>
    </tr>`;
  }).join('');
}

els.orderSearch.addEventListener('input', renderOrders);
els.orderMode.addEventListener('change', renderOrders);
els.orderRows.addEventListener('click', e => {
  const btn = e.target.closest('[data-open-order]');
  if (btn) openOrderModal(btn.dataset.openOrder);
});

// ── Naročilo detail modal — GERK groups, segment rows, box select ──
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

function renderOrderModal(order) {
  els.orderModalTitle.textContent = `Nalog ${order.stevilka ?? ''} · ${customerName(order.customers)}`;
  const gerks = order.delovni_nalogi_gerki || [];
  const groups = gerks.map(g => {
    const segs = g.delovni_nalogi_vzorci || [];
    if (!segs.length) return '';
    return `<div class="sled-gerk-group">
      <h4 class="sled-gerk-title">GERK ${esc(g.gerk_code || '—')}</h4>
      ${segs.map(s => {
        const stage = segmentStage(s);
        const locked = stage >= 2; // sent, or already has results — box assignment frozen
        return `<div class="sled-seg-row" data-seg-id="${esc(s.id)}">
          <span class="sled-seg-sample">${esc(s.sample_no)}</span>
          <span class="fert-badge ${stageBadgeClass(stage)}">${esc(STAGE_LABELS[stage])}</span>
          <select class="field-input sled-seg-box-select" data-box-select="${esc(s.id)}" ${locked ? 'disabled' : ''}>${boxSelectHtml(s)}</select>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
  els.orderGerks.innerHTML = groups || '<p class="fert-hint">Ta nalog nima GERK segmentov (vzorcev).</p>';
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

els.orderGerks.addEventListener('change', async e => {
  const sel = e.target.closest('[data-box-select]');
  if (!sel) return;
  const segId = sel.dataset.boxSelect;
  if (sel.value === '__new__') {
    const label = prompt('Oznaka nove škatle:');
    if (!label || !label.trim()) { renderOrderModal(orders.find(o => o.id === currentOrderId)); return; }
    const box = await createBox(label.trim());
    if (box) await assignSegmentToBox(segId, box.id);
    else renderOrderModal(orders.find(o => o.id === currentOrderId));
    return;
  }
  await assignSegmentToBox(segId, sel.value || null);
});

async function assignSegmentToBox(segId, boxId) {
  const { error } = await supabase.from('delovni_nalogi_vzorci').update({ box_id: boxId }).eq('id', segId);
  if (error) { alert('Napaka pri dodeljevanju škatle: ' + error.message); return; }
  for (const o of orders) for (const g of (o.delovni_nalogi_gerki || [])) {
    const seg = (g.delovni_nalogi_vzorci || []).find(s => s.id === segId);
    if (seg) { seg.box_id = boxId; seg.sample_boxes = boxId ? (boxes.find(b => b.id === boxId) ?? null) : null; }
  }
  if (currentOrderId) renderOrderModal(orders.find(o => o.id === currentOrderId));
  renderCurrentView();
}

// ── Škatle view ──────────────────────────────────────────────────
function samplesInBox(boxId) {
  return orders.flatMap(o => allSegments(o)
    .filter(s => s.box_id === boxId)
    .map(s => ({ ...s, stevilka: o.stevilka, stranka: customerName(o.customers) })));
}

function renderBoxes() {
  if (!boxes.length) {
    els.boxRows.innerHTML = `<tr><td colspan="6" class="fert-empty">Še ni ustvarjenih škatel — klikni + Nova škatla, ali dodeli škatlo vzorcu znotraj naročila.</td></tr>`;
    return;
  }
  els.boxRows.innerHTML = boxes.map(b => {
    const n = samplesInBox(b.id).length;
    const statusBadge = b.status === 'Poslano'
      ? `<span class="fert-badge fert-badge--sent">Poslano</span>`
      : `<span class="fert-badge fert-badge--warn">Odprta</span>`;
    const actions = [`<button type="button" class="btn btn-secondary btn-sm" data-print-box="${esc(b.id)}">Natisni</button>`];
    if (b.status === 'Odprta') actions.push(`<button type="button" class="btn btn-primary btn-sm" data-send-box="${esc(b.id)}">Zaključi in pošlji</button>`);
    return `<tr>
      <td class="fert-strong">${esc(b.label)}</td>
      <td>${statusBadge}</td>
      <td class="fert-num">${n}</td>
      <td>${fmtDate(b.created_at)}</td>
      <td>${b.sent_at ? fmtDate(b.sent_at) : '—'}</td>
      <td><div class="sled-row-actions">${actions.join('')}</div></td>
    </tr>`;
  }).join('');
}

async function createBox(label) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from('sample_boxes').insert({ label, created_by: user?.id ?? null }).select('*').single();
  if (error) { alert('Napaka pri ustvarjanju škatle: ' + error.message); return null; }
  boxes.unshift(data);
  return data;
}

els.newBoxBtn.addEventListener('click', async () => {
  const label = prompt('Oznaka nove škatle:');
  if (!label || !label.trim()) return;
  if (await createBox(label.trim())) renderBoxes();
});

els.boxRows.addEventListener('click', async e => {
  const sendBtn = e.target.closest('[data-send-box]');
  if (sendBtn) {
    const box = boxes.find(b => b.id === sendBtn.dataset.sendBox);
    if (!box) return;
    const n = samplesInBox(box.id).length;
    if (!confirm(`Zaključiti in poslati škatlo "${box.label}" (${n} vzorcev) laboratoriju?`)) return;
    const { data: { user } } = await supabase.auth.getUser();
    const sentAt = new Date().toISOString();
    const { error } = await supabase.from('sample_boxes').update({ status: 'Poslano', sent_at: sentAt, sent_by: user?.id ?? null }).eq('id', box.id);
    if (error) { alert('Napaka: ' + error.message); return; }
    box.status = 'Poslano';
    box.sent_at = sentAt;
    for (const o of orders) for (const g of (o.delovni_nalogi_gerki || [])) for (const s of (g.delovni_nalogi_vzorci || [])) {
      if (s.box_id === box.id) s.sample_boxes = box;
    }
    renderCurrentView();
    return;
  }
  const printBtn = e.target.closest('[data-print-box]');
  if (printBtn) printBox(boxes.find(b => b.id === printBtn.dataset.printBox));
});

function printBox(box) {
  if (!box) return;
  const items = samplesInBox(box.id).sort((a, b) =>
    (a.stevilka || '').localeCompare(b.stevilka || '', 'sl', { numeric: true }) || (a.gerk_code || '').localeCompare(b.gerk_code || '', 'sl'));
  const win = window.open('', '_blank');
  if (!win) { alert('Brskalnik je blokiral novo okno — dovoli pojavna okna za to stran.'); return; }
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Škatla ${esc(box.label)}</title>
<style>
  body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.meta { color: #555; margin: 0 0 20px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; }
  th { background: #eee; }
</style></head><body>
<h1>Škatla: ${esc(box.label)}</h1>
<p class="meta">Status: ${esc(box.status)} · ${items.length} vzorcev · natisnjeno ${new Date().toLocaleString('sl-SI')}</p>
<table><thead><tr><th>#</th><th>Nalog</th><th>Stranka</th><th>GERK</th><th>Vzorec</th></tr></thead>
<tbody>${items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.stevilka)}</td><td>${esc(it.stranka)}</td><td>${esc(it.gerk_code)}</td><td>${esc(it.sample_no)}</td></tr>`).join('')}</tbody>
</table>
<script>window.onload = () => window.print();<\/script>
</body></html>`);
  win.document.close();
}

// ── Izvoz (CSV, odpre se v Excelu) — en vzorec = ena vrstica, nad
// trenutno filtriranim seznamom naročil (iskanje + Prikaz), ne glede na
// to, katera podstran (Naročila/Škatle) je trenutno odprta. ───────────
const LAB_EXPORT_COLS = [
  ['lab_sample_code', 'Lab. koda'], ['analysis_date', 'Datum analize'],
  ['ph_kcl', 'pH (KCl)'], ['ka', 'KA'], ['caco3_pct', 'CaCO3 %'], ['humus_pct', 'Humus %'],
  ['no3_no2_n', 'NO3+NO2-N'], ['p2o5', 'P2O5'], ['k2o', 'K2O'], ['mg', 'Mg'], ['na', 'Na'],
  ['zn', 'Zn'], ['cu', 'Cu'], ['mn', 'Mn'], ['salts_pct', 'Soli %'], ['so4_s', 'SO4-S'], ['fe', 'Fe'], ['notes', 'Opomba'],
];

els.exportBtn.addEventListener('click', () => {
  const rows = filteredOrders();
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
});

// ── Sub-navigation ───────────────────────────────────────────────
function renderCurrentView() {
  if (currentView === 'orders') renderOrders();
  else renderBoxes();
}
for (const btn of els.subnavBtns) btn.addEventListener('click', () => {
  currentView = btn.dataset.sledView;
  for (const b of els.subnavBtns) {
    const active = b === btn;
    b.classList.toggle('fert-subnav-btn--active', active);
    b.setAttribute('aria-selected', String(active));
  }
  els.views.orders.hidden = currentView !== 'orders';
  els.views.boxes.hidden = currentView !== 'boxes';
  els.newBoxBtn.hidden = currentView !== 'boxes';
  renderCurrentView();
});

// app.js's switchTab() shows/hides #panelSledenje itself — this just
// (re)loads fresh data every time the tab is opened, same as every other
// admin tab's own click listener on the same button (fertilization.js,
// planning.js).
els.tab.addEventListener('click', loadAll);
