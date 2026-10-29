import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

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
  },
  importOpenBtn: document.getElementById('fertImportOpenBtn'),
  importBackBtn: document.getElementById('fertImportBackBtn'),
  importFiles: document.getElementById('fertImportFiles'),
  importFolder: document.getElementById('fertImportFolder'),
  importNameFilter: document.getElementById('fertImportNameFilter'),
  dropzone: document.getElementById('fertDropzone'),
  importPreview: document.getElementById('fertImportPreview'),
  labSearch: document.getElementById('fertLabSearch'),
  labOnlyUnmatched: document.getElementById('fertLabOnlyUnmatched'),
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

// ── Sub-navigation ───────────────────────────────────────────
function showView(view) {
  if (view !== 'lab') labFlash = '';
  currentView = view;
  const navView = view === 'import' ? 'lab' : view; // Uvoz is a sub-screen of Analize tal
  for (const btn of els.subnavBtns) {
    const active = btn.dataset.fertView === navView;
    btn.classList.toggle('fert-subnav-btn--active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  for (const [name, el] of Object.entries(els.views)) el.hidden = name !== view;
  els.importOpenBtn.hidden = view !== 'lab';
  if (view === 'lab' && !labLoaded) loadLabResults();
  if (view === 'settings' && !settingsLoaded) loadSettings();
}

for (const btn of els.subnavBtns) btn.addEventListener('click', () => showView(btn.dataset.fertView));
// app.js's switchTab() shows/hides #panelGnojilni itself; this only needs to
// know the tab was opened, to (re)load whichever sub-view is showing.
els.tab.addEventListener('click', () => showView(currentView === 'import' ? 'import' : currentView));

// ── Analize tal: list ────────────────────────────────────────
async function loadLabResults() {
  els.labRows.innerHTML = '<tr><td colspan="13" class="fert-empty">Nalaganje …</td></tr>';
  const { data, error } = await supabase
    .from('lab_soil_result')
    .select('id, sample_no, lab_sample_code, ph_kcl, p2o5, k2o, humus_pct, mg, raw_values, notes, analysis_date, created_at, vzorec_id, '
      + 'lab_import_file(file_name, imported_at), '
      + 'delovni_nalogi_vzorci(id, sample_no, delovni_nalogi_gerki(gerk_code, delovni_nalogi(stevilka, customers(naziv, company_name))))')
    .order('created_at', { ascending: false })
    .order('sample_no')
    .limit(5000);
  if (error) {
    els.labRows.innerHTML = `<tr><td colspan="13" class="fert-empty fert-error">Napaka pri nalaganju: ${esc(error.message)}</td></tr>`;
    return;
  }
  labResults = data ?? [];
  labLoaded = true;
  renderLabResults();
}

// Column order = table order. `value` feeds the sort: numbers sort as
// numbers, text with natural number order ("9087" < "12613"); empty values
// always go last, whichever direction. Same click behavior as the work-order
// list header (first click ▲ ascending, second ▼ descending).
const labGerk = r => r.delovni_nalogi_vzorci?.delovni_nalogi_gerki;
const LAB_COLUMNS = [
  { key: 'sample',   label: 'Vzorec',        value: r => r.sample_no },
  { key: 'customer', label: 'Stranka',       value: r => labGerk(r) ? customerName(labGerk(r).delovni_nalogi?.customers) : null },
  { key: 'gerk',     label: 'GERK',          value: r => labGerk(r)?.gerk_code },
  { key: 'order',    label: 'Nalog',         value: r => labGerk(r)?.delovni_nalogi?.stevilka },
  { key: 'ph',       label: 'pH (KCl)',      value: r => r.ph_kcl, num: true },
  { key: 'p2o5',     label: 'P₂O₅',          value: r => r.p2o5, num: true },
  { key: 'k2o',      label: 'K₂O',           value: r => r.k2o, num: true },
  { key: 'humus',    label: 'Humus %',       value: r => r.humus_pct, num: true },
  { key: 'mg',       label: 'Mg',            value: r => r.mg, num: true },
  { key: 'code',     label: 'Lab. koda',     value: r => r.lab_sample_code },
  { key: 'date',     label: 'Datum analize', value: r => r.analysis_date },
  { key: 'file',     label: 'Datoteka',      value: r => r.lab_import_file?.file_name },
  { key: 'state',    label: 'Stanje',        value: r => ({ linked: 'a', multiple: 'b', unmatched: 'c' })[labMatchState(r)] },
];
let labSortKey = 'sample'; // default: Vzorec, newest (highest) sample number first (Matej, 2026-10-29)
let labSortDir = 'desc';
const textCollator = new Intl.Collator('sl', { numeric: true, sensitivity: 'base' });

function sortLabRows(rows) {
  const col = LAB_COLUMNS.find(c => c.key === labSortKey);
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
  els.labHead.innerHTML = LAB_COLUMNS.map(col => {
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
  renderLabHead();
  const query = els.labSearch.value.trim().toLowerCase();
  const onlyUnmatched = els.labOnlyUnmatched.checked;
  const unmatchedCount = labResults.filter(r => labMatchState(r) !== 'linked').length;

  els.labNotice.innerHTML = (labFlash ? `<div class="fert-notice fert-notice--ok">${esc(labFlash)}</div>` : '')
    + (unmatchedCount
      ? `<div class="fert-notice fert-notice--warn"><strong>${unmatchedCount} ${unmatchedCount === 1 ? 'rezultat ni povezan' : 'rezultatov ni povezanih'} z vzorcem.</strong> Številka vzorca iz laboratorija se ne ujema z natanko enim vzorcem v delovnih nalogih — preveri številko ali poveži ročno.</div>`
      : '');

  const rows = labResults.filter(r => {
    if (onlyUnmatched && labMatchState(r) === 'linked') return false;
    if (!query) return true;
    const g = r.delovni_nalogi_vzorci?.delovni_nalogi_gerki;
    const hay = [r.sample_no, r.lab_sample_code, g?.gerk_code, customerName(g?.delovni_nalogi?.customers), g?.delovni_nalogi?.stevilka, r.lab_import_file?.file_name].join(' ').toLowerCase();
    return hay.includes(query);
  });

  if (!rows.length) {
    els.labRows.innerHTML = `<tr><td colspan="13" class="fert-empty">${labResults.length ? 'Ni zadetkov.' : 'Še ni uvoženih rezultatov — klikni ⬆ Uvoz Excel.'}</td></tr>`;
    return;
  }

  // raw text wins for display when the lab wrote a qualifier ("<25"), so the
  // list shows what the lab reported, not just the number used in calculations
  const cell = (row, key, header) => {
    const raw = row.raw_values?.[header];
    const shown = raw != null && /[<>]/.test(String(raw)) ? String(raw) : fmtNum(row[key]);
    return `<td class="fert-num">${esc(shown)}</td>`;
  };

  els.labRows.innerHTML = sortLabRows(rows).map(r => {
    const g = r.delovni_nalogi_vzorci?.delovni_nalogi_gerki;
    const state = labMatchState(r);
    const noCode = (r.notes || '').includes(NO_CODE_NOTE)
      ? `<span class="fert-badge" title="${esc(NO_CODE_NOTE)}">Brez lab. kode</span>` : '';
    const badge = (state === 'linked'
      ? '<span class="fert-badge fert-badge--ok">Povezan</span>'
      : `<span class="fert-badge fert-badge--warn">${state === 'multiple' ? 'Več zadetkov' : 'Ni povezan'}</span>
         <button type="button" class="btn btn-secondary btn-sm fert-link-btn" data-link-id="${esc(r.id)}">Poveži</button>`) + noCode;
    const file = r.lab_import_file;
    return `<tr data-row-id="${esc(r.id)}">
      <td class="fert-strong">${esc(r.sample_no)}</td>
      <td>${esc(g ? customerName(g.delovni_nalogi?.customers) : '—')}</td>
      <td>${esc(g?.gerk_code ?? '—')}</td>
      <td>${esc(g?.delovni_nalogi?.stevilka ?? '—')}</td>
      ${cell(r, 'ph_kcl', 'pH (KCl)')}${cell(r, 'p2o5', 'P2O5')}${cell(r, 'k2o', 'K2O')}
      <td class="fert-num">${esc(fmtNum(r.humus_pct))}</td><td class="fert-num">${esc(fmtNum(r.mg))}</td>
      <td class="fert-muted">${esc(r.lab_sample_code ?? '—')}</td>
      <td>${esc(fmtDate(r.analysis_date))}</td>
      <td class="fert-muted" title="${esc(file ? 'Uvoženo ' + fmtDate(file.imported_at) : '')}">${esc(file?.file_name ?? '—')}</td>
      <td class="fert-state">${badge}</td>
    </tr>`;
  }).join('');
}

els.labSearch.addEventListener('input', renderLabResults);
els.labOnlyUnmatched.addEventListener('change', renderLabResults);

// Manual link: list every sample carrying this number and let the admin pick.
els.labRows.addEventListener('click', async event => {
  const btn = event.target.closest('[data-link-id]');
  if (btn) return openLinkPicker(btn.dataset.linkId, btn.closest('td'));
  const pick = event.target.closest('[data-pick-vzorec]');
  if (pick) return linkLabResult(pick.dataset.resultId, pick.dataset.pickVzorec);
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
