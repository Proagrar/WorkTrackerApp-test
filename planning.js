import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Own client instance, deliberately — this module is self-contained (own
// state, own DOM refs, own event wiring) and app.js is already huge; sharing
// its client would just add cross-module coupling for no real benefit (both
// instances read the same session from the same storage).
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const MONTHS = ['januar', 'februar', 'marec', 'april', 'maj', 'junij', 'julij', 'avgust', 'september', 'oktober', 'november', 'december'];
const WEEKDAYS = ['Pon', 'Tor', 'Sre', 'Čet', 'Pet', 'Sob', 'Ned'];
// Per-operator color for the calendar. A fixed palette hashed by operator id
// (the old approach) can put two different operators in the same bucket —
// with only ~10 buckets that's a near-certain collision once there are more
// than a handful of operators, which is exactly what happened (Janez, Blaž
// and a third operator all landed on the same slot). Guarantee distinctness
// instead: give every *eligible* operator its own evenly-spaced hue around
// the color wheel (360° / operator count), assigned once the roster is
// loaded — so as long as two operators have different ids, they get
// different hues, no collision possible regardless of headcount.
let operatorHueById = new Map();
function assignOperatorColors() {
  operatorHueById = new Map();
  const sorted = [...eligibleOperators].sort((a, b) => a.id.localeCompare(b.id)); // stable order across reloads, independent of name
  const total = sorted.length;
  sorted.forEach((op, index) => operatorHueById.set(op.id, Math.round((index * 360) / Math.max(total, 1))));
}
function operatorColor(key) {
  if (key === 'none' || !operatorHueById.has(key)) return '#9AA3B2';
  return `hsl(${operatorHueById.get(key)}, 65%, 45%)`;
}
function operatorBackground(key) {
  if (key === 'none' || !operatorHueById.has(key)) return '#eef0f4';
  return `hsl(${operatorHueById.get(key)}, 65%, 88%)`;
}

let orders = [];
let planningLoaded = false;
let planEntries = [];
// The full "eligible izvajalec" roster (same list Izvajalci/order-creation
// use), not just operators who happen to have an open order right now —
// so the filter still lets you pick someone with zero current orders.
let eligibleOperators = [];
let selectedPlanId = null;
let selectedOperators = new Set();
let calendarDate = new Date();

const els = {
  tab: document.getElementById('tabPlaniranje'),
  cards: document.getElementById('workOrderCards'),
  count: document.getElementById('planningCount'),
  hint: document.getElementById('planningHint'),
  title: document.getElementById('calendarTitle'),
  grid: document.getElementById('calendarGrid'),
  prev: document.getElementById('calendarPrev'),
  next: document.getElementById('calendarNext'),
  today: document.getElementById('calendarToday'),
  from: document.getElementById('calendarFrom'),
  to: document.getElementById('calendarTo'),
  operatorFilterButton: document.getElementById('operatorFilterButton'),
  operatorFilterMenu: document.getElementById('operatorFilterMenu'),
};

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function firstCalendarDay(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const weekday = (first.getDay() + 6) % 7;
  return addDays(first, -weekday);
}

function formatArea(area) {
  const number = Number(area);
  if (!Number.isFinite(number)) return '—';
  return `${new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 2 }).format(number)} ha`;
}

// The plannable unit is a delovni_nalogi_gerki *line* (its own id), not a
// fields row — a compound "A+B+C" GERK code is one line/one checkbox, same
// as everywhere else in the app (get_work_order_gerk_shapes etc.).
function normalizeGerkLine(link) {
  return {
    id: link.id,
    code: link.gerk_code,
    // kolicina_ha, not fields.area_ha — same source the main Delovni
    // Nalogi list uses (loadWorkOrders() in app.js), so totals match.
    area: link.kolicina_ha ?? null,
  };
}

function normalizeOrder(row, operatorNames, segmentCountById) {
  const izvajalecId = row.izvajalec || null;
  const izvajalecKey = izvajalecId || 'none';
  const izvajalecName = izvajalecId ? (operatorNames.get(izvajalecId) ?? 'Neznan izvajalec') : 'Ni izvajalca';
  return {
    id: row.id,
    stevilka: row.stevilka || '—',
    customerName: row.customers?.naziv || row.customers?.company_name || 'Brez stranke',
    izvajalecKey,
    izvajalecName,
    segmentCount: segmentCountById.get(row.id) ?? 0,
    gerkLines: (row.delovni_nalogi_gerki ?? []).map(normalizeGerkLine),
  };
}

function getOrder(id) { return orders.find(order => String(order.id) === String(id)); }

function matchesOperator(order) {
  return !selectedOperators.size || selectedOperators.has(order.izvajalecKey);
}

function renderOperatorFilter() {
  // Same roster as everywhere else in the app (profiles.eligible_izvajalec),
  // not just whoever happens to have an open order right now — plus "Ni
  // izvajalca" for unassigned orders, which are a normal, common case.
  const entries = [
    ['none', 'Ni izvajalca'],
    ...eligibleOperators
      .map(op => [op.id, op.name])
      .sort((left, right) => left[1].localeCompare(right[1], 'sl')),
  ];
  const validKeys = new Set(entries.map(([key]) => key));
  selectedOperators = new Set([...selectedOperators].filter(key => validKeys.has(key)));
  els.operatorFilterMenu.innerHTML = entries.map(([key, name]) => `<label class="operator-filter-option">
    <input type="checkbox" value="${esc(key)}" ${selectedOperators.has(key) ? 'checked' : ''} />
    <span>${esc(name)}</span>
  </label>`).join('');
  els.operatorFilterButton.textContent = selectedOperators.size ? `${selectedOperators.size} izbranih` : 'Vsi izvajalci';
}

async function loadPlanningData() {
  if (planningLoaded) return;
  planningLoaded = true;
  els.hint.textContent = 'Nalaganje delovnih nalogov ...';

  // Same scope as the main Delovni Nalogi list's default view: every
  // non-archived order, any status (that list has no server-side status
  // filter either — see loadWorkOrders()/filteredWorkOrders() in app.js).
  // Orders with nothing left to schedule simply won't produce a card, via
  // the unplannedGerkLines() check in renderCards() below.
  const [ordersRes, profilesRes, segmentCountsRes] = await Promise.all([
    supabase
      .from('delovni_nalogi')
      .select('id, stevilka, izvajalec, customers(naziv, company_name), delovni_nalogi_gerki(id, gerk_code, kolicina_ha)')
      .is('deleted_at', null),
    supabase.from('profiles').select('id, full_name, eligible_izvajalec'),
    supabase.rpc('get_work_orders_segment_counts'),
  ]);

  if (ordersRes.error) {
    els.hint.textContent = 'Delovnih nalogov ni mogoče prebrati.';
    els.cards.innerHTML = `<div class="planning-error">${esc(ordersRes.error.message)}</div>`;
    return;
  }

  const rows = ordersRes.data ?? [];
  const profiles = profilesRes.data ?? [];
  const operatorNames = new Map(profiles.map(p => [p.id, p.full_name || 'Brez imena']));
  eligibleOperators = profiles
    .filter(p => p.eligible_izvajalec)
    .map(p => ({ id: p.id, name: p.full_name || 'Brez imena' }));
  assignOperatorColors();
  renderOperatorFilter();

  const segmentCountById = new Map((segmentCountsRes.data ?? []).map(r => [r.delovni_nalog_id, Number(r.segment_count)]));

  orders = rows.map(row => normalizeOrder(row, operatorNames, segmentCountById));

  await loadPlanEntries();

  els.hint.textContent = orders.length ? 'Povlecite nalog na dan v koledarju.' : 'Ni odprtih delovnih nalogov.';
  renderAll();
}

async function loadPlanEntries() {
  const { data: plans, error } = await supabase
    .from('delovni_nalogi_planiranje')
    .select('id, delovni_nalog_id, plan_date, delovni_nalogi_planiranje_gerki(delovni_nalog_gerk_id)');

  planEntries = error ? [] : (plans ?? []).map(plan => ({
    id: plan.id,
    orderId: plan.delovni_nalog_id,
    date: plan.plan_date,
    gerkLineIds: new Set((plan.delovni_nalogi_planiranje_gerki ?? []).map(item => item.delovni_nalog_gerk_id)),
  }));
}

// Bridge for app.js — editing the "Planirano" date directly in the work-
// order detail popup (opened via window.openWorkOrderDetailById) writes to
// delovni_nalogi_planiranje from over there; this re-syncs our own cached
// planEntries afterward so the calendar reflects it without a full reload.
window.refreshPlanningEntries = async function () {
  await loadPlanEntries();
  renderAll();
};

// Bridge for app.js — reassigning the izvajalec from the work-order detail
// popup's own dropdown (woIzvajalecEdit) writes straight to delovni_nalogi
// from over there, bypassing our cached `orders` array entirely. Without
// this, the calendar/cards kept showing the old operator's name and color
// until a full page reload (loadPlanningData() only ever runs once per
// session — see `planningLoaded`). Mirrors what reassignOperator() already
// does to its own local cache after its own write, just triggered from the
// other module instead of our own <select>.
window.refreshPlanningOrderOperator = function (orderId, izvajalecId) {
  const order = getOrder(orderId);
  if (!order) return;
  order.izvajalecKey = izvajalecId || 'none';
  order.izvajalecName = izvajalecId
    ? (eligibleOperators.find(op => op.id === izvajalecId)?.name ?? 'Neznan izvajalec')
    : 'Ni izvajalca';
  renderOperatorFilter();
  renderAll();
};

function entriesForOrder(order) { return planEntries.filter(entry => String(entry.orderId) === String(order.id)); }
function plannedGerkLineIds(order) {
  return new Set(entriesForOrder(order).flatMap(entry => [...entry.gerkLineIds]));
}
function unplannedGerkLines(order) {
  const planned = plannedGerkLineIds(order);
  return order.gerkLines.filter(line => !planned.has(line.id));
}
function gerkLinesForEntry(order, entry) {
  const selected = entry?.gerkLineIds ?? new Set();
  return order.gerkLines.filter(line => selected.has(line.id));
}
function operatorOptionsHtml(selectedKey) {
  const options = [['none', 'Ni izvajalca'], ...eligibleOperators.map(op => [op.id, op.name])];
  return options.map(([key, name]) =>
    `<option value="${esc(key)}" ${key === selectedKey ? 'selected' : ''}>${esc(name)}</option>`
  ).join('');
}

function renderCards() {
  const available = orders
    .filter(order => matchesOperator(order) && unplannedGerkLines(order).length > 0)
    .sort((left, right) => (Number(right.stevilka) || 0) - (Number(left.stevilka) || 0));
  els.count.textContent = String(available.length);
  els.cards.innerHTML = available.map(order => {
    // Same numbers as the main Delovni Nalogi list (loadWorkOrders() in
    // app.js) — the WHOLE order's GERK count/total ha, not just what's
    // still unplanned, so a card's stats match what's shown everywhere else.
    const totalHa = order.gerkLines.reduce((sum, line) => sum + (Number(line.area) || 0), 0);
    const haStr = totalHa > 0 ? formatArea(totalHa) : '—'; // same > 0 ? … : '—' convention as loadWorkOrders() in app.js
    // Left border uses the same per-operator color as the calendar tiles
    // (operatorColor) instead of a fixed blue, so a card reads whose order
    // it is at a glance — same identity cue in both places.
    return `<article class="work-order-card" style="border-left-color:${operatorColor(order.izvajalecKey)}" draggable="true" data-order-id="${esc(order.id)}" role="listitem" tabindex="0">
      <div class="work-order-card-head">
        <h3>${esc(order.stevilka)} – ${esc(order.customerName)}</h3>
      </div>
      <div class="work-order-card-meta">${order.gerkLines.length} GERK · ${order.segmentCount} segm. · ${haStr}</div>
      <select class="card-operator-select" draggable="false" data-order-id="${esc(order.id)}">${operatorOptionsHtml(order.izvajalecKey)}</select>
    </article>`;
  }).join('');

  els.cards.querySelectorAll('.work-order-card').forEach(card => {
    card.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', `order:${card.dataset.orderId}`));
    card.addEventListener('dblclick', () => window.openWorkOrderDetailById(card.dataset.orderId));
    card.addEventListener('keydown', event => {
      if (event.target !== card) return; // let the operator <select> handle its own keys
      if (event.key === 'Enter' || event.key === ' ') window.openWorkOrderDetailById(card.dataset.orderId);
    });
  });
  els.cards.querySelectorAll('.card-operator-select').forEach(select => {
    // Stop the card's own drag/dblclick from hijacking normal <select> use.
    select.addEventListener('mousedown', event => event.stopPropagation());
    select.addEventListener('click', event => event.stopPropagation());
    select.addEventListener('change', () => reassignOperator(select.dataset.orderId, select.value));
  });
}

async function reassignOperator(orderId, izvajalecKey) {
  const order = getOrder(orderId);
  if (!order) return;
  const izvajalecId = izvajalecKey === 'none' ? null : izvajalecKey;
  const { error } = await supabase.from('delovni_nalogi').update({ izvajalec: izvajalecId }).eq('id', orderId);
  if (error) {
    els.hint.textContent = `Sprememba izvajalca ni uspela: ${error.message}`;
    return;
  }
  order.izvajalecKey = izvajalecKey;
  order.izvajalecName = izvajalecId
    ? (eligibleOperators.find(op => op.id === izvajalecId)?.name ?? 'Neznan izvajalec')
    : 'Ni izvajalca';
  renderOperatorFilter();
  renderAll();
}

function renderCalendar() {
  const fromDate = els.from.value || null;
  const toDate = els.to.value || null;
  const displayStart = fromDate ? parseDate(fromDate) : firstCalendarDay(calendarDate);
  const year = displayStart.getFullYear();
  const month = displayStart.getMonth();
  els.title.textContent = `${MONTHS[month]} ${year}`;
  const leadingDays = fromDate ? (displayStart.getDay() + 6) % 7 : 0;
  const today = localDate();
  let html = WEEKDAYS.map(day => `<div class="calendar-weekday">${day}</div>`).join('');
  html += Array.from({ length: leadingDays }, () => '<div class="calendar-day calendar-day--blank" aria-hidden="true"></div>').join('');

  for (let index = 0; index < 42 - leadingDays; index++) {
    const date = addDays(displayStart, index);
    const iso = localDate(date);
    const inRange = (!fromDate || iso >= fromDate) && (!toDate || iso <= toDate);
    const dayEntries = planEntries.filter(entry => {
      const order = getOrder(entry.orderId);
      return entry.date === iso && entry.gerkLineIds.size > 0 && order && matchesOperator(order);
    });
    const classes = ['calendar-day'];
    if (date.getMonth() !== month) classes.push('is-outside');
    if (iso === today) classes.push('is-today');
    if (!inRange) classes.push('is-out-of-range');
    html += `<div class="${classes.join(' ')}" data-date="${iso}" role="gridcell">
      <span class="calendar-day-number">${date.getDate()}</span>
      <div class="calendar-day-orders">${dayEntries.map(renderCalendarOrder).join('')}</div>
    </div>`;
  }
  els.grid.innerHTML = html;
  els.grid.querySelectorAll('.calendar-day').forEach(day => {
    day.addEventListener('dragover', event => { event.preventDefault(); day.classList.add('is-drop-target'); });
    day.addEventListener('dragleave', () => day.classList.remove('is-drop-target'));
    day.addEventListener('drop', event => {
      event.preventDefault();
      day.classList.remove('is-drop-target');
      const transfer = event.dataTransfer.getData('text/plain');
      if (transfer.startsWith('plan:')) movePlan(transfer.slice(5), day.dataset.date);
      if (transfer.startsWith('order:')) placeOrder(transfer.slice(6), day.dataset.date);
    });
  });
  els.grid.querySelectorAll('.calendar-order').forEach(card => {
    card.addEventListener('click', () => selectCalendarOrder(card));
    card.addEventListener('dblclick', () => window.openWorkOrderDetailById(card.dataset.orderId, card.dataset.planId));
    card.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', `plan:${card.dataset.planId}`));
  });
  els.grid.querySelectorAll('.calendar-order-remove').forEach(btn => {
    // Explicit, visible unschedule action — not just right-click/Delete,
    // which aren't discoverable (and right-click doesn't exist on mobile).
    btn.addEventListener('click', event => {
      event.stopPropagation();
      removeOrderFromCalendar(btn.closest('.calendar-order').dataset.planId);
    });
  });
}

// Just the operator and the order number/customer name for this entry. The
// whole tile's background is the operator's pastel color (operatorBackground)
// so whose work is whose reads at a glance without opening anything; the dot
// repeats it in the solid palette shade for a sharper swatch. Scheduling
// progress (complete/partial) moved to a left accent stripe (is-complete/
// is-partial in style.css) since the fill is now taken by the operator
// color. The hover tooltip mirrors the same two lines shown on the tile
// (not GERK codes — those aren't shown here anymore, so the tooltip
// shouldn't show them either) in case the tile is too narrow to read in full.
function renderCalendarOrder(entry) {
  const sourceOrder = getOrder(entry.orderId);
  const lines = sourceOrder ? gerkLinesForEntry(sourceOrder, entry) : [];
  const complete = sourceOrder ? lines.length === sourceOrder.gerkLines.length : false;
  const izvajalecKey = sourceOrder?.izvajalecKey ?? 'none';
  const color = operatorColor(izvajalecKey);
  const bg = operatorBackground(izvajalecKey);
  const izvajalecName = sourceOrder?.izvajalecName ?? 'Ni izvajalca';
  const orderLabel = sourceOrder ? `${sourceOrder.stevilka} – ${sourceOrder.customerName}` : 'Delovni nalog';
  return `<div class="calendar-order ${complete ? 'is-complete' : 'is-partial'}" style="background:${bg}" draggable="true" data-order-id="${esc(entry.orderId)}" data-plan-id="${esc(entry.id)}" title="${esc(izvajalecName)}
${esc(orderLabel)}">
    <button class="calendar-order-remove" type="button" aria-label="Odstrani z datuma" title="Odstrani z datuma">✕</button>
    <span class="calendar-order-name"><span class="calendar-order-dot" style="background:${color}"></span>${esc(izvajalecName)}</span>
    <span class="calendar-order-sub">${esc(orderLabel)}</span>
  </div>`;
}

function selectCalendarOrder(card) {
  els.grid.querySelectorAll('.calendar-order.is-selected').forEach(item => item.classList.remove('is-selected'));
  card.classList.add('is-selected');
  selectedPlanId = card.dataset.planId;
}

async function placeOrder(orderId, date) {
  const order = getOrder(orderId);
  if (!order) return;
  const selectedIds = unplannedGerkLines(order).map(line => line.id);
  if (!selectedIds.length) return;
  await savePlan({ orderId: order.id, date, gerkLineIds: new Set(selectedIds) });
  renderAll();
}

async function movePlan(planId, date) {
  const entry = planEntries.find(item => String(item.id) === String(planId));
  if (!entry || entry.date === date) return;
  const { error } = await supabase
    .from('delovni_nalogi_planiranje')
    .update({ plan_date: date })
    .eq('id', entry.id);
  if (error) {
    els.hint.textContent = `Premik ni uspel: ${error.message}`;
    return;
  }
  entry.date = date;
  renderAll();
}

async function savePlan(entry) {
  const { data: plan, error } = await supabase
    .from('delovni_nalogi_planiranje')
    .insert({ delovni_nalog_id: entry.orderId, plan_date: entry.date })
    .select('id')
    .single();
  if (error) {
    els.hint.textContent = `Shranjevanje ni uspelo: ${error.message}`;
    return false;
  }
  const selected = [...entry.gerkLineIds].map(id => ({ plan_id: plan.id, delovni_nalog_gerk_id: id }));
  if (selected.length) await supabase.from('delovni_nalogi_planiranje_gerki').insert(selected);
  planEntries.push({ id: plan.id, orderId: entry.orderId, date: entry.date, gerkLineIds: new Set(entry.gerkLineIds) });
  return true;
}

async function removeOrderFromCalendar(planId) {
  const entry = planEntries.find(item => String(item.id) === String(planId));
  if (!entry) return;
  const { error } = await supabase.from('delovni_nalogi_planiranje').delete().eq('id', entry.id);
  if (error) {
    els.hint.textContent = `Brisanje ni uspelo: ${error.message}`;
    return;
  }
  planEntries = planEntries.filter(item => String(item.id) !== String(planId));
  renderAll();
}

function renderAll() {
  renderCards();
  renderCalendar();
}

// app.js's switchTab() owns showing/hiding #panelPlaniranje itself (same as
// the other two tabs) — this module only needs to know when it *becomes*
// visible for the first time, to lazy-load its data. A second, independent
// click listener on the same button is fine; it doesn't touch app.js's own.
els.tab.addEventListener('click', loadPlanningData);

els.prev.addEventListener('click', () => { calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1); renderCalendar(); });
els.next.addEventListener('click', () => { calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1); renderCalendar(); });
els.today.addEventListener('click', () => { calendarDate = new Date(); renderCalendar(); });
els.from.addEventListener('change', () => {
  if (els.from.value && els.to.value && els.from.value > els.to.value) els.to.value = els.from.value;
  if (els.from.value) calendarDate = parseDate(els.from.value);
  renderCalendar();
});
els.to.addEventListener('change', () => {
  if (els.from.value && els.to.value && els.to.value < els.from.value) els.from.value = els.to.value;
  renderCalendar();
});
els.operatorFilterButton.addEventListener('click', () => {
  const isOpen = !els.operatorFilterMenu.hidden;
  els.operatorFilterMenu.hidden = isOpen;
  els.operatorFilterButton.setAttribute('aria-expanded', String(!isOpen));
});
els.operatorFilterMenu.addEventListener('change', event => {
  if (!event.target.matches('input[type="checkbox"]')) return;
  if (event.target.checked) selectedOperators.add(event.target.value);
  else selectedOperators.delete(event.target.value);
  renderOperatorFilter();
  renderAll();
});
document.addEventListener('click', event => {
  if (!event.target.closest('.operator-filter')) {
    els.operatorFilterMenu.hidden = true;
    els.operatorFilterButton.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Delete' || !selectedPlanId) return;
  if (event.target.matches('input, select, textarea')) return; // don't hijack Delete while editing a field (e.g. the Od/Do date inputs)
  removeOrderFromCalendar(selectedPlanId);
});
