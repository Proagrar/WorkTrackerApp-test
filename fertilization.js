import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { calculateSegment, organicTotals, reportText, roundHalfUp } from './fert-calc.js';

// Gnojilni načrt (admin-only tab). Own client and state, same reasoning as
// planning.js: app.js is already huge and only needs to show/hide
// #panelGnojilni. Sub-views: Načrti (next step), Analize tal (lab results +
// Excel import), Nastavitve (read-only view of the fert_* settings tables).
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// SheetJS, loaded only when an import actually starts — a CDN hiccup must
// never break the rest of the tab (or the app). cdn.sheetjs.com is the
// official distribution; the npm "xlsx" package stopped at 0.18.5.
const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
let XLSX = null;
async function loadSheetJs() {
  if (!XLSX) XLSX = await import(SHEETJS_URL);
  return XLSX;
}

const els = {
  tab: document.getElementById('tabGnojilni'),
  subnavBtns: [...document.querySelectorAll('.fert-subnav-btn')],
  views: {
    plans: document.getElementById('fertViewPlans'),
    lab: document.getElementById('fertViewLab'),
    import: document.getElementById('fertViewImport'),
    settings: document.getElementById('fertViewSettings'),
    wizard: document.getElementById('fertViewWizard'),
  },
  newPlanBtn: document.getElementById('fertNewPlanBtn'),
  planSearch: document.getElementById('fertPlanSearch'),
  planStatus: document.getElementById('fertPlanStatus'),
  planRows: document.getElementById('fertPlanRows'),
  importOpenBtn: document.getElementById('fertImportOpenBtn'),
  importBackBtn: document.getElementById('fertImportBackBtn'),
  importFiles: document.getElementById('fertImportFiles'),
  importFolder: document.getElementById('fertImportFolder'),
  importNameFilter: document.getElementById('fertImportNameFilter'),
  dropzone: document.getElementById('fertDropzone'),
  importPreview: document.getElementById('fertImportPreview'),
  labSearch: document.getElementById('fertLabSearch'),
  labMode: document.getElementById('fertLabMode'),
  labNotice: document.getElementById('fertLabNotice'),
  labHead: document.getElementById('fertLabHead'),
  labRows: document.getElementById('fertLabRows'),
  settingsBody: document.getElementById('fertSettingsBody'),
};

// Default name filter: the lab's own result files for the current season
// ("Proagrar d.o.o._21.10.2026.xlsx"); the shared LAB RESULTS folder also
// holds other labs' and older years' files.
els.importNameFilter.value = `proagrar ${new Date().getFullYear()}`;

let currentView = 'plans';
let labResults = [];
let labLoaded = false;
let labMode = 'linked';   // Analize tal: 'linked' (default) | 'unlinked'
let labPlans = new Map(); // delovni_nalog_gerk_id → newest live plan; null = failed to load
let settingsLoaded = false;
let pendingImport = null; // { files: [...parsed] } between preview and confirm
let labFlash = '';        // one-shot success message shown above the list after an import

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const numFmt = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 3 });
function fmtNum(value) {
  return value == null || value === '' ? '—' : numFmt.format(Number(value));
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
}
function customerName(c) {
  return c ? (c.naziv || c.company_name || '—') : '—';
}

// PostgREST returns at most 1000 rows per request (Supabase's max-rows), so
// anything that can grow past that (lab results: 3220 after the first import)
// is fetched page by page. `build` must return a fresh, ordered query each call.
async function fetchAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return { data: rows, error: null };
  }
}

// ── Sub-navigation ───────────────────────────────────────────
function showView(view) {
  if (view !== 'lab') labFlash = '';
  currentView = view;
  // Uvoz is a sub-screen of Analize tal, the wizard one of Načrti
  const navView = view === 'import' ? 'lab' : view === 'wizard' ? 'plans' : view;
  for (const btn of els.subnavBtns) {
    const active = btn.dataset.fertView === navView;
    btn.classList.toggle('fert-subnav-btn--active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  for (const [name, el] of Object.entries(els.views)) el.hidden = name !== view;
  els.importOpenBtn.hidden = view !== 'lab';
  els.newPlanBtn.hidden = view !== 'plans';
  if (view === 'lab') {
    if (!labLoaded) loadLabResults();
    else loadLabPlans().then(renderLabResults); // a plan may have been made or confirmed meanwhile
  }
  if (view === 'settings' && !settingsLoaded) loadSettings();
  if (view === 'plans') loadPlans();
}

for (const btn of els.subnavBtns) btn.addEventListener('click', () => {
  if (currentView === 'wizard' && !confirmLeaveWizard()) return;
  showView(btn.dataset.fertView);
});
// app.js's switchTab() shows/hides #panelGnojilni itself; this only needs to
// know the tab was opened, to (re)load whichever sub-view is showing.
els.tab.addEventListener('click', () => showView(currentView));

// ── Analize tal: list ────────────────────────────────────────
// Read in the order the work flows (Matej, 2026-10-29): work order → GERK
// segment (sample) → lab analysis → gnojilni načrt. By default only results
// linked to a work-order sample are listed — most lab rows (pre-app sample
// numbers, other customers) never link and would bury the useful ones; they
// stay reachable under Prikaz: Nepovezani for manual linking.
async function loadLabResults() {
  els.labRows.innerHTML = `<tr><td colspan="${labColumns().length}" class="fert-empty">Nalaganje …</td></tr>`;
  const [{ data, error }] = await Promise.all([
    fetchAll(() => supabase
      .from('lab_soil_result')
      .select('id, sample_no, lab_sample_code, ph_kcl, p2o5, k2o, humus_pct, mg, raw_values, notes, analysis_date, created_at, vzorec_id, '
        + 'lab_import_file(file_name, imported_at), '
        + 'delovni_nalogi_vzorci(id, sample_no, delovni_nalogi_gerki(id, gerk_code, field_id, fields(name), delovni_nalogi(stevilka, customers(id, naziv, company_name))))')
      .order('created_at', { ascending: false })
      .order('id')),
    loadLabPlans(),
  ]);
  if (error) {
    els.labRows.innerHTML = `<tr><td colspan="${labColumns().length}" class="fert-empty fert-error">Napaka pri nalaganju: ${esc(error.message)}</td></tr>`;
    return;
  }
  labResults = data ?? [];
  labLoaded = true;
  renderLabResults();
}

// Newest live plan per GERK line of a work order (one plan per field, dated —
// copies make several, the list shows the latest). null = plans couldn't load.
async function loadLabPlans() {
  const { data, error } = await supabase
    .from('fert_plan')
    .select('id, status, plan_date, created_at, delovni_nalog_gerk_id')
    .is('deleted_at', null)
    .not('delovni_nalog_gerk_id', 'is', null)
    .order('plan_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) { labPlans = null; return; }
  labPlans = new Map();
  for (const p of data ?? []) if (!labPlans.has(p.delovni_nalog_gerk_id)) labPlans.set(p.delovni_nalog_gerk_id, p);
}

const labGerk = r => r.delovni_nalogi_vzorci?.delovni_nalogi_gerki;
const labPlan = r => labPlans?.get(labGerk(r)?.id) ?? null;

// raw text wins for display when the lab wrote a qualifier ("<25"), so the
// list shows what the lab reported, not just the number used in calculations
function labValueCell(row, key, header) {
  const raw = row.raw_values?.[header];
  const shown = raw != null && /[<>]/.test(String(raw)) ? String(raw) : fmtNum(row[key]);
  return `<td class="fert-num">${esc(shown)}</td>`;
}
const noCodeBadge = r => (r.notes || '').includes(NO_CODE_NOTE)
  ? ` <span class="fert-badge" title="${esc(NO_CODE_NOTE)}">Brez lab. kode</span>` : '';

function labPlanCell(r) {
  if (!labPlans) return '<td class="fert-muted">—</td>';
  const p = labPlan(r);
  if (!p) return `<td class="fert-row-actions"><button type="button" class="btn btn-secondary btn-sm" data-lab-plan-new="${esc(r.id)}">+ Ustvari</button></td>`;
  const badge = p.status === 'potrjeno'
    ? '<span class="fert-badge fert-badge--ok">Potrjeno</span>'
    : '<span class="fert-badge fert-badge--warn">Osnutek</span>';
  return `<td class="fert-row-actions">${badge} <span class="fert-muted">${esc(fmtDate(p.plan_date))}</span>
    <button type="button" class="btn btn-secondary btn-sm" data-lab-plan-open="${esc(p.id)}">Odpri</button></td>`;
}

// Column order = table order. `value` feeds the sort: numbers sort as
// numbers, text with natural number order ("9087" < "12613"); empty values
// always go last, whichever direction. Same click behavior as the work-order
// list header (first click ▲ ascending, second ▼ descending).
const LAB_VALUE_COLUMNS = [
  { key: 'ph',    label: 'pH (KCl)', value: r => r.ph_kcl,    num: true, render: r => labValueCell(r, 'ph_kcl', 'pH (KCl)') },
  { key: 'p2o5',  label: 'P₂O₅',     value: r => r.p2o5,      num: true, render: r => labValueCell(r, 'p2o5', 'P2O5') },
  { key: 'k2o',   label: 'K₂O',      value: r => r.k2o,       num: true, render: r => labValueCell(r, 'k2o', 'K2O') },
  { key: 'humus', label: 'Humus %',  value: r => r.humus_pct, num: true, render: r => `<td class="fert-num">${esc(fmtNum(r.humus_pct))}</td>` },
  { key: 'mg',    label: 'Mg',       value: r => r.mg,        num: true, render: r => `<td class="fert-num">${esc(fmtNum(r.mg))}</td>` },
  { key: 'date',  label: 'Datum analize', value: r => r.analysis_date, render: r => `<td>${esc(fmtDate(r.analysis_date))}</td>` },
  { key: 'file',  label: 'Datoteka', value: r => r.lab_import_file?.file_name,
    render: r => `<td class="fert-muted" title="${esc(r.lab_import_file ? 'Uvoženo ' + fmtDate(r.lab_import_file.imported_at) : '')}">${esc(r.lab_import_file?.file_name ?? '—')}</td>` },
];
const LAB_LINKED_COLUMNS = [
  { key: 'order',    label: 'Nalog',  value: r => labGerk(r)?.delovni_nalogi?.stevilka, render: r => `<td>${esc(labGerk(r)?.delovni_nalogi?.stevilka ?? '—')}</td>` },
  { key: 'customer', label: 'Stranka', value: r => customerName(labGerk(r)?.delovni_nalogi?.customers),
    render: r => `<td class="fert-strong">${esc(customerName(labGerk(r)?.delovni_nalogi?.customers))}</td>` },
  { key: 'gerk',     label: 'GERK',   value: r => labGerk(r)?.gerk_code, render: r => `<td>${esc(labGerk(r)?.gerk_code ?? '—')}</td>` },
  { key: 'sample',   label: 'Vzorec', value: r => r.sample_no,
    render: r => `<td class="fert-strong" title="${esc(r.lab_sample_code ? 'Lab. koda ' + r.lab_sample_code : '')}">${esc(r.sample_no)}${noCodeBadge(r)}</td>` },
  ...LAB_VALUE_COLUMNS,
  { key: 'plan',     label: 'Gnojilni načrt', value: r => labPlan(r) ? `${labPlan(r).status === 'potrjeno' ? 'a' : 'b'}${labPlan(r).plan_date}` : null, render: labPlanCell },
];
const LAB_UNLINKED_COLUMNS = [
  { key: 'sample', label: 'Vzorec', value: r => r.sample_no, render: r => `<td class="fert-strong">${esc(r.sample_no)}</td>` },
  { key: 'code',   label: 'Lab. koda', value: r => r.lab_sample_code, render: r => `<td class="fert-muted">${esc(r.lab_sample_code ?? '—')}</td>` },
  ...LAB_VALUE_COLUMNS,
  { key: 'state',  label: 'Stanje', value: r => labMatchState(r),
    render: r => `<td class="fert-state"><span class="fert-badge fert-badge--warn">${labMatchState(r) === 'multiple' ? 'Več zadetkov' : 'Ni povezan'}</span>
      <button type="button" class="btn btn-secondary btn-sm fert-link-btn" data-link-id="${esc(r.id)}">Poveži</button>${noCodeBadge(r)}</td>` },
];
const labColumns = () => labMode === 'unlinked' ? LAB_UNLINKED_COLUMNS : LAB_LINKED_COLUMNS;

let labSortKey = 'sample'; // default: Vzorec, newest (highest) sample number first (Matej, 2026-10-29)
let labSortDir = 'desc';
const textCollator = new Intl.Collator('sl', { numeric: true, sensitivity: 'base' });

function sortLabRows(rows) {
  const col = labColumns().find(c => c.key === labSortKey);
  if (!col) return rows;
  const dir = labSortDir === 'asc' ? 1 : -1;
  return rows
    .map(r => ({ r, v: col.value(r) }))
    .sort((a, b) => {
      const aEmpty = a.v == null || a.v === '', bEmpty = b.v == null || b.v === '';
      if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
      return dir * (col.num ? Number(a.v) - Number(b.v) : textCollator.compare(String(a.v), String(b.v)));
    })
    .map(x => x.r);
}

function renderLabHead() {
  els.labHead.innerHTML = labColumns().map(col => {
    const active = labSortKey === col.key;
    const arrow = active ? (labSortDir === 'asc' ? ' ▲' : ' ▼') : '';
    const ariaSort = active ? (labSortDir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th class="${col.num ? 'fert-num' : ''}" aria-sort="${ariaSort}">`
      + `<button type="button" class="fert-sort-btn${active ? ' fert-sort-btn--active' : ''}" data-sort="${col.key}">${col.label}${arrow}</button></th>`;
  }).join('');
}

els.labHead.addEventListener('click', event => {
  const btn = event.target.closest('[data-sort]');
  if (!btn) return;
  const key = btn.dataset.sort;
  labSortDir = (labSortKey === key && labSortDir === 'asc') ? 'desc' : 'asc';
  labSortKey = key;
  renderLabResults();
});
renderLabHead();

function labMatchState(row) {
  if (row.vzorec_id) return 'linked';
  return (row.notes || '').includes('Več vzorcev') ? 'multiple' : 'unmatched';
}

function renderLabResults() {
  const query = els.labSearch.value.trim().toLowerCase();
  const linkedCount = labResults.filter(r => labMatchState(r) === 'linked').length;
  const unlinkedCount = labResults.length - linkedCount;
  els.labMode.options[0].textContent = `Povezani z nalogi (${linkedCount})`;
  els.labMode.options[1].textContent = `Nepovezani (${unlinkedCount})`;
  if (!labColumns().some(c => c.key === labSortKey)) { labSortKey = 'sample'; labSortDir = 'desc'; }
  renderLabHead();

  const flash = labFlash ? `<div class="fert-notice fert-notice--ok">${esc(labFlash)}</div>` : '';
  els.labNotice.innerHTML = flash + (labMode === 'unlinked'
    ? `<div class="fert-notice fert-notice--warn"><strong>${unlinkedCount} ${unlinkedCount === 1 ? 'rezultat ni povezan' : 'rezultatov ni povezanih'} z vzorcem.</strong> Številka vzorca iz laboratorija se ne ujema z natanko enim vzorcem v delovnih nalogih — preveri številko ali poveži ročno.</div>`
    : (unlinkedCount ? `<p class="fert-hint">${unlinkedCount} ${unlinkedCount === 1 ? 'rezultat ni povezan' : 'rezultatov ni povezanih'} z vzorcem iz delovnega naloga — niso prikazani (Prikaz: Nepovezani).</p>` : '')
      + (labPlans ? '' : '<div class="fert-notice fert-notice--warn">Gnojilnih načrtov ni bilo mogoče naložiti.</div>'));

  const rows = labResults.filter(r => {
    if ((labMatchState(r) === 'linked') !== (labMode === 'linked')) return false;
    if (!query) return true;
    const g = labGerk(r);
    const hay = [r.sample_no, r.lab_sample_code, g?.gerk_code, customerName(g?.delovni_nalogi?.customers), g?.delovni_nalogi?.stevilka, r.lab_import_file?.file_name].join(' ').toLowerCase();
    return hay.includes(query);
  });

  const cols = labColumns();
  if (!rows.length) {
    const empty = !labResults.length ? 'Še ni uvoženih rezultatov — klikni ⬆ Uvoz Excel.'
      : query ? 'Ni zadetkov.'
      : labMode === 'linked' ? 'Noben rezultat še ni povezan z vzorcem iz delovnega naloga.' : 'Vsi rezultati so povezani z vzorci.';
    els.labRows.innerHTML = `<tr><td colspan="${cols.length}" class="fert-empty">${empty}</td></tr>`;
    return;
  }
  els.labRows.innerHTML = sortLabRows(rows)
    .map(r => `<tr data-row-id="${esc(r.id)}">${cols.map(c => c.render(r)).join('')}</tr>`)
    .join('');
}

els.labSearch.addEventListener('input', renderLabResults);
els.labMode.addEventListener('change', () => { labMode = els.labMode.value; renderLabResults(); });

// Manual link: list every sample carrying this number and let the admin pick.
els.labRows.addEventListener('click', async event => {
  const btn = event.target.closest('[data-link-id]');
  if (btn) return openLinkPicker(btn.dataset.linkId, btn.closest('td'));
  const pick = event.target.closest('[data-pick-vzorec]');
  if (pick) return linkLabResult(pick.dataset.resultId, pick.dataset.pickVzorec);
  const openBtn = event.target.closest('[data-lab-plan-open]');
  if (openBtn) return openPlan(openBtn.dataset.labPlanOpen, { copy: false });
  const newBtn = event.target.closest('[data-lab-plan-new]');
  if (newBtn) {
    // new plan for this row's GERK line — the wizard opens on step 1 with
    // customer and GERK already chosen
    const g = labGerk(labResults.find(r => r.id === newBtn.dataset.labPlanNew) ?? {});
    const c = g?.delovni_nalogi?.customers;
    if (!g || !c) return;
    return startNewPlan({ customer_id: c.id, customer_name: customerName(c), delovni_nalog_gerk_id: g.id,
      gerk_code: g.gerk_code, field_id: g.field_id, field_name: g.fields?.name ?? null });
  }
});

async function openLinkPicker(resultId, cellEl) {
  const result = labResults.find(r => r.id === resultId);
  if (!result) return;
  cellEl.innerHTML = '<span class="fert-muted">Iskanje vzorcev …</span>';
  const { data, error } = await supabase
    .from('delovni_nalogi_vzorci')
    .select('id, sample_no, delovni_nalogi_gerki(gerk_code, delovni_nalogi(stevilka, customers(naziv, company_name)))')
    .eq('sample_no', result.sample_no);
  if (error) { cellEl.innerHTML = `<span class="fert-error">${esc(error.message)}</span>`; return; }
  if (!data?.length) {
    cellEl.innerHTML = `<span class="fert-badge fert-badge--warn">Ni vzorca št. ${esc(result.sample_no)}</span>`;
    return;
  }
  cellEl.innerHTML = '<div class="fert-pick-list">' + data.map(v => {
    const g = v.delovni_nalogi_gerki;
    const label = `Nalog ${g?.delovni_nalogi?.stevilka ?? '?'} · ${customerName(g?.delovni_nalogi?.customers)} · GERK ${g?.gerk_code ?? '?'}`;
    return `<button type="button" class="btn btn-secondary btn-sm" data-pick-vzorec="${esc(v.id)}" data-result-id="${esc(resultId)}">${esc(label)}</button>`;
  }).join('') + '</div>';
}

async function linkLabResult(resultId, vzorecId) {
  const { error } = await supabase.from('lab_soil_result').update({ vzorec_id: vzorecId, notes: null }).eq('id', resultId);
  if (error) { alert('Povezava ni uspela: ' + error.message); return; }
  await loadLabResults();
}

// ── Uvoz: parsing ────────────────────────────────────────────
// Lab exports come in two header variants (seen across the 2024–2026 files):
// MINTASZAM/MINTAAZONO (header on row 1) or SamplePartnerCode/ClientSampleCode
// (header on row 2). Headers are matched loosely (case, accents, punctuation
// ignored) so "Össz.só" and "Össz,só" are the same column.
function normHeader(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}
const CODE_HEADERS = { mintaszam: 'hu', samplepartnercode: 'en' };
const SAMPLE_HEADERS = { mintaazono: 'hu', clientsamplecode: 'en' };
// Hungarian and English header names both occur (2026 files: "pH (KCl)/KA/
// Humusz/Össz.só" or "pH KCl/Plasticity/Humus/Soluble salts"). Columns not
// listed here (e.g. "B") are still kept in raw_values.
const VALUE_COLUMNS = {
  phkcl: 'ph_kcl', ph: 'ph_kcl',
  ka: 'ka', plasticity: 'ka',
  caco3: 'caco3_pct',
  humusz: 'humus_pct', humus: 'humus_pct', organicmatter: 'humus_pct',
  no2no3n: 'no3_no2_n', no3no2n: 'no3_no2_n',
  p2o5: 'p2o5', k2o: 'k2o', mg: 'mg', na: 'na', zn: 'zn', cu: 'cu', mn: 'mn',
  osszso: 'salts_pct', salts: 'salts_pct', solublesalts: 'salts_pct',
  so4s: 'so4_s', fe: 'fe',
};
// Lab files are named like "Proagrar d.o.o._21.10.2026.xlsx" — the date in
// the name is the analysis date (the sheet itself carries none).
function dateFromFileName(name) {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(name);
  if (!m) return null;
  const [, d, mo, y] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const NO_CODE_NOTE = 'Brez laboratorijske kode (združen ali dopolnjen vzorec)';
// Database column limits (numeric(p, s)) — a value outside them would make
// the whole insert fail, so it's dropped (raw text still kept) instead.
const VALUE_LIMITS = { ph_kcl: 999, ka: 999999, caco3_pct: 99999, humus_pct: 99999, salts_pct: 99999 };

// "<25" → 25 and ">60" → 60 (what the Excel calculation effectively used),
// comma decimals → dot. Anything else non-numeric ("5,3¸1", "#VALUE!", "BB",
// notes) → null; the original text always stays in raw_values.
function parseLabNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim().replace(/\s+/g, '').replace(',', '.').replace(/^(<=?|>=?|≤|≥)/, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

function cellText(cell) {
  if (!cell) return null;
  if (cell.t === 'e') return cell.w || '#ERR';
  if (cell.t === 'z') return null;
  return cell.v;
}

function parseWorkbook(workbook) {
  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    if (!ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    // find the header row within the first 10 rows
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 9); r++) {
      const headers = [];
      let codeCol = -1, sampleCol = -1, format = null;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const text = cellText(ws[XLSX.utils.encode_cell({ r, c })]);
        const key = normHeader(text);
        headers[c] = text == null ? null : String(text).trim();
        if (key in CODE_HEADERS) { codeCol = c; format = CODE_HEADERS[key]; }
        if (key in SAMPLE_HEADERS) { sampleCol = c; format = format || SAMPLE_HEADERS[key]; }
      }
      if (sampleCol < 0) continue;

      const rows = [];
      const unreadable = [];
      for (let rr = r + 1; rr <= range.e.r; rr++) {
        const sampleRaw = cellText(ws[XLSX.utils.encode_cell({ r: rr, c: sampleCol })]);
        if (sampleRaw == null || String(sampleRaw).trim() === '') continue;
        const row = { sample_no: String(sampleRaw).trim(), lab_sample_code: null, raw_values: {} };
        if (codeCol >= 0) {
          const code = cellText(ws[XLSX.utils.encode_cell({ r: rr, c: codeCol })]);
          row.lab_sample_code = code == null || String(code).trim() === '' ? null : String(code).trim();
        }
        for (let c = range.s.c; c <= range.e.c; c++) {
          const header = headers[c];
          if (!header) continue;
          const raw = cellText(ws[XLSX.utils.encode_cell({ r: rr, c })]);
          if (raw == null || raw === '') continue;
          row.raw_values[header] = String(raw);
          const column = VALUE_COLUMNS[normHeader(header)];
          if (!column) continue;
          let num = parseLabNumber(raw);
          if (num != null && VALUE_LIMITS[column] != null && Math.abs(num) > VALUE_LIMITS[column]) num = null;
          if (num == null) unreadable.push(String(raw));
          row[column] = num;
        }
        rows.push(row);
      }
      return { sheetName, format, rows, unreadable };
    }
  }
  return null;
}

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ── Uvoz: preview ────────────────────────────────────────────
// "proagrar 2026" → every word must appear in the file name (any order, any case)
function nameFilterWords() {
  return els.importNameFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

async function handleFiles(fileList) {
  const excel = [...fileList].filter(f => /\.xlsx?$/i.test(f.name) && !f.name.startsWith('~$')); // ~$ = Excel lock files in a picked folder
  const words = nameFilterWords();
  const files = excel.filter(f => words.every(w => f.name.toLowerCase().includes(w)));
  const filteredOut = excel.length - files.length;
  if (!files.length) {
    els.importPreview.innerHTML = `<div class="fert-notice fert-notice--warn">${excel.length
      ? `Nobena od ${excel.length} Excel datotek nima v imenu „${esc(words.join(' '))}“ — spremeni filter imena in izberi znova.`
      : 'V izbiri ni Excel datotek (.xlsx).'}</div>`;
    return;
  }
  els.importPreview.innerHTML = `<div class="fert-notice fert-notice--info">Branje ${files.length} ${files.length === 1 ? 'datoteke' : 'datotek'} …</div>`;
  try {
    await loadSheetJs();
  } catch (err) {
    els.importPreview.innerHTML = `<div class="fert-notice fert-notice--warn">Knjižnice za branje Excela ni bilo mogoče naložiti (${esc(err.message)}). Preveri povezavo in poskusi znova.</div>`;
    return;
  }

  const parsed = [];
  for (const file of files) {
    const entry = { name: file.name, status: 'ok', rows: [], unreadable: [], analysisDate: dateFromFileName(file.name) };
    try {
      const buffer = await file.arrayBuffer();
      entry.hash = await sha256Hex(buffer);
      const result = parseWorkbook(XLSX.read(buffer, { type: 'array' }));
      if (!result) entry.status = 'no-header';
      else Object.assign(entry, result);
    } catch (err) {
      entry.status = 'error';
      entry.error = err.message;
    }
    parsed.push(entry);
  }

  // same file picked twice in one go → keep the first
  const seenHashes = new Set();
  for (const entry of parsed) {
    if (!entry.hash) continue;
    if (seenHashes.has(entry.hash)) entry.status = 'dup-in-batch';
    seenHashes.add(entry.hash);
  }

  // already-imported files
  const hashes = parsed.filter(e => e.status === 'ok').map(e => e.hash);
  const importedByHash = new Map();
  for (const part of chunk(hashes, 100)) {
    const { data, error } = await supabase.from('lab_import_file').select('file_hash, imported_at').in('file_hash', part);
    if (error) return showImportError(error);
    for (const row of data ?? []) importedByHash.set(row.file_hash, row.imported_at);
  }
  for (const entry of parsed) {
    if (entry.status === 'ok' && importedByHash.has(entry.hash)) { entry.status = 'already'; entry.importedAt = importedByHash.get(entry.hash); }
  }

  const live = parsed.filter(e => e.status === 'ok');
  const allRows = live.flatMap(e => e.rows);

  // lab codes that already exist (re-sent result in a different file) or
  // repeat within this batch → skipped, the first one wins
  const codes = [...new Set(allRows.map(r => r.lab_sample_code).filter(Boolean))];
  const existingCodes = new Set();
  for (const part of chunk(codes, 150)) {
    const { data, error } = await supabase.from('lab_soil_result').select('lab_sample_code').in('lab_sample_code', part);
    if (error) return showImportError(error);
    for (const row of data ?? []) existingCodes.add(row.lab_sample_code);
  }

  // match sample numbers to samples on work orders — link only when exactly one
  const sampleNos = [...new Set(allRows.map(r => r.sample_no))];
  const vzorciBySample = new Map();
  for (const part of chunk(sampleNos, 150)) {
    const { data, error } = await supabase.from('delovni_nalogi_vzorci').select('id, sample_no').in('sample_no', part);
    if (error) return showImportError(error);
    for (const v of data ?? []) {
      if (!vzorciBySample.has(v.sample_no)) vzorciBySample.set(v.sample_no, []);
      vzorciBySample.get(v.sample_no).push(v.id);
    }
  }

  const batchCodes = new Set();
  for (const entry of live) {
    entry.insertRows = [];
    entry.matched = 0; entry.multiple = 0; entry.unmatched = 0; entry.skippedExisting = 0;
    for (const row of entry.rows) {
      if (row.lab_sample_code && (existingCodes.has(row.lab_sample_code) || batchCodes.has(row.lab_sample_code))) { entry.skippedExisting++; continue; }
      if (row.lab_sample_code) batchCodes.add(row.lab_sample_code);
      const notes = [];
      if (!row.lab_sample_code) { notes.push(NO_CODE_NOTE); entry.noCode = (entry.noCode ?? 0) + 1; }
      const candidates = vzorciBySample.get(row.sample_no) ?? [];
      if (candidates.length === 1) { row.vzorec_id = candidates[0]; entry.matched++; }
      else if (candidates.length > 1) { row.vzorec_id = null; notes.push(`Več vzorcev s to številko (${candidates.length}) — poveži ročno`); entry.multiple++; }
      else { row.vzorec_id = null; entry.unmatched++; }
      row.notes = notes.length ? notes.join('; ') : null;
      row.analysis_date = entry.analysisDate;
      entry.insertRows.push(row);
    }
  }

  pendingImport = { files: parsed, filteredOut, filterWords: words };
  renderImportPreview();
}

function showImportError(error) {
  els.importPreview.innerHTML = `<div class="fert-notice fert-notice--warn">Napaka: ${esc(error.message)}</div>`;
}

function renderImportPreview() {
  const { files, filteredOut, filterWords } = pendingImport;
  const toInsert = files.reduce((sum, f) => sum + (f.insertRows?.length ?? 0), 0);
  const unreadable = files.flatMap(f => (f.status === 'ok' ? f.unreadable : []));
  const examples = [...new Set(unreadable)].slice(0, 4).map(v => `„${esc(v)}“`).join(', ');

  const fileRow = f => {
    const meta = [];
    let icon = '✓', cls = 'ok', detail = '';
    if (f.status === 'ok') {
      meta.push(`Glava: ${f.format === 'en' ? 'SamplePartnerCode / ClientSampleCode' : 'MINTASZAM / MINTAAZONO'} · ${f.rows.length} vrstic`);
      meta.push(f.analysisDate ? `datum analize ${fmtDate(f.analysisDate)}` : 'datuma v imenu ni');
      detail = `<span class="fert-count fert-count--ok">${f.matched} povezanih</span>`
        + (f.unmatched ? `<span class="fert-count fert-count--warn">${f.unmatched} nepovezanih</span>` : '')
        + (f.multiple ? `<span class="fert-count fert-count--warn">${f.multiple} z več zadetki</span>` : '')
        + (f.noCode ? `<span class="fert-count">${f.noCode} brez lab. kode</span>` : '')
        + (f.skippedExisting ? `<span class="fert-count">${f.skippedExisting} že obstaja</span>` : '');
    } else {
      icon = '–'; cls = 'skip';
      meta.push({
        'already': `Že uvoženo ${fmtDate(f.importedAt)} — preskočeno`,
        'dup-in-batch': 'Ista datoteka je izbrana dvakrat — preskočeno',
        'no-header': 'Ni stolpca MINTAAZONO / ClientSampleCode — to ni izvoz laboratorija, preskočeno',
        'error': `Datoteke ni bilo mogoče prebrati (${esc(f.error)})`,
      }[f.status]);
    }
    return `<div class="fert-file fert-file--${cls}">
      <span class="fert-file-icon" aria-hidden="true">${icon}</span>
      <div class="fert-file-main"><span class="fert-strong">${esc(f.name)}</span><span class="fert-hint">${esc(meta.join(' · '))}</span></div>
      <div class="fert-file-counts">${detail}</div>
    </div>`;
  };

  els.importPreview.innerHTML = `
    <section class="fert-card">
      <h3 class="fert-card-title">Predogled · ${files.length} ${files.length === 1 ? 'datoteka' : 'datotek'}</h3>
      ${filteredOut ? `<p class="fert-hint">${filteredOut} drugih Excel datotek preskočenih — ime ne vsebuje „${esc(filterWords.join(' '))}“.</p>` : ''}
      ${files.map(fileRow).join('')}
      ${unreadable.length ? `<div class="fert-notice fert-notice--warn"><strong>${unreadable.length} ${unreadable.length === 1 ? 'vrednosti' : 'vrednosti'} ni bilo mogoče prebrati</strong> (npr. ${examples}) — shranjene bodo kot prazne, originalno besedilo ostane zapisano.</div>` : ''}
      <div class="fert-actions">
        <button type="button" class="btn btn-secondary" id="fertImportCancel">Prekliči</button>
        <button type="button" class="btn btn-primary" id="fertImportConfirm" ${toInsert ? '' : 'disabled'}>Uvozi ${toInsert} ${toInsert === 1 ? 'rezultat' : 'rezultatov'}</button>
      </div>
    </section>`;
  document.getElementById('fertImportCancel').addEventListener('click', resetImport);
  document.getElementById('fertImportConfirm').addEventListener('click', confirmImport);
}

async function confirmImport() {
  const confirmBtn = document.getElementById('fertImportConfirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Uvažanje …';
  const { data: { user } } = await supabase.auth.getUser();
  let inserted = 0;
  const failures = [];

  for (const f of pendingImport.files) {
    if (f.status !== 'ok' || !f.insertRows.length) continue;
    const { data: fileRow, error: fileError } = await supabase
      .from('lab_import_file')
      .insert({ file_name: f.name, file_hash: f.hash, header_format: f.format, row_count: f.insertRows.length, imported_by: user?.id ?? null })
      .select('id')
      .single();
    if (fileError) { failures.push(`${f.name}: ${fileError.message}`); continue; }
    let fileFailed = false;
    for (const part of chunk(f.insertRows, 500)) {
      const { error } = await supabase.from('lab_soil_result').insert(part.map(row => ({ ...row, import_file_id: fileRow.id })));
      if (error) { failures.push(`${f.name}: ${error.message}`); fileFailed = true; break; }
      inserted += part.length;
    }
    // a half-imported file must not block a retry — the file row's cascade removes its results too
    if (fileFailed) await supabase.from('lab_import_file').delete().eq('id', fileRow.id);
  }

  resetImport();
  labFlash = inserted ? `Uvoženih ${inserted} rezultatov.` : '';
  labLoaded = false;
  showView('lab');
  if (failures.length) alert('Uvoz ni v celoti uspel:\n' + failures.join('\n'));
}

function resetImport() {
  pendingImport = null;
  els.importPreview.innerHTML = '';
  els.importFiles.value = '';
  els.importFolder.value = '';
}

els.importOpenBtn.addEventListener('click', () => { resetImport(); showView('import'); });
els.importBackBtn.addEventListener('click', () => { resetImport(); showView('lab'); });
els.importFiles.addEventListener('change', () => handleFiles(els.importFiles.files));
els.importFolder.addEventListener('change', () => handleFiles(els.importFolder.files));
els.dropzone.addEventListener('dragover', event => { event.preventDefault(); els.dropzone.classList.add('fert-dropzone--over'); });
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('fert-dropzone--over'));
els.dropzone.addEventListener('drop', event => {
  event.preventDefault();
  els.dropzone.classList.remove('fert-dropzone--over');
  handleFiles(event.dataTransfer.files);
});

// ── Nastavitve (read-only) ───────────────────────────────────
async function loadSettings() {
  els.settingsBody.innerHTML = '<p class="fert-hint">Nalaganje …</p>';
  const [settings, fertilizers, organics, lime, factors, crops] = await Promise.all([
    supabase.from('fert_settings').select('*').eq('is_active', true).maybeSingle(),
    supabase.from('fert_fertilizer').select('*').order('nutrient').order('name'),
    supabase.from('fert_organic_fertilizer').select('*').order('name'),
    supabase.from('fert_lime_ph').select('*').order('ph_from', { nullsFirst: true }),
    supabase.from('fert_map_factor').select('*').order('nutrient', { ascending: false }).order('class_from'),
    supabase.from('fert_crop').select('*').order('code'),
  ]);
  const failed = [settings, fertilizers, organics, lime, factors, crops].find(r => r.error);
  if (failed) { els.settingsBody.innerHTML = `<p class="fert-error">Napaka pri nalaganju: ${esc(failed.error.message)}</p>`; return; }
  settingsLoaded = true;

  const s = settings.data;
  const defaults = new Set([s?.default_p_fertilizer_id, s?.default_k_fertilizer_id, s?.default_lime_fertilizer_id]);
  const pct = v => `${numFmt.format(Number(v) * 100)} %`;
  const nutrientLabel = { P2O5: 'P₂O₅', K2O: 'K₂O', LIME: 'apno' };
  const range = (from, to) => from == null ? `≤ ${fmtNum(to)}` : to == null ? `≥ ${fmtNum(from)}` : from === to ? fmtNum(from) : `${fmtNum(from)}–${fmtNum(to)}`;
  const factorRange = (from, to) => to == null ? `${from}+` : `${from}–${to}`;
  const pFactors = factors.data.filter(f => f.nutrient === 'P2O5');
  const kFactors = factors.data.filter(f => f.nutrient === 'K2O');

  const card = (title, body) => `<section class="fert-card"><h3 class="fert-card-title">${title}</h3>${body}</section>`;
  const table = (head, rows) => `<div class="reports-table-wrap"><table class="evidenca-table fert-table fert-table--compact"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;

  const params = s ? table('<th>Parameter</th><th class="fert-num">Vrednost</th>', [
    ['Ciljna vrednost P₂O₅ / K₂O (mg/kg)', `${fmtNum(s.target_p2o5)} / ${fmtNum(s.target_k2o)}`],
    ['Meje P₂O₅ (nizko / optimalno / visoko)', `${fmtNum(s.p_low_max)} / ${fmtNum(s.p_optimal_max)} / ${fmtNum(s.p_high_max)}`],
    ['Meje K₂O (nizko / optimalno / visoko)', `${fmtNum(s.k_low_max)} / ${fmtNum(s.k_optimal_max)} / ${fmtNum(s.k_high_max)}`],
    ['Zmanjšanje nad optimalnim', `${fmtNum(s.reduced_factor)} × odvzem`],
    ['Letna melioracija', pct(s.correction_rate)],
    ['Faktor tal (gostota)', fmtNum(s.soil_factor)],
    ['Naslednje leto: dvig pH', `+${fmtNum(s.followup_ph_step)} do pH ${fmtNum(s.followup_ph_cap)}`],
  ].map(([k, v]) => `<tr><td>${esc(k)}</td><td class="fert-num">${esc(v)}</td></tr>`).join(''))
    : '<p class="fert-error">Ni aktivnih nastavitev.</p>';

  const fertRows = fertilizers.data.map(f => `<tr><td>${esc(f.name)}</td><td>${esc(nutrientLabel[f.nutrient] ?? f.nutrient)}</td>
    <td class="fert-num">${f.nutrient === 'LIME' ? '—' : esc(pct(f.content))}</td>
    <td class="fert-muted">${[defaults.has(f.id) ? 'privzeto' : '', f.is_organic_approved ? 'EKO' : ''].filter(Boolean).join(', ')}</td></tr>`).join('');
  const orgRows = organics.data.map(o => `<tr><td>${esc(o.name)}</td><td>${esc(o.unit)}</td><td class="fert-num">${esc(fmtNum(o.p2o5_per_unit))}</td><td class="fert-num">${esc(fmtNum(o.k2o_per_unit))}</td></tr>`).join('');
  const limeTiles = lime.data.map(l => `<div class="fert-tile"><span class="fert-muted">${esc(range(l.ph_from, l.ph_to))}</span><strong>${esc(fmtNum(l.kg_per_ha))}</strong></div>`).join('');
  const factorRows = Array.from({ length: Math.max(pFactors.length, kFactors.length) }, (_, i) => {
    const p = pFactors[i], k = kFactors[i];
    return `<tr><td>${p ? esc(factorRange(p.class_from, p.class_to)) : ''}</td><td class="fert-num">${p ? esc(fmtNum(p.factor)) : ''}</td>
      <td>${k ? esc(factorRange(k.class_from, k.class_to)) : ''}</td><td class="fert-num">${k ? esc(fmtNum(k.factor)) : ''}</td></tr>`;
  }).join('');
  const cropRows = crops.data.map(c => {
    const v = x => x == null ? '<span class="fert-warn-text">manjka</span>' : esc(fmtNum(x));
    return `<tr data-crop="${esc(c.name.toLowerCase())}"><td>${esc(c.code)}</td><td>${esc(c.name)}</td>
      <td class="fert-num">${v(c.p2o5_per_t)}</td><td class="fert-num">${v(c.k2o_per_t)}</td>
      <td class="fert-num">${v(c.p2o5_per_t_straw_removed)}</td><td class="fert-num">${v(c.k2o_per_t_straw_removed)}</td></tr>`;
  }).join('');

  els.settingsBody.innerHTML = [
    card(`Osnovni parametri${s ? ' · ' + esc(s.name) : ''}`, params),
    card('Mineralna gnojila', table('<th>Gnojilo</th><th>Hranilo</th><th class="fert-num">Vsebnost</th><th></th>', fertRows))
      + card('Organska gnojila (na enoto)', table('<th>Vrsta</th><th>Enota</th><th class="fert-num">P₂O₅</th><th class="fert-num">K₂O</th>', orgRows)),
    card('Apnenje po pH (Calciprill kg/ha)', `<div class="fert-tiles">${limeTiles}</div>`),
    card('Faktorji karte (razred = mg/kg ÷ 10)', table('<th>P₂O₅ razred</th><th class="fert-num">Faktor</th><th>K₂O razred</th><th class="fert-num">Faktor</th>', factorRows)),
    card(`Kulture · ${crops.data.length}`, `<input type="search" class="field-input fert-input fert-crop-search" placeholder="Išči kulturo" aria-label="Išči kulturo">`
      + table('<th>Št.</th><th>Kultura</th><th class="fert-num">P₂O₅/t</th><th class="fert-num">K₂O/t</th><th class="fert-num">P₂O₅/t brez slame</th><th class="fert-num">K₂O/t brez slame</th>', cropRows)),
  ].join('');

  const cropSearch = els.settingsBody.querySelector('.fert-crop-search');
  cropSearch.addEventListener('input', () => {
    const q = cropSearch.value.trim().toLowerCase();
    for (const tr of els.settingsBody.querySelectorAll('tr[data-crop]')) tr.hidden = q && !tr.dataset.crop.includes(q);
  });
}

// ══ Načrti: plan list + step-by-step wizard ═════════════════════════════
// One plan = one field (GERK line of a sampling work order) on one date.
// The Nastavitve tables are only DEFAULTS: a new plan copies them into its
// own rows (fert_plan_parameters, fert_plan_lime_ph, fert_plan_map_factor,
// per-unit values in fert_plan_organic) and every change made in the plan
// edits only those copies (Matej, 2026-10-29). overridden_fields /
// is_overridden mark what differs from the default it came from.
// Drafts (osnutek) are editable; a confirmed plan (potrjeno) is read-only —
// "Kopiraj kot nov osnutek" makes an editable copy.

const STEPS = ['Polje', 'Segmenti in analize', 'Kultura in organska gnojila', 'Parametri izračuna', 'Rezultat', 'Zaključek'];

// Scalar parameters, in display order. `src: 'crop'` = default comes from the crop list.
const PARAM_GROUPS = [
  { title: 'Ciljne vrednosti (mg/kg)', fields: [
    { key: 'target_p2o5', label: 'Ciljna vrednost P₂O₅' }, { key: 'target_k2o', label: 'Ciljna vrednost K₂O' }] },
  { title: 'Meje P₂O₅ (mg/kg)', fields: [
    { key: 'p_low_max', label: 'Nizko do' }, { key: 'p_optimal_max', label: 'Optimalno do' }, { key: 'p_high_max', label: 'Visoko do', hint: 'nad tem 0' }] },
  { title: 'Meje K₂O (mg/kg)', fields: [
    { key: 'k_low_max', label: 'Nizko do' }, { key: 'k_optimal_max', label: 'Optimalno do' }, { key: 'k_high_max', label: 'Visoko do', hint: 'nad tem 0' }] },
  { title: 'Faktorji', fields: [
    { key: 'reduced_factor', label: 'Nad optimalnim', hint: '× odvzem' },
    { key: 'correction_rate', label: 'Letna melioracija', hint: 'delež, 0,1 = 10 %' },
    { key: 'soil_factor', label: 'Faktor tal', hint: 'kg/ha na 1 mg/100 g' }] },
  { title: 'Naslednje leto', fields: [
    { key: 'followup_ph_step', label: 'Dvig pH na leto' }, { key: 'followup_ph_cap', label: 'Dvig pH samo pod' }] },
  { title: 'Odvzem kulture (kg na tono pridelka)', fields: [
    { key: 'crop_p2o5_per_t', label: 'P₂O₅ / t', src: 'crop' }, { key: 'crop_k2o_per_t', label: 'K₂O / t', src: 'crop' }] },
];
const SETTINGS_KEYS = PARAM_GROUPS.flatMap(g => g.fields).filter(f => !f.src).map(f => f.key);
const FERT_SLOTS = [
  { slot: 'p', nutrient: 'P2O5', label: 'Fosforno gnojilo' },
  { slot: 'k', nutrient: 'K2O', label: 'Kalijevo gnojilo' },
  { slot: 'lime', nutrient: 'LIME', label: 'Apnenje' },
];
const DEFAULTED_KEYS = [...SETTINGS_KEYS, 'crop_p2o5_per_t', 'crop_k2o_per_t', ...FERT_SLOTS.map(s => `${s.slot}_fertilizer_content`)];

let defaults = null;      // Nastavitve tables, loaded once per page
let plans = [];
let wiz = null;           // { plan, step, maxStep, readOnly, dirty, fieldSources, notice, segmentsStale, customerQuery }

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseNum(value) {
  if (value == null) return null;
  const s = String(value).trim().replace(/\s+/g, '').replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function fmtInput(value) {
  const n = parseNum(value);
  return n == null ? (value == null ? '' : String(value)) : String(n).replace('.', ',');
}
const kgFmt = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 0 });
function fmtKg(value) { return value == null ? '—' : kgFmt.format(value); }
function fmtInt(value) { return value == null ? '—' : intFmt.format(value); }
function sameNum(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}
const sampleCollator = new Intl.Collator('sl', { numeric: true });

async function loadDefaults() {
  if (defaults) return defaults;
  const [settings, fertilizers, organics, lime, factors, crops] = await Promise.all([
    supabase.from('fert_settings').select('*').eq('is_active', true).maybeSingle(),
    supabase.from('fert_fertilizer').select('*').eq('is_active', true).order('name'),
    supabase.from('fert_organic_fertilizer').select('*').eq('is_active', true).order('name'),
    supabase.from('fert_lime_ph').select('*').order('ph_from', { nullsFirst: true }),
    supabase.from('fert_map_factor').select('*').order('nutrient', { ascending: false }).order('class_from'),
    supabase.from('fert_crop').select('*').eq('is_active', true).order('name'),
  ]);
  const failed = [settings, fertilizers, organics, lime, factors, crops].find(r => r.error);
  if (failed) throw failed.error;
  if (!settings.data) throw new Error('Ni aktivnih nastavitev (fert_settings).');
  defaults = { settings: settings.data, fertilizers: fertilizers.data, organics: organics.data, lime: lime.data, factors: factors.data, crops: crops.data };
  return defaults;
}

// ── defaults for one plan ────────────────────────────────────
function cropById(id) { return defaults.crops.find(c => c.id === id) ?? null; }
function fertById(id) { return defaults.fertilizers.find(f => f.id === id) ?? null; }
function organicById(id) { return defaults.organics.find(o => o.id === id) ?? null; }

function defaultParam(key, plan) {
  if (SETTINGS_KEYS.includes(key)) return defaults.settings[key];
  const crop = cropById(plan.crop_id);
  if (key === 'crop_p2o5_per_t') return crop ? (plan.straw_stays ? crop.p2o5_per_t : crop.p2o5_per_t_straw_removed) : null;
  if (key === 'crop_k2o_per_t') return crop ? (plan.straw_stays ? crop.k2o_per_t : crop.k2o_per_t_straw_removed) : null;
  const slot = FERT_SLOTS.find(s => key === `${s.slot}_fertilizer_content`);
  if (slot) return fertById(plan[`${slot.slot}_fertilizer_id`])?.content ?? null;
  return null;
}
// Re-derive every parameter the admin hasn't changed (after a crop / straw /
// fertilizer choice changes); changed ones stay as the admin set them.
function refreshDefaultedParams(plan) {
  for (const key of DEFAULTED_KEYS) if (!plan.overridden.has(key)) plan.params[key] = defaultParam(key, plan);
  for (const s of FERT_SLOTS) {
    const f = fertById(plan[`${s.slot}_fertilizer_id`]);
    if (f) plan.params[`${s.slot}_fertilizer_name`] = f.name;
  }
}
function defaultLime() { return defaults.lime.map(r => ({ ph_from: r.ph_from, ph_to: r.ph_to, kg_per_ha: r.kg_per_ha, is_overridden: false })); }
function defaultFactors() { return defaults.factors.map(r => ({ nutrient: r.nutrient, class_from: r.class_from, class_to: r.class_to, factor: r.factor, is_overridden: false })); }
function defaultLimeRow(row) { return defaults.lime.find(d => sameNum(d.ph_from, row.ph_from) && sameNum(d.ph_to, row.ph_to)); }
function defaultFactorRow(row) { return defaults.factors.find(d => d.nutrient === row.nutrient && sameNum(d.class_from, row.class_from) && sameNum(d.class_to, row.class_to)); }

function blankPlan() {
  const s = defaults.settings;
  const plan = {
    id: null, status: 'osnutek', customer_id: null, customer_name: '', gerk_code: null, field_id: null, field_name: null,
    delovni_nalog_gerk_id: null, plan_date: todayIso(), is_followup_year: false,
    crop_id: null, crop_name: null, expected_yield_t_per_ha: null, straw_stays: true,
    p_fertilizer_id: s.default_p_fertilizer_id, k_fertilizer_id: s.default_k_fertilizer_id, lime_fertilizer_id: s.default_lime_fertilizer_id,
    report_text: '', report_edited: false, notes: '', confirmed_at: null,
    params: { source_settings_id: s.id }, overridden: new Set(),
    lime: defaultLime(), mapFactors: defaultFactors(), organic: [], segments: [],
    declarationChecked: false, declarationHint: '',
  };
  refreshDefaultedParams(plan);
  return plan;
}

// ── plan list ────────────────────────────────────────────────
async function loadPlans() {
  els.planRows.innerHTML = '<tr><td colspan="8" class="fert-empty">Nalaganje …</td></tr>';
  const { data, error } = await supabase
    .from('fert_plan')
    .select('id, plan_date, status, gerk_code, field_name, crop_name, created_at, customers(naziv, company_name), fert_plan_segment(area_ha, included)')
    .is('deleted_at', null)
    .order('plan_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) {
    els.planRows.innerHTML = `<tr><td colspan="8" class="fert-empty fert-error">Napaka pri nalaganju: ${esc(error.message)}</td></tr>`;
    return;
  }
  plans = data ?? [];
  renderPlans();
}

function renderPlans() {
  const q = els.planSearch.value.trim().toLowerCase();
  const status = els.planStatus.value;
  const rows = plans.filter(p => (!status || p.status === status)
    && (!q || [customerName(p.customers), p.gerk_code, p.field_name, p.crop_name].join(' ').toLowerCase().includes(q)));
  if (!rows.length) {
    els.planRows.innerHTML = `<tr><td colspan="8" class="fert-empty">${plans.length ? 'Ni zadetkov.' : 'Še ni načrtov — klikni + Nov načrt.'}</td></tr>`;
    return;
  }
  els.planRows.innerHTML = rows.map(p => {
    const segs = (p.fert_plan_segment ?? []).filter(s => s.included);
    const ha = segs.reduce((sum, s) => sum + (Number(s.area_ha) || 0), 0);
    const badge = p.status === 'potrjeno'
      ? '<span class="fert-badge fert-badge--ok">Potrjeno</span>'
      : '<span class="fert-badge fert-badge--warn">Osnutek</span>';
    return `<tr>
      <td>${esc(fmtDate(p.plan_date))}</td>
      <td class="fert-strong">${esc(customerName(p.customers))}</td>
      <td>${esc(p.gerk_code ?? '—')}${p.field_name && p.field_name !== p.gerk_code ? ` · ${esc(p.field_name)}` : ''}</td>
      <td>${esc(p.crop_name ?? '—')}</td>
      <td class="fert-num">${ha ? esc(numFmt.format(roundHalfUp(ha, 2))) : '—'}</td>
      <td class="fert-num">${segs.length}</td>
      <td>${badge}</td>
      <td class="fert-row-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-plan-open="${esc(p.id)}">Odpri</button>
        <button type="button" class="btn btn-secondary btn-sm" data-plan-copy="${esc(p.id)}">Kopiraj</button>
        <button type="button" class="btn btn-secondary btn-sm fert-danger-text" data-plan-delete="${esc(p.id)}">Izbriši</button>
      </td>
    </tr>`;
  }).join('');
}

els.planSearch.addEventListener('input', renderPlans);
els.planStatus.addEventListener('change', renderPlans);
els.planRows.addEventListener('click', async event => {
  const open = event.target.closest('[data-plan-open]');
  const copy = event.target.closest('[data-plan-copy]');
  const del = event.target.closest('[data-plan-delete]');
  if (open) return openPlan(open.dataset.planOpen, { copy: false });
  if (copy) return openPlan(copy.dataset.planCopy, { copy: true });
  if (del) {
    const p = plans.find(x => x.id === del.dataset.planDelete);
    if (!p || !confirm(`Izbrišem načrt ${customerName(p.customers)} · ${p.gerk_code} (${fmtDate(p.plan_date)})?`)) return;
    const { error } = await supabase.from('fert_plan').update({ deleted_at: new Date().toISOString() }).eq('id', p.id);
    if (error) alert('Brisanje ni uspelo: ' + error.message);
    loadPlans();
  }
});

// `preset` = customer + GERK line chosen up front (from Analize tal)
async function startNewPlan(preset) {
  try { await loadDefaults(); } catch (err) { alert('Nastavitev ni bilo mogoče naložiti: ' + err.message); return; }
  const plan = Object.assign(blankPlan(), preset ?? {});
  wiz = { plan, step: 0, maxStep: 0, readOnly: false, dirty: !!preset, fieldSources: null, notice: null, segmentsStale: !!preset, customerQuery: '' };
  showView('wizard');
  renderWizard();
  await prepareStep();
  renderWizard();
}
els.newPlanBtn.addEventListener('click', () => startNewPlan(null));

async function openPlan(id, { copy }) {
  try { await loadDefaults(); } catch (err) { alert('Nastavitev ni bilo mogoče naložiti: ' + err.message); return; }
  const { data: p, error } = await supabase
    .from('fert_plan')
    .select('*, customers(naziv, company_name), fert_plan_parameters(*), fert_plan_lime_ph(*), fert_plan_map_factor(*), fert_plan_organic(*), fert_plan_segment(*)')
    .eq('id', id)
    .single();
  if (error) { alert('Načrta ni bilo mogoče odpreti: ' + error.message); return; }
  const params = Array.isArray(p.fert_plan_parameters) ? p.fert_plan_parameters[0] : p.fert_plan_parameters;
  const plan = {
    id: copy ? null : p.id, status: copy ? 'osnutek' : p.status, customer_id: p.customer_id, customer_name: customerName(p.customers),
    gerk_code: p.gerk_code, field_id: p.field_id, field_name: p.field_name, delovni_nalog_gerk_id: p.delovni_nalog_gerk_id,
    plan_date: copy ? todayIso() : p.plan_date, is_followup_year: p.is_followup_year,
    crop_id: p.crop_id, crop_name: p.crop_name, expected_yield_t_per_ha: p.expected_yield_t_per_ha, straw_stays: p.straw_stays ?? true,
    p_fertilizer_id: p.p_fertilizer_id, k_fertilizer_id: p.k_fertilizer_id, lime_fertilizer_id: p.lime_fertilizer_id,
    report_text: p.report_text ?? '', report_edited: !!p.report_text && p.report_text !== reportText((p.fert_plan_organic ?? []).sort((a, b) => a.sort_order - b.sort_order)),
    notes: p.notes ?? '', confirmed_at: copy ? null : p.confirmed_at,
    params: { ...(params ?? { source_settings_id: defaults.settings.id }) },
    overridden: new Set(params?.overridden_fields ?? []),
    lime: (p.fert_plan_lime_ph ?? []).sort((a, b) => (a.ph_from ?? -1) - (b.ph_from ?? -1))
      .map(r => ({ ph_from: r.ph_from, ph_to: r.ph_to, kg_per_ha: r.kg_per_ha, is_overridden: r.is_overridden })),
    mapFactors: (p.fert_plan_map_factor ?? []).sort((a, b) => b.nutrient.localeCompare(a.nutrient) || a.class_from - b.class_from)
      .map(r => ({ nutrient: r.nutrient, class_from: r.class_from, class_to: r.class_to, factor: r.factor, is_overridden: r.is_overridden })),
    organic: (p.fert_plan_organic ?? []).sort((a, b) => a.sort_order - b.sort_order)
      .map(o => ({ organic_fertilizer_id: o.organic_fertilizer_id, name: o.name, unit: o.unit, amount: o.amount, p2o5_per_unit: o.p2o5_per_unit, k2o_per_unit: o.k2o_per_unit, is_overridden: o.is_overridden })),
    segments: (p.fert_plan_segment ?? []).sort((a, b) => a.sort_order - b.sort_order).map(s => ({ ...s, lab: null })),
    declarationChecked: true, declarationHint: '',
  };
  if (!params) refreshDefaultedParams(plan);
  if (!plan.lime.length) plan.lime = defaultLime();
  if (!plan.mapFactors.length) plan.mapFactors = defaultFactors();
  const readOnly = plan.status === 'potrjeno';
  wiz = { plan, step: readOnly ? 4 : 0, maxStep: STEPS.length - 1, readOnly, dirty: copy, fieldSources: null, segmentsStale: false, customerQuery: '',
    notice: copy ? { kind: 'info', text: 'Kopija načrta — shrani jo kot nov osnutek (datum načrta je nastavljen na danes).' } : null };
  showView('wizard');
  await prepareStep();
  renderWizard();
}

function confirmLeaveWizard() {
  return !wiz || wiz.readOnly || !wiz.dirty || confirm('Načrt ima neshranjene spremembe. Zapustim brez shranjevanja?');
}

// ── step 1 data: customers → GERK lines of sampling work orders ─────
async function loadFieldSources() {
  const [orders, lab] = await Promise.all([
    supabase.from('delovni_nalogi')
      .select('id, stevilka, stranka_id, customers(id, naziv, company_name), delovni_nalogi_gerki(id, gerk_code, field_id, fields(name), delovni_nalogi_vzorci(id, sample_no))')
      .is('deleted_at', null),
    fetchAll(() => supabase.from('lab_soil_result').select('id, vzorec_id, sample_no').order('id')),
  ]);
  if (orders.error) throw orders.error;
  if (lab.error) throw lab.error;
  const linked = new Set(lab.data.filter(r => r.vzorec_id).map(r => r.vzorec_id));
  const unlinkedNos = new Set(lab.data.filter(r => !r.vzorec_id).map(r => r.sample_no));
  const byCustomer = new Map();
  for (const o of orders.data ?? []) {
    if (!o.customers) continue;
    for (const g of o.delovni_nalogi_gerki ?? []) {
      const samples = g.delovni_nalogi_vzorci ?? [];
      if (!samples.length) continue;
      const labCount = samples.filter(v => linked.has(v.id) || unlinkedNos.has(v.sample_no)).length;
      if (!byCustomer.has(o.customers.id)) byCustomer.set(o.customers.id, { id: o.customers.id, name: customerName(o.customers), lines: [] });
      byCustomer.get(o.customers.id).lines.push({
        lineId: g.id, gerk_code: g.gerk_code, field_id: g.field_id, field_name: g.fields?.name ?? null,
        order_no: o.stevilka, sampleCount: samples.length, labCount,
      });
    }
  }
  const customers = [...byCustomer.values()].sort((a, b) => a.name.localeCompare(b.name, 'sl'));
  for (const c of customers) {
    c.lines.sort((a, b) => sampleCollator.compare(String(b.order_no), String(a.order_no)) || String(a.gerk_code).localeCompare(String(b.gerk_code)));
    c.labCount = c.lines.reduce((s, l) => s + l.labCount, 0);
  }
  return { customers };
}

// ── step 2 data: the line's samples + their lab results + areas ─────
async function buildSegments(plan) {
  const { data: samples, error } = await supabase.from('delovni_nalogi_vzorci')
    .select('id, sample_no, area_ha').eq('delovni_nalog_gerk_id', plan.delovni_nalog_gerk_id);
  if (error) throw error;
  const ids = samples.map(s => s.id);
  const nos = [...new Set(samples.map(s => s.sample_no).filter(Boolean))];
  const labCols = 'id, vzorec_id, sample_no, ph_kcl, p2o5, k2o, humus_pct, analysis_date, lab_sample_code';
  const [linked, byNo, segs] = await Promise.all([
    ids.length ? supabase.from('lab_soil_result').select(labCols).in('vzorec_id', ids) : { data: [] },
    nos.length ? supabase.from('lab_soil_result').select(labCols).in('sample_no', nos).is('vzorec_id', null) : { data: [] },
    // gerk_segment has no SELECT policy — areas come through an admin-only RPC
    // (supabase/schema/migration_fert_segment_areas.sql)
    nos.length ? supabase.rpc('get_fert_segment_areas', { p_labels: nos }) : { data: [] },
  ]);
  for (const r of [linked, byNo]) if (r.error) throw r.error;
  // a missing RPC (migration not run) must not block the plan — areas can be typed in
  if (segs.error) { console.warn('get_fert_segment_areas failed', segs.error); segs.data = []; }
  // compound codes ("688697+6492082+6492080") — the segmentation sits under one of the parts
  const gerkParts = String(plan.gerk_code ?? '').split('+').map(s => s.trim());
  const newest = list => [...list].sort((a, b) => String(b.analysis_date ?? '').localeCompare(String(a.analysis_date ?? '')))[0] ?? null;

  return samples
    .sort((a, b) => sampleCollator.compare(String(a.sample_no), String(b.sample_no)))
    .map((s, i) => {
      const own = newest(linked.data.filter(r => r.vzorec_id === s.id));
      const lab = own ?? newest(byNo.data.filter(r => r.sample_no === s.sample_no));
      const segArea = segs.data.find(g => g.label === s.sample_no && gerkParts.includes(String(g.gerk_id)))?.area_ha
        ?? segs.data.find(g => g.label === s.sample_no)?.area_ha ?? null;
      const area = s.area_ha ?? segArea;
      const usable = lab && lab.ph_kcl != null && lab.p2o5 != null && lab.k2o != null && area;
      return {
        sample_no: s.sample_no, vzorec_id: s.id, lab_result_id: lab?.id ?? null,
        area_ha: area == null ? null : roundHalfUp(Number(area), 4),
        area_source: s.area_ha != null ? 'vzorec' : segArea != null ? 'segmentacija' : null,
        included: !!usable, ph_kcl: lab?.ph_kcl ?? null, p2o5: lab?.p2o5 ?? null, k2o: lab?.k2o ?? null,
        lab: lab ? { date: lab.analysis_date, code: lab.lab_sample_code, linked: !!own } : null,
        sort_order: i,
      };
    });
}

// ── step 3: prefill from the customer's crop declaration, once ─────
async function applyDeclaration(plan) {
  plan.declarationChecked = true;
  if (!plan.field_id) return;
  const { data } = await supabase.from('field_declarations')
    .select('year, crop_current, crop_next, straw_stays, expected_yield_t_per_ha, organic_fertilizer_used, organic_fertilizer_type, organic_fertilizer_amount, organic_fertilizer_unit')
    .eq('field_id', plan.field_id).order('year', { ascending: false }).limit(1);
  const d = data?.[0];
  if (!d) return;
  // a declaration of year Y names the crop for Y and for Y+1 — fertilizing
  // after sampling is for the coming crop, so crop_next wins
  const cropText = d.crop_next || d.crop_current;
  const crop = cropText && defaults.crops.find(c => c.name.toLowerCase() === String(cropText).trim().toLowerCase());
  if (crop && !plan.crop_id) { plan.crop_id = crop.id; plan.crop_name = crop.name; }
  if (d.expected_yield_t_per_ha != null && plan.expected_yield_t_per_ha == null) plan.expected_yield_t_per_ha = d.expected_yield_t_per_ha;
  if (d.straw_stays != null) plan.straw_stays = d.straw_stays;
  if (d.organic_fertilizer_used && d.organic_fertilizer_amount && !plan.organic.length) {
    const o = defaults.organics.find(x => x.unit === d.organic_fertilizer_unit);
    if (o) plan.organic.push({ organic_fertilizer_id: o.id, name: o.name, unit: o.unit, amount: d.organic_fertilizer_amount, p2o5_per_unit: o.p2o5_per_unit, k2o_per_unit: o.k2o_per_unit, is_overridden: false });
  }
  plan.declarationHint = `Predizpolnjeno iz deklaracije ${d.year}: kultura „${cropText ?? '—'}“${crop || !cropText ? '' : ' (ni v seznamu kultur — izberi ročno)'}`
    + (d.organic_fertilizer_used ? `, organsko gnojilo ${d.organic_fertilizer_type ?? ''} ${d.organic_fertilizer_amount ?? ''} ${d.organic_fertilizer_unit ?? ''}` : '') + '. Preveri in po potrebi popravi.';
  refreshDefaultedParams(plan);
}

// ── calculation over all included segments ───────────────────
const RESULT_KEYS = ['need_p2o5_kg_ha', 'need_k2o_kg_ha', 'p_fert_kg_ha', 'k_fert_kg_ha', 'lime_kg_ha', 'p_fert_real_kg', 'k_fert_real_kg', 'lime_real_kg',
  'p_map_factor', 'k_map_factor', 'p_fert_map_kg', 'k_fert_map_kg', 'lime_map_kg', 'used_ph_kcl', 'used_p2o5', 'used_k2o', 'warning'];
function calculatePlan(plan) {
  const params = Object.fromEntries(Object.entries(plan.params).map(([k, v]) => [k, typeof v === 'string' ? parseNum(v) ?? v : v]));
  const ctx = {
    params, isFollowupYear: plan.is_followup_year, yieldTPerHa: parseNum(plan.expected_yield_t_per_ha),
    lime: plan.lime.map(r => ({ ...r, kg_per_ha: parseNum(r.kg_per_ha) ?? 0 })),
    mapFactors: plan.mapFactors.map(r => ({ ...r, factor: parseNum(r.factor) ?? 1 })),
    organic: plan.organic.map(o => ({ ...o, amount: parseNum(o.amount), p2o5_per_unit: parseNum(o.p2o5_per_unit), k2o_per_unit: parseNum(o.k2o_per_unit) })),
  };
  for (const s of plan.segments) {
    for (const k of RESULT_KEYS) s[k] = null;
    if (s.included) Object.assign(s, calculateSegment({ ...s, area_ha: parseNum(s.area_ha) }, ctx));
  }
}

// ── validation per step ──────────────────────────────────────
function stepProblem(step, plan) {
  if (step === 0) {
    if (!plan.delovni_nalog_gerk_id) return 'Izberi stranko in polje (GERK).';
    if (!plan.plan_date) return 'Vpiši datum načrta.';
  }
  if (step === 1 && !plan.segments.some(s => s.included)) return 'Vključi vsaj en segment z analizo in površino.';
  if (step === 2) {
    if (!plan.crop_id) return 'Izberi kulturo.';
    if (!(parseNum(plan.expected_yield_t_per_ha) > 0)) return 'Vpiši pričakovan pridelek (t/ha).';
    if (plan.organic.some(o => parseNum(o.amount) == null)) return 'Vpiši količino za vsako organsko gnojilo (ali ga odstrani).';
  }
  if (step === 3) {
    const missing = PARAM_GROUPS.flatMap(g => g.fields).filter(f => parseNum(plan.params[f.key]) == null).map(f => f.label);
    if (missing.length) return `Manjkajo vrednosti: ${missing.join(', ')}.`;
    if (!(parseNum(plan.params.p_fertilizer_content) > 0) || !(parseNum(plan.params.k_fertilizer_content) > 0)) return 'Vpiši vsebnost hranila za fosforno in kalijevo gnojilo.';
    for (const s of FERT_SLOTS) { const v = parseNum(plan.params[`${s.slot}_fertilizer_content`]); if (v != null && (v <= 0 || v > 1)) return `${s.label}: vsebnost vpiši kot delež med 0 in 1 (npr. 0,26 za 26 %).`; }
  }
  return null;
}

// ── persistence: the whole plan, every save ──────────────────
function overriddenFields(plan) {
  return DEFAULTED_KEYS.filter(k => !sameNum(parseNum(plan.params[k]), parseNum(defaultParam(k, plan))));
}

async function savePlan({ confirmPlan = false } = {}) {
  const plan = wiz.plan;
  calculatePlan(plan);
  if (!plan.report_edited) plan.report_text = reportText(plan.organic);
  const { data: { user } } = await supabase.auth.getUser();
  const row = {
    customer_id: plan.customer_id, field_id: plan.field_id, gerk_code: plan.gerk_code, field_name: plan.field_name,
    delovni_nalog_gerk_id: plan.delovni_nalog_gerk_id, plan_date: plan.plan_date, is_followup_year: plan.is_followup_year,
    status: confirmPlan ? 'potrjeno' : 'osnutek', confirmed_at: confirmPlan ? new Date().toISOString() : null,
    crop_id: plan.crop_id, crop_name: cropById(plan.crop_id)?.name ?? plan.crop_name,
    expected_yield_t_per_ha: parseNum(plan.expected_yield_t_per_ha), straw_stays: plan.straw_stays,
    p_fertilizer_id: plan.p_fertilizer_id, k_fertilizer_id: plan.k_fertilizer_id, lime_fertilizer_id: plan.lime_fertilizer_id,
    settings_id: plan.params.source_settings_id ?? defaults.settings.id, calculated_at: new Date().toISOString(),
    report_text: plan.report_text || null, notes: plan.notes || null,
  };
  if (plan.id) {
    const { error } = await supabase.from('fert_plan').update(row).eq('id', plan.id);
    if (error) throw error;
  } else {
    const { data, error } = await supabase.from('fert_plan').insert({ ...row, created_by: user?.id ?? null }).select('id').single();
    if (error) throw error;
    plan.id = data.id;
  }
  const params = { plan_id: plan.id, source_settings_id: plan.params.source_settings_id ?? defaults.settings.id };
  for (const g of PARAM_GROUPS) for (const f of g.fields) params[f.key] = parseNum(plan.params[f.key]);
  // the NOT NULL settings columns can't be empty — fall back to the default for an emptied field
  for (const k of SETTINGS_KEYS) if (params[k] == null) params[k] = defaults.settings[k];
  for (const s of FERT_SLOTS) {
    params[`${s.slot}_fertilizer_name`] = plan.params[`${s.slot}_fertilizer_name`] ?? null;
    params[`${s.slot}_fertilizer_content`] = parseNum(plan.params[`${s.slot}_fertilizer_content`]);
  }
  params.overridden_fields = overriddenFields(plan);
  const { error: pErr } = await supabase.from('fert_plan_parameters').upsert(params, { onConflict: 'plan_id' });
  if (pErr) throw pErr;

  // child rows: replace wholesale — a plan has a few dozen of them at most
  const replace = async (table, rows) => {
    const { error: dErr } = await supabase.from(table).delete().eq('plan_id', plan.id);
    if (dErr) throw dErr;
    if (rows.length) { const { error: iErr } = await supabase.from(table).insert(rows); if (iErr) throw iErr; }
  };
  await replace('fert_plan_lime_ph', plan.lime.map(r => ({ plan_id: plan.id, ph_from: r.ph_from, ph_to: r.ph_to, kg_per_ha: parseNum(r.kg_per_ha) ?? 0, is_overridden: !!r.is_overridden })));
  await replace('fert_plan_map_factor', plan.mapFactors.map(r => ({ plan_id: plan.id, nutrient: r.nutrient, class_from: r.class_from, class_to: r.class_to, factor: parseNum(r.factor) ?? 1, is_overridden: !!r.is_overridden })));
  await replace('fert_plan_organic', plan.organic.map((o, i) => ({ plan_id: plan.id, organic_fertilizer_id: o.organic_fertilizer_id, name: o.name, unit: o.unit,
    amount: parseNum(o.amount) ?? 0, p2o5_per_unit: parseNum(o.p2o5_per_unit) ?? 0, k2o_per_unit: parseNum(o.k2o_per_unit) ?? 0, is_overridden: !!o.is_overridden, sort_order: i })));
  // ph_kcl / p2o5 / k2o are stored as measured; in a follow-up-year plan the
  // raised values are recomputed from them (fert-calc.js), never stored raised
  await replace('fert_plan_segment', plan.segments.map((s, i) => ({
    plan_id: plan.id, sample_no: s.sample_no, vzorec_id: s.vzorec_id ?? null, lab_result_id: s.lab_result_id ?? null,
    area_ha: parseNum(s.area_ha), included: !!s.included, ph_kcl: s.ph_kcl, p2o5: s.p2o5, k2o: s.k2o,
    need_p2o5_kg_ha: s.need_p2o5_kg_ha, need_k2o_kg_ha: s.need_k2o_kg_ha, p_fert_kg_ha: s.p_fert_kg_ha, k_fert_kg_ha: s.k_fert_kg_ha, lime_kg_ha: s.lime_kg_ha,
    p_fert_real_kg: s.p_fert_real_kg, k_fert_real_kg: s.k_fert_real_kg, lime_real_kg: s.lime_real_kg,
    p_map_factor: s.p_map_factor, k_map_factor: s.k_map_factor, p_fert_map_kg: s.p_fert_map_kg, k_fert_map_kg: s.k_fert_map_kg, lime_map_kg: s.lime_map_kg,
    warning: s.warning ?? null, sort_order: i,
  })));
  plan.status = row.status;
  plan.confirmed_at = row.confirmed_at;
  wiz.dirty = false;
}

async function saveAndNotify(opts, okText) {
  try {
    await savePlan(opts);
    wiz.notice = { kind: 'ok', text: okText };
    return true;
  } catch (err) {
    wiz.notice = { kind: 'warn', text: 'Shranjevanje ni uspelo: ' + err.message };
    renderWizard();
    return false;
  }
}

// ── wizard navigation ────────────────────────────────────────
async function goToStep(target) {
  const { plan } = wiz;
  wiz.notice = null;
  if (target > wiz.step && !wiz.readOnly) {
    for (let s = wiz.step; s < target; s++) {
      const problem = stepProblem(s, plan);
      if (problem) { wiz.notice = { kind: 'warn', text: problem }; renderWizard(); return; }
    }
    // the segments must exist before the first save that leaves step 1
    if (wiz.step === 0 && wiz.segmentsStale) {
      try { plan.segments = await buildSegments(plan); wiz.segmentsStale = false; }
      catch (err) { wiz.notice = { kind: 'warn', text: 'Napaka pri nalaganju segmentov: ' + err.message }; renderWizard(); return; }
    }
    if (!(await saveAndNotify({}, 'Osnutek shranjen.'))) return;
  }
  wiz.step = target;
  wiz.maxStep = Math.max(wiz.maxStep, target);
  await prepareStep();
  renderWizard();
  els.views.wizard.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// load whatever the step needs before it renders
async function prepareStep() {
  const { plan } = wiz;
  try {
    if (wiz.step === 0 && !wiz.fieldSources && !wiz.readOnly) wiz.fieldSources = await loadFieldSources();
    if (wiz.step === 1 && wiz.segmentsStale) { plan.segments = await buildSegments(plan); wiz.segmentsStale = false; }
    if (wiz.step === 2 && !plan.declarationChecked && !wiz.readOnly) await applyDeclaration(plan);
    if (wiz.step >= 4) calculatePlan(plan);
    if (wiz.step === 5 && !plan.report_edited) plan.report_text = reportText(plan.organic);
  } catch (err) {
    wiz.notice = { kind: 'warn', text: 'Napaka pri nalaganju podatkov: ' + err.message };
  }
}

// ── rendering ────────────────────────────────────────────────
function renderWizard() {
  if (!wiz) return;
  const { plan, step, readOnly } = wiz;
  const title = plan.gerk_code
    ? `${esc(plan.customer_name)} · ${esc(plan.gerk_code)}${plan.field_name && plan.field_name !== plan.gerk_code ? ' ' + esc(plan.field_name) : ''}`
    : 'Nov gnojilni načrt';
  const statusBadge = plan.status === 'potrjeno'
    ? `<span class="fert-badge fert-badge--ok">Potrjeno${plan.confirmed_at ? ' ' + esc(fmtDate(plan.confirmed_at)) : ''}</span>`
    : `<span class="fert-badge fert-badge--warn">${plan.id ? 'Osnutek' : 'Nov osnutek'}</span>`;
  const stepper = STEPS.map((label, i) => {
    const state = i === step ? 'current' : i <= wiz.maxStep ? 'done' : 'todo';
    return `<li><button type="button" class="fert-step fert-step--${state}" data-step="${i}" ${i > wiz.maxStep ? 'disabled' : ''} ${i === step ? 'aria-current="step"' : ''}>
      <span class="fert-step-num">${i + 1}</span><span class="fert-step-label">${label}</span></button></li>`;
  }).join('');
  const body = [renderStepField, renderStepSegments, renderStepCrop, renderStepParams, renderStepResult, renderStepFinish][step]();
  const notice = wiz.notice ? `<div class="fert-notice fert-notice--${wiz.notice.kind}">${esc(wiz.notice.text)}</div>` : '';
  const last = step === STEPS.length - 1;

  els.views.wizard.innerHTML = `
    <div class="fert-wiz-head">
      <button type="button" class="btn btn-secondary btn-sm" data-wiz="back-to-list">← Načrti</button>
      <h2 class="section-title fert-title">${title}</h2>
      ${statusBadge}
    </div>
    ${readOnly ? '<div class="fert-notice fert-notice--info">Načrt je potrjen in ga ni več mogoče spreminjati. Za spremembe naredi kopijo (Kopiraj kot nov osnutek).</div>' : ''}
    <ol class="fert-stepper">${stepper}</ol>
    ${notice}
    <fieldset class="fert-wiz-body" ${readOnly ? 'disabled' : ''}>${body}</fieldset>
    <div class="fert-actions fert-wiz-nav">
      ${step > 0 ? '<button type="button" class="btn btn-secondary" data-wiz="prev">← Nazaj</button>' : ''}
      <span class="fert-spacer"></span>
      ${readOnly ? '<button type="button" class="btn btn-secondary" data-wiz="copy">Kopiraj kot nov osnutek</button>'
        : '<button type="button" class="btn btn-secondary" data-wiz="save">Shrani osnutek</button>'}
      ${!last ? '<button type="button" class="btn btn-primary" data-wiz="next">Naprej →</button>'
        : readOnly ? '' : '<button type="button" class="btn btn-success" data-wiz="confirm">Potrdi načrt</button>'}
    </div>`;
}

function changedMark(isChanged, resetAttr) {
  return isChanged ? `<span class="fert-changed">spremenjeno</span><button type="button" class="fert-reset" ${resetAttr} title="Ponastavi na privzeto" aria-label="Ponastavi na privzeto">↺</button>` : '';
}

function renderStepField() {
  const { plan, fieldSources } = wiz;
  if (wiz.readOnly || !fieldSources) {
    return `<div class="fert-card">
      <dl class="fert-dl"><dt>Stranka</dt><dd>${esc(plan.customer_name || '—')}</dd>
      <dt>GERK / polje</dt><dd>${esc(plan.gerk_code ?? '—')}${plan.field_name ? ' · ' + esc(plan.field_name) : ''}</dd>
      <dt>Datum načrta</dt><dd>${esc(fmtDate(plan.plan_date))}</dd>
      <dt>Izhodišče</dt><dd>${plan.is_followup_year ? 'Naslednje leto' : 'Prvo leto (vrednosti analize)'}</dd></dl>
      ${wiz.readOnly ? '' : '<p class="fert-hint">Nalaganje seznama strank …</p>'}</div>`;
  }
  const q = (wiz.customerQuery ?? '').trim().toLowerCase();
  const customers = fieldSources.customers.filter(c => !q || c.name.toLowerCase().includes(q) || c.id === plan.customer_id);
  const selected = fieldSources.customers.find(c => c.id === plan.customer_id);
  const lineRows = selected ? selected.lines.map(l => `
      <tr class="${l.lineId === plan.delovni_nalog_gerk_id ? 'fert-row--selected' : ''}">
        <td><input type="radio" name="fertLine" value="${esc(l.lineId)}" data-line="${esc(l.lineId)}" ${l.lineId === plan.delovni_nalog_gerk_id ? 'checked' : ''} aria-label="Izberi GERK ${esc(l.gerk_code)}"></td>
        <td class="fert-strong">${esc(l.gerk_code)}</td><td>${esc(l.field_name ?? '—')}</td><td>${esc(l.order_no)}</td>
        <td class="fert-num">${l.sampleCount}</td>
        <td class="fert-num">${l.labCount ? `<span class="fert-badge fert-badge--ok">${l.labCount}</span>` : '<span class="fert-muted">0</span>'}</td>
      </tr>`).join('') : '';
  return `
    <div class="fert-card">
      <h3 class="fert-card-title">Stranka</h3>
      <div class="fert-toolbar">
        <label class="fert-field"><span class="field-label">Iskanje stranke</span>
          <input type="search" class="field-input fert-input" data-wiz-input="customer-query" value="${esc(wiz.customerQuery ?? '')}" placeholder="Ime stranke"></label>
        <label class="fert-field fert-field--wide"><span class="field-label">Stranka (${customers.length})</span>
          <select class="field-input fert-input" data-wiz-input="customer">
            <option value="">— izberi —</option>
            ${customers.map(c => `<option value="${esc(c.id)}" ${c.id === plan.customer_id ? 'selected' : ''}>${esc(c.name)} · ${c.lines.length} GERK · ${c.labCount} z analizo</option>`).join('')}
          </select></label>
      </div>
      <p class="fert-hint">Prikazane so stranke z vzorčenjem v delovnih nalogih.</p>
    </div>
    ${selected ? `<div class="fert-card">
      <h3 class="fert-card-title">Polje (GERK)</h3>
      <div class="reports-table-wrap"><table class="evidenca-table fert-table">
        <thead><tr><th></th><th>GERK</th><th>Polje</th><th>Nalog</th><th class="fert-num">Segmenti</th><th class="fert-num">Z analizo</th></tr></thead>
        <tbody>${lineRows}</tbody></table></div>
    </div>` : ''}
    <div class="fert-card">
      <h3 class="fert-card-title">Načrt</h3>
      <div class="fert-toolbar">
        <label class="fert-field fert-field--narrow"><span class="field-label">Datum načrta</span>
          <input type="date" class="field-input fert-input" data-wiz-input="plan_date" value="${esc(plan.plan_date)}"></label>
        <div class="fert-field"><span class="field-label">Izhodišče</span>
          <div class="fert-seg" role="group" aria-label="Izhodišče">
            <button type="button" class="fert-seg-btn ${!plan.is_followup_year ? 'fert-seg-btn--on' : ''}" data-wiz-toggle="followup" data-value="0" aria-pressed="${!plan.is_followup_year}">Prvo leto</button>
            <button type="button" class="fert-seg-btn ${plan.is_followup_year ? 'fert-seg-btn--on' : ''}" data-wiz-toggle="followup" data-value="1" aria-pressed="${plan.is_followup_year}">Naslednje leto</button>
          </div></div>
      </div>
      <p class="fert-hint">Naslednje leto: vrednosti analize se pred izračunom dvignejo za eno leto melioracije (P/K proti ciljni vrednosti, pH za korak) — kot stolpca „zvišan P / zvišan K“ v Excelu.</p>
    </div>`;
}

function renderStepSegments() {
  const { plan } = wiz;
  if (!plan.segments.length) return '<div class="fert-notice fert-notice--warn">Ta GERK nima segmentov (vzorcev) v delovnem nalogu.</div>';
  const included = plan.segments.filter(s => s.included);
  const ha = included.reduce((sum, s) => sum + (parseNum(s.area_ha) || 0), 0);
  const rows = plan.segments.map((s, i) => {
    const hasLab = s.ph_kcl != null || s.p2o5 != null || s.k2o != null;
    const labCell = !hasLab ? '<span class="fert-badge fert-badge--warn">Ni analize</span>'
      : s.lab ? `${esc(fmtDate(s.lab.date))} <span class="fert-muted">${s.lab.linked ? 'povezan' : 'po številki vzorca'}</span>` : '<span class="fert-muted">shranjeno v načrtu</span>';
    const missing = hasLab && (s.ph_kcl == null || s.p2o5 == null || s.k2o == null);
    return `<tr class="${s.included ? '' : 'fert-row--off'}">
      <td><input type="checkbox" data-seg="${i}" data-seg-field="included" ${s.included ? 'checked' : ''} aria-label="Vključi segment ${esc(s.sample_no)}"></td>
      <td class="fert-strong">${esc(s.sample_no)}</td>
      <td><input type="text" inputmode="decimal" class="field-input fert-input fert-input--num" data-seg="${i}" data-seg-field="area_ha" value="${esc(fmtInput(s.area_ha))}" aria-label="Površina segmenta ${esc(s.sample_no)} v ha"></td>
      <td class="fert-muted">${s.area_source === 'vzorec' ? 'vzorec' : s.area_source === 'segmentacija' ? 'segmentacija' : parseNum(s.area_ha) ? '' : '<span class="fert-warn-text">manjka</span>'}</td>
      <td>${labCell}</td>
      <td class="fert-num">${esc(fmtNum(s.ph_kcl))}</td><td class="fert-num">${esc(fmtNum(s.p2o5))}</td><td class="fert-num">${esc(fmtNum(s.k2o))}</td>
      <td>${missing ? '<span class="fert-warn-text">manjka P/K/pH</span>' : ''}</td>
    </tr>`;
  }).join('');
  return `<div class="fert-card">
    <div class="fert-card-head"><h3 class="fert-card-title">Segmenti in analize</h3>
      <span class="fert-badge ${included.length === plan.segments.length ? 'fert-badge--ok' : 'fert-badge--warn'}">${included.length} / ${plan.segments.length} vključenih · ${esc(numFmt.format(roundHalfUp(ha, 2)))} ha</span>
      ${wiz.readOnly ? '' : '<button type="button" class="btn btn-secondary btn-sm" data-wiz="reload-segments">Osveži iz analiz</button>'}</div>
    <div class="reports-table-wrap"><table class="evidenca-table fert-table">
      <thead><tr><th>Vključi</th><th>Segment</th><th>ha</th><th>Vir površine</th><th>Analiza</th><th class="fert-num">pH (KCl)</th><th class="fert-num">P₂O₅ mg/kg</th><th class="fert-num">K₂O mg/kg</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="fert-hint">Segment brez analize ali površine se ne izračuna. Površino lahko popraviš samo za ta načrt.</p>
  </div>`;
}

function renderStepCrop() {
  const { plan } = wiz;
  const crop = cropById(plan.crop_id);
  const yld = parseNum(plan.expected_yield_t_per_ha);
  const removal = crop && yld
    ? `${fmtKg(yld * (parseNum(plan.params.crop_p2o5_per_t) ?? 0))} P₂O₅ · ${fmtKg(yld * (parseNum(plan.params.crop_k2o_per_t) ?? 0))} K₂O kg/ha`
    : '—';
  const orgRows = plan.organic.map((o, i) => {
    const amount = parseNum(o.amount) ?? 0;
    return `<div class="fert-org-row ${o.is_overridden ? 'fert-param--changed' : ''}">
      <select class="field-input fert-input" data-org="${i}" data-org-field="organic_fertilizer_id" aria-label="Vrsta organskega gnojila">
        ${defaults.organics.map(d => `<option value="${esc(d.id)}" ${d.id === o.organic_fertilizer_id ? 'selected' : ''}>${esc(d.name)} (${esc(d.unit)})</option>`).join('')}
      </select>
      <label class="fert-inline">Količina <input type="text" inputmode="decimal" class="field-input fert-input fert-input--num" data-org="${i}" data-org-field="amount" value="${esc(fmtInput(o.amount))}"> ${esc(o.unit)}</label>
      <label class="fert-inline">P₂O₅/enoto <input type="text" inputmode="decimal" class="field-input fert-input fert-input--num" data-org="${i}" data-org-field="p2o5_per_unit" value="${esc(fmtInput(o.p2o5_per_unit))}"></label>
      <label class="fert-inline">K₂O/enoto <input type="text" inputmode="decimal" class="field-input fert-input fert-input--num" data-org="${i}" data-org-field="k2o_per_unit" value="${esc(fmtInput(o.k2o_per_unit))}"></label>
      ${changedMark(o.is_overridden, `data-org-reset="${i}"`)}
      <span class="fert-muted fert-org-total">= ${fmtKg(amount * (parseNum(o.p2o5_per_unit) ?? 0))} P₂O₅ · ${fmtKg(amount * (parseNum(o.k2o_per_unit) ?? 0))} K₂O kg/ha</span>
      <button type="button" class="btn btn-secondary btn-sm" data-org-remove="${i}" aria-label="Odstrani organsko gnojilo">✕</button>
    </div>`;
  }).join('');
  const tot = organicTotals(plan.organic.map(o => ({ amount: parseNum(o.amount), p2o5_per_unit: parseNum(o.p2o5_per_unit), k2o_per_unit: parseNum(o.k2o_per_unit) })));
  return `
    ${plan.declarationHint ? `<div class="fert-notice fert-notice--info">${esc(plan.declarationHint)}</div>` : ''}
    <div class="fert-card">
      <h3 class="fert-card-title">Kultura</h3>
      <div class="fert-form-grid">
        <label class="fert-field fert-field--wide"><span class="field-label">Kultura</span>
          <select class="field-input fert-input" data-wiz-input="crop_id">
            <option value="">— izberi —</option>
            ${defaults.crops.map(c => `<option value="${esc(c.id)}" ${c.id === plan.crop_id ? 'selected' : ''}>${esc(c.name)}${c.p2o5_per_t == null ? ' (brez vrednosti odvzema)' : ''}</option>`).join('')}
          </select></label>
        <label class="fert-field fert-field--narrow"><span class="field-label">Pričakovan pridelek (t/ha)</span>
          <input type="text" inputmode="decimal" class="field-input fert-input" data-wiz-input="expected_yield_t_per_ha" value="${esc(fmtInput(plan.expected_yield_t_per_ha))}"></label>
        <div class="fert-field fert-field--narrow"><span class="field-label">Slama ostane na njivi</span>
          <div class="fert-seg" role="group" aria-label="Slama ostane na njivi">
            <button type="button" class="fert-seg-btn ${plan.straw_stays ? 'fert-seg-btn--on' : ''}" data-wiz-toggle="straw" data-value="1" aria-pressed="${plan.straw_stays}">DA</button>
            <button type="button" class="fert-seg-btn ${!plan.straw_stays ? 'fert-seg-btn--on' : ''}" data-wiz-toggle="straw" data-value="0" aria-pressed="${!plan.straw_stays}">NE</button>
          </div></div>
        <div class="fert-field"><span class="field-label">Odvzem kulture</span><span class="fert-value">${removal}</span></div>
      </div>
      <p class="fert-hint">Odvzem na tono pridelka pride iz seznama kultur (pri „NE“ vrednosti z odvozom slame); v naslednjem koraku ga lahko spremeniš samo za ta načrt.</p>
    </div>
    <div class="fert-card">
      <h3 class="fert-card-title">Organska gnojila</h3>
      ${orgRows || '<p class="fert-hint">Brez organskih gnojil.</p>'}
      <div class="fert-actions fert-actions--start">
        <button type="button" class="btn btn-secondary btn-sm" data-org-add>+ Dodaj organsko gnojilo</button>
        ${plan.organic.length ? `<span class="fert-muted">Skupaj: ${fmtKg(tot.p2o5)} P₂O₅ · ${fmtKg(tot.k2o)} K₂O kg/ha</span>` : ''}
      </div>
    </div>`;
}

function renderStepParams() {
  const { plan } = wiz;
  const input = f => {
    const changed = plan.overridden.has(f.key);
    const def = defaultParam(f.key, plan);
    return `<label class="fert-field fert-param ${changed ? 'fert-param--changed' : ''}">
      <span class="field-label">${f.label}</span>
      <span class="fert-param-row"><input type="text" inputmode="decimal" class="field-input fert-input fert-input--num" data-param="${f.key}" value="${esc(fmtInput(plan.params[f.key]))}">
      ${changedMark(changed, `data-param-reset="${f.key}"`)}</span>
      <span class="fert-hint">${f.hint ? `${esc(f.hint)} · ` : ''}privzeto: ${def == null ? '—' : esc(fmtInput(def))}</span></label>`;
  };
  const groups = PARAM_GROUPS.map(g => `<div class="fert-param-group"><h4 class="fert-group-title">${g.title}</h4><div class="fert-form-grid">${g.fields.map(input).join('')}</div></div>`).join('');
  const fertBlocks = FERT_SLOTS.map(s => {
    const key = `${s.slot}_fertilizer_content`;
    const changed = plan.overridden.has(key);
    const options = defaults.fertilizers.filter(f => f.nutrient === s.nutrient);
    return `<div class="fert-param-group"><h4 class="fert-group-title">${s.label}</h4><div class="fert-form-grid">
      <label class="fert-field fert-field--wide"><span class="field-label">Gnojilo</span>
        <select class="field-input fert-input" data-fert-slot="${s.slot}">
          ${options.map(f => `<option value="${esc(f.id)}" ${f.id === plan[`${s.slot}_fertilizer_id`] ? 'selected' : ''}>${esc(f.name)}${f.is_organic_approved ? ' (EKO)' : ''}</option>`).join('')}
        </select></label>
      ${s.slot === 'lime' ? '<p class="fert-hint">Količina apna pride iz tabele apnenja po pH (kg izbranega gnojila na ha) — spodaj v Napredno.</p>' : `
      <label class="fert-field fert-param ${changed ? 'fert-param--changed' : ''}"><span class="field-label">Vsebnost hranila</span>
        <span class="fert-param-row"><input type="text" inputmode="decimal" class="field-input fert-input fert-input--num" data-param="${key}" value="${esc(fmtInput(plan.params[key]))}">
        ${changedMark(changed, `data-param-reset="${key}"`)}</span>
        <span class="fert-hint">delež, 0,26 = 26 % · privzeto: ${esc(fmtInput(defaultParam(key, plan)) || '—')}</span></label>`}
    </div></div>`;
  }).join('');
  const rangeLabel = (from, to) => from == null ? `≤ ${fmtInput(to)}` : to == null ? `≥ ${fmtInput(from)}` : sameNum(from, to) ? fmtInput(from) : `${fmtInput(from)}–${fmtInput(to)}`;
  const limeInputs = plan.lime.map((r, i) => `<label class="fert-tile fert-tile--input ${r.is_overridden ? 'fert-param--changed' : ''}">
      <span class="fert-muted">pH ${esc(rangeLabel(r.ph_from, r.ph_to))}</span>
      <input type="text" inputmode="decimal" class="field-input fert-input fert-input--num" data-lime="${i}" value="${esc(fmtInput(r.kg_per_ha))}" aria-label="kg/ha pri pH ${esc(rangeLabel(r.ph_from, r.ph_to))}"></label>`).join('');
  const factorInputs = nutrient => plan.mapFactors.map((r, i) => r.nutrient !== nutrient ? '' : `<label class="fert-tile fert-tile--input ${r.is_overridden ? 'fert-param--changed' : ''}">
      <span class="fert-muted">${r.class_to == null ? `${r.class_from}+` : `${r.class_from}–${r.class_to}`}</span>
      <input type="text" inputmode="decimal" class="field-input fert-input fert-input--num" data-factor="${i}" value="${esc(fmtInput(r.factor))}" aria-label="Faktor ${nutrient} razred ${r.class_from}"></label>`).join('');
  const advancedChanged = plan.lime.some(r => r.is_overridden) || plan.mapFactors.some(r => r.is_overridden);
  const anyChanged = plan.overridden.size || advancedChanged || plan.organic.some(o => o.is_overridden);
  return `
    <div class="fert-notice fert-notice--info">Vrednosti so privzete iz Nastavitev. Spremembe veljajo samo za ta načrt in se shranijo skupaj z njim.
      ${anyChanged && !wiz.readOnly ? ' <button type="button" class="btn btn-secondary btn-sm" data-wiz="reset-all">Ponastavi vse na privzeto</button>' : ''}</div>
    <div class="fert-card">${groups}</div>
    <div class="fert-card">${fertBlocks}</div>
    <details class="fert-card fert-details" ${advancedChanged ? 'open' : ''}>
      <summary class="fert-card-title">Napredno: apnenje po pH in faktorji karte${advancedChanged ? ' <span class="fert-changed">spremenjeno</span>' : ''}</summary>
      <h4 class="fert-group-title">Apnenje po pH (kg/ha)</h4><div class="fert-tiles fert-tiles--inputs">${limeInputs}</div>
      <h4 class="fert-group-title">Faktorji karte P₂O₅ (razred = mg/kg ÷ 10)</h4><div class="fert-tiles fert-tiles--inputs">${factorInputs('P2O5')}</div>
      <h4 class="fert-group-title">Faktorji karte K₂O</h4><div class="fert-tiles fert-tiles--inputs">${factorInputs('K2O')}</div>
    </details>`;
}

function renderStepResult() {
  const { plan } = wiz;
  const segs = plan.segments.filter(s => s.included);
  const pName = esc(plan.params.p_fertilizer_name ?? 'P gnojilo'), kName = esc(plan.params.k_fertilizer_name ?? 'K gnojilo'), lName = esc(plan.params.lime_fertilizer_name ?? 'Apno');
  const warnings = segs.filter(s => s.warning).map(s => `<li>Segment ${esc(s.sample_no)}: ${esc(s.warning)}</li>`).join('');
  const sum = key => segs.reduce((t, s) => t + (s[key] ?? 0), 0);
  const changedCount = plan.overridden.size + plan.lime.filter(r => r.is_overridden).length + plan.mapFactors.filter(r => r.is_overridden).length + plan.organic.filter(o => o.is_overridden).length;
  const soilNote = plan.is_followup_year ? ' <span class="fert-muted">(+1 leto)</span>' : '';
  const r2 = (v, d) => v == null ? null : roundHalfUp(v, d);
  const perHa = segs.map(s => `<tr><td class="fert-strong">${esc(s.sample_no)}</td><td class="fert-num">${esc(numFmt.format(parseNum(s.area_ha) ?? 0))}</td>
      <td class="fert-num">${esc(fmtNum(r2(s.used_ph_kcl, 2)))}</td><td class="fert-num">${esc(fmtNum(r2(s.used_p2o5, 1)))}</td><td class="fert-num">${esc(fmtNum(r2(s.used_k2o, 1)))}</td>
      <td class="fert-num">${fmtKg(s.need_p2o5_kg_ha)}</td><td class="fert-num">${fmtKg(s.need_k2o_kg_ha)}</td>
      <td class="fert-num">${fmtInt(s.p_fert_kg_ha)}</td><td class="fert-num">${fmtInt(s.k_fert_kg_ha)}</td><td class="fert-num">${fmtInt(s.lime_kg_ha)}</td></tr>`).join('');
  const totals = segs.map(s => `<tr><td class="fert-strong">${esc(s.sample_no)}</td>
      <td class="fert-num fert-col-sep">${fmtKg(s.p_fert_real_kg)}</td><td class="fert-num">${fmtKg(s.k_fert_real_kg)}</td><td class="fert-num">${fmtKg(s.lime_real_kg)}</td>
      <td class="fert-num fert-col-sep">${fmtKg(s.p_fert_map_kg)}</td><td class="fert-num">${fmtKg(s.k_fert_map_kg)}</td><td class="fert-num">${fmtKg(s.lime_map_kg)}</td></tr>`).join('');
  return `
    ${warnings ? `<div class="fert-notice fert-notice--warn"><strong>Opozorila</strong><ul class="fert-list">${warnings}</ul></div>` : ''}
    <p class="fert-hint">${changedCount ? `${changedCount} ${changedCount === 1 ? 'vrednost je spremenjena' : 'vrednosti je spremenjenih'} glede na privzete nastavitve (korak 3–4).` : 'Izračun uporablja privzete nastavitve.'}</p>
    <div class="fert-card"><h3 class="fert-card-title">Na hektar (kg/ha)</h3>
      <div class="reports-table-wrap"><table class="evidenca-table fert-table">
        <thead><tr><th>Segment</th><th class="fert-num">ha</th><th class="fert-num">pH${soilNote}</th><th class="fert-num">P₂O₅${soilNote}</th><th class="fert-num">K₂O${soilNote}</th>
          <th class="fert-num">Potreba P₂O₅</th><th class="fert-num">Potreba K₂O</th><th class="fert-num">${pName}</th><th class="fert-num">${kName}</th><th class="fert-num">${lName}</th></tr></thead>
        <tbody>${perHa}</tbody></table></div></div>
    <div class="fert-card"><h3 class="fert-card-title">Skupaj na segment (kg)</h3>
      <div class="reports-table-wrap"><table class="evidenca-table fert-table">
        <thead><tr><th></th><th colspan="3" class="fert-col-sep fert-center">Realno</th><th colspan="3" class="fert-col-sep fert-center">Mapa</th></tr>
          <tr><th>Segment</th><th class="fert-num fert-col-sep">${pName}</th><th class="fert-num">${kName}</th><th class="fert-num">${lName}</th><th class="fert-num fert-col-sep">${pName}</th><th class="fert-num">${kName}</th><th class="fert-num">${lName}</th></tr></thead>
        <tbody>${totals}</tbody>
        <tfoot><tr class="fert-total-row"><td>Skupaj</td><td class="fert-num fert-col-sep">${fmtKg(sum('p_fert_real_kg'))}</td><td class="fert-num">${fmtKg(sum('k_fert_real_kg'))}</td><td class="fert-num">${fmtKg(sum('lime_real_kg'))}</td>
          <td class="fert-num fert-col-sep">${fmtKg(sum('p_fert_map_kg'))}</td><td class="fert-num">${fmtKg(sum('k_fert_map_kg'))}</td><td class="fert-num">${fmtKg(sum('lime_map_kg'))}</td></tr></tfoot>
      </table></div></div>`;
}

function renderStepFinish() {
  const { plan } = wiz;
  return `<div class="fert-card">
    <h3 class="fert-card-title">Zaključek</h3>
    <label class="fert-field fert-field--full"><span class="field-label">Besedilo za poročilo${plan.report_edited ? '' : ' (samodejno iz organskih gnojil)'}</span>
      <textarea class="field-input fert-textarea" rows="3" data-wiz-input="report_text">${esc(plan.report_text)}</textarea></label>
    ${plan.report_edited && !wiz.readOnly ? '<div><button type="button" class="btn btn-secondary btn-sm" data-wiz="report-auto">Samodejno besedilo</button></div>' : ''}
    <label class="fert-field fert-field--full"><span class="field-label">Opombe (interno)</span>
      <textarea class="field-input fert-textarea" rows="2" data-wiz-input="notes">${esc(plan.notes)}</textarea></label>
    ${wiz.readOnly ? '' : '<p class="fert-hint">Potrjenega načrta ni več mogoče spreminjati — za spremembe naredi kopijo.</p>'}
  </div>`;
}

// ── wizard events (delegated — the body re-renders) ─────────
function markDirty() { wiz.dirty = true; }

els.views.wizard.addEventListener('click', async event => {
  if (!wiz) return;
  const { plan } = wiz;
  const t = event.target;
  const action = t.closest('[data-wiz]')?.dataset.wiz;
  const stepBtn = t.closest('[data-step]');
  if (action === 'back-to-list') { if (confirmLeaveWizard()) { wiz = null; showView('plans'); } return; }
  if (stepBtn) { if (!stepBtn.disabled) await goToStep(Number(stepBtn.dataset.step)); return; }
  if (action === 'prev') return goToStep(wiz.step - 1);
  if (action === 'next') return goToStep(wiz.step + 1);
  if (action === 'copy') return openPlan(plan.id, { copy: true });
  if (wiz.readOnly) return;
  if (action === 'save') {
    const problem = stepProblem(0, plan);
    if (problem) { wiz.notice = { kind: 'warn', text: problem }; return renderWizard(); }
    if (wiz.segmentsStale) {
      try { plan.segments = await buildSegments(plan); wiz.segmentsStale = false; }
      catch (err) { wiz.notice = { kind: 'warn', text: 'Napaka pri nalaganju segmentov: ' + err.message }; return renderWizard(); }
    }
    if (await saveAndNotify({}, 'Osnutek shranjen.')) renderWizard();
    return;
  }
  if (action === 'confirm') {
    for (let s = 0; s < STEPS.length - 1; s++) {
      const problem = stepProblem(s, plan);
      if (problem) { wiz.notice = { kind: 'warn', text: `Korak ${s + 1}: ${problem}` }; return renderWizard(); }
    }
    if (!confirm('Potrdim načrt? Potrjenega načrta ni več mogoče spreminjati.')) return;
    if (await saveAndNotify({ confirmPlan: true }, 'Načrt potrjen.')) { wiz.readOnly = true; renderWizard(); }
    return;
  }
  if (action === 'reload-segments') {
    if (!confirm('Ponovno naložim segmente in analize? Ročno popravljene površine in izbira segmentov se izgubijo.')) return;
    wiz.segmentsStale = true; markDirty(); await prepareStep(); return renderWizard();
  }
  if (action === 'reset-all') {
    plan.overridden.clear();
    plan.lime = defaultLime();
    plan.mapFactors = defaultFactors();
    for (const o of plan.organic) { const d = organicById(o.organic_fertilizer_id); if (d) Object.assign(o, { p2o5_per_unit: d.p2o5_per_unit, k2o_per_unit: d.k2o_per_unit, is_overridden: false }); }
    refreshDefaultedParams(plan); markDirty(); return renderWizard();
  }
  if (action === 'report-auto') { plan.report_edited = false; plan.report_text = reportText(plan.organic); markDirty(); return renderWizard(); }

  const toggle = t.closest('[data-wiz-toggle]');
  if (toggle) {
    if (toggle.dataset.wizToggle === 'followup') plan.is_followup_year = toggle.dataset.value === '1';
    if (toggle.dataset.wizToggle === 'straw') { plan.straw_stays = toggle.dataset.value === '1'; refreshDefaultedParams(plan); }
    markDirty(); return renderWizard();
  }
  const paramReset = t.closest('[data-param-reset]');
  if (paramReset) { plan.overridden.delete(paramReset.dataset.paramReset); refreshDefaultedParams(plan); markDirty(); return renderWizard(); }
  const orgReset = t.closest('[data-org-reset]');
  if (orgReset) {
    const o = plan.organic[Number(orgReset.dataset.orgReset)];
    const d = organicById(o?.organic_fertilizer_id);
    if (d) Object.assign(o, { p2o5_per_unit: d.p2o5_per_unit, k2o_per_unit: d.k2o_per_unit, is_overridden: false });
    markDirty(); return renderWizard();
  }
  if (t.closest('[data-org-add]')) {
    const d = defaults.organics[0];
    if (d) plan.organic.push({ organic_fertilizer_id: d.id, name: d.name, unit: d.unit, amount: null, p2o5_per_unit: d.p2o5_per_unit, k2o_per_unit: d.k2o_per_unit, is_overridden: false });
    markDirty(); return renderWizard();
  }
  const orgRemove = t.closest('[data-org-remove]');
  if (orgRemove) { plan.organic.splice(Number(orgRemove.dataset.orgRemove), 1); markDirty(); return renderWizard(); }
});

// text inputs update state without re-rendering (keeps focus); selects,
// checkboxes and finished edits ('change') re-render because other values
// shown on the step depend on them
els.views.wizard.addEventListener('input', event => {
  if (!wiz || wiz.readOnly) return;
  const { plan } = wiz;
  const t = event.target;
  if (t.dataset.wizInput === 'customer-query') {
    wiz.customerQuery = t.value;
    const pos = t.selectionStart;
    renderWizard();
    const again = els.views.wizard.querySelector('[data-wiz-input="customer-query"]');
    again?.focus();
    again?.setSelectionRange(pos, pos);
    return;
  }
  if (t.dataset.wizInput === 'expected_yield_t_per_ha') { plan.expected_yield_t_per_ha = t.value; markDirty(); return; }
  if (t.dataset.wizInput === 'report_text') { plan.report_text = t.value; plan.report_edited = true; markDirty(); return; }
  if (t.dataset.wizInput === 'notes') { plan.notes = t.value; markDirty(); return; }
  if (t.dataset.param) {
    const key = t.dataset.param;
    plan.params[key] = t.value;
    const changed = !sameNum(parseNum(t.value), parseNum(defaultParam(key, plan)));
    if (changed) plan.overridden.add(key); else plan.overridden.delete(key);
    t.closest('.fert-param')?.classList.toggle('fert-param--changed', changed);
    markDirty(); return;
  }
  if (t.dataset.seg != null && t.dataset.segField === 'area_ha') { plan.segments[Number(t.dataset.seg)].area_ha = t.value; markDirty(); return; }
  if (t.dataset.org != null && t.dataset.orgField !== 'organic_fertilizer_id') {
    const o = plan.organic[Number(t.dataset.org)];
    o[t.dataset.orgField] = t.value;
    const d = organicById(o.organic_fertilizer_id);
    o.is_overridden = !!d && (!sameNum(parseNum(o.p2o5_per_unit), d.p2o5_per_unit) || !sameNum(parseNum(o.k2o_per_unit), d.k2o_per_unit));
    markDirty(); return;
  }
  if (t.dataset.lime != null) {
    const r = plan.lime[Number(t.dataset.lime)];
    r.kg_per_ha = t.value;
    r.is_overridden = !sameNum(parseNum(t.value), defaultLimeRow(r)?.kg_per_ha);
    t.closest('.fert-tile')?.classList.toggle('fert-param--changed', r.is_overridden);
    markDirty(); return;
  }
  if (t.dataset.factor != null) {
    const r = plan.mapFactors[Number(t.dataset.factor)];
    r.factor = t.value;
    r.is_overridden = !sameNum(parseNum(t.value), defaultFactorRow(r)?.factor);
    t.closest('.fert-tile')?.classList.toggle('fert-param--changed', r.is_overridden);
    markDirty(); return;
  }
});

els.views.wizard.addEventListener('change', event => {
  if (!wiz || wiz.readOnly) return;
  const { plan } = wiz;
  const t = event.target;
  if (t.dataset.wizInput === 'customer') {
    const c = wiz.fieldSources.customers.find(x => x.id === t.value);
    Object.assign(plan, { customer_id: c?.id ?? null, customer_name: c?.name ?? '', delovni_nalog_gerk_id: null, gerk_code: null, field_id: null, field_name: null, segments: [] });
    markDirty(); return renderWizard();
  }
  if (t.dataset.line) {
    const line = wiz.fieldSources.customers.find(x => x.id === plan.customer_id)?.lines.find(l => l.lineId === t.dataset.line);
    if (!line) return;
    Object.assign(plan, { delovni_nalog_gerk_id: line.lineId, gerk_code: line.gerk_code, field_id: line.field_id, field_name: line.field_name, segments: [], declarationChecked: false });
    wiz.segmentsStale = true;
    wiz.maxStep = 0; // a different field invalidates the later steps
    markDirty(); return renderWizard();
  }
  if (t.dataset.wizInput === 'plan_date') { plan.plan_date = t.value; markDirty(); return; }
  if (t.dataset.wizInput === 'crop_id') {
    plan.crop_id = t.value || null;
    plan.crop_name = cropById(plan.crop_id)?.name ?? null;
    const defYield = cropById(plan.crop_id)?.default_yield_t_per_ha;
    if (parseNum(plan.expected_yield_t_per_ha) == null && defYield != null) plan.expected_yield_t_per_ha = defYield;
    refreshDefaultedParams(plan); markDirty(); return renderWizard();
  }
  if (t.dataset.wizInput === 'expected_yield_t_per_ha') return renderWizard(); // refresh "Odvzem kulture"
  if (t.dataset.seg != null) {
    if (t.dataset.segField === 'included') plan.segments[Number(t.dataset.seg)].included = t.checked;
    markDirty(); return renderWizard();
  }
  if (t.dataset.org != null && t.dataset.orgField === 'organic_fertilizer_id') {
    const o = plan.organic[Number(t.dataset.org)];
    const d = organicById(t.value);
    if (d) Object.assign(o, { organic_fertilizer_id: d.id, name: d.name, unit: d.unit, p2o5_per_unit: d.p2o5_per_unit, k2o_per_unit: d.k2o_per_unit, is_overridden: false });
    markDirty(); return renderWizard();
  }
  if (t.dataset.org != null) { markDirty(); return renderWizard(); } // refresh the row's "= … kg/ha" and the marker
  if (t.dataset.fertSlot) {
    const slot = t.dataset.fertSlot;
    plan[`${slot}_fertilizer_id`] = t.value;
    plan.overridden.delete(`${slot}_fertilizer_content`); // a new fertilizer starts from its own content
    refreshDefaultedParams(plan); markDirty(); return renderWizard();
  }
});
