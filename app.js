import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Bump alongside sw.js's CACHE constant on every push to GitHub.
const APP_VERSION = 'v4.17';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
document.getElementById('appVersion').textContent = APP_VERSION;

// ── State ──────────────────────────────────────────────────────
let currentUser  = null;
let currentRole  = 'operator';
let currentUserName = '';
let currentOrg   = null;
// Admin-only "act as a regular user" toggle — hides admin controls
// (deletes, role editing, soft-delete, etc.) without changing what
// data is visible/queried. Remembered per device; defaults to on
// (today's behavior) the first time, so nothing changes until an
// admin explicitly switches into Regular view.
let adminViewActive = localStorage.getItem('adminViewActive') !== '0';
function isAdminView() { return currentRole === 'admin' && adminViewActive; }
let profileMap   = {};
let logs         = [];
let fields       = [];
let currentMonth = new Date().toISOString().slice(0, 7);

let currentTab       = 'nalogi'; // 'evidenca' | 'nalogi' | 'planiranje' | 'gnojilni' | 'reports'
let preReportsTab    = 'nalogi'; // which real tab to return to from Poročila — see openReportsView()
let reportsData         = []; // raw rows from get_work_orders_report(), refetched every time the view opens
let reportsStatusValues = new Set();
let reportsCustomerValues = new Set();
let selectedReportIds   = new Set();
let reportsChartGrouping = 'week'; // 'day' | 'week' — toggle above the chart, see renderReportsChart()
let reportsChartMetric   = 'time'; // 'time' | 'ha' — second toggle above the chart
let workOrders       = [];
let workOrdersLoaded = false;
let workOrderCenterPoints = {}; // work_order_id -> {lat, lng}, from get_work_orders_center_points
let workOrderDurations    = {}; // work_order_id -> total logged minutes, from get_work_orders_durations
let customers        = [];
let operatorsList    = [];

// ── DOM refs ───────────────────────────────────────────────────
const operatorNameEl = document.getElementById('operatorName');
const greetingEl     = document.getElementById('greeting');
const todayDateEl    = document.getElementById('todayDate');
const logoutBtn      = document.getElementById('logoutBtn');
const addBtn         = document.getElementById('addBtn');
const logsList       = document.getElementById('logsList');
const exportLogsBtn  = document.getElementById('exportLogsBtn');
const adminBadge = document.getElementById('adminBadge');
const locationStatusDot = document.getElementById('locationStatusDot');
const adminViewToggleWrap = document.getElementById('adminViewToggleWrap');
const adminViewToggle = document.getElementById('adminViewToggle');
const adminViewSwitchLabel = document.querySelector('#adminViewToggleWrap .admin-view-switch-label');

const monthLabel   = document.getElementById('monthLabel');
const prevMonthBtn = document.getElementById('prevMonthBtn');
const nextMonthBtn = document.getElementById('nextMonthBtn');

const formModal   = document.getElementById('formModal');
const modalTitle  = document.getElementById('modalTitle');
const modalClose  = document.getElementById('modalClose');
const woBackBtn   = document.getElementById('woBackBtn'); // phone only — same close path as modalClose
const woHeaderSummary = document.getElementById('woHeaderSummary'); // phone-only compact header line
const workLogForm = document.getElementById('workLogForm');
const woTravelTimeField = document.getElementById('woTravelTimeField'); // phone only — see layoutWoDetailSections()
const workLogOrderLabel = document.getElementById('workLogOrderLabel');
// Admin-only "assign a customer" control shown instead of
// workLogOrderLabel when the open order has no stranka_id at all —
// see updateOrderHeader()/assignCustomerToWorkOrder().
const woAssignCustomerBtn         = document.getElementById('woAssignCustomerBtn');
const woAssignCustomerWrap        = document.getElementById('woAssignCustomerWrap');
const woAssignCustomerInput       = document.getElementById('woAssignCustomerInput');
const woAssignCustomerSuggestions = document.getElementById('woAssignCustomerSuggestions');
const workLogDateInput = document.getElementById('workLogDate');
const workLogDateDisplay = document.getElementById('workLogDateDisplay');
const woDateSummary = document.getElementById('woDateSummary'); // phone-only mirror of workLogDateDisplay
const woDateEditBtn = document.getElementById('woDateEditBtn');
const woDatePanel   = document.getElementById('woDatePanel');
const woIzvajalecEdit = document.getElementById('woIzvajalecEdit');
const woPlanDateWrap = document.getElementById('woPlanDateWrap');
const woPlanDateInput = document.getElementById('woPlanDate');
const woStatusEdit = document.getElementById('woStatusEdit');
const woStatusEditBtn = document.getElementById('woStatusEditBtn'); // phone-only admin disclosure for woStatusEdit
const woStatusBadge = document.getElementById('woStatusBadge');
const woDeleteBtn = document.getElementById('woDeleteBtn');
const woRestoreBtn = document.getElementById('woRestoreBtn');
const woAddExistingGerkWrap = document.getElementById('woAddExistingGerkWrap');
const woAddExistingGerkPaste = document.getElementById('woAddExistingGerkPaste');
const woAddExistingGerkBtn = document.getElementById('woAddExistingGerkBtn');
const woImportZonesWrap = document.getElementById('woImportZonesWrap');
const woKmlInput = document.getElementById('woKmlInput');
const woImportZonesPickBtn = document.getElementById('woImportZonesPickBtn');
const woImportZonesForm = document.getElementById('woImportZonesForm');
const woImportZonesFiles = document.getElementById('woImportZonesFiles');
const woImportZonesGerkList = document.getElementById('woImportZonesGerkList');
const woImportZonesType = document.getElementById('woImportZonesType');
const woImportZonesGlobina = document.getElementById('woImportZonesGlobina');
const woImportZonesDate = document.getElementById('woImportZonesDate');
const woImportZonesConfirmBtn = document.getElementById('woImportZonesConfirmBtn');
const woImportZonesCancelBtn = document.getElementById('woImportZonesCancelBtn');
const woImportZonesError = document.getElementById('woImportZonesError');
const woDetailMap = document.getElementById('woDetailMap');
const woMapGerkLabel = document.getElementById('woMapGerkLabel');
const woMapExpandBtn = document.getElementById('woMapExpandBtn');
const woMapLayersBtn = document.getElementById('woMapLayersBtn');
const wlgCompactList = document.getElementById('wlgCompactList');
const woDetailLayoutEl = document.querySelector('.wo-detail-layout');
const woDetailMapWrapEl = document.querySelector('.wo-detail-map-wrap');
let woMapExpanded = false;
const woCapturePanel = document.getElementById('woCapturePanel');
const woCaptureBtn  = document.getElementById('woCaptureBtn');
const woCaptureError = document.getElementById('woCaptureError');
const woCaptureToast = document.getElementById('woCaptureToast');
const woCaptureShowPoints = document.getElementById('woCaptureShowPoints');
const woCaptureList = document.getElementById('woCaptureList');
const woHeaderMeta = document.getElementById('woHeaderMeta');
const roadTypeSel = document.getElementById('roadType');
const roadHourSel = document.getElementById('roadHour');
const roadMinSel  = document.getElementById('roadMin');
const roadAddBtn  = document.getElementById('roadAddBtn');
const roadCommentInput = document.getElementById('roadComment');
const roadTimeListEl = document.getElementById('roadTimeList');
const workLogGerkRowsEl = document.getElementById('workLogGerkRows');
const woGerkPagerEl       = document.getElementById('woGerkPager'); // phone-only — see updateGerkPaging()
const woGerkPagerLabelEl  = document.getElementById('woGerkPagerLabel');
const woGerkPagerPrevBtn  = document.getElementById('woGerkPagerPrev');
const woGerkPagerNextBtn  = document.getElementById('woGerkPagerNext');
const wlgSelectionBar   = document.getElementById('wlgSelectionBar');
const tractorInput = document.getElementById('tractor');
const descInput   = document.getElementById('description');
const formError   = document.getElementById('formError');
const formSuccess = document.getElementById('formSuccess');
const cancelBtn   = document.getElementById('cancelBtn');

// ── Tabs ───────────────────────────────────────────────────────
const tabBarEl        = document.querySelector('.tab-bar');
const tabEvidenca     = document.getElementById('tabEvidenca');
const tabNalogi       = document.getElementById('tabNalogi');
const tabPlaniranje   = document.getElementById('tabPlaniranje');
const tabGnojilni     = document.getElementById('tabGnojilni');
const panelEvidenca   = document.getElementById('panelEvidenca');
const panelNalogi     = document.getElementById('panelNalogi');
const panelPlaniranje = document.getElementById('panelPlaniranje');
const panelGnojilni   = document.getElementById('panelGnojilni');
const workOrdersList = document.getElementById('workOrdersList');
const woHaChipTotal = document.getElementById('woHaChipTotal');
const woHaChipIzvedeno = document.getElementById('woHaChipIzvedeno');
const woHaChipPlan = document.getElementById('woHaChipPlan');
const woHaChipTime = document.getElementById('woHaChipTime');
const woSearchStranka = document.getElementById('woSearchStranka');
const woSearchClearBtn = document.getElementById('woSearchClearBtn');
const woStatusFilterBtn  = document.getElementById('woStatusFilterBtn');
const woStatusFilterMenu = document.getElementById('woStatusFilterMenu');
let woStatusFilterValues = new Set(); // empty = no filter, show all statuses
const woSearchSuggestions = document.getElementById('woSearchSuggestions');
// Admin-view-only: shows archived (soft-deleted) orders instead of the
// normal list. Always forced back off when leaving Admin view (see the
// adminViewToggle handler), so deleted orders never show by default.
const woShowDeletedBtn = document.getElementById('woShowDeletedBtn');
let woShowDeletedActive = false;
// Admin-view-only bulk-select on the main work orders list (checkboxes
// next to each row's Št.), powering the floating woSelectionBar below —
// same pattern as selectedGerkCodes/wlgSelectionBar in the detail view.
// Not offered while browsing the "Izbrisani" list itself (nothing to
// delete there that isn't already deleted).
const woSelectionBar = document.getElementById('woSelectionBar');
let selectedWorkOrderIds = new Set();
// Map overview — available to every user, not just admins. One field
// boundary shape per GERK across the currently filtered work orders,
// colored by status. Admins can additionally narrow it to just the
// checked rows, since the bulk-select checkboxes themselves stay
// admin-only (selectedWorkOrderIds is always empty for regular
// users, so they always see the full filtered set). Shapes are
// fetched lazily on first toggle-on, not at boot — see
// loadWorkOrdersGerkShapes/ensureWoOverviewMap.
const woMapToggleBtn   = document.getElementById('woMapToggleBtn');
const woListLayout     = document.getElementById('woListLayout');
const woOverviewMapWrap = document.getElementById('woOverviewMapWrap');
const woOverviewMapEl  = document.getElementById('woOverviewMap');
const woOverviewMapLayersBtn = document.getElementById('woOverviewMapLayersBtn');
const woOverviewMapCloseBtn  = document.getElementById('woOverviewMapCloseBtn');
let woMapOverviewActive = false;
let woOverviewMap = null;
let woOverviewLabelsLayer = null; // roads/borders/place-names overlay — off by default, see ensureWoOverviewMap
let woOverviewMarkersLayer = null;
let workOrdersGerkShapes = [];
let workOrdersGerkShapesLoaded = false;
// Set by clicking a GERK/segment on the overview map — narrows the
// list on the left to just that one work order, so it can be opened.
// Cleared by woMapFilterClearBtn or by closing the map overview.
const woMapFilterBanner   = document.getElementById('woMapFilterBanner');
const woMapFilterClearBtn = document.getElementById('woMapFilterClearBtn');
let woMapClickFilterId = null;

// ── Seznam strank / Deklaracije modal refs (admin only) ──────────
const fabMenu               = document.getElementById('fabMenu');
const declModal              = document.getElementById('declModal');
const declModalClose         = document.getElementById('declModalClose');
const declListView           = document.getElementById('declListView');
const declListSearch         = document.getElementById('declListSearch');
const declCustomerList       = document.getElementById('declCustomerList');
const declDetailView         = document.getElementById('declDetailView');
const declBackBtn            = document.getElementById('declBackBtn');
const declCustomerInfo       = document.getElementById('declCustomerInfo');
const declShowDeletedBtn     = document.getElementById('declShowDeletedBtn');
let declShowDeletedActive = false;
const declDeleteCustomerBtn  = document.getElementById('declDeleteCustomerBtn');
const declRestoreCustomerBtn = document.getElementById('declRestoreCustomerBtn');
const declGenerateBtn        = document.getElementById('declGenerateBtn');
const declLinkResult         = document.getElementById('declLinkResult');
const declLinksList          = document.getElementById('declLinksList');
const declTableWrap          = document.getElementById('declTableWrap');
const declAddCustomerBtn     = document.getElementById('declAddCustomerBtn');
let declCustomerId = null;

// ── Poročila (reports) full-screen view refs ────────────────────
const panelReports            = document.getElementById('panelReports');
const reportsBackBtn          = document.getElementById('reportsBackBtn');
const reportsError            = document.getElementById('reportsError');
const reportsListWrap         = document.getElementById('reportsListWrap');
const reportsStatusFilterBtn  = document.getElementById('reportsStatusFilterBtn');
const reportsStatusFilterMenu = document.getElementById('reportsStatusFilterMenu');
const reportsOperatorFilter   = document.getElementById('reportsOperatorFilter');
const reportsDateFrom         = document.getElementById('reportsDateFrom');
const reportsDateTo           = document.getElementById('reportsDateTo');
const reportsCustomerFilterBtn   = document.getElementById('reportsCustomerFilterBtn');
const reportsCustomerFilterMenu  = document.getElementById('reportsCustomerFilterMenu');
const reportsCustomerFilterList  = document.getElementById('reportsCustomerFilterList');
const reportsCustomerSelectAllCb = document.getElementById('reportsCustomerSelectAllCb');
const reportsChartWrap        = document.getElementById('reportsChartWrap');
const reportsChipHa           = document.getElementById('reportsChipHa');
const reportsChipTracked      = document.getElementById('reportsChipTracked');
const reportsChipGap          = document.getElementById('reportsChipGap');
const reportsChipTotal        = document.getElementById('reportsChipTotal');
const reportsChipCost         = document.getElementById('reportsChipCost');

// ── Operators (Izvajalci) modal refs ────────────────────────────
const operatorsModal      = document.getElementById('operatorsModal');
const operatorsModalClose = document.getElementById('operatorsModalClose');
const operatorsListEl     = document.getElementById('operatorsList');
const operatorsErrorEl    = document.getElementById('operatorsError');
const operatorsSuccessEl  = document.getElementById('operatorsSuccess');
const operatorsAddWrap    = document.getElementById('operatorsAddWrap');
const operatorsAddToggleBtn = document.getElementById('operatorsAddToggleBtn');
const operatorsAddForm    = document.getElementById('operatorsAddForm');
const newOperatorName     = document.getElementById('newOperatorName');
const newOperatorEmail    = document.getElementById('newOperatorEmail');
const newOperatorPassword = document.getElementById('newOperatorPassword');
const newOperatorRole     = document.getElementById('newOperatorRole');
const newOperatorOrg      = document.getElementById('newOperatorOrg');
const operatorsAddConfirmBtn = document.getElementById('operatorsAddConfirmBtn');
const operatorsAddCancelBtn  = document.getElementById('operatorsAddCancelBtn');

// ── Add customer modal refs (admin: "Seznam strank" + inline from
// the work-order form's customer search when no match exists) ───
const addCustomerModal      = document.getElementById('addCustomerModal');
const addCustomerModalClose = document.getElementById('addCustomerModalClose');
const addCustomerForm       = document.getElementById('addCustomerForm');
const newCustomerNazivInput = document.getElementById('newCustomerNaziv');
const newCustomerKrajInput  = document.getElementById('newCustomerKraj');
const newCustomerCountryInput = document.getElementById('newCustomerCountry');
const addCustomerErrorEl    = document.getElementById('addCustomerError');
const addCustomerCancelBtn  = document.getElementById('addCustomerCancelBtn');
const addCustomerSaveBtn    = document.getElementById('addCustomerSaveBtn');
let addCustomerContext = null; // 'decl' | 'wo' — where to route the result after saving

// ── Map modal refs ────────────────────────────────────────────
const mapModal            = document.getElementById('mapModal');
const mapModalClose       = document.getElementById('mapModalClose');
const mapModalTitle       = document.getElementById('mapModalTitle');
const mapContainer        = document.getElementById('mapContainer');
const mapOpenExternalLink = document.getElementById('mapOpenExternalLink');

// ── Work order modal refs ───────────────────────────────────────
const workOrderModal      = document.getElementById('workOrderModal');
const woModalTitle        = document.getElementById('woModalTitle');
const woModalClose        = document.getElementById('woModalClose');
const workOrderForm       = document.getElementById('workOrderForm');
const woStevilkaLabel     = document.getElementById('woStevilkaLabel');
const woStrankaInput      = document.getElementById('woStranka');
const woStrankaIdInput    = document.getElementById('woStrankaId');
const woStrankaSuggestions = document.getElementById('woStrankaSuggestions');
const woIzvajalecSel      = document.getElementById('woIzvajalec');
const woTipSel            = document.getElementById('woTip');
const woCustomerGerksWrap = document.getElementById('woCustomerGerksWrap');
const woCustomerGerksList = document.getElementById('woCustomerGerksList');
const woNewImportZonesWrap      = document.getElementById('woNewImportZonesWrap');
const woNewKmlInput             = document.getElementById('woNewKmlInput');
const woNewImportZonesPickBtn   = document.getElementById('woNewImportZonesPickBtn');
const woNewImportZonesForm      = document.getElementById('woNewImportZonesForm');
const woNewImportZonesFiles     = document.getElementById('woNewImportZonesFiles');
const woNewImportZonesGerkList  = document.getElementById('woNewImportZonesGerkList');
const woNewImportZonesType      = document.getElementById('woNewImportZonesType');
const woNewImportZonesGlobina   = document.getElementById('woNewImportZonesGlobina');
const woNewImportZonesDate      = document.getElementById('woNewImportZonesDate');
const woNewImportZonesConfirmBtn = document.getElementById('woNewImportZonesConfirmBtn');
const woNewImportZonesCancelBtn  = document.getElementById('woNewImportZonesCancelBtn');
const woNewImportZonesError     = document.getElementById('woNewImportZonesError');
const woGerkPasteInput    = document.getElementById('woGerkPaste');
const woGerkPasteBtn      = document.getElementById('woGerkPasteBtn');
const woGerksListEl       = document.getElementById('woGerksList');
const woAddGerkBtn        = document.getElementById('woAddGerkBtn');
const woBulkDepthSel      = document.getElementById('woBulkDepth');
const woStatusSel         = document.getElementById('woStatus');
const woPodrobnostiInput  = document.getElementById('woPodrobnosti');
const woFormError         = document.getElementById('woFormError');
const woFormSuccess       = document.getElementById('woFormSuccess');
const woSaveBtn           = document.getElementById('woSaveBtn');
const woCancelBtn         = document.getElementById('woCancelBtn');

// ── Session guard ──────────────────────────────────────────────
async function initAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { window.location.replace('index.html'); return false; }
  currentUser = session.user;
  supabase.auth.onAuthStateChange((_e, s) => {
    if (!s) window.location.replace('index.html');
  });
  return true;
}

// ── Duration selects ───────────────────────────────────────────
function buildTimeOptions() {
  for (let h = 0; h <= 23; h++) roadHourSel.appendChild(new Option(String(h), String(h)));
  for (const m of ['00', '15', '30', '45']) roadMinSel.appendChild(new Option(m, m));
  roadHourSel.value = '0'; roadMinSel.value = '00';
}

function getDurationMins(hourSel, minSel) {
  return (parseInt(hourSel.value, 10) || 0) * 60 + (parseInt(minSel.value, 10) || 0);
}

// ── Date / month helpers ───────────────────────────────────────
const MONTHS_SL      = ['jan','feb','mar','apr','maj','jun','jul','avg','sep','okt','nov','dec'];
const MONTHS_SL_LONG = ['Januar','Februar','Marec','April','Maj','Junij','Julij','Avgust','September','Oktober','November','December'];

function fmtDuration(mins) {
  if (!mins || mins <= 0) return '0h';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function fmtTodayLong() {
  const d = new Date();
  return `${d.getDate()}. ${MONTHS_SL[d.getMonth()]} ${d.getFullYear()}`;
}

// ── Month navigation ───────────────────────────────────────────
function renderMonthLabel() {
  const [y, m] = currentMonth.split('-').map(Number);
  monthLabel.textContent = `${MONTHS_SL_LONG[m - 1]} ${y}`;
}

function changeMonth(delta) {
  const [y, m] = currentMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  renderMonthLabel();
  renderLogs();
}

prevMonthBtn.addEventListener('click', () => changeMonth(-1));
nextMonthBtn.addEventListener('click', () => changeMonth(1));

function filteredLogs() {
  return logs.filter(l => l.work_date.startsWith(currentMonth));
}

// ── Greeting ───────────────────────────────────────────────────
function renderGreeting(fullName) {
  const h = new Date().getHours();
  const word = h < 12 ? 'Dobro jutro' : h < 18 ? 'Dober dan' : 'Dober večer';
  greetingEl.textContent = `${word}, ${fullName.split(' ')[0]}!`;
  todayDateEl.textContent = fmtTodayLong();
}

// ── Load logs ──────────────────────────────────────────────────
async function loadLogs() {
  logsList.innerHTML = `
    <div class="state-loading">
      <div class="spinner"></div>
      <p>Nalaganje...</p>
    </div>`;

  // !inner + the dot-path filter below excludes logs belonging to an
  // archived (soft-deleted) work order — without !inner, PostgREST
  // can't apply a filter on an embedded resource as a real restriction.
  let query = supabase
    .from('work_logs')
    .select('*, work_log_gerks(*), work_log_road_time(minutes, vehicle_type), delovni_nalogi!inner(stevilka, status, deleted_at, customers(naziv, company_name))')
    .is('delovni_nalogi.deleted_at', null)
    .order('work_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (currentRole === 'admin' || currentRole === 'supervisor') {
    const { data: profs } = await supabase.from('profiles').select('id, full_name');
    profileMap = Object.fromEntries((profs ?? []).map(p => [p.id, p.full_name]));
  } else {
    profileMap = { [currentUser.id]: currentUserName };
    query = query.eq('operator_id', currentUser.id);
  }

  const { data, error } = await query;

  if (error) {
    logsList.innerHTML = `<div class="state-empty"><p>Napaka pri nalaganju. Poskusite znova.</p></div>`;
    return;
  }

  logs = data ?? [];
  renderLogs();
}

// Sums this log's road-time entries by vehicle type — work_log_road_time
// rows are per-line-item (operator can log several trips), not a single
// pre-split value like work_duration.
function roadMinutesByType(log, vehicleType) {
  return (log.work_log_road_time || [])
    .filter(r => r.vehicle_type === vehicleType)
    .reduce((s, r) => s + (r.minutes || 0), 0);
}

// ── Render: simple exportable table — Delovni nalog / Stranka / Ure
// traktor / Ure avto / Ure na polju / Datum / Status / Operater ────
function renderLogs() {
  const fl = filteredLogs();
  if (fl.length === 0) {
    logsList.innerHTML = `
      <div class="state-empty">
        <p>Ni vpisov za ta mesec.<br>Dodajte prvega s tipko <strong>+</strong></p>
      </div>`;
    return;
  }

  logsList.innerHTML = `
    <table class="evidenca-table">
      <thead>
        <tr>
          <th>Delovni nalog</th><th>Stranka</th><th>Ure traktor</th><th>Ure avto</th>
          <th>Ure na polju</th><th>Datum</th><th>Status</th><th>Operater</th>
        </tr>
      </thead>
      <tbody>
        ${fl.map(log => {
          const wo = log.delovni_nalogi;
          const stranka = wo?.customers?.naziv || wo?.customers?.company_name || '—';
          return `
          <tr>
            <td>${escHtml(wo?.stevilka ?? '—')}</td>
            <td>${escHtml(stranka)}</td>
            <td>${fmtDuration(roadMinutesByType(log, 'Traktor'))}</td>
            <td>${fmtDuration(roadMinutesByType(log, 'Avto'))}</td>
            <td>${fmtDuration(log.work_duration)}</td>
            <td>${fmtSampleDate(log.work_date)}</td>
            <td>${wo?.status ? `<span class="wo-status-badge wo-status--${slugStatus(wo.status)}">${escHtml(wo.status)}</span>` : '—'}</td>
            <td>${escHtml(profileMap[log.operator_id] ?? '—')}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ── Export: current month's filtered rows, decimal hours (payroll/
// spreadsheet friendly rather than the on-screen "2h 30m" format). ──
function exportLogsCSV() {
  const fl = filteredLogs();
  const csvEscape = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [
    ['Delovni nalog', 'Stranka', 'Ure traktor', 'Ure avto', 'Ure na polju', 'Datum', 'Status', 'Operater'],
    ...fl.map(log => {
      const wo = log.delovni_nalogi;
      return [
        wo?.stevilka ?? '—',
        wo?.customers?.naziv || wo?.customers?.company_name || '—',
        (roadMinutesByType(log, 'Traktor') / 60).toFixed(2),
        (roadMinutesByType(log, 'Avto') / 60).toFixed(2),
        (log.work_duration / 60).toFixed(2),
        fmtSampleDate(log.work_date),
        wo?.status ?? '—',
        profileMap[log.operator_id] ?? '—',
      ];
    }),
  ];
  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `evidenca-dela-${currentMonth}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

exportLogsBtn.addEventListener('click', exportLogsCSV);

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Modal show/hide (shared by all 6 .modal-backdrop dialogs) ────
// Must match --duration-slow in style.css — kept as a plain constant
// here rather than read from CSS since there's no cheap way to pull a
// computed transition-duration back into a setTimeout delay.
const MODAL_CLOSE_MS = 300;

// Sets hidden=false synchronously (some callers measure/init layout —
// Leaflet maps, focus() — right after calling this, which needs the
// element already unhidden) and defers adding the class that actually
// fades/slides it in to the next paint, so the browser has a "from"
// state (hidden's initial opacity:0/translateY) to transition from
// instead of jumping straight to visible.
function showModalAnimated(el) {
  el.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('modal-backdrop--visible')));
}

// Reverse: starts the fade/slide-out immediately, then waits for it to
// finish before setting hidden=true — an instant `hidden = true` skips
// straight to display:none, which can't be transitioned.
function hideModalAnimated(el) {
  el.classList.remove('modal-backdrop--visible');
  setTimeout(() => { el.hidden = true; }, MODAL_CLOSE_MS);
}

// ── Tractor history (localStorage) ────────────────────────────
function getTractorHistory() {
  return JSON.parse(localStorage.getItem('wt_tractors') || '[]');
}
function saveTractorToHistory(name) {
  if (!name) return;
  const list = getTractorHistory().filter(t => t !== name);
  list.unshift(name);
  localStorage.setItem('wt_tractors', JSON.stringify(list.slice(0, 15)));
}
function updateTractorDatalist() {
  const dl = document.getElementById('tractorList');
  if (dl) dl.innerHTML = getTractorHistory().map(t => `<option value="${escHtml(t)}">`).join('');
}

// ── GERK autocomplete ──────────────────────────────────────────
// Reads WorkTracker's own fields table (not the CRM's FIELD) — the two
// were consolidated so there's a single source of truth for what fields
// exist. See supabase/migration_import_field_only_rows.sql.
async function loadFields() {
  // PostgREST caps a single response at 1000 rows; fields is well past
  // that (5000+), so this has to page through in batches or everything
  // past the 1000th row (alphabetically, by name) silently vanishes
  // from the client — including its map pin.
  const pageSize = 1000;
  const data = [];
  for (let from = 0; ; from += pageSize) {
    const { data: page } = await supabase
      .from('fields')
      .select('cadastre_id, name, area_ha, centroid_lat, centroid_lng, customers(naziv, company_name)')
      .is('deleted_at', null)
      .order('name')
      .range(from, from + pageSize - 1);
    if (!page?.length) break;
    data.push(...page);
    if (page.length < pageSize) break;
  }
  const seen = new Set();
  fields = data
    .filter(f => f.cadastre_id)
    .map(f => ({
      code:     f.cadastre_id,
      name:     f.name ?? null,
      area:     f.area_ha ?? null,
      lat:      f.centroid_lat ?? null,
      lng:      f.centroid_lng ?? null,
      customer: f.customers?.naziv || f.customers?.company_name || null,
    }))
    .filter(f => { if (seen.has(f.code)) return false; seen.add(f.code); return true; });
}

function filterFields(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  return fields
    .filter(f =>
      f.code.toLowerCase().includes(q) ||
      (f.name     && f.name.toLowerCase().includes(q)) ||
      (f.customer && f.customer.toLowerCase().includes(q))
    )
    .slice(0, 8);
}

function attachGerkAutocomplete(inputEl, suggestionsEl, hintEl, onSelect) {
  inputEl.addEventListener('input', () => {
    hintEl.hidden = true;
    showSuggestionsInto(suggestionsEl, filterFields(inputEl.value.trim()));
  });
  inputEl.addEventListener('focus', () => {
    if (inputEl.value.trim()) showSuggestionsInto(suggestionsEl, filterFields(inputEl.value.trim()));
  });
  inputEl.addEventListener('blur', () => {
    setTimeout(() => { suggestionsEl.hidden = true; }, 150);
  });
  suggestionsEl.addEventListener('mousedown', e => {
    const item = e.target.closest('.gerk-suggestion-item');
    if (!item) return;
    const code = item.dataset.code;
    inputEl.value = code;
    suggestionsEl.hidden = true;
    const f = fields.find(f => f.code === code);
    if (f) {
      const parts = [f.name, f.customer, f.area ? `${f.area} ha` : null].filter(Boolean);
      if (parts.length) { hintEl.textContent = parts.join(' · '); hintEl.hidden = false; }
      if (onSelect) onSelect(f);
    }
  });
}

function showSuggestionsInto(suggestionsEl, matches) {
  if (!matches.length) { suggestionsEl.hidden = true; return; }
  suggestionsEl.innerHTML = matches.map(f => {
    const meta = [f.name, f.customer, f.area ? `${f.area} ha` : null].filter(Boolean);
    return `
      <li class="gerk-suggestion-item" data-code="${escHtml(f.code)}">
        <span class="gerk-suggestion-code">${escHtml(f.code)}</span>
        ${meta.length ? `<span class="gerk-suggestion-meta">${escHtml(meta.join(' · '))}</span>` : ''}
      </li>`;
  }).join('');
  suggestionsEl.hidden = false;
}

function addGerkRow(container = woGerksListEl, code = '', hectares = '', lokacija = '') {
  const row = document.createElement('div');
  row.className = 'gerk-row';
  row.innerHTML = `
    <div class="gerk-row-main">
      <div class="gerk-wrap">
        <input type="text" class="field-input gerk-code-input"
               placeholder="GERK številka ali ime" autocomplete="off">
        <ul class="gerk-suggestions" hidden></ul>
        <p class="field-hint gerk-hint" hidden></p>
      </div>
      <input type="number" class="field-input gerk-ha-input"
             placeholder="ha" step="0.0001" min="0" max="9999">
      <button type="button" class="gerk-remove-btn" aria-label="Odstrani">✕</button>
    </div>
    <input type="text" class="field-input gerk-lokacija-input"
           placeholder="Lokacija (npr. GPS koordinate)" autocomplete="off">
    <div class="gerk-segments-section">
      <button type="button" class="wlg-samples-toggle gerk-segments-toggle" data-action="gerk-segments-toggle">
        <span class="gerk-segments-count">0 segmentov</span>
        <span class="wlg-samples-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="wlg-samples-panel gerk-segments-panel" hidden>
        <div class="gerk-segments-list"></div>
        <button type="button" class="btn btn-secondary btn-sm gerk-segment-add" data-action="gerk-segment-add">+ Dodaj segment</button>
      </div>
    </div>`;

  const codeInput     = row.querySelector('.gerk-code-input');
  const haInput       = row.querySelector('.gerk-ha-input');
  const lokacijaInput = row.querySelector('.gerk-lokacija-input');
  const suggestionsEl = row.querySelector('.gerk-suggestions');
  const hintEl        = row.querySelector('.gerk-hint');
  const removeBtn     = row.querySelector('.gerk-remove-btn');

  codeInput.value = code;
  if (hectares !== '' && hectares != null) haInput.value = hectares;
  if (lokacija) lokacijaInput.value = lokacija;

  if (code) {
    const f = fields.find(f => f.code === code);
    if (f) {
      const parts = [f.name, f.customer, f.area ? `${f.area} ha` : null].filter(Boolean);
      if (parts.length) { hintEl.textContent = parts.join(' · '); hintEl.hidden = false; }
    }
  }

  attachGerkAutocomplete(codeInput, suggestionsEl, hintEl, f => {
    if (f.area != null && !haInput.value) haInput.value = f.area;
  });

  removeBtn.addEventListener('click', () => {
    // If this code is also checked in the customer GERK checklist,
    // uncheck it too — otherwise the checklist would claim it's still
    // included after the row backing it is gone.
    const codeNow = codeInput.value.trim();
    if (codeNow && container === woGerksListEl) {
      const cb = woCustomerGerksList.querySelector(`.wo-gerk-checkbox[data-code="${CSS.escape(codeNow)}"]`);
      if (cb) cb.checked = false;
    }
    row.remove();
    if (!container.querySelector('.gerk-row')) addGerkRow(container);
  });

  row.querySelector('[data-action="gerk-segments-toggle"]').addEventListener('click', e => {
    const panel = row.querySelector('.gerk-segments-panel');
    panel.hidden = !panel.hidden;
    e.currentTarget.classList.toggle('wlg-samples-toggle--open', !panel.hidden);
  });
  row.querySelector('[data-action="gerk-segment-add"]').addEventListener('click', () => {
    addGerkSegmentRow(row);
    updateGerkSegmentsCount(row);
  });

  container.appendChild(row);
  return codeInput;
}

// One FMS + Sample no + Vzorčenje line inside a GERK row's (initially
// collapsed) segments panel — filled from the Excel paste, or added/
// edited by hand. Vzorčenje is per-segment (unlike Globina, which is
// bulk-applied to the whole order at save time) since a paste can
// genuinely mix "ne pobereš"/"združi_1"/etc. across different segments.
function addGerkSegmentRow(row, fms = '', sampleNo = '', vzorcenje = '', areaHa = null) {
  const list = row.querySelector('.gerk-segments-list');
  const segRow = document.createElement('div');
  segRow.className = 'gerk-segment-row';
  // areaHa (a KML-imported zone's own polygon area) has no visible input —
  // the form only shows FMS/Sample no/Vzorčenje — but needs to survive
  // through to the final insert so export can report it per segment, so
  // it's carried as a dataset value instead.
  segRow.dataset.areaHa = areaHa != null ? areaHa : '';
  const vzorcenjeOpts = ['<option value="">Vzorčenje…</option>']
    .concat(SAMPLE_ACTIONS.map(a => `<option value="${escHtml(a)}">${escHtml(a)}</option>`))
    .join('');
  segRow.innerHTML = `
    <input type="text" class="sample-field-input gerk-segment-fms" placeholder="FMS">
    <input type="text" class="sample-field-input gerk-segment-sample" placeholder="Segment št.">
    <select class="sample-field-input gerk-segment-vzorcenje">${vzorcenjeOpts}</select>
    <button type="button" class="gerk-segment-remove" aria-label="Odstrani segment">✕</button>`;
  segRow.querySelector('.gerk-segment-fms').value = fms;
  segRow.querySelector('.gerk-segment-sample').value = sampleNo;
  segRow.querySelector('.gerk-segment-vzorcenje').value = vzorcenje;
  segRow.querySelector('.gerk-segment-remove').addEventListener('click', () => {
    segRow.remove();
    updateGerkSegmentsCount(row);
  });
  list.appendChild(segRow);
}

function updateGerkSegmentsCount(row) {
  const n = row.querySelectorAll('.gerk-segment-row').length;
  row.querySelector('.gerk-segments-count').textContent = `${n} ${n === 1 ? 'segment' : 'segmentov'}`;
}

// Appends a batch of parsed {fms, sampleNo} segments to a GERK row's
// panel (deduped against what's already there by sample_no — pasting
// the same range twice, or a code that also matched a manual add,
// shouldn't produce duplicate lines), expands the panel so they're
// immediately visible, and refreshes the count label.
function addGerkSegments(row, segments) {
  if (!segments.length) return;
  const existing = new Set(
    Array.from(row.querySelectorAll('.gerk-segment-sample')).map(el => el.value.trim())
  );
  for (const { fms, sampleNo, vzorcenje, areaHa } of segments) {
    if (!sampleNo || existing.has(sampleNo)) continue;
    addGerkSegmentRow(row, fms, sampleNo, vzorcenje, areaHa ?? null);
    existing.add(sampleNo);
  }
  updateGerkSegmentsCount(row);
  const panel = row.querySelector('.gerk-segments-panel');
  panel.hidden = false;
  row.querySelector('.gerk-segments-toggle').classList.add('wlg-samples-toggle--open');
}

// Shared by the create-order form's paste button AND an existing order's
// "+ Dodaj GERK-e" (manual add) — same accepted formats either way: a
// plain code list (comma/semicolon-separated, or one code[+ha] pasted
// per Excel row), or the lab's 4+ column "GERK/Ha/FMS/Sample no[/
// Vzorčenje]" segment sheet. Returns [{ code, hectares, segments }] —
// segments is null for a plain code-list paste, an array of
// {fms, sampleNo, vzorcenje} for a segment-sheet paste. Each caller
// applies these to its own target (in-memory form rows vs. direct DB
// inserts) — only the parsing is shared.
function parseGerkPasteText(text) {
  // Don't trim whole lines here — a continuation row copied out of a
  // lab's 4-column sheet ("GERK/Ha/FMS/Sample no") is literally
  // "\t\t\t11722" (blank GERK/Ha/FMS, only the sample number), and
  // trimming would eat those leading tabs and destroy which column
  // the "11722" actually came from.
  const rawLines = text.split('\n').filter(l => l.trim() !== '');
  if (!rawLines.length) return [];

  // A header row ("GERK  Ha  FMS  Sample no") has a non-numeric Ha
  // (2nd) cell — drop it rather than choke on it as a bogus GERK entry.
  let lines = rawLines;
  const firstHa = (lines[0].split('\t')[1] || '').trim();
  if (firstHa && !/^\d+([.,]\d+)?$/.test(firstHa)) lines = lines.slice(1);

  // 4+ tab-separated cells on any row means this is the lab's GERK +
  // segment sheet, not a plain code (+ha) list.
  const isSegmentPaste = lines.some(l => l.split('\t').length >= 4);

  if (isSegmentPaste) {
    // GERK/Ha/FMS are blank on every row but a group's first (merged-cell
    // style paste) — carry the last-seen value forward. Sample no is
    // the only cell that's always present. Cell 5 (optional) is the
    // lab's pooling instruction — "združi 1", "ne pobereš"... —
    // normalized to match SAMPLE_ACTIONS exactly.
    const codesInOrder = [];
    const segmentsByCode = new Map();
    const haByCode = new Map();
    let lastCode = null, lastFms = null;
    for (const line of lines) {
      const cells = line.split('\t');
      const code = (cells[0] || '').trim();
      const ha   = (cells[1] || '').trim();
      const fms  = (cells[2] || '').trim();
      const sampleNo = (cells[3] || '').trim();
      const vzorcenje = normalizeZdruzi((cells[4] || '').trim());
      if (!sampleNo) continue;
      if (code) { lastCode = code; if (ha) haByCode.set(code, ha); }
      if (fms)  lastFms  = fms;
      if (!lastCode) continue;
      if (!segmentsByCode.has(lastCode)) { segmentsByCode.set(lastCode, []); codesInOrder.push(lastCode); }
      segmentsByCode.get(lastCode).push({ fms: lastFms || null, sampleNo, vzorcenje });
    }
    return codesInOrder.map(code => ({
      code,
      hectares: haByCode.get(code) ? haByCode.get(code).replace(',', '.') : null,
      segments: segmentsByCode.get(code),
    }));
  }

  // Plain code list (comma/semicolon-separated, or one code[+ha] per line).
  const entries = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.includes('\t')) {
      const [code, hectares] = line.split('\t').map(s => s.trim());
      // Slovenian Excel exports use a comma decimal separator, but
      // <input type="number"> only accepts a period — silently rejects
      // "2,5" otherwise, leaving the field empty with no explanation.
      if (code) entries.push({ code, hectares: hectares ? hectares.replace(',', '.') : null, segments: null });
    } else {
      line.split(/[,;]/).map(s => s.trim()).filter(Boolean)
        .forEach(code => entries.push({ code, hectares: null, segments: null }));
    }
  }
  return entries;
}

function getFormGerks(container = woGerksListEl) {
  return Array.from(container.querySelectorAll('.gerk-row')).map(row => ({
    code:     row.querySelector('.gerk-code-input').value.trim(),
    hectares: row.querySelector('.gerk-ha-input').value
              ? parseFloat(row.querySelector('.gerk-ha-input').value) : null,
    lokacija: row.querySelector('.gerk-lokacija-input').value.trim() || null,
    segments: Array.from(row.querySelectorAll('.gerk-segment-row')).map(sr => ({
      fms:       sr.querySelector('.gerk-segment-fms').value.trim() || null,
      sampleNo:  sr.querySelector('.gerk-segment-sample').value.trim(),
      vzorcenje: sr.querySelector('.gerk-segment-vzorcenje').value || null,
      areaHa:    sr.dataset.areaHa ? parseFloat(sr.dataset.areaHa) : null,
    })).filter(s => s.sampleNo),
  })).filter(g => g.code);
}

// ── Work log GERK entry table (fixed to the work order's fields) ──
// Rows = the work order's planned fields, plus any field today's log
// already carries but the current plan no longer lists.
// Every fetched entry that ISN'T "me, on the date currently being viewed"
// (that one is already represented by the row's own Start/Konec state) —
// grouped by GERK so each row can show who else has worked it, and when.
function otherGerkEntriesByCode() {
  const map = {};
  for (const e of currentAllGerkEntries) {
    const wl = e.work_logs;
    if (wl.operator_id === currentUser.id && wl.work_date === currentDetailDate) continue;
    (map[e.gerk_code] ??= []).push(e);
  }
  return map;
}

// A field counts as "locked" the moment ANY start/end time exists for
// it — logged by anyone, on any date — not just the current viewer's
// own entry for the date currently being looked at. Without this,
// Start/Konec stayed clickable forever (start_gerk/end_gerk always
// overwrite start_time/end_time/duration unconditionally) and a
// re-click silently wiped whatever had already been recorded, and an
// admin who hadn't logged anything themselves never saw a row as
// "done" even once someone else genuinely finished it.
function lockedEntryFor(mine, others) {
  if (mine?.start_time) return mine;
  return others.find(o => o.completed) || others.find(o => o.start_time) || null;
}

function buildGerkPlanRows(workOrder, todaysGerks) {
  const planFields = workOrder?.delovni_nalogi_gerki || [];
  const logByCode   = Object.fromEntries((todaysGerks || []).map(g => [g.gerk_code, g]));
  const othersByCode = otherGerkEntriesByCode();

  const rows = planFields.map(pf => {
    const mine   = logByCode[pf.gerk_code];
    const others = othersByCode[pf.gerk_code] || [];
    const locked = lockedEntryFor(mine, others);
    // When the locked entry came from someone else (not "mine"), carry
    // its real owner/date so an admin editing it doesn't default the
    // edit panel to the currently-viewed date/operator — see saveGerkEdit.
    const lockedOther = locked && locked !== mine ? locked : null;
    return {
      code:      pf.gerk_code,
      gerkId:    pf.id,
      tipLabAnalize: pf.tip_lab_analize ?? null,
      hectares:  pf.kolicina_ha ?? mine?.hectares ?? null,
      lokacija:  pf.lokacija ?? null,
      startTime: locked?.start_time ?? null,
      endTime:   locked?.end_time ?? null,
      duration:  locked?.duration ?? null,
      completed: locked?.completed ?? false,
      ownerId:   lockedOther?.work_logs?.operator_id ?? null,
      ownerDate: lockedOther?.work_logs?.work_date ?? null,
      canEnd:    !!mine?.start_time && !mine?.completed,
      samples:   pf.delovni_nalogi_vzorci || [],
      otherEntries: others,
    };
  });

  const planCodes = new Set(planFields.map(pf => pf.gerk_code));
  (todaysGerks || []).filter(g => !planCodes.has(g.gerk_code)).forEach(g => {
    const others = othersByCode[g.gerk_code] || [];
    const locked = lockedEntryFor(g, others);
    const lockedOther = locked && locked !== g ? locked : null;
    rows.push({
      code: g.gerk_code, hectares: g.hectares, lokacija: null,
      startTime: locked?.start_time ?? null, endTime: locked?.end_time ?? null,
      duration: locked?.duration ?? null, completed: locked?.completed ?? false,
      ownerId:   lockedOther?.work_logs?.operator_id ?? null,
      ownerDate: lockedOther?.work_logs?.work_date ?? null,
      canEnd: !!g.start_time && !g.completed,
      samples: [],
      otherEntries: others,
    });
  });

  return rows;
}

function fmtHM(mins) {
  if (!mins) return '0m';
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Local HH:MM for display next to the Start/Konec buttons.
function fmtClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Short d.m.yyyy for the samples panel; dash for unset dates (common in
// the historical import — sampling/sending dates weren't always recorded).
function fmtSampleDate(isoDate) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(d, 10)}.${parseInt(m, 10)}.${y}`;
}

// Day.month only, no year — for chart axis labels where space is tight.
function fmtDayMonth(isoDate) {
  const [, m, d] = isoDate.split('-');
  return `${parseInt(d, 10)}.${parseInt(m, 10)}.`;
}

// Monday (ISO week start) of the week containing isoDate, as YYYY-MM-DD —
// used to bucket the Poročila chart into weekly bars.
function isoWeekStartStr(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  const dayIdx = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setDate(d.getDate() - dayIdx);
  return d.toISOString().slice(0, 10);
}

// First of the month containing isoDate, as YYYY-MM-01 — used to bucket
// the Poročila chart into monthly bars. String-sortable like the day/week keys.
function monthStartStr(isoDate) {
  return isoDate.slice(0, 7) + '-01';
}

const SLO_MONTHS_SHORT = ['jan.', 'feb.', 'mar.', 'apr.', 'maj', 'jun.', 'jul.', 'avg.', 'sep.', 'okt.', 'nov.', 'dec.'];
const SLO_MONTHS_FULL = ['januar', 'februar', 'marec', 'april', 'maj', 'junij', 'julij', 'avgust', 'september', 'oktober', 'november', 'december'];
function fmtMonthShort(isoDate) {
  const [y, m] = isoDate.split('-');
  return `${SLO_MONTHS_SHORT[parseInt(m, 10) - 1]} ${y}`;
}
function fmtMonthFull(isoDate) {
  const [y, m] = isoDate.split('-');
  return `${SLO_MONTHS_FULL[parseInt(m, 10) - 1]} ${y}`;
}

// workLogDateInput's value, mirrored into #workLogDateDisplay in the
// Slovenian d.m.yyyy format (see the overlay comment on #workLogDate in
// app.html) — every place that sets workLogDateInput.value goes through
// this instead, so the overlay never falls out of sync with it.
function setWorkLogDate(value) {
  workLogDateInput.value = value;
  updateWorkLogDateDisplay();
}
function updateWorkLogDateDisplay() {
  workLogDateDisplay.textContent = fmtSampleDate(workLogDateInput.value);
  woDateSummary.textContent = workLogDateDisplay.textContent; // phone-only mirror
  if (currentDetailWorkOrder) buildWoHeaderSummary();
}

// Phone-only tap-to-edit: date/status show as plain text in the compact
// header, with a pencil revealing the real control — same disclosure
// pattern as toggleGerkEdit()/.wlg-edit-panel, just for the header fields.
function toggleWoDateEdit() {
  woDatePanel.hidden = !woDatePanel.hidden;
}
woDateEditBtn.addEventListener('click', toggleWoDateEdit);

let woStatusPanelOpen = false;
woStatusEditBtn.addEventListener('click', () => {
  woStatusPanelOpen = !woStatusPanelOpen;
  woStatusEdit.hidden = !woStatusPanelOpen;
});

// Compact "123/Customer/izvaja: Name/16.10.2026/v delu" line — phone only
// (hidden via CSS on desktop). Built from the same data the full fields
// already show, so it can't drift out of sync with them.
function buildWoHeaderSummary() {
  const wo = currentDetailWorkOrder;
  if (!wo) return;
  const customer = wo.customers?.naziv || wo.customers?.company_name || '—';
  const izvaja = wo.profiles?.full_name || '-';
  woHeaderSummary.textContent = `${wo.stevilka || ''}/${customer}/izvaja: ${izvaja}/${workLogDateDisplay.textContent}/${wo.status}`;
}

// Same, but as a value an <input type="time"> will accept.
function toTimeInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── Vzorčenje (sampling_note) action / sampling depth ──
// Both set once, by an admin, when a segment is added (the "+ Dodaj
// segment" form in renderSamplesSection) — read-only everywhere else,
// including in the table itself, for everyone.
//
// The action concept lives in sampling_note, not a separate column —
// that's already where "ne pobereš" shows up 251 times from the
// original import. "združi" (bare, no group number, 148 rows) is kept
// as its own option alongside združi_1..5: the original Excel used
// cell color to show which segments group together, and only the
// word itself survived the import, not which group — so these rows
// genuinely don't have a group number to default to.
const SAMPLE_ACTIONS = ['ne pobereš', 'združi', 'združi_1', 'združi_2', 'združi_3', 'združi_4', 'združi_5'];
const SAMPLE_DEPTHS  = [12, 20, 25, 30, 60, 90];

// Lab sheets paste "združi 1" (space) — SAMPLE_ACTIONS uses "združi_1"
// (underscore) to double as a valid CSS-free <option value>. Anything
// that isn't "združi <n>" (e.g. "ne pobereš", or already underscored)
// passes through untouched.
function normalizeZdruzi(raw) {
  if (!raw) return '';
  const m = raw.match(/^združi\s+(\d+)$/i);
  return m ? `združi_${m[1]}` : raw;
}

woBulkDepthSel.innerHTML = '<option value="">Globina…</option>' +
  SAMPLE_DEPTHS.map(d => `<option value="${d}">${d} cm</option>`).join('');

// Read-only everywhere, including for admins — set once when the
// segment is added (see the "+ Dodaj segment" form), never edited
// afterward in this table.
function renderSampleNoCell(s) {
  if (!isAdminView()) return escHtml(s.sample_no);
  return `<input type="text" class="sample-field-input wlg-sampleno-input" data-sample-id="${escHtml(s.id)}" value="${escHtml(s.sample_no)}">`;
}

function renderSamplingCell(s) {
  if (!isAdminView()) return s.sampling_note ? escHtml(s.sampling_note) : fmtSampleDate(s.sampling_date);
  const opts = ['<option value="">—</option>']
    .concat(SAMPLE_ACTIONS.map(a => `<option value="${escHtml(a)}"${s.sampling_note === a ? ' selected' : ''}>${escHtml(a)}</option>`))
    .join('');
  return `<select class="sample-field-input wlg-vzorcenje-select" data-sample-id="${escHtml(s.id)}">${opts}</select>`;
}

// Tip LAB analize — one per GERK-on-this-work-order (not per segment;
// a GERK can carry several segments/samples, but only one analysis
// type covers all of them). Admin-write via "Admins can manage work
// order fields", same as everything else at this level (kolicina_ha,
// lokacija).
const LAB_ANALYSIS_TYPES = ['basic', 'micro elements'];

function renderGerkLabTypeCell(r) {
  if (!r.gerkId) return '';
  if (!isAdminView()) {
    return r.tipLabAnalize ? `<span class="wlg-lab-type">${escHtml(r.tipLabAnalize)}</span>` : '';
  }
  const opts = ['<option value="">-</option>']
    .concat(LAB_ANALYSIS_TYPES.map(v => `<option value="${escHtml(v)}"${r.tipLabAnalize === v ? ' selected' : ''}>${escHtml(v)}</option>`))
    .join('');
  return `<select class="wlg-lab-type-select sample-field-input" data-gerk-row-id="${escHtml(r.gerkId)}">${opts}</select>`;
}

async function updateGerkLabType(selectEl) {
  const gerkId = selectEl.dataset.gerkRowId;
  const value  = selectEl.value || null;
  selectEl.disabled = true;
  try {
    const { error } = await supabase.from('delovni_nalogi_gerki').update({ tip_lab_analize: value }).eq('id', gerkId);
    if (error) throw error;
    const gerk = (currentDetailWorkOrder.delovni_nalogi_gerki || []).find(g => g.id === gerkId);
    if (gerk) gerk.tip_lab_analize = value;
  } catch (e) {
    showFormError('Napaka pri shranjevanju.');
  } finally {
    selectEl.disabled = false;
  }
}

// Read-only, same reasoning as renderSamplingCell — set once at entry.
function renderSampleDepthCell(s) {
  if (!isAdminView()) return s.sampling_depth_cm ? `${s.sampling_depth_cm} cm` : '—';
  const opts = ['<option value="">—</option>']
    .concat(SAMPLE_DEPTHS.map(d => `<option value="${d}"${s.sampling_depth_cm === d ? ' selected' : ''}>${d} cm</option>`))
    .join('');
  return `<select class="sample-field-input wlg-globina-select" data-sample-id="${escHtml(s.id)}">${opts}</select>`;
}

// Free-text, editable by every user (unlike the other sample-field
// cells, e.g. renderSampleNoCell, which stay admin-only) — short note
// about this specific segment (e.g. why it was skipped, a field
// observation). Written via the update_sample_comment RPC rather than
// a direct .update(), since regular users have no RLS UPDATE policy
// on delovni_nalogi_vzorci at all otherwise — see
// migration_update_sample_comment_rpc.sql.
// "Don't collect this one" markers from the lab/field — flagged
// visually (red) so it isn't missed while scanning a long segment list.
function isNoCollectComment(comment) {
  if (!comment) return false;
  const norm = comment.trim().toLowerCase();
  return norm === 'ne' || norm === 'ne pobereš' || norm === 'ne poberes';
}

// Same "don't collect" signal, but from the Vzorčenje field itself
// (sampling_note — a controlled SAMPLE_ACTIONS value, "ne pobereš" being
// one of them) rather than the free-text Opomba comment. Either one
// flags the segment — a sampler marking it via Vzorčenje is just as
// real a "skip this one" as writing it in the comment.
function isNoCollectSample(s) {
  return isNoCollectComment(s.comment) || s.sampling_note === 'ne pobereš';
}

function renderSampleCommentCell(s) {
  const flagClass = isNoCollectComment(s.comment) ? ' wlg-comment-input--flagged' : '';
  return `<input type="text" class="sample-field-input wlg-comment-input${flagClass}" data-sample-id="${escHtml(s.id)}" value="${escHtml(s.comment || '')}" maxlength="200">`;
}


// Phone (max-width:899px) vs desktop — the app's one real breakpoint
// (style.css has a matching comment at its own phone-only block). Used
// wherever a layout decision needs JS, not just CSS.
function isMobile() {
  return window.matchMedia('(max-width: 899px)').matches;
}

// Phone only: moves #woTravelTimeField above the map and #roadComment
// (its opomba input) to right below the map, as direct children of
// .wo-detail-layout alongside the map wrap and #workLogForm — matching
// what Matej asked for after seeing the fullscreen phone layout in
// practice. Desktop resets both back to their original nested position
// inside #workLogForm (first child, with #roadComment restored as
// #woTravelTimeField's own last child) — real DOM moves, not CSS
// order, since they cross levels of nesting that CSS order can't reach.
// Idempotent (insertBefore/appendChild just no-op if already placed),
// so it's safe to call on every openWorkOrderDetail() regardless of
// where either element currently sits.
function layoutWoDetailSections() {
  const layout  = document.querySelector('.wo-detail-layout');
  const mapWrap = document.querySelector('.wo-detail-map-wrap');
  if (isMobile()) {
    layout.insertBefore(woTravelTimeField, mapWrap);
    layout.insertBefore(roadCommentInput, workLogForm);
  } else {
    workLogForm.insertBefore(woTravelTimeField, workLogForm.firstChild);
    woTravelTimeField.appendChild(roadCommentInput);
  }
}

// Phone-only: shows one .wlg-row at a time (filling the remaining screen
// height via CSS) instead of a scrollable list, with ↑/↓ paging. Desktop,
// an expanded map, or an empty list all just show everything normally —
// this never touches which rows exist, only their `hidden` attribute, so
// every existing per-row interaction (start/end, edit panel, samples,
// admin multi-select) keeps working completely unchanged.
let woGerkPageIndex = 0;
function updateGerkPaging() {
  const rows = Array.from(workLogGerkRowsEl.querySelectorAll('.wlg-row'));
  const n = rows.length;
  if (!isMobile() || woMapExpanded || !n) {
    rows.forEach(r => { r.hidden = false; });
    woGerkPagerEl.hidden = true;
    return;
  }
  if (woGerkPageIndex >= n) woGerkPageIndex = n - 1;
  rows.forEach((r, i) => { r.hidden = i !== woGerkPageIndex; });
  woGerkPagerEl.hidden = n <= 1;
  woGerkPagerLabelEl.textContent = `${woGerkPageIndex + 1}/${n}`;
  woGerkPagerPrevBtn.disabled = woGerkPageIndex === 0;
  woGerkPagerNextBtn.disabled = woGerkPageIndex === n - 1;
}
woGerkPagerPrevBtn.addEventListener('click', () => {
  if (woGerkPageIndex > 0) { woGerkPageIndex--; updateGerkPaging(); }
});
woGerkPagerNextBtn.addEventListener('click', () => {
  const n = workLogGerkRowsEl.querySelectorAll('.wlg-row').length;
  if (woGerkPageIndex < n - 1) { woGerkPageIndex++; updateGerkPaging(); }
});

function renderWorkLogGerkRows(rows) {
  // Prune any selected code that no longer has a row (GERK removed,
  // order reloaded) so the selection bar's count never lies.
  const validCodes = new Set(rows.map(r => r.code));
  for (const code of selectedGerkCodes) if (!validCodes.has(code)) selectedGerkCodes.delete(code);

  if (!rows.length) {
    workLogGerkRowsEl.innerHTML = `<p class="field-hint">Ta delovni nalog nima dodanih GERKOV.</p>`;
    updateGerkSelectionBar();
    updateGerkPaging();
    return;
  }
  workLogGerkRowsEl.innerHTML = rows.map(r => {
    const f = fields.find(f => f.code === r.code);
    // fields.name is sometimes just a copy of its own code (a placeholder
    // from whatever external process created the row — this app never
    // writes fields.name itself) — showing it next to the code then would
    // just duplicate it, e.g. "2715429 2715429".
    const name = (f?.name && f.name !== r.code) ? f.name : '';
    const ha   = r.hectares != null ? `${Number(r.hectares).toFixed(2)} ha` : (f?.area ? `${f.area} ha` : '');
    const meta = [ha, r.lokacija].filter(Boolean).join(' · ');
    const completed = !!r.completed;
    const locked    = !!r.startTime; // any start recorded anywhere — mine or someone else's
    const canEnd    = !!r.canEnd;    // only the entry's own operator may press Konec
    const samples   = r.samples || [];
    const others    = r.otherEntries || [];
    return `
      <div class="wlg-row${completed ? ' wlg-row--completed' : ''}" data-code="${escHtml(r.code)}"
           data-start="${r.startTime || ''}" data-end="${r.endTime || ''}" data-duration="${r.duration ?? ''}"
           data-owner="${r.ownerId || ''}" data-owner-date="${r.ownerDate || ''}">
        <div class="wlg-info" data-action="wlg-highlight-map">
          <span class="wlg-code-line">
            ${isAdminView() ? `<input type="checkbox" class="wlg-select-checkbox" data-action="wlg-select" data-code="${escHtml(r.code)}" aria-label="Izberi GERK" ${selectedGerkCodes.has(r.code) ? 'checked' : ''}>` : ''}
            <span class="wlg-code">${escHtml(r.code)}</span>${name ? ` <span class="wlg-name">${escHtml(name)}</span>` : ''}
            <span class="wlg-segmentation-info" data-code="${escHtml(r.code)}"></span>
            <span class="wlg-field-map-slot" data-code="${escHtml(r.code)}">${f?.lat != null && f?.lng != null ? `<a class="wlg-field-map" href="https://www.google.com/maps?q=${f.lat},${f.lng}" target="_blank" rel="noopener" aria-label="Odpri na zemljevidu">📍</a>` : ''}</span>
          </span>
          ${meta ? `<span class="wlg-meta">${escHtml(meta)}</span>` : ''}
          ${renderGerkLabTypeCell(r)}
        </div>
        <div class="wlg-times">
          <button type="button" class="wlg-toggle-btn" data-action="wlg-start" ${locked ? 'disabled' : ''}>Start</button>
          <span class="wlg-time-value" data-role="start-value">${fmtClock(r.startTime)}</span>
          <button type="button" class="wlg-toggle-btn" data-action="wlg-end" ${canEnd ? '' : 'disabled'}>Konec</button>
          <span class="wlg-time-value" data-role="end-value">${fmtClock(r.endTime)}</span>
          <button type="button" class="btn btn-icon wlg-edit-btn" data-action="wlg-edit-toggle" aria-label="Uredi čas">✎</button>
        </div>
        <div class="wlg-edit-panel" hidden>
          <label class="wlg-edit-label">Datum
            <input type="date" class="wlg-edit-date" max="${todayISO()}" value="${currentDetailDate}">
          </label>
          <label class="wlg-edit-label">Začetek
            <input type="time" class="wlg-edit-start" value="${toTimeInputValue(r.startTime)}">
          </label>
          <label class="wlg-edit-label">Konec
            <input type="time" class="wlg-edit-end" value="${toTimeInputValue(r.endTime)}">
          </label>
          <button type="button" class="btn btn-secondary btn-sm" data-action="wlg-edit-save">Shrani</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="wlg-edit-cancel">Prekliči</button>
          ${isAdminView() && r.gerkId ? `<button type="button" class="btn btn-danger btn-sm" data-action="wlg-remove-gerk" data-gerk-row-id="${escHtml(r.gerkId)}">Odstrani GERK</button>` : ''}
        </div>
        ${others.length ? `
        <div class="wlg-others">
          ${others.map(o => {
            const opName = o.work_logs.profiles?.full_name || '—';
            const when   = fmtSampleDate(o.work_logs.work_date);
            const time   = o.end_time ? `${fmtClock(o.start_time)}–${fmtClock(o.end_time)}` : (o.start_time ? 'v teku' : '');
            return `<span class="wlg-others-item">${o.completed ? '✓' : '•'} ${escHtml(opName)} · ${when}${time ? ' · ' + time : ''}</span>`;
          }).join('')}
        </div>` : ''}
        ${renderSamplesSection(samples, r.gerkId)}
      </div>`;
  }).join('');

  wireGerkRowButtons();
  updateGerkSelectionBar();
  if (woMapExpanded) renderCompactGerkList();
  woGerkPageIndex = 0;
  updateGerkPaging();
}

// Compact code + segment-numbers + Start/Konec view, shown in place of
// the full interactive GERK rows while the map is expanded. Reads
// straight from the real (hidden, not removed) .wlg-row elements in
// workLogGerkRowsEl rather than keeping its own copy of the data, so
// it's always exactly in sync with whatever renderWorkLogGerkRows last
// built — including after a Start/Konec click (see
// delegateCompactGerkAction, which re-renders this from the real row's
// post-update DOM instead of predicting the result itself).
function renderCompactGerkList() {
  const rows = Array.from(workLogGerkRowsEl.querySelectorAll('.wlg-row'));
  if (!rows.length) {
    wlgCompactList.innerHTML = `<p class="field-hint">Ta delovni nalog nima dodanih GERKOV.</p>`;
    return;
  }
  wlgCompactList.innerHTML = rows.map(row => {
    const code = row.dataset.code;
    const name = fields.find(f => f.code === code)?.name || '';
    const startBtn = row.querySelector('[data-action="wlg-start"]');
    const endBtn   = row.querySelector('[data-action="wlg-end"]');
    const startVal = row.querySelector('[data-role="start-value"]')?.textContent || '';
    const endVal   = row.querySelector('[data-role="end-value"]')?.textContent || '';
    const segs = Array.from(row.querySelectorAll('.wlg-samples-table tbody tr')).map(tr => {
      const cell = tr.querySelector('td');
      return (cell?.querySelector('input')?.value ?? cell?.textContent ?? '').trim();
    }).filter(Boolean).join(', ');
    return `
      <div class="wlg-compact-row" data-code="${escHtml(code)}">
        <div class="wlg-compact-head" data-action="wlg-highlight-map">
          <span class="wlg-compact-code">${escHtml(code)}${name ? ` <span class="wlg-compact-name">${escHtml(name)}</span>` : ''}</span>
          ${segs ? `<span class="wlg-compact-segs">${escHtml(segs)}</span>` : ''}
        </div>
        <div class="wlg-times">
          <button type="button" class="wlg-toggle-btn" data-action="wlg-compact-start" ${startBtn?.disabled ? 'disabled' : ''}>Start</button>
          <span class="wlg-time-value">${escHtml(startVal)}</span>
          <button type="button" class="wlg-toggle-btn" data-action="wlg-compact-end" ${endBtn?.disabled ? 'disabled' : ''}>Konec</button>
          <span class="wlg-time-value">${escHtml(endVal)}</span>
        </div>
      </div>`;
  }).join('');

  wlgCompactList.querySelectorAll('[data-action="wlg-highlight-map"]').forEach(el => {
    el.addEventListener('click', () => highlightGerkOnWoMap(el.closest('.wlg-compact-row')?.dataset.code));
  });
  wlgCompactList.querySelectorAll('[data-action="wlg-compact-start"]').forEach(btn => {
    btn.addEventListener('click', () => delegateCompactGerkAction(btn, 'wlg-start'));
  });
  wlgCompactList.querySelectorAll('[data-action="wlg-compact-end"]').forEach(btn => {
    btn.addEventListener('click', () => delegateCompactGerkAction(btn, 'wlg-end'));
  });
}

// Compact rows don't carry the full .wlg-row structure startGerk/endGerk/
// applyGerkRowUpdate expect (edit panel, data-role spans, etc.) — rather
// than duplicating that, this clicks the real (hidden) button for the
// same GERK in the full list and awaits the exact same code path, then
// re-renders the compact list from its result. One code path that ever
// calls start_gerk/end_gerk, compact or not.
async function delegateCompactGerkAction(compactBtn, action) {
  const code = compactBtn.closest('.wlg-compact-row')?.dataset.code;
  const realBtn = workLogGerkRowsEl.querySelector(`.wlg-row[data-code="${CSS.escape(code)}"] [data-action="${action}"]`);
  if (!realBtn || realBtn.disabled) return;
  compactBtn.disabled = true;
  await (action === 'wlg-start' ? startGerk(realBtn) : endGerk(realBtn));
  if (woMapExpanded) renderCompactGerkList();
}

function updateMapExpandState() {
  // The map and content column share a row with align-items: stretch,
  // so the map's real height already tracks .wo-detail-content's height
  // (that's the "adaptive" sizing wanted in the normal view — see the
  // wrap's own CSS comment). Swapping in the much shorter compact list
  // would shrink .wo-detail-content and, via that same stretch, shrink
  // the map along with it — expand should only ever change width, never
  // height. Freezing the map's current pixel height BEFORE the content
  // swap (and only that — not touched by the class toggle below) keeps
  // it exactly as it was; clearing the inline style on the way back out
  // hands sizing back to the normal CSS-driven behavior.
  if (woMapExpanded) {
    if (woDetailMapWrapEl) woDetailMapWrapEl.style.height = woDetailMapWrapEl.getBoundingClientRect().height + 'px';
  } else if (woDetailMapWrapEl) {
    woDetailMapWrapEl.style.height = '';
  }

  woDetailLayoutEl?.classList.toggle('wo-detail-layout--map-expanded', woMapExpanded);
  workLogGerkRowsEl.hidden = woMapExpanded;
  wlgCompactList.hidden = !woMapExpanded;
  woMapExpandBtn.textContent = woMapExpanded ? '⤡ Pomanjšaj zemljevid' : '⛶ Razširi zemljevid';
  if (woMapExpanded) renderCompactGerkList();
  updateGerkPaging(); // restores per-row hidden state correctly either way
  // The map's own container just changed size — Leaflet only re-measures
  // when told to, and needs the new size already applied in the DOM
  // (hence rAF, not immediate) or it reads the stale one mid-transition.
  requestAnimationFrame(() => woMap?.invalidateSize());
}

woMapExpandBtn.addEventListener('click', () => {
  woMapExpanded = !woMapExpanded;
  updateMapExpandState();
});

woMapLayersBtn.addEventListener('click', () => {
  if (!woMap || !woMapLabelsLayer) return;
  const active = woMap.hasLayer(woMapLabelsLayer);
  if (active) woMap.removeLayer(woMapLabelsLayer); else woMapLabelsLayer.addTo(woMap);
  woMapLayersBtn.setAttribute('aria-pressed', String(!active));
});

// Admins can always see + add segments (even zero today — that's the
// point of the + button), everyone else only sees the panel when
// there's actually something to show.
function renderSamplesSection(samples, gerkId) {
  if (!samples.length && !isAdminView()) return '';
  // Vzorčenje/Globina can also be set here, at creation — but stay
  // editable afterward too, admin-only (see renderSamplingCell/
  // renderSampleDepthCell).
  const addSection = isAdminView() && gerkId ? `
          <div class="wlg-add-sample-wrap" data-gerk-id="${escHtml(gerkId)}">
            <button type="button" class="btn btn-secondary btn-sm wlg-add-sample" data-action="wlg-add-sample-toggle">+ Dodaj segment</button>
            <div class="wlg-add-sample-form" hidden>
              <input type="text" class="wlg-new-sample-input" data-role="new-sample-no" placeholder="Št. segmenta">
              <select class="wlg-new-sample-input" data-role="new-vzorcenje">
                <option value="">Vzorčenje…</option>
                ${SAMPLE_ACTIONS.map(a => `<option value="${escHtml(a)}">${escHtml(a)}</option>`).join('')}
              </select>
              <select class="wlg-new-sample-input" data-role="new-globina">
                <option value="">Globina…</option>
                ${SAMPLE_DEPTHS.map(d => `<option value="${d}">${d} cm</option>`).join('')}
              </select>
              <input type="text" class="wlg-new-sample-input" data-role="new-comment" placeholder="Opomba" maxlength="200">
              <button type="button" class="btn btn-secondary btn-sm" data-action="wlg-add-sample-confirm">Dodaj</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="wlg-add-sample-cancel">Prekliči</button>
            </div>
          </div>` : '';
  const hasFlagged = samples.some(isNoCollectSample);
  return `
        <button type="button" class="wlg-samples-toggle" data-action="wlg-samples-toggle" data-count="${samples.length}">
          <span>${samples.length} ${samples.length === 1 ? 'segment' : 'segmentov'}</span>
          ${hasFlagged ? '<span class="wlg-sample-flag-dot" title="Vsaj en segment je označen »ne poberi«" aria-hidden="true"></span>' : ''}
          <span class="wlg-samples-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="wlg-samples-panel" hidden>
          <table class="wlg-samples-table">
            <thead><tr><th>Št. segmenta</th><th>Vzorčenje</th><th>Globina</th><th>Opomba</th>${isAdminView() ? '<th></th>' : ''}</tr></thead>
            <tbody>
              ${samples.map(s => `
                <tr class="${isNoCollectSample(s) ? 'wlg-sample-row--flagged' : ''}">
                  <td>${renderSampleNoCell(s)}</td>
                  <td>${renderSamplingCell(s)}</td>
                  <td>${renderSampleDepthCell(s)}</td>
                  <td>${renderSampleCommentCell(s)}</td>
                  ${isAdminView() ? `<td><button type="button" class="wlg-remove-sample" data-action="wlg-remove-sample" data-sample-id="${escHtml(s.id)}" aria-label="Izbriši segment">✕</button></td>` : ''}
                </tr>`).join('')}
            </tbody>
          </table>
          ${addSection}
        </div>`;
}

function updateOrderHeader() {
  const wo = currentDetailWorkOrder;
  const rows = Array.from(workLogGerkRowsEl.querySelectorAll('.wlg-row'));
  const totalSec = rows.reduce((s, r) => s + (parseInt(r.dataset.duration, 10) || 0), 0);
  const totalMin = Math.round(totalSec / 60);
  const isAdmin = isAdminView();

  // Customer: normally just the read-only label — but a handful of
  // orders (e.g. #84) somehow have no stranka_id at all, and until now
  // there was no way to fix that short of editing the DB directly.
  // Admin-only "+ Dodaj stranko" replaces the label in that case.
  const showAssignCustomer = !wo.stranka_id && isAdmin;
  workLogOrderLabel.hidden = showAssignCustomer;
  woAssignCustomerBtn.hidden = !showAssignCustomer;
  if (wo.stranka_id) woAssignCustomerWrap.hidden = true;

  // Izvajalec — admin-only reassignment dropdown. Options are loaded
  // asynchronously (loadIzvajalecEditOptions(), fire-and-forget from
  // openWorkOrderDetail()), so this can run again once they exist too.
  woIzvajalecEdit.hidden = !isAdmin;
  if (isAdmin && woIzvajalecEdit.options.length) woIzvajalecEdit.value = wo.izvajalec || '';

  // "Planirano" — only its own row when there's an unambiguous plan date
  // but we're NOT in header-date mode (opened without pinning to a specific
  // calendar entry); in header-date mode the date field itself already
  // shows/edits it, so a second row would just duplicate it. Resolved
  // asynchronously (separate query) by loadPlanDateForDetail(), so this can
  // run again after openWorkOrderDetail()'s own render pass.
  woPlanDateWrap.hidden = !isAdmin || !currentDetailPlanId || currentDetailPlanIsHeaderDate;
  if (currentDetailPlanId && !currentDetailPlanIsHeaderDate) woPlanDateInput.value = currentDetailPlanDate;

  // Status: admin gets an editable dropdown (only way to change it now
  // that there's no claim button); everyone else gets a read-only badge.
  // On phone, admin's dropdown is additionally collapsed behind a pencil
  // (woStatusEditBtn, toggles woStatusPanelOpen) so the compact header
  // doesn't show a <select> inline — desktop behavior is unchanged.
  const statusCollapsed = isAdmin && isMobile();
  woStatusEdit.hidden = statusCollapsed ? !woStatusPanelOpen : !isAdmin;
  woStatusEditBtn.hidden = !statusCollapsed;
  if (isAdmin) woStatusEdit.value = wo.status;
  woStatusBadge.hidden = isAdmin && !isMobile();
  if (!woStatusBadge.hidden) {
    woStatusBadge.textContent = wo.status;
    woStatusBadge.className = `wo-status-badge wo-status--${slugStatus(wo.status)}`;
  }

  woImportZonesWrap.hidden = !isAdmin;
  // Manual "+ Dodaj GERK-e" — works regardless of status (Plan/V delu/
  // Izvedeno) — see migration_sync_status_on_gerk_assignment.sql for why
  // adding a GERK to an "Izvedeno" order now correctly drops it back to
  // "V delu".
  woAddExistingGerkWrap.hidden = !isAdmin;

  // Delete (archive) / restore — mutually exclusive on deleted_at, admin-only.
  const isDeleted = !!wo.deleted_at;
  woDeleteBtn.hidden  = !isAdmin || isDeleted;
  woRestoreBtn.hidden = !isAdmin || !isDeleted;

  // Everything else that used to have its own dedicated slot (who
  // worked on it, total logged time, archived state) is read-only —
  // one concatenated line in the header instead. Everyone who's
  // actually logged a GERK on this order, not just whoever originally
  // claimed it — a second operator picking up mid-order doesn't
  // replace the first in this list, both show.
  const contributors = [...new Set(currentAllGerkEntries.map(e => e.work_logs.profiles?.full_name).filter(Boolean))];
  const izvajaLabel = contributors.length ? contributors.join(', ') : wo.profiles?.full_name;
  const metaParts = [];
  if (isDeleted) metaParts.push('🗑 Arhivirano');
  if (wo.status !== 'Plan' && izvajaLabel) metaParts.push(`Izvaja: ${izvajaLabel}`);
  if (totalMin > 0) metaParts.push(`Skupaj: ${fmtHM(totalMin)}`);
  woHeaderMeta.textContent = metaParts.join(' · ');
  buildWoHeaderSummary();
}

// ── Modal ──────────────────────────────────────────────────────
let currentDetailWorkOrder = null;
let currentDetailLogId     = null;
let currentDetailDate      = null;
let currentRoadTimeEntries = [];
let currentAllGerkEntries  = []; // every operator's work_log_gerks for this work order — powers the "who else worked on this" view
let currentCapturedPoints  = []; // gerk_captured_point rows for this work order — the right-side map capture panel
let currentGerkSegments    = []; // get_work_order_gerk_segments rows — one per imported zone, powers the per-GERK badge + map layer
let woMapSegmentLabelLayers = new Map(); // segment_id -> its permanent map label tooltip layer, so renaming a segment (updateSampleNo) can patch it live
let woMapSegmentPointLayers = new Map(); // segment_id -> [{ layer, pointNo }] captured-point markers, same reason
let selectedGerkCodes      = new Set(); // admin-only multi-select on the GERK list, powers the contextual selection bar
let currentDetailPlanId    = null; // delovni_nalogi_planiranje.id backing the "Planirano" field, if any — see loadPlanDateForDetail()
let currentDetailPlanDate  = null;
// True when opened from a specific Planiranje calendar entry (a planId was
// given) — in that case the header's date field IS the plan date (not
// "which day's work-log am I viewing"), and the separate "Planirano" row
// is redundant. Everywhere else workLogDateInput keeps its normal meaning.
let currentDetailPlanIsHeaderDate = false;

async function openWorkOrderDetail(workOrder, planId = null) {
  currentDetailWorkOrder  = workOrder;
  currentDetailDate       = todayISO();
  selectedGerkCodes       = new Set();
  currentDetailPlanId     = null;
  currentDetailPlanDate   = null;
  currentDetailPlanIsHeaderDate = !!planId;
  woDatePanel.hidden = true; // phone-only tap-to-edit — always starts collapsed
  woStatusPanelOpen = false;
  layoutWoDetailSections(); // phone only — see its own comment

  modalTitle.textContent = workOrder.stevilka || 'Delovni nalog';
  hideFormFeedback();
  updateTractorDatalist();

  workLogOrderLabel.textContent = workOrder.customers?.naziv || workOrder.customers?.company_name || '—';

  // A plan date can be in the future (it's a schedule) — no upper cap in
  // that mode, unlike the normal "log hours, never for a future day" case.
  // title: the visible "Planirano" label is gone in this mode (the field
  // itself now doubles as that editor), so a hover tooltip fills the gap.
  workLogDateInput.max   = currentDetailPlanIsHeaderDate ? '' : todayISO();
  workLogDateInput.title = currentDetailPlanIsHeaderDate ? 'Planirano (datum iz koledarja Planiranje)' : '';
  setWorkLogDate(currentDetailDate);

  woAddExistingGerkPaste.value = '';
  if (isAdminView()) loadPlanDateForDetail(workOrder.id, planId); // fire-and-forget, re-renders the header itself once resolved
  if (isAdminView()) loadIzvajalecEditOptions(); // fire-and-forget, same — see below

  await loadDetailForDate();

  showModalAnimated(formModal);
  // Only now, with the modal (and #woDetailMap inside it) actually
  // visible — Leaflet computes its tile viewport from the container's
  // real layout size at init time. Calling this any earlier, while
  // formModal was still `hidden` (0×0), left the map permanently
  // broken: controls rendered but tiles never did, even after the
  // modal opened, because nothing re-measured the container afterward.
  showWoDetailMap(workOrder); // fire-and-forget, don't block modal open on a geometry query
  document.body.style.overflow = 'hidden';
}

// Bridge for planning.js — a separate module with its own Supabase client
// and no access to this file's internals — to open the SAME work-order
// detail popup the main list uses, instead of a second, redundant one.
// Guards on workOrdersLoaded since Planiranje can be the first tab visited
// in a session, before loadWorkOrders() would otherwise have run. planId
// (a delovni_nalogi_planiranje.id), when known — i.e. opened from a specific
// calendar entry — pins the "Planirano" field to that exact plan row.
window.openWorkOrderDetailById = async function (id, planId = null) {
  if (!workOrdersLoaded) await loadWorkOrders();
  const wo = workOrders.find(w => w.id === id);
  if (wo) await openWorkOrderDetail(wo, planId);
};

// Admin-only "Planirano" field in the detail header — the scheduled date
// from Planiranje (delovni_nalogi_planiranje.plan_date), editable right
// here instead of only from the calendar. If planId isn't given (opened
// from the main list, not a specific calendar entry) and the order has
// exactly one plan row, that one is used; with zero or multiple plan rows
// there's no single unambiguous date, so the field just stays hidden.
async function loadPlanDateForDetail(workOrderId, planId) {
  const { data } = await supabase.from('delovni_nalogi_planiranje').select('id, plan_date').eq('delovni_nalog_id', workOrderId);
  if (currentDetailWorkOrder?.id !== workOrderId) return; // modal moved on to a different order already
  const rows = data ?? [];
  const row = planId ? rows.find(r => String(r.id) === String(planId)) : (rows.length === 1 ? rows[0] : null);
  currentDetailPlanId = row?.id ?? null;
  currentDetailPlanDate = row?.plan_date ?? null;
  if (currentDetailPlanIsHeaderDate && currentDetailPlanDate) setWorkLogDate(currentDetailPlanDate);
  updateOrderHeader();
}

// Populates the header's admin-only izvajalec dropdown — reuses
// operatorsList/loadOperatorsList(), the same roster the "+ Nov delovni
// nalog" form's own select already loads, instead of a second query.
async function loadIzvajalecEditOptions() {
  if (!operatorsList.length) await loadOperatorsList();
  if (!currentDetailWorkOrder) return; // modal closed while this was loading
  woIzvajalecEdit.innerHTML = '<option value="">— brez —</option>' +
    operatorsList.map(p => `<option value="${p.id}">${escHtml(p.full_name || '—')}</option>`).join('');
  updateOrderHeader();
}

// ── Work order detail: persistent split-view map ─────────────────
// Separate Leaflet instance from the popup map modal (openMapModal) —
// this one lives inside the detail sheet itself and stays up for as
// long as the order is open, rather than being opened on demand for
// one point.
let woMap           = null;
let woMapLabelsLayer = null; // roads/borders/place-names overlay — off by default, see ensureWoMap
let woMapGerkLayer  = null;
let woMapSegmentLayer = null; // imported KML zones (gerk_segment) + their sample points — separate layer, drawn on top
let woMapCapturedLayer = null; // operator-captured points (gerk_captured_point) — own layer, own color
let woMapMeMarker   = null;
let woMapMeWatchId  = null;
let woMapHasFitBounds = false;
let woMapLayersByCode = new Map(); // gerk_code -> { marker, shape, latlng } — for the list<->map highlight
let woMapHighlightedCode = null;
let woMapHighlightRing   = null;   // circleMarker used as a highlight ring when a code has no shape

const WO_MAP_SHAPE_STYLE = { color: '#2455AA', weight: 2, fillColor: '#2455AA', fillOpacity: .15 };
const WO_MAP_SEGMENT_STYLE = { color: '#D97706', weight: 2, dashArray: '4,3', fillColor: '#D97706', fillOpacity: .08 };
const WO_MAP_CAPTURED_COLOR = '#16A34A';
const WO_MAP_SHAPE_HIGHLIGHT_STYLE = { color: '#F59E0B', weight: 4, fillColor: '#F59E0B', fillOpacity: .35 };
const WO_MAP_SEGMENT_HIGHLIGHT_STYLE = { color: '#F59E0B', weight: 3, dashArray: null, fillColor: '#F59E0B', fillOpacity: .3 };

// Map → list: hovering a GERK's marker/shape highlights its row.
function highlightGerkRow(code, on) {
  const row = workLogGerkRowsEl.querySelector(`.wlg-row[data-code="${CSS.escape(code)}"]`);
  if (row) row.classList.toggle('wlg-row--map-hover', on);
}

// List → map: clicking a GERK row highlights its marker/shape (only
// one at a time — clicking another clears the previous highlight).
function highlightGerkOnWoMap(code) {
  if (!code || !woMap) return;

  if (woMapHighlightedCode && woMapHighlightedCode !== code) {
    const prev = woMapLayersByCode.get(woMapHighlightedCode);
    if (prev?.shapes) prev.shapes.forEach(l => l.setStyle(WO_MAP_SHAPE_STYLE));
    if (prev?.zoneLayers) prev.zoneLayers.forEach(l => l.setStyle(WO_MAP_SEGMENT_STYLE));
  }
  if (woMapHighlightRing) { woMapHighlightRing.remove(); woMapHighlightRing = null; }

  const entry = woMapLayersByCode.get(code);
  woMapHighlightedCode = code;

  // Name overlay — shown regardless of whether there's any geometry to
  // fit/highlight below, so clicking a GERK always confirms which one
  // you picked even if it has no shape/zone drawn yet.
  const row = workLogGerkRowsEl.querySelector(`.wlg-row[data-code="${CSS.escape(code)}"]`);
  const label = [row?.querySelector('.wlg-code')?.textContent, row?.querySelector('.wlg-name')?.textContent]
    .filter(Boolean).join(' ');
  woMapGerkLabel.textContent = label || code;
  woMapGerkLabel.hidden = false;

  if (!entry) return; // no marker/shape/zone for this GERK — nothing to show

  if (entry.shapes?.length) {
    // A compound "A+B+C" GERK code (see get_work_order_gerk_shapes)
    // means multiple real shapes share one entry — highlight/fit all
    // of them together, not just the first.
    let combined = entry.shapes[0].getBounds();
    for (const l of entry.shapes) {
      l.setStyle(WO_MAP_SHAPE_HIGHLIGHT_STYLE);
      l.bringToFront();
      combined = combined.extend(l.getBounds());
    }
    woMap.fitBounds(combined, { padding: [40, 40], maxZoom: 17 });
  } else if (entry.zoneLayers?.length) {
    // A text-named GERK (no official registry entry) has no .shapes —
    // its imported zones are the only real geometry, so focus on their
    // combined extent instead.
    let combined = entry.zoneLayers[0].getBounds();
    for (const l of entry.zoneLayers) {
      l.setStyle(WO_MAP_SEGMENT_HIGHLIGHT_STYLE);
      l.bringToFront();
      combined = combined.extend(l.getBounds());
    }
    woMap.fitBounds(combined, { padding: [40, 40], maxZoom: 17 });
  } else if (entry.latlng) {
    woMapHighlightRing = L.circleMarker(entry.latlng, {
      radius: 16, color: '#F59E0B', weight: 3, fillOpacity: 0,
    }).addTo(woMap);
    woMap.setView(entry.latlng, Math.max(woMap.getZoom(), 15));
  }
}

function ensureWoMap() {
  if (woMap) return woMap;
  woMap = L.map(woDetailMap);
  // Esri World Imagery (free, no API key) — satellite detail matters
  // more here than street-map labels for seeing actual field/crop
  // conditions, and unlike Google's tiles this is fine to embed
  // directly without their JS API/billing.
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }).addTo(woMap);
  // Roads/borders/place-name overlay — created but not added (off by
  // default, per the comment above), toggled on/off via woMapLayersBtn.
  woMapLabelsLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri',
  });
  woMapGerkLayer = L.layerGroup().addTo(woMap);
  woMapSegmentLayer = L.layerGroup().addTo(woMap);
  woMapCapturedLayer = L.layerGroup().addTo(woMap);
  // .wo-detail-map-wrap's height now tracks .wo-detail-content's real
  // height (see its CSS comment) instead of a fixed value — it can
  // change size after this point too (a GERK row expanding, the window
  // resizing), and Leaflet only re-measures its container when told to.
  // A one-time invalidateSize() at open caught the initial size; this
  // catches every size change after that, not just the first.
  new ResizeObserver(() => woMap?.invalidateSize()).observe(woDetailMap.parentElement);
  return woMap;
}

async function showWoDetailMap(workOrder) {
  const map = ensureWoMap();
  woMapGerkLayer.clearLayers();
  woMapSegmentLayer.clearLayers();
  woMapCapturedLayer.clearLayers();
  currentCapturedPoints = [];
  currentGerkSegments = [];
  woMapSegmentLabelLayers = new Map();
  woMapSegmentPointLayers = new Map();
  woCaptureList.innerHTML = '';
  woCaptureError.hidden = true;
  woCaptureShowPoints.checked = true;
  pendingKmlImports = [];
  woImportZonesForm.hidden = true;
  woImportZonesError.hidden = true;
  woMapHasFitBounds = false;
  woMapLayersByCode = new Map();
  woMapHighlightedCode = null;
  if (woMapHighlightRing) { woMapHighlightRing.remove(); woMapHighlightRing = null; }
  woMapGerkLabel.hidden = true;
  woMapExpanded = false;
  updateMapExpandState();

  // invalidateSize() has to run — with the container actually part of
  // the visible layout — before any setView/fitBounds call below, or
  // those compute against Leaflet's stale cached size (usually 0×0,
  // from whenever the map was first constructed) instead of the real
  // one. Awaiting a frame here (this function is only ever called
  // after showModalAnimated(formModal), which unhides it synchronously)
  // is the earliest point the container has real dimensions to measure.
  await new Promise(resolve => requestAnimationFrame(resolve));
  map.invalidateSize();

  // Plain center-point markers immediately from field data already
  // loaded client-side — the boundary shapes below can take a moment,
  // and not every GERK has one, so this gives an instant baseline.
  const gerkCodes = (workOrder.delovni_nalogi_gerki || []).map(g => g.gerk_code);
  const markerBounds = [];
  for (const code of gerkCodes) {
    const f = fields.find(f => f.code === code);
    if (f?.lat != null && f?.lng != null) {
      const marker = L.marker([f.lat, f.lng]).bindTooltip(code).addTo(woMapGerkLayer);
      marker.on('mouseover', () => highlightGerkRow(code, true));
      marker.on('mouseout',  () => highlightGerkRow(code, false));
      woMapLayersByCode.set(code, { marker, shape: null, latlng: [f.lat, f.lng] });
      markerBounds.push([f.lat, f.lng]);
    }
  }
  if (markerBounds.length) {
    map.fitBounds(markerBounds, { padding: [30, 30], maxZoom: 16 });
    woMapHasFitBounds = true;
  } else {
    map.setView([46.1512, 14.9955], 8); // Slovenia-wide fallback until something better is known
  }

  startWatchingMyLocationOnWoMap();

  // Actual GERK boundary polygons, when the CRM has shape data for
  // them — drawn on top of the plain markers once they arrive (guarded
  // against the modal having moved to a different order by the time
  // this resolves). Imported KML zones (gerk_segment) load alongside,
  // same guard, own layer.
  // Capturing soil-sampling points only makes sense on a Vzorčenje
  // order — showing it on Gnojenje/Setev/Škropljenje/Žetev orders too
  // was confusing since there's nothing to sample there. Excluding by
  // known non-sampling type (rather than requiring an exact
  // 'Vzorčenje' match) so it still shows on older orders where this
  // field was never filled in — plenty of real orders predate it.
  const NON_SAMPLING_TYPES = ['Gnojenje', 'Setev', 'Škropljenje', 'Žetev'];
  const isSamplingOrder = !NON_SAMPLING_TYPES.includes(workOrder.tip_storitve);
  woCapturePanel.hidden = !isSamplingOrder;
  woCaptureBtn.hidden = !(isSamplingOrder && ['Plan', 'V delu'].includes(workOrder.status));

  const [{ data: shapes, error: shapesError }, { data: segments, error: segmentsError }, { data: captured, error: capturedError }] = await Promise.all([
    supabase.rpc('get_work_order_gerk_shapes', { p_work_order_id: workOrder.id }),
    supabase.rpc('get_work_order_gerk_segments', { p_work_order_id: workOrder.id }),
    isSamplingOrder
      ? supabase.rpc('get_work_order_captured_points', { p_work_order_id: workOrder.id })
      : Promise.resolve({ data: [] }),
  ]);
  // Only shapesError used to be checked — a failure in either of the
  // other two calls left the map's official boundaries drawn (or not)
  // while silently showing zero zones/captured points, with nothing
  // telling you it had actually failed rather than legitimately having
  // nothing to show.
  if (segmentsError || capturedError) console.error('showWoDetailMap', segmentsError || capturedError);
  if (shapesError || currentDetailWorkOrder?.id !== workOrder.id) return;

  currentCapturedPoints = captured || [];
  renderCapturedPointsList();

  currentGerkSegments = segments || [];
  renderGerkSegmentationInfo();

  // When a GERK has an imported KML zone, that shape wins outright — the
  // official ARKOD polygon for that same code is skipped rather than
  // drawn underneath/alongside it. A KML import means the real boundary
  // for this GERK is known to differ from (or only cover part of) the
  // registry shape, so showing both as if equally valid is misleading;
  // every .shapes consumer below (highlight, bounds, the 📍 link, KML
  // export) already falls back to .zoneLayers when .shapes is empty, so
  // simply not registering the ARKOD shape here is enough.
  const kmlCoveredCodes = new Set((segments || []).filter(s => s.segment_geojson).map(s => s.gerk_code));

  const shapeLayers = [];
  for (const row of (shapes || [])) {
    if (!row.geojson || kmlCoveredCodes.has(row.gerk_code)) continue;
    const layer = L.geoJSON(row.geojson, { style: WO_MAP_SHAPE_STYLE })
      .bindTooltip(row.gerk_code).addTo(woMapGerkLayer);
    layer.on('mouseover', () => highlightGerkRow(row.gerk_code, true));
    layer.on('mouseout',  () => highlightGerkRow(row.gerk_code, false));
    const entry = woMapLayersByCode.get(row.gerk_code) || { marker: null, latlng: null };
    // A compound "A+B+C" code (see get_work_order_gerk_shapes) returns
    // one row per real GERK sharing this same gerk_code — accumulate
    // every shape instead of overwriting, so highlight/bounds/centroid
    // logic can combine all of them.
    entry.shapes = entry.shapes || [];
    entry.shapes.push(layer);
    woMapLayersByCode.set(row.gerk_code, entry);
    shapeLayers.push(layer);
  }
  const segmentLayers = [];
  for (const row of (segments || [])) {
    if (!row.segment_geojson) continue;
    const layer = L.geoJSON(row.segment_geojson, { style: WO_MAP_SEGMENT_STYLE })
      .addTo(woMapSegmentLayer);
    // Positioned via label_point (PostGIS ST_PointOnSurface, guaranteed
    // inside the polygon) instead of Leaflet's bindTooltip direction:
    // 'center', which uses the layer's BOUNDING-BOX center — for
    // irregular/elongated zones that routinely falls outside the
    // polygon, or inside a tightly-packed neighboring one.
    if (row.label_point) {
      const [lpLng, lpLat] = row.label_point.coordinates;
      const labelLayer = L.tooltip({ permanent: true, direction: 'center', className: 'wo-map-segment-label' })
        .setLatLng([lpLat, lpLng])
        .setContent(row.segment_label || '')
        .addTo(woMapSegmentLayer);
      if (row.segment_id) woMapSegmentLabelLayers.set(row.segment_id, labelLayer);
    }
    layer.on('mouseover', () => highlightGerkRow(row.gerk_code, true));
    layer.on('mouseout',  () => highlightGerkRow(row.gerk_code, false));
    segmentLayers.push(layer);
    // A GERK known only by a text name has no official shape/centroid
    // at all (see highlightGerkOnWoMap) — its imported zones are the
    // only real geometry there is to click-to-focus on, so they need
    // to be registered here too, not just drawn.
    const entry = woMapLayersByCode.get(row.gerk_code) || { marker: null, latlng: null };
    entry.zoneLayers = entry.zoneLayers || [];
    entry.zoneLayers.push(layer);
    woMapLayersByCode.set(row.gerk_code, entry);
    for (const p of (row.points || [])) {
      const [lng, lat] = p.geojson.coordinates;
      const ptLayer = L.circleMarker([lat, lng], { radius: 5, color: '#D97706', weight: 2, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(`${row.segment_label || ''} · ${p.point_no ?? ''}`.trim())
        .addTo(woMapSegmentLayer);
      if (row.segment_id) {
        if (!woMapSegmentPointLayers.has(row.segment_id)) woMapSegmentPointLayers.set(row.segment_id, []);
        woMapSegmentPointLayers.get(row.segment_id).push({ layer: ptLayer, pointNo: p.point_no });
      }
    }
  }

  // Fit to whatever real shape data exists — official GERK boundaries
  // when there are any, imported zones too. A GERK known only by a
  // text name has no official polygon at all, so for a work order
  // made entirely of those, shapeLayers is empty and zones are the
  // *only* real geometry — without including them here, the map fell
  // back to a whole-Slovenia view and the zones were imperceptible at
  // that zoom (looked like they hadn't imported at all).
  const boundsLayers = [...shapeLayers, ...segmentLayers];
  if (boundsLayers.length) {
    let combined = boundsLayers[0].getBounds();
    for (const layer of boundsLayers.slice(1)) combined = combined.extend(layer.getBounds());
    map.fitBounds(combined, { padding: [30, 30] });
    woMapHasFitBounds = true;
  }

  drawCapturedPointsOnMap();
  updateGerkMapLinksFromShapes();
}

// The 📍 link next to each GERK row falls back to fields.centroid_lat/
// lng at render time (see renderWorkLogGerkRows), which is a separate,
// precomputed column — not live-joined against gerk_polygon, so it
// didn't get the SI/HR country-collision fix and can be stale in two
// ways: null for ~10% of fields (pin just never showed), or, worse,
// silently pointing at a Croatian parcel that happens to share the
// same GERK number (pin shows, but goes to the wrong country). Once
// the official shape itself is drawn — already correctly SI-only —
// deriving the pin from its own centroid is strictly more trustworthy
// than the cached column, so it wins whenever a shape is available.
function updateGerkMapLinksFromShapes() {
  workLogGerkRowsEl.querySelectorAll('.wlg-field-map-slot').forEach(slot => {
    const code = slot.dataset.code;
    const entry = woMapLayersByCode.get(code);
    // Prefer the official boundary's centroid; a text-named GERK (no
    // registry match at all) has no .shapes, so fall back to its
    // imported zones' combined centroid — same fallback chain already
    // used by highlightGerkOnWoMap/exportSelectedGerksToKml. Only
    // when neither exists does the fields.centroid_* link (set at
    // render time, possibly null) stay as-is. A compound "A+B+C" code
    // combines all of its shapes' bounds first (see
    // get_work_order_gerk_shapes).
    let center = null;
    if (entry?.shapes?.length) {
      let combined = entry.shapes[0].getBounds();
      for (const l of entry.shapes.slice(1)) combined = combined.extend(l.getBounds());
      center = combined.getCenter();
    } else if (entry?.zoneLayers?.length) {
      let combined = entry.zoneLayers[0].getBounds();
      for (const l of entry.zoneLayers.slice(1)) combined = combined.extend(l.getBounds());
      center = combined.getCenter();
    } else if (entry?.latlng) {
      center = { lat: entry.latlng[0], lng: entry.latlng[1] };
    }
    if (!center) return;
    slot.innerHTML = `<a class="wlg-field-map" href="https://www.google.com/maps?q=${center.lat},${center.lng}" target="_blank" rel="noopener" aria-label="Odpri na zemljevidu">📍</a>`;
  });
}

// "Prikaži točke" gates both the numbered markers and the path
// connecting them in point_no order (1→2→3…, which is also capture
// order — point_no is assigned sequentially per work order).
function drawCapturedPointsOnMap() {
  woMapCapturedLayer.clearLayers();
  if (!woCaptureShowPoints.checked || !currentCapturedPoints.length) return;

  const sorted = [...currentCapturedPoints].sort((a, b) => a.point_no - b.point_no);
  if (sorted.length > 1) {
    L.polyline(sorted.map(p => [p.lat, p.lng]), {
      color: WO_MAP_CAPTURED_COLOR, weight: 2, dashArray: '6,4',
    }).addTo(woMapCapturedLayer);
  }
  for (const p of sorted) {
    L.marker([p.lat, p.lng], {
      icon: L.divIcon({
        className: 'wo-capture-marker-icon',
        html: `<span class="wo-capture-marker">${p.point_no}</span>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      }),
    }).addTo(woMapCapturedLayer);
  }
}

// Shows, on each GERK row, which imported KML segmentation(s) it
// carries (type, validity, zone count) — visible to everyone, since
// it's informational; the remove action stays admin-only, matching
// the import itself. Wires its own remove buttons inline since this
// runs after wireGerkRowButtons() already did its pass (segments load
// async, alongside the map).
function renderGerkSegmentationInfo() {
  const byGerk = new Map(); // gerk_code -> segmentation_id -> { id, type, validFrom, validTo, count }
  for (const row of currentGerkSegments) {
    if (!byGerk.has(row.gerk_code)) byGerk.set(row.gerk_code, new Map());
    const segs = byGerk.get(row.gerk_code);
    if (!segs.has(row.segmentation_id)) {
      segs.set(row.segmentation_id, { id: row.segmentation_id, type: row.seg_type, validFrom: row.valid_from, validTo: row.valid_to, count: 0 });
    }
    segs.get(row.segmentation_id).count++;
  }

  // Icon-only — full detail (type/count/validity) lives in the title
  // tooltip instead of always-visible text. For admins the icon itself
  // is the remove action (confirm() below is the safety net against a
  // stray click); everyone else just gets a static indicator.
  workLogGerkRowsEl.querySelectorAll('.wlg-segmentation-info').forEach(el => {
    const list = byGerk.get(el.dataset.code);
    if (!list) { el.innerHTML = ''; return; }
    el.innerHTML = Array.from(list.values()).map(s => {
      const detail = `${s.type} · ${s.count} ${s.count === 1 ? 'cona' : 'con'} · velja od ${fmtSampleDate(s.validFrom)}${s.validTo ? ' do ' + fmtSampleDate(s.validTo) : ''}`;
      return isAdminView()
        ? `<button type="button" class="wlg-segmentation-icon" data-action="wlg-remove-segmentation" data-segmentation-id="${escHtml(s.id)}" title="${escHtml(detail)} — klikni za odstranitev">🌐</button>`
        : `<span class="wlg-segmentation-icon" title="${escHtml(detail)}">🌐</span>`;
    }).join('');
    el.querySelectorAll('[data-action="wlg-remove-segmentation"]').forEach(btn => {
      btn.addEventListener('click', () => removeGerkSegmentation(btn));
    });
  });
}

async function removeGerkSegmentation(btn) {
  const segmentationId = btn.dataset.segmentationId;
  if (!confirm('Odstranim uvožene cone za ta GERK?')) return;
  btn.disabled = true;
  try {
    const { error } = await supabase.rpc('remove_gerk_segmentation', { p_segmentation_id: segmentationId });
    if (error) throw error;
    await showWoDetailMap(currentDetailWorkOrder); // refetches segments/captured points and redraws everything
  } catch (e) {
    showFormError(e.message || 'Napaka pri odstranjevanju con.');
    btn.disabled = false;
  }
}

function renderCapturedPointsList() {
  woCaptureList.innerHTML = currentCapturedPoints.map(p => `
    <div class="wo-capture-item" data-id="${escHtml(p.id)}" data-lat="${p.lat}" data-lng="${p.lng}">
      <span>Točka ${p.point_no}${p.segment_label ? ` · ${escHtml(p.segment_label)}` : ''}</span>
      <button type="button" class="wo-capture-item-remove" data-action="wo-capture-remove" aria-label="Izbriši točko">✕</button>
    </div>`).join('');
}

// Dedicated slot, not the shared showFormError — that alert lives far
// down in the scrollable detail content, well out of view while
// looking at the map, so a failure here was invisible rather than
// silent (same bug class as operatorsError vs formError earlier).
function showCaptureError(msg) {
  woCaptureError.textContent = msg;
  woCaptureError.hidden = false;
}

// Success confirmation for a captured point — fades out on its own
// instead of needing to be dismissed, unlike showCaptureError above.
let captureToastTimer = null;
function showCaptureToast(msg) {
  woCaptureToast.textContent = msg;
  clearTimeout(captureToastTimer);
  woCaptureToast.classList.add('wo-capture-toast--visible');
  captureToastTimer = setTimeout(() => {
    woCaptureToast.classList.remove('wo-capture-toast--visible');
  }, 2500);
}

// High-accuracy GPS can take a long time to get a fix (or never manage
// it, e.g. weak signal indoors) and was timing out often at 15s. Try it
// first since it's the better reading when it works, but fall back to
// a low-accuracy (network/cell-based) fix on a timeout instead of just
// failing outright — much faster, and still far better than nothing.
// maximumAge is no longer 0: forcing a fully fresh fix on every call
// throws away a location the OS's fused provider may already have from
// moments ago, which is often the difference between an instant return
// and a full 20s wait. A soil-sample point doesn't need to be fresher
// than a few/tens of seconds for zone-matching purposes, since the
// worker is standing still at the point when they tap the button.
async function getCapturePosition(onFallback) {
  try {
    return await getCurrentPositionAsync({ enableHighAccuracy: true, timeout: 25000, maximumAge: 10000 });
  } catch (e) {
    if (e?.code !== 3) throw e; // 3 = TIMEOUT — anything else (denied, unavailable) isn't worth retrying
    onFallback?.();
    return await getCurrentPositionAsync({ enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 });
  }
}

async function captureGerkPoint() {
  if (!currentDetailWorkOrder) return;
  woCaptureError.hidden = true;
  woCaptureBtn.disabled = true;
  const originalLabel = woCaptureBtn.textContent;
  woCaptureBtn.textContent = '🔎 Iščem lokacijo…';
  try {
    const pos = await getCapturePosition(() => { woCaptureBtn.textContent = '🔎 Iščem (nižja natančnost)…'; });
    const { data, error } = await supabase.rpc('capture_gerk_point', {
      p_work_order_id: currentDetailWorkOrder.id,
      p_lat: pos.coords.latitude,
      p_lng: pos.coords.longitude,
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    currentCapturedPoints.push(result);
    renderCapturedPointsList();
    drawCapturedPointsOnMap();
    showCaptureToast(`✓ Točka ${result.point_no} zajeta`);
  } catch (e) {
    showCaptureError(geolocationErrorMessage(e));
  } finally {
    woCaptureBtn.disabled = false;
    woCaptureBtn.textContent = originalLabel;
  }
}

async function removeCapturedPoint(btn) {
  const item = btn.closest('.wo-capture-item');
  const id = item.dataset.id;
  woCaptureError.hidden = true;
  btn.disabled = true;
  try {
    const { error } = await supabase.rpc('remove_gerk_captured_point', { p_point_id: id });
    if (error) throw error;
    currentCapturedPoints = currentCapturedPoints.filter(p => p.id !== id);
    renderCapturedPointsList();
    drawCapturedPointsOnMap();
  } catch (e) {
    showCaptureError(e.message || 'Napaka pri brisanju točke.');
    btn.disabled = false;
  }
}

woCaptureBtn.addEventListener('click', captureGerkPoint);
woCaptureShowPoints.addEventListener('change', drawCapturedPointsOnMap);
woCaptureList.addEventListener('click', e => {
  const removeBtn = e.target.closest('[data-action="wo-capture-remove"]');
  if (removeBtn) { removeCapturedPoint(removeBtn); return; }
  const item = e.target.closest('.wo-capture-item');
  if (item) openMapModal(Number(item.dataset.lat), Number(item.dataset.lng), item.querySelector('span').textContent);
});

function startWatchingMyLocationOnWoMap() {
  if (!navigator.geolocation || !woMap) return;
  stopWatchingMyLocationOnWoMap();
  woMapMeWatchId = navigator.geolocation.watchPosition(pos => {
    if (!woMap) return;
    const { latitude, longitude } = pos.coords;
    if (woMapMeMarker) {
      woMapMeMarker.setLatLng([latitude, longitude]);
    } else {
      woMapMeMarker = L.circleMarker([latitude, longitude], {
        radius: 8, color: '#fff', weight: 2, fillColor: '#2455AA', fillOpacity: 1,
      }).addTo(woMap).bindTooltip('Vi');
      if (!woMapHasFitBounds) woMap.setView([latitude, longitude], 15);
    }
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
}

function stopWatchingMyLocationOnWoMap() {
  if (woMapMeWatchId != null) { navigator.geolocation.clearWatch(woMapMeWatchId); woMapMeWatchId = null; }
  if (woMapMeMarker) { woMapMeMarker.remove(); woMapMeMarker = null; }
}

// Re-fetches and re-renders the modal's contents for currentDetailDate —
// called on open, and again whenever the date picker changes, since each
// work order can carry at most one work_logs row per operator per day.
async function loadDetailForDate() {
  currentDetailLogId     = null;
  ensureTodaysLogPromise = null;

  roadHourSel.value = '0'; roadMinSel.value = '00';
  tractorInput.value = '';
  descInput.value = '';

  const [{ data: existingLog, error: existingLogError }, { data: allEntries, error: allEntriesError }] = await Promise.all([
    supabase
      .from('work_logs')
      .select('id, road_duration, tractor, description, work_log_gerks(gerk_code, hectares, start_time, end_time, duration, completed), work_log_road_time(id, minutes)')
      .eq('operator_id', currentUser.id)
      .eq('work_order_id', currentDetailWorkOrder.id)
      .eq('work_date', currentDetailDate)
      .maybeSingle(),
    // Every operator's GERK entries for this work order (any date) — lets
    // someone taking over mid-order see what's already been done, and by whom.
    // No profiles(full_name) embed here on purpose — work_logs.operator_id
    // references auth.users, not profiles, directly, so PostgREST has no
    // real foreign key to embed profiles through (unlike e.g.
    // gerk_captured_point.operator_id, which does FK straight to
    // profiles). Relying on it "bridging" via the shared auth.users
    // reference intermittently worked and intermittently threw PGRST200
    // — fetched separately below instead, which doesn't depend on that.
    supabase
      .from('work_log_gerks')
      .select('gerk_code, start_time, end_time, duration, completed, work_logs!inner(operator_id, work_date)')
      .eq('work_logs.work_order_id', currentDetailWorkOrder.id),
  ]);

  // Both queries used to fail silently on error — data just came back
  // undefined and the UI quietly rendered as if nothing had ever been
  // logged (this is exactly how the profiles embed above hid its own
  // PGRST200 failures before it was split out).
  if (existingLogError || allEntriesError) {
    console.error('loadDetailForDate', existingLogError || allEntriesError);
    showFormError('Napaka pri nalaganju vpisanih ur. Poskusite znova.');
  }

  const operatorIds = [...new Set((allEntries || []).map(e => e.work_logs.operator_id))];
  const { data: operatorProfiles } = operatorIds.length
    ? await supabase.from('profiles').select('id, full_name').in('id', operatorIds)
    : { data: [] };
  const nameById = Object.fromEntries((operatorProfiles || []).map(p => [p.id, p.full_name]));
  for (const e of (allEntries || [])) e.work_logs.profiles = { full_name: nameById[e.work_logs.operator_id] };

  if (existingLog) {
    currentDetailLogId = existingLog.id;
    tractorInput.value = existingLog.tractor || '';
    descInput.value    = existingLog.description || '';
  }

  currentRoadTimeEntries = existingLog?.work_log_road_time || [];
  renderRoadTimeList();

  currentAllGerkEntries = allEntries || [];
  renderWorkLogGerkRows(buildGerkPlanRows(currentDetailWorkOrder, existingLog?.work_log_gerks || []));
  updateOrderHeader();
}

// Changing the date used to just re-fetch a *different* work_logs row
// (one row per operator/order/day) — any hours already entered under
// the old date stayed in the DB but vanished from view, looking like
// they'd been erased (they'd reappear if you switched the date back).
// move_work_log_date moves the in-progress log itself to the new date
// (merging into that day's log if one already exists there), so
// entering hours and picking the date can happen in either order.
workLogDateInput.addEventListener('change', async () => {
  updateWorkLogDateDisplay(); // the native picker just set .value itself — sync the overlay before anything else runs

  // Header-date mode (opened from a specific Planiranje calendar entry):
  // this field edits delovni_nalogi_planiranje.plan_date, not which day's
  // work-log to view — a completely different write, so branch off first.
  if (currentDetailPlanIsHeaderDate) {
    if (!currentDetailPlanId) { setWorkLogDate(currentDetailPlanDate || ''); return; } // plan row vanished (e.g. removed) since opening
    const newPlanDate = workLogDateInput.value;
    if (!newPlanDate) { setWorkLogDate(currentDetailPlanDate); return; }
    const oldPlanDate = currentDetailPlanDate;
    const { error } = await supabase.from('delovni_nalogi_planiranje').update({ plan_date: newPlanDate }).eq('id', currentDetailPlanId);
    if (error) {
      setWorkLogDate(oldPlanDate);
      showFormError('Napaka pri spreminjanju datuma planiranja: ' + error.message);
      return;
    }
    currentDetailPlanDate = newPlanDate;
    window.refreshPlanningEntries?.();
    return;
  }

  const oldDate = currentDetailDate;
  const oldLogId = currentDetailLogId;
  const newDate = workLogDateInput.value || todayISO();
  hideFormFeedback();

  if (oldLogId && newDate !== oldDate) {
    const { error } = await supabase.rpc('move_work_log_date', {
      p_work_order_id: currentDetailWorkOrder.id,
      p_old_date: oldDate,
      p_new_date: newDate,
    });
    if (error) {
      setWorkLogDate(oldDate);
      showFormError('Napaka pri spreminjanju datuma.');
      return;
    }
  }

  currentDetailDate = newDate;
  loadDetailForDate();
});

// Editing the scheduled date right here instead of only via drag-and-drop
// on the Planiranje calendar. Writes straight to delovni_nalogi_planiranje
// (this file's own Supabase client — same table planning.js's own client
// writes to, just from the other side), then tells planning.js to re-sync
// its cached calendar state if it's been loaded this session.
woPlanDateInput.addEventListener('change', async () => {
  if (!currentDetailPlanId) return;
  const newDate = woPlanDateInput.value;
  if (!newDate) { woPlanDateInput.value = currentDetailPlanDate; return; }
  const oldDate = currentDetailPlanDate;
  const { error } = await supabase.from('delovni_nalogi_planiranje').update({ plan_date: newDate }).eq('id', currentDetailPlanId);
  if (error) {
    woPlanDateInput.value = oldDate;
    showFormError('Napaka pri spreminjanju datuma planiranja: ' + error.message);
    return;
  }
  currentDetailPlanDate = newDate;
  window.refreshPlanningEntries?.();
});

// Same write reassignOperator() in planning.js does from a Planiranje
// card — reachable here too now, so it doesn't only work from that screen.
woIzvajalecEdit.addEventListener('change', async () => {
  const newIzvajalec = woIzvajalecEdit.value || null;
  const previousIzvajalec = currentDetailWorkOrder.izvajalec;
  woIzvajalecEdit.disabled = true;
  const { error } = await supabase.from('delovni_nalogi').update({ izvajalec: newIzvajalec }).eq('id', currentDetailWorkOrder.id);
  woIzvajalecEdit.disabled = false;
  if (error) {
    woIzvajalecEdit.value = previousIzvajalec || '';
    showFormError('Napaka pri spreminjanju izvajalca: ' + error.message);
    return;
  }
  currentDetailWorkOrder.izvajalec = newIzvajalec;
  currentDetailWorkOrder.profiles = newIzvajalec
    ? { full_name: operatorsList.find(p => p.id === newIzvajalec)?.full_name ?? null }
    : null;
  updateOrderHeader();
  await loadWorkOrders(); // keeps the main list's izvajalec sort/column in sync — same pattern as assignCustomerToWorkOrder
  window.refreshPlanningOrderOperator?.(currentDetailWorkOrder.id, newIzvajalec);
});

function closeModal() {
  hideModalAnimated(formModal);
  document.body.style.overflow = '';
  stopWatchingMyLocationOnWoMap();
  // Without this, a GERK selection left checked when the order was closed
  // kept wlgSelectionBar floating over the main list afterward — stacked
  // on top of woSelectionBar if a row was also selected there.
  clearGerkSelection();
  // Time logged via the live Start/Stop timers writes straight to Supabase
  // without updating the in-memory `logs` array — refresh it so Evidenca
  // dela reflects what was just logged.
  loadLogs();
}

function hideFormFeedback() {
  formError.hidden   = true;
  formSuccess.hidden = true;
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
  formSuccess.hidden = true;
}

function showFormSuccess(msg) {
  formSuccess.textContent = msg;
  formSuccess.hidden = false;
  formError.hidden = true;
}

// ── Live time tracking: today's work_logs + work_log_gerks ──────
// Both RPCs below do their own find-or-create of the day's work_logs
// row and the field's work_log_gerks row server-side, in one round
// trip — see supabase/migration_gerk_timer_rpc.sql. ensureTodaysLog()
// still handles that same find-or-create client-side, but only for the
// road-duration/tractor/notes fields, which aren't covered by either RPC.
let ensureTodaysLogPromise = null;

async function ensureTodaysLog() {
  if (currentDetailLogId) return currentDetailLogId;
  // Two fields saved in quick succession would otherwise both race
  // through the check-then-insert below before either resolves — share
  // the same in-flight promise so only one insert is ever attempted.
  if (ensureTodaysLogPromise) return ensureTodaysLogPromise;

  ensureTodaysLogPromise = (async () => {
    const { data: existing } = await supabase
      .from('work_logs')
      .select('id')
      .eq('operator_id', currentUser.id)
      .eq('work_order_id', currentDetailWorkOrder.id)
      .eq('work_date', currentDetailDate)
      .maybeSingle();

    if (existing) { currentDetailLogId = existing.id; return existing.id; }

    const { data, error } = await supabase
      .from('work_logs')
      .insert({ operator_id: currentUser.id, work_order_id: currentDetailWorkOrder.id, work_date: currentDetailDate, work_duration: 0 })
      .select('id')
      .single();

    if (error) {
      // Unique violation from a concurrent insert (e.g. a second tab)
      // that won the race — fetch the row it created instead of failing.
      if (error.code === '23505') {
        const { data: raceWinner, error: fetchErr } = await supabase
          .from('work_logs')
          .select('id')
          .eq('operator_id', currentUser.id)
          .eq('work_order_id', currentDetailWorkOrder.id)
          .eq('work_date', currentDetailDate)
          .single();
        if (fetchErr) throw fetchErr;
        currentDetailLogId = raceWinner.id;
        return raceWinner.id;
      }
      throw error;
    }

    currentDetailLogId = data.id;
    return data.id;
  })();

  try {
    return await ensureTodaysLogPromise;
  } finally {
    ensureTodaysLogPromise = null;
  }
}

// Applies an RPC's returned row to the DOM: timer/duration display,
// completed styling, and the Start/Stop button state.
function applyGerkRowUpdate(row, updated) {
  currentDetailLogId   = updated.log_id;
  row.dataset.start    = updated.start_time || '';
  row.dataset.end      = updated.end_time || '';
  row.dataset.duration = updated.duration ?? '';

  row.classList.toggle('wlg-row--completed', !!updated.completed);
  row.querySelector('[data-role="start-value"]').textContent = fmtClock(updated.start_time);
  row.querySelector('[data-role="end-value"]').textContent   = fmtClock(updated.end_time);
  row.querySelector('[data-action="wlg-start"]').disabled = !!updated.start_time;
  row.querySelector('[data-action="wlg-end"]').disabled = !updated.start_time || !!updated.completed;

  row.querySelector('.wlg-edit-panel').hidden = true;
  row.querySelector('.wlg-edit-start').value = toTimeInputValue(updated.start_time);
  row.querySelector('.wlg-edit-end').value   = toTimeInputValue(updated.end_time);

  updateOrderHeader();
}

async function startGerk(btn) {
  const row = btn.closest('.wlg-row');
  btn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('start_gerk', {
      p_work_order_id: currentDetailWorkOrder.id,
      p_gerk_code:      row.dataset.code,
      p_work_date:      currentDetailDate,
    });
    if (error) throw error;
    applyGerkRowUpdate(row, Array.isArray(data) ? data[0] : data);
  } catch (e) {
    showFormError('Napaka pri shranjevanju časa.');
  } finally {
    btn.disabled = false;
  }
}

async function endGerk(btn) {
  const row = btn.closest('.wlg-row');
  btn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('end_gerk', {
      p_work_order_id: currentDetailWorkOrder.id,
      p_gerk_code:      row.dataset.code,
      p_work_date:      currentDetailDate,
    });
    if (error) throw error;
    applyGerkRowUpdate(row, Array.isArray(data) ? data[0] : data);
  } catch (e) {
    showFormError(e.message || 'Napaka pri shranjevanju časa.');
  } finally {
    btn.disabled = false;
  }
}

function toggleGerkEdit(btn) {
  const row = btn.closest('.wlg-row');
  const panel = row.querySelector('.wlg-edit-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    // If this row's locked time belongs to another operator (admin
    // viewing/editing someone else's entry), default to THAT entry's
    // real date, not whatever date is currently open in the picker.
    row.querySelector('.wlg-edit-date').value  = row.dataset.ownerDate || currentDetailDate;
    row.querySelector('.wlg-edit-start').value = toTimeInputValue(row.dataset.start);
    row.querySelector('.wlg-edit-end').value   = toTimeInputValue(row.dataset.end);
  }
}

function cancelGerkEdit(btn) {
  btn.closest('.wlg-edit-panel').hidden = true;
}

// Phone-only label for the GERK/segments switch button — "N segmentov"
// when showing the GERK view (tap to switch to segments), "← GERK" when
// already showing segments (tap to switch back). Desktop never calls
// this; its button always just reads "N segmentov" since there it's a
// plain inline expand/collapse, not a view switch.
function updateSamplesToggleLabel(btn, showingSegments) {
  const label = btn.querySelector('span');
  if (showingSegments) {
    label.textContent = '← GERK';
  } else {
    const n = Number(btn.dataset.count);
    label.textContent = `${n} ${n === 1 ? 'segment' : 'segmentov'}`;
  }
}

function toggleGerkSamples(btn) {
  const row = btn.closest('.wlg-row');
  const panel = row.querySelector('.wlg-samples-panel');
  // Phone: a full view switch (GERK info OR segments, never both at
  // once — see the .wlg-row[data-mobile-view="segments"] rules in
  // style.css) instead of expanding the segments table inline below
  // the GERK info. Inline expansion could make a single row's card
  // grow very tall, pushing the pager's own buttons off-screen and
  // eating the room the map was cropped to free up. Desktop keeps the
  // original inline expand/collapse untouched.
  if (isMobile()) {
    const showingSegments = row.dataset.mobileView !== 'segments';
    row.dataset.mobileView = showingSegments ? 'segments' : 'gerk';
    panel.hidden = !showingSegments;
    btn.classList.toggle('wlg-samples-toggle--open', showingSegments);
    updateSamplesToggleLabel(btn, showingSegments);
    return;
  }
  panel.hidden = !panel.hidden;
  btn.classList.toggle('wlg-samples-toggle--open', !panel.hidden);
  if (!panel.hidden) panel.scrollIntoView({ block: 'nearest' });
}

// Combines the modal's selected work_date with an <input type="time">
// value (local HH:MM, no timezone) into a proper timestamptz.
function timeInputToISO(dateStr, timeVal) {
  if (!timeVal) return null;
  return new Date(`${dateStr}T${timeVal}:00`).toISOString();
}

async function saveGerkEdit(btn) {
  const row      = btn.closest('.wlg-row');
  const ownerId  = row.dataset.owner || null;
  // Baseline is the entry's own date when it belongs to another operator
  // (admin edit), otherwise the date currently open in the picker.
  const baseDate = row.dataset.ownerDate || currentDetailDate;
  const dateVal  = row.querySelector('.wlg-edit-date').value || baseDate;
  const startVal = row.querySelector('.wlg-edit-start').value;
  const endVal   = row.querySelector('.wlg-edit-end').value;
  const moved    = dateVal !== baseDate;

  btn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('set_gerk_times', {
      p_work_order_id: currentDetailWorkOrder.id,
      p_gerk_code:      row.dataset.code,
      p_start_time:     timeInputToISO(dateVal, startVal),
      p_end_time:       timeInputToISO(dateVal, endVal),
      p_work_date:      dateVal,
      p_previous_work_date: baseDate,
      p_target_operator_id: ownerId,
    });
    if (error) throw error;
    if (moved) {
      // Entry now belongs to a different day's log. Rows are one-per-
      // planned-field, not one-per-entry, so this row stays in the list —
      // it just needs to drop back to "not started" for currentDetailDate.
      // Reloading is simplest and matches what a fresh open would show.
      await loadDetailForDate();
      showFormSuccess(`Vnos prestavljen na ${fmtSampleDate(dateVal)}.`);
    } else if ((!startVal && !endVal) || ownerId) {
      // Clearing a field (blank start+end), or an admin editing another
      // operator's entry — either way the row's own RPC result isn't
      // enough: a full reload also refreshes the "who else worked this"
      // list and header total, which a single-row patch wouldn't.
      await loadDetailForDate();
    } else {
      applyGerkRowUpdate(row, Array.isArray(data) ? data[0] : data);
    }
  } catch (e) {
    showFormError(e.message || 'Napaka pri shranjevanju.');
  } finally {
    btn.disabled = false;
  }
}

function wireGerkRowButtons() {
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-select"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedGerkCodes.add(cb.dataset.code);
      else selectedGerkCodes.delete(cb.dataset.code);
      updateGerkSelectionBar();
    });
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-start"]').forEach(btn => {
    btn.addEventListener('click', () => startGerk(btn));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-end"]').forEach(btn => {
    btn.addEventListener('click', () => endGerk(btn));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-edit-toggle"]').forEach(btn => {
    btn.addEventListener('click', () => toggleGerkEdit(btn));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-edit-save"]').forEach(btn => {
    btn.addEventListener('click', () => saveGerkEdit(btn));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-edit-cancel"]').forEach(btn => {
    btn.addEventListener('click', () => cancelGerkEdit(btn));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-remove-gerk"]').forEach(btn => {
    btn.addEventListener('click', () => removeGerkFromOrder(btn));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-samples-toggle"]').forEach(btn => {
    btn.addEventListener('click', () => toggleGerkSamples(btn));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-add-sample-toggle"]').forEach(btn => {
    btn.addEventListener('click', () => toggleAddSampleForm(btn.closest('.wlg-add-sample-wrap'), true));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-add-sample-cancel"]').forEach(btn => {
    btn.addEventListener('click', () => toggleAddSampleForm(btn.closest('.wlg-add-sample-wrap'), false));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-add-sample-confirm"]').forEach(btn => {
    btn.addEventListener('click', () => addSample(btn));
  });
  workLogGerkRowsEl.querySelectorAll('.wlg-lab-type-select').forEach(sel => {
    sel.addEventListener('change', () => updateGerkLabType(sel));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-remove-sample"]').forEach(btn => {
    btn.addEventListener('click', () => removeSample(btn));
  });
  workLogGerkRowsEl.querySelectorAll('.wlg-sampleno-input').forEach(input => {
    input.addEventListener('change', () => updateSampleNo(input));
  });
  workLogGerkRowsEl.querySelectorAll('.wlg-vzorcenje-select').forEach(sel => {
    sel.addEventListener('change', () => updateSampleVzorcenje(sel));
  });
  workLogGerkRowsEl.querySelectorAll('.wlg-globina-select').forEach(sel => {
    sel.addEventListener('change', () => updateSampleGlobina(sel));
  });
  workLogGerkRowsEl.querySelectorAll('.wlg-comment-input').forEach(input => {
    input.addEventListener('change', () => updateSampleComment(input));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-open-map"]').forEach(btn => {
    btn.addEventListener('click', () => openMapModal(Number(btn.dataset.lat), Number(btn.dataset.lng), btn.dataset.label));
  });
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-highlight-map"]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('a, button, select, input')) return; // let their own handlers run undisturbed
      highlightGerkOnWoMap(el.closest('.wlg-row')?.dataset.code);
    });
  });
}

// Adds one new segment/sample row for a GERK — sample_no auto-suggested
// as (highest existing number for that GERK) + 1, everything else left
// blank to fill in afterward via the existing dropdowns/inputs.
// currentDetailWorkOrder.delovni_nalogi_gerki isn't kept in sync by
// loadDetailForDate() (that only re-fetches work_logs/work_log_gerks
// for the day), so the freshly inserted row is fetched directly and
// patched in before re-rendering.
function toggleAddSampleForm(wrap, open) {
  wrap.querySelector('.wlg-add-sample').hidden = open;
  wrap.querySelector('.wlg-add-sample-form').hidden = !open;
  if (!open) {
    wrap.querySelectorAll('.wlg-new-sample-input').forEach(sel => { sel.value = ''; });
  }
}

// Vzorčenje/Globina can be set here, at creation, or edited later via
// the table itself (see renderSamplingCell/renderSampleDepthCell,
// updateSampleVzorcenje/updateSampleGlobina). Št. segmenta is typed
// here too, not auto-numbered — the lab's own numbering doesn't follow
// a simple next-integer sequence, so guessing one just meant it had to
// be corrected by hand anyway.
async function addSample(btn) {
  const wrap  = btn.closest('.wlg-add-sample-wrap');
  const gerkId = wrap.dataset.gerkId;
  const sampleNo  = wrap.querySelector('[data-role="new-sample-no"]').value.trim();
  const vzorcenje = wrap.querySelector('[data-role="new-vzorcenje"]').value || null;
  const globina   = wrap.querySelector('[data-role="new-globina"]').value;
  const comment   = wrap.querySelector('[data-role="new-comment"]').value.trim() || null;
  if (!sampleNo) { showFormError('Vpišite št. segmenta.'); return; }

  const gerk = (currentDetailWorkOrder.delovni_nalogi_gerki || []).find(g => g.id === gerkId);
  const existing = gerk?.delovni_nalogi_vzorci || [];

  btn.disabled = true;
  try {
    const { data, error } = await supabase
      .from('delovni_nalogi_vzorci')
      .insert({
        delovni_nalog_gerk_id: gerkId,
        sample_no: sampleNo,
        sampling_note: vzorcenje,
        sampling_depth_cm: globina ? parseInt(globina, 10) : null,
        comment,
      })
      .select('id, sample_no, sampling_date, sending_date, sampling_note, sending_note, sampling_depth_cm, area_ha, comment')
      .single();
    if (error) throw error;

    gerk.delovni_nalogi_vzorci = [...existing, data];
    toggleAddSampleForm(wrap, false);
    await loadDetailForDate();
  } catch (e) {
    // 23505 = unique_violation on (delovni_nalog_gerk_id, sample_no) —
    // this GERK already has a segment with that number.
    showFormError(e.code === '23505'
      ? 'Ta št. segmenta je znotraj GERK-a že v uporabi.'
      : (e.message || 'Napaka pri dodajanju segmenta.'));
  } finally {
    btn.disabled = false;
  }
}

// Removing a GERK from an already-created order — its segments/samples
// (delovni_nalogi_vzorci) cascade-delete automatically via the DB's
// own ON DELETE CASCADE FK, so no separate guard/warning for those.
// Logged work time (work_log_gerks) isn't FK-tied to this row at all
// (it's keyed by gerk_code, independent of delovni_nalogi_gerki.id),
// so it survives the removal as historical data — but since that can
// leave it looking orphaned from the order's current GERK list, it's
// not a silent, no-warning removal either: a soft warn-then-continue,
// not a hard block.
async function removeGerkFromOrder(btn) {
  const gerkRowId = btn.dataset.gerkRowId;
  const gerkCode  = btn.closest('.wlg-row').dataset.code;

  // currentAllGerkEntries already holds every operator's work_log_gerks
  // rows for this order (loaded once in loadDetailForDate) — no need for
  // a round trip to check for logged time.
  const hasLoggedTime = currentAllGerkEntries.some(e => e.gerk_code === gerkCode && (e.start_time || e.completed));
  const confirmMsg = hasLoggedTime
    ? `Na GERKU "${gerkCode}" je že zabeležen čas dela. Odstranitev bo izbrisala tudi vse njegove segmente/vzorce (zabeležen čas dela ostane v evidenci). Nadaljujem?`
    : 'Odstranim ta GERK iz naloga? Izbrisani bodo tudi vsi njegovi segmenti/vzorci.';
  if (!confirm(confirmMsg)) return;

  btn.disabled = true;
  const { error } = await supabase.from('delovni_nalogi_gerki').delete().eq('id', gerkRowId);
  btn.disabled = false;
  if (error) return showFormError(error.message || 'Napaka pri odstranjevanju GERKA.');

  currentDetailWorkOrder.delovni_nalogi_gerki = (currentDetailWorkOrder.delovni_nalogi_gerki || []).filter(g => g.id !== gerkRowId);
  await loadDetailForDate();
  await loadWorkOrders();
  // Redraw — otherwise the removed GERK's shape/zones (drawn once when
  // the modal opened) stay stuck on screen since nothing else here
  // touches the map layers.
  await showWoDetailMap(currentDetailWorkOrder);
}

// ── GERK selection bar (admin-only multi-select on the detail view) ──
// Built once as a small, generic, config-driven toolbar — a close
// button, a live summary, and a list of actions (icon + label +
// tooltip + variant + its own onClick) — so a second use of this
// pattern elsewhere would just need a new config, not new markup.
const WLG_SEL_ICON_CLOSE = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><line x1="4" y1="4" x2="16" y2="16" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><line x1="16" y1="4" x2="4" y2="16" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`;
const WLG_SEL_ICON_TRASH = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 6h12M8 6V4.5A1.5 1.5 0 0 1 9.5 3h1A1.5 1.5 0 0 1 12 4.5V6m-6 0v9a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 14 15V6M7.5 9v4M12.5 9v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const WLG_SEL_ICON_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M4 14v1.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const WLG_SEL_ICON_ZIP = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M10 4v2m0 2v2m0 2v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

// KML export (exportSelectedGerksToKml) intentionally not wired into this
// bar for now — not needed currently, kept in code (not deleted) in case
// it's wanted back.
const GERK_SELECTION_ACTIONS = [
  { id: 'export',     label: 'Izvozi',      tooltip: 'Izvozi izbrane GERKE v Excel',                 icon: WLG_SEL_ICON_DOWNLOAD, variant: 'default', onClick: exportSelectedGerksToExcel },
  { id: 'export-shp', label: 'ZIP',          tooltip: 'Izvozi cone vzorčenja izbranih GERKOV (shapefile/NextFarm)', icon: WLG_SEL_ICON_ZIP, variant: 'default', onClick: exportSelectedGerksToShapefile },
  { id: 'delete',     label: 'Briši',       tooltip: 'Izbriši izbrane GERKE iz naloga',              icon: WLG_SEL_ICON_TRASH,    variant: 'danger',  onClick: bulkDeleteSelectedGerks },
];

function buildSelectionBar() {
  wlgSelectionBar.setAttribute('role', 'toolbar');
  wlgSelectionBar.setAttribute('aria-label', 'Skupinska dejanja za izbrane GERKE');
  wlgSelectionBar.innerHTML = `
    <span class="wlg-sel-summary"></span>
    <button type="button" class="wlg-sel-close" data-action="wlg-sel-close" aria-label="Prekliči izbiro" title="Prekliči izbiro">${WLG_SEL_ICON_CLOSE}</button>
    <span class="wlg-sel-sep" aria-hidden="true"></span>
    <div class="wlg-sel-actions">
      ${GERK_SELECTION_ACTIONS.map((a, i) => `
        ${i > 0 ? '<span class="wlg-sel-sep" aria-hidden="true"></span>' : ''}
        <button type="button" class="wlg-sel-action wlg-sel-action--${a.variant}" data-action-id="${a.id}" aria-label="${escHtml(a.tooltip)}" title="${escHtml(a.tooltip)}">
          ${a.icon}<span class="wlg-sel-action-label">${escHtml(a.label)}</span>
        </button>`).join('')}
    </div>`;
  wlgSelectionBar.querySelector('[data-action="wlg-sel-close"]').addEventListener('click', clearGerkSelection);
  GERK_SELECTION_ACTIONS.forEach(a => {
    const btn = wlgSelectionBar.querySelector(`[data-action-id="${a.id}"]`);
    btn.addEventListener('click', () => a.onClick(btn));
  });
}
buildSelectionBar();

function updateGerkSelectionBar() {
  const n = selectedGerkCodes.size;
  wlgSelectionBar.classList.toggle('wlg-selection-bar--visible', n > 0);
  if (n === 0) return;
  // "3 izbranih" alone, or "3 izbranih · 1.24 ha" once the selected
  // GERKs' own areas are known — a plain count doesn't tell you how
  // much land a bulk delete/export is actually about to touch.
  const gerks = (currentDetailWorkOrder?.delovni_nalogi_gerki || []).filter(g => selectedGerkCodes.has(g.gerk_code));
  const totalHa = gerks.reduce((s, g) => s + (Number(g.kolicina_ha) || 0), 0);
  const countLabel = `${n} ${n === 1 ? 'izbran' : 'izbranih'}`;
  const summaryEl = wlgSelectionBar.querySelector('.wlg-sel-summary');
  if (summaryEl) summaryEl.textContent = totalHa > 0 ? `${countLabel} · ${totalHa.toFixed(2)} ha` : countLabel;
}

function clearGerkSelection() {
  selectedGerkCodes = new Set();
  workLogGerkRowsEl.querySelectorAll('[data-action="wlg-select"]').forEach(cb => { cb.checked = false; });
  updateGerkSelectionBar();
}

// Same reasoning as the single-row remove: segments/samples cascade-
// delete automatically via the DB's own FK, no guard needed. Logged
// time isn't FK-tied to these rows, so it survives removal as
// historical data — GERKs with logged time get one combined warning
// (which ones, and that they'll still be removed if confirmed) rather
// than either a silent removal or a hard block.
async function bulkDeleteSelectedGerks(btn) {
  const codes = [...selectedGerkCodes];
  if (!codes.length) return;

  const rows = codes
    .map(code => (currentDetailWorkOrder.delovni_nalogi_gerki || []).find(g => g.gerk_code === code))
    .filter(Boolean);
  if (!rows.length) return;

  const withLoggedTime = rows.filter(g => currentAllGerkEntries.some(e => e.gerk_code === g.gerk_code && (e.start_time || e.completed)));
  let removable = rows;
  if (withLoggedTime.length) {
    const proceed = confirm(
      `Na ${withLoggedTime.length} od izbranih GERKOV (${withLoggedTime.map(g => g.gerk_code).join(', ')}) je že zabeležen čas dela. ` +
      `Odstranitev bo izbrisala tudi njihove segmente/vzorce (zabeležen čas dela ostane v evidenci).\n\n` +
      `Odstranim vseh ${rows.length} izbranih GERKOV (vključno s temi)?`
    );
    if (!proceed) {
      removable = rows.filter(g => !withLoggedTime.includes(g));
      if (!removable.length) return;
      if (!confirm(`Odstranim preostalih ${removable.length} GERKOV (brez zabeleženega časa) iz naloga?`)) return;
    }
  } else if (!confirm(`Odstranim ${rows.length} izbranih GERKOV iz naloga? Izbrisani bodo tudi njihovi segmenti/vzorci.`)) {
    return;
  }

  btn.disabled = true;
  try {
    const { error } = await supabase.from('delovni_nalogi_gerki').delete().in('id', removable.map(g => g.id));
    if (error) throw error;

    const removedIds = new Set(removable.map(g => g.id));
    currentDetailWorkOrder.delovni_nalogi_gerki = (currentDetailWorkOrder.delovni_nalogi_gerki || []).filter(g => !removedIds.has(g.id));
    clearGerkSelection();
    await loadDetailForDate();
    await loadWorkOrders();
    await showWoDetailMap(currentDetailWorkOrder);
    const skipped = rows.length - removable.length;
    showFormSuccess(`✓ ${removable.length} GERKOV odstranjenih.` + (skipped ? ` Preskočenih: ${skipped}.` : ''));
  } catch (e) {
    showFormError(e.message || 'Napaka pri odstranjevanju.');
  } finally {
    btn.disabled = false;
  }
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function kmlRingCoords(ring) {
  return ring.map(([lng, lat]) => `${lng},${lat},0`).join(' ');
}
function kmlPolygon(coordinates) {
  // coordinates[0] is the outer ring — inner rings (holes) aren't used
  // by any shape in this app, so they're not carried into the export.
  return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlRingCoords(coordinates[0])}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
}
function geojsonToKmlGeometry(geojson) {
  if (!geojson) return '';
  if (geojson.type === 'Polygon') return kmlPolygon(geojson.coordinates);
  if (geojson.type === 'MultiPolygon') return `<MultiGeometry>${geojson.coordinates.map(kmlPolygon).join('')}</MultiGeometry>`;
  return '';
}
function buildKmlDocument(features) {
  const placemarks = features.map(f => `
    <Placemark>
      <name>${escHtml(f.name)}</name>
      ${geojsonToKmlGeometry(f.geojson)}
    </Placemark>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${placemarks}
</Document></kml>`;
}

// A Leaflet GeoJSON layer's own toGeoJSON() wraps its geometry in a
// Feature (single sub-layer) or FeatureCollection (more than one) —
// normalizing here so callers always just get the bare geometry.
function layerGeometry(layer) {
  const gj = layer.toGeoJSON();
  if (gj.type === 'FeatureCollection') return gj.features[0]?.geometry ?? null;
  if (gj.type === 'Feature') return gj.geometry;
  return gj;
}

// Exports whatever geometry is already drawn on the map for each
// selected GERK — its official boundary shape when it has one,
// otherwise its imported KML zones (a text-named GERK with no
// registry polygon has only those). A GERK with neither is skipped
// and called out in the result message rather than silently dropped.
function exportSelectedGerksToKml(btn) {
  const codes = [...selectedGerkCodes];
  if (!codes.length) return;

  const features = [];
  const skipped = [];
  for (const code of codes) {
    const entry = woMapLayersByCode.get(code);
    if (entry?.shapes?.length) {
      // A compound "A+B+C" code (see get_work_order_gerk_shapes) has
      // one shape per real GERK sharing this entry — export each as
      // its own placemark, same as the zoneLayers branch below.
      let any = false;
      entry.shapes.forEach((layer, i) => {
        const geojson = layerGeometry(layer);
        if (!geojson) return;
        any = true;
        features.push({ name: entry.shapes.length > 1 ? `${code} (${i + 1})` : code, geojson });
      });
      if (!any) skipped.push(code);
    } else if (entry?.zoneLayers?.length) {
      for (const layer of entry.zoneLayers) {
        const geojson = layerGeometry(layer);
        if (!geojson) continue;
        const label = layer.getTooltip?.()?.getContent() || '';
        features.push({ name: `${code} · ${label}`.trim(), geojson });
      }
    } else {
      skipped.push(code);
    }
  }

  if (!features.length) {
    showFormError('Noben izbran GERK nima geometrije za izvoz.');
    return;
  }

  const kml = buildKmlDocument(features);
  const filename = `${(currentDetailWorkOrder?.stevilka || 'gerki').replace(/[^\w.-]+/g, '_')}_export.kml`;
  downloadTextFile(filename, kml, 'application/vnd.google-earth.kml+xml');
  showFormSuccess(`✓ Izvoženih ${features.length} ${features.length === 1 ? 'oblika' : 'oblik'} v KML.` + (skipped.length ? ` Brez geometrije: ${skipped.join(', ')}.` : ''));
}

// Same CSV shape as the work-orders list's export (one row per segment,
// Ha = the segment's own area_ha, comma-decimal for Excel) — just scoped
// to the selected GERKs of this one order instead of a set of orders.
function exportSelectedGerksToExcel(btn) {
  const codes = [...selectedGerkCodes];
  if (!codes.length) return;

  const wo = currentDetailWorkOrder;
  const gerks = (wo?.delovni_nalogi_gerki || []).filter(g => codes.includes(g.gerk_code));
  if (!gerks.length) return;

  const header = ['Št. naloga', 'GERK', 'Segment', 'Ha'];
  const lines = [header.map(csvField).join(';')];
  for (const g of gerks) {
    const segments = g.delovni_nalogi_vzorci || [];
    if (!segments.length) {
      lines.push([wo.stevilka || '', g.gerk_code || '', '', csvHa(g.kolicina_ha)].map(csvField).join(';'));
    } else {
      for (const s of segments) {
        lines.push([wo.stevilka || '', g.gerk_code || '', s.sample_no || '', csvHa(s.area_ha)].map(csvField).join(';'));
      }
    }
  }

  const csv = '﻿' + lines.join('\r\n');
  downloadTextFile(`${(wo?.stevilka || 'gerki').replace(/[^\w.-]+/g, '_')}_export.csv`, csv, 'text/csv;charset=utf-8');
}

// ── Export sampling zones to a NextFarm-compatible shapefile ─────
// NextFarm (the soil-sampling app the lab's own reports are built from)
// exports a per-customer shapefile where each row is one sampling zone —
// not one GERK — carrying a sample number (PROBENUMME) and area, plus a
// full set of lab-chemistry columns that ship blank until the lab sends
// results back. Reproducing that exact schema (field names/widths/
// decimals byte-for-byte, verified against a real NextFarm export) lets
// this file be handed straight to the lab/NextFarm instead of re-typed.
// Coordinates are reprojected from this app's native WGS84 lon/lat to
// UTM 33N meters (matches NextFarm's own export) — the projection formula
// was verified against real paired WGS84/UTM33N coordinates for the same
// sampling zone to within 16cm.

function wgs84ToUtm33N(lon, lat) {
  const a = 6378137.0, f = 1 / 298.257223563, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const k0 = 0.9996, lon0 = 15 * Math.PI / 180, FE = 500000, FN = 0;
  const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = (lambda - lon0) * Math.cos(phi);
  const M = a * (
    (1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * phi
    - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * Math.sin(2*phi)
    + (15*e2**2/256 + 45*e2**3/1024) * Math.sin(4*phi)
    - (35*e2**3/3072) * Math.sin(6*phi)
  );
  const x = FE + k0*N*(A + (1-T+C)*A**3/6 + (5-18*T+T**2+72*C-58*ep2)*A**5/120);
  const y = FN + k0*(M + N*Math.tan(phi)*(A**2/2 + (5-T+9*C+4*C**2)*A**4/24 + (61-58*T+T**2+600*C-330*ep2)*A**6/720));
  return [x, y];
}

const NF_PRJ_WKT = 'PROJCS["MYCUSTOM_TGIS_CSProjectedCoordinateSystem_GeoPROJ_SYS_32633_9807_7006945_8901_9001",GEOGCS["MYCUSTOM_TGIS_CSGeographicCoordinateSystem_GeoSYS_7006945_8901",DATUM["MYCUSTOM_TGIS_CSDatum_WGS84",SPHEROID["WGS_1984",6378137,298.257223563],TOWGS84[0,0,0,0,0,0,0]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator",AUTHORITY["EPSG","9807"]],PARAMETER["Central_Meridian",15],PARAMETER["Latitude_Of_Origin",0],PARAMETER["False_Easting",500000],PARAMETER["False_Northing",0],PARAMETER["Scale_Factor",0.9996],UNIT["Meter",1,AUTHORITY["EPSG","9001"]]]';

// ESRI shapefiles want exterior rings clockwise, holes counter-clockwise
// — the opposite of GeoJSON's own convention — so flip whichever rings
// don't already match before writing.
function nfShoelaceSignedArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0]*ring[i+1][1] - ring[i+1][0]*ring[i][1];
  return s / 2;
}
function nfEnsureWinding(ring, wantClockwise) {
  const isClockwise = nfShoelaceSignedArea(ring) < 0;
  return isClockwise === wantClockwise ? ring : ring.slice().reverse();
}
function nfPolygonAreaHa(rings) { // rings already projected to UTM meters
  if (!rings.length) return 0;
  const outer = Math.abs(nfShoelaceSignedArea(rings[0]));
  const holes = rings.slice(1).reduce((s, r) => s + Math.abs(nfShoelaceSignedArea(r)), 0);
  return (outer - holes) / 10000;
}

// features: [{ rings: [[[x,y],...], ...] }], rings[0] exterior, rest holes
function nfBuildShpShx(features) {
  const recordBlobs = features.map(f => {
    const rings = f.rings.map((ring, ri) => nfEnsureWinding(ring, ri === 0));
    let numPoints = 0;
    const parts = [];
    for (const ring of rings) { parts.push(numPoints); numPoints += ring.length; }
    const contentLenBytes = 4 + 32 + 4 + 4 + parts.length * 4 + numPoints * 16;
    const dv = new DataView(new ArrayBuffer(contentLenBytes));
    let o = 0;
    dv.setInt32(o, 5, true); o += 4; // shape type: Polygon
    let xmin=Infinity, ymin=Infinity, xmax=-Infinity, ymax=-Infinity;
    for (const ring of rings) for (const [x,y] of ring) { if(x<xmin)xmin=x; if(x>xmax)xmax=x; if(y<ymin)ymin=y; if(y>ymax)ymax=y; }
    dv.setFloat64(o, xmin, true); o += 8;
    dv.setFloat64(o, ymin, true); o += 8;
    dv.setFloat64(o, xmax, true); o += 8;
    dv.setFloat64(o, ymax, true); o += 8;
    dv.setInt32(o, parts.length, true); o += 4;
    dv.setInt32(o, numPoints, true); o += 4;
    for (const p of parts) { dv.setInt32(o, p, true); o += 4; }
    for (const ring of rings) for (const [x,y] of ring) { dv.setFloat64(o, x, true); o += 8; dv.setFloat64(o, y, true); o += 8; }
    return new Uint8Array(dv.buffer);
  });

  let fileXmin=Infinity, fileYmin=Infinity, fileXmax=-Infinity, fileYmax=-Infinity;
  for (const f of features) for (const ring of f.rings) for (const [x,y] of ring) {
    if(x<fileXmin)fileXmin=x; if(x>fileXmax)fileXmax=x; if(y<fileYmin)fileYmin=y; if(y>fileYmax)fileYmax=y;
  }

  const shpRecordsTotalBytes = recordBlobs.reduce((s, b) => s + 8 + b.length, 0);
  const shpTotalBytes = 100 + shpRecordsTotalBytes;
  const shp = new Uint8Array(shpTotalBytes);
  const shpDv = new DataView(shp.buffer);
  const shx = new Uint8Array(100 + recordBlobs.length * 8);
  const shxDv = new DataView(shx.buffer);
  for (const [dv, totalLen] of [[shpDv, shpTotalBytes], [shxDv, shx.length]]) {
    dv.setInt32(0, 9994, false);
    dv.setInt32(24, totalLen / 2, false);
    dv.setInt32(28, 1000, true);
    dv.setInt32(32, 5, true);
    dv.setFloat64(36, fileXmin, true);
    dv.setFloat64(44, fileYmin, true);
    dv.setFloat64(52, fileXmax, true);
    dv.setFloat64(60, fileYmax, true);
  }

  let shpOffset = 100;
  recordBlobs.forEach((blob, i) => {
    shpDv.setInt32(shpOffset, i + 1, false);
    shpDv.setInt32(shpOffset + 4, blob.length / 2, false);
    shp.set(blob, shpOffset + 8);
    shxDv.setInt32(100 + i * 8, shpOffset / 2, false);
    shxDv.setInt32(100 + i * 8 + 4, blob.length / 2, false);
    shpOffset += 8 + blob.length;
  });

  return { shp, shx };
}

function nfDbfField(name, type, length, decimals = 0) { return { name, type, length, decimals }; }

function nfBuildDbf(fields, rows) {
  const enc = new TextEncoder();
  const recordLen = 1 + fields.reduce((s, f) => s + f.length, 0);
  const headerLen = 32 + fields.length * 32 + 1;
  const now = new Date();
  const bytes = new Uint8Array(headerLen + recordLen * rows.length + 1);
  const dv = new DataView(bytes.buffer);

  bytes[0] = 3; // dBase III, no memo
  bytes[1] = now.getFullYear() - 1900;
  bytes[2] = now.getMonth() + 1;
  bytes[3] = now.getDate();
  dv.setUint32(4, rows.length, true);
  dv.setUint16(8, headerLen, true);
  dv.setUint16(10, recordLen, true);

  let o = 32;
  for (const f of fields) {
    bytes.set(enc.encode(f.name.slice(0, 10)), o);
    bytes[o + 11] = f.type.charCodeAt(0);
    bytes[o + 16] = f.length;
    bytes[o + 17] = f.decimals;
    o += 32;
  }
  bytes[o] = 0x0d; o += 1;

  for (const row of rows) {
    bytes[o] = 0x20; // not deleted
    let fo = o + 1;
    for (const f of fields) {
      const val = row[f.name];
      let str;
      if (f.type === 'N') {
        const num = (val === null || val === undefined || val === '') ? 0 : Number(val);
        str = num.toFixed(f.decimals).padStart(f.length, ' ').slice(-f.length);
      } else {
        str = ((val === null || val === undefined) ? '' : String(val)).slice(0, f.length).padEnd(f.length, ' ');
      }
      const strBytes = enc.encode(str).slice(0, f.length);
      bytes.set(strBytes, fo);
      if (strBytes.length < f.length) bytes.fill(0x20, fo + strBytes.length, fo + f.length);
      fo += f.length;
    }
    o += recordLen;
  }
  bytes[o] = 0x1a; // EOF marker
  return bytes;
}

const NF_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function nfCrc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = NF_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function nfBuildZip(entries) { // [{ name, data: Uint8Array }]
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = nfCrc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.data.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    localParts.push(new Uint8Array(local.buffer), nameBytes, entry.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, entry.data.length, true);
    central.setUint32(24, entry.data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);

    offset += 30 + nameBytes.length + entry.data.length;
  }

  const centralStart = offset;
  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of [...localParts, ...centralParts]) { out.set(part, p); p += part.length; }
  out.set(new Uint8Array(eocd.buffer), p);
  return out;
}

const NF_DBF_FIELDS = [
  nfDbfField('ID', 'C', 5), nfDbfField('SCHLAGNUMM', 'C', 30), nfDbfField('SCHLAGNAME', 'C', 30),
  nfDbfField('KUNDE', 'C', 10), nfDbfField('NUTZART', 'C', 10), nfDbfField('PROBEDATUM', 'C', 20),
  nfDbfField('PROBENUMME', 'C', 30), nfDbfField('FEIN', 'N', 10, 8), nfDbfField('HUMUS', 'N', 10, 8),
  nfDbfField('BODENART', 'C', 10), nfDbfField('LABORPRNR', 'C', 30), nfDbfField('HUMUS_NGES', 'N', 10, 8),
  nfDbfField('HUMUS_CN', 'N', 10, 8), nfDbfField('FLAECHE_HA', 'N', 10, 8), nfDbfField('ANALYSEINF', 'C', 100),
  nfDbfField('P_WERT', 'N', 10, 8), nfDbfField('P_VS', 'C', 10), nfDbfField('P_EMPFEHLU', 'N', 10, 8),
  nfDbfField('K_WERT', 'N', 10, 8), nfDbfField('K_VS', 'C', 10), nfDbfField('K_EMPFEHLU', 'N', 10, 8),
  nfDbfField('MG_WERT', 'N', 10, 8), nfDbfField('MG_VS', 'C', 10), nfDbfField('MG_EMPFEHL', 'N', 10, 8),
  nfDbfField('PH_WERT', 'N', 10, 8), nfDbfField('PH_VS', 'C', 10), nfDbfField('PH_EMPFEHL', 'N', 10, 8),
  nfDbfField('B_WERT', 'N', 10, 8), nfDbfField('B_VS', 'C', 10), nfDbfField('B_EMPFEHLU', 'N', 10, 8),
  nfDbfField('CU_WERT', 'N', 10, 8), nfDbfField('CU_VS', 'C', 10), nfDbfField('CU_EMPFEHL', 'N', 10, 8),
  nfDbfField('MN_WERT', 'N', 10, 8), nfDbfField('MN_VS', 'C', 10), nfDbfField('MN_EMPFEHL', 'N', 10, 8),
  nfDbfField('MO_WERT', 'N', 10, 8), nfDbfField('MO_VS', 'C', 10), nfDbfField('MO_EMPFEHL', 'N', 10, 8),
  nfDbfField('ZN_WERT', 'N', 10, 8), nfDbfField('ZN_VS', 'C', 10), nfDbfField('ZN_EMPFEHL', 'N', 10, 8),
  nfDbfField('S_WERT', 'N', 10, 8), nfDbfField('S_VS', 'C', 10), nfDbfField('S_EMPFEHLU', 'N', 10, 8),
];

function fmtDateSlashes(isoDate) { // 'YYYY-MM-DD' -> 'DD/MM/YYYY'
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

function geojsonRingsLonLat(geojson) {
  if (!geojson) return [];
  if (geojson.type === 'Polygon') return geojson.coordinates;
  if (geojson.type === 'MultiPolygon') return geojson.coordinates.flat();
  return [];
}

// A zone's sample_no (segment_label) is only unique within the order, not
// tied to a specific compound sub-code — matched by value across every
// GERK line's sample list, same as the rest of this file treats sample
// numbers.
function findVzorecForZone(seg) {
  for (const g of (currentDetailWorkOrder?.delovni_nalogi_gerki || [])) {
    const match = (g.delovni_nalogi_vzorci || []).find(s => s.sample_no === seg.segment_label);
    if (match) return match;
  }
  return null;
}

function zoneAreaHa(seg, projectedRings) {
  const vzorec = findVzorecForZone(seg);
  if (vzorec?.area_ha != null) return Number(vzorec.area_ha);
  const rings = projectedRings || geojsonRingsLonLat(seg.segment_geojson).map(ring => ring.map(([lon, lat]) => wgs84ToUtm33N(lon, lat)));
  return nfPolygonAreaHa(rings);
}

// Same shapefile build as before, now driven directly by the GERK
// selection bar's selectedGerkCodes instead of its own picker modal —
// GERKs with no imported sampling zone geometry are silently skipped
// (reported in the result message) rather than never shown at all.
function exportSelectedGerksToShapefile(btn) {
  if (!currentDetailWorkOrder) return;
  const codes = [...selectedGerkCodes];
  if (!codes.length) return;

  const customerName = (currentDetailWorkOrder.customers?.naziv || currentDetailWorkOrder.customers?.company_name || '').trim();
  const zones = currentGerkSegments
    .filter(seg => codes.includes(seg.gerk_code) && seg.segment_geojson)
    .sort((a, b) => a.gerk_code.localeCompare(b.gerk_code, 'sl') || (a.segment_label || '').localeCompare(b.segment_label || '', 'sl'));

  const features = [];
  const rows = [];
  let id = 1;
  for (const seg of zones) {
    const rings = geojsonRingsLonLat(seg.segment_geojson).map(ring => ring.map(([lon, lat]) => wgs84ToUtm33N(lon, lat)));
    if (!rings.length) continue;
    features.push({ rings });

    const vzorec = findVzorecForZone(seg);
    rows.push({
      ID: String(id++),
      SCHLAGNAME: `${seg.gerk_code} ${customerName}`.trim(),
      PROBEDATUM: fmtDateSlashes(vzorec?.sampling_date),
      PROBENUMME: seg.segment_label || '',
      FLAECHE_HA: zoneAreaHa(seg, rings),
    });
  }

  if (!features.length) { showFormError('Noben izbran GERK nima uvožene cone vzorčenja za izvoz.'); return; }

  const { shp, shx } = nfBuildShpShx(features);
  const dbf = nfBuildDbf(NF_DBF_FIELDS, rows);
  const prj = new TextEncoder().encode(NF_PRJ_WKT);
  const baseName = `${(currentDetailWorkOrder.stevilka || 'vzorcenje').replace(/[^\w.-]+/g, '_')}_vzorcenje`;
  const zip = nfBuildZip([
    { name: `${baseName}.shp`, data: shp },
    { name: `${baseName}.shx`, data: shx },
    { name: `${baseName}.dbf`, data: dbf },
    { name: `${baseName}.prj`, data: prj },
  ]);

  downloadTextFile(`${baseName}.zip`, zip, 'application/zip');
  const exportedCodes = new Set(zones.map(z => z.gerk_code));
  const skipped = codes.filter(c => !exportedCodes.has(c));
  showFormSuccess(`✓ Izvoženih ${features.length} ${features.length === 1 ? 'cona' : 'con'} vzorčenja.` + (skipped.length ? ` Brez con: ${skipped.join(', ')}.` : ''));
}

async function updateSampleNo(inputEl) {
  const sampleId = inputEl.dataset.sampleId;
  const value = inputEl.value.trim();
  if (!value) { showFormError('Št. segmenta ne sme biti prazna.'); return; }
  const gerk = (currentDetailWorkOrder.delovni_nalogi_gerki || [])
    .find(g => (g.delovni_nalogi_vzorci || []).some(s => s.id === sampleId));
  const sample = gerk?.delovni_nalogi_vzorci.find(s => s.id === sampleId);
  if (sample && sample.sample_no === value) return;
  const oldValue = sample?.sample_no;

  inputEl.disabled = true;
  try {
    const { error } = await supabase.from('delovni_nalogi_vzorci').update({ sample_no: value }).eq('id', sampleId);
    if (error) throw error;
    if (sample) sample.sample_no = value;

    // The map's segment label comes from a separate table (gerk_segment.label,
    // set once at KML import time, matched here only by string equality — no
    // FK between the two) — without this it would silently drift from the
    // renamed sample_no and keep showing the old number.
    const seg = gerk && currentGerkSegments.find(s => s.gerk_code === gerk.gerk_code && s.segment_label === oldValue);
    if (seg) {
      // gerk_segment has no client-writable RLS policy — goes through a
      // SECURITY DEFINER RPC, same as the other writes to this table.
      const { error: segError } = await supabase.rpc('rename_gerk_segment', { p_segment_id: seg.segment_id, p_label: value });
      if (!segError) {
        seg.segment_label = value;
        woMapSegmentLabelLayers.get(seg.segment_id)?.setContent(value);
        (woMapSegmentPointLayers.get(seg.segment_id) || []).forEach(({ layer, pointNo }) => {
          layer.setTooltipContent(`${value} · ${pointNo ?? ''}`.trim());
        });
      } else {
        console.warn('gerk_segment label sync failed', segError);
      }
    }
  } catch (e) {
    // 23505 = unique_violation on (delovni_nalog_gerk_id, sample_no) — same
    // constraint as addSample, hit here if renamed to a number already in use.
    showFormError(e.code === '23505'
      ? 'Ta št. segmenta je znotraj GERK-a že v uporabi.'
      : (e.message || 'Napaka pri shranjevanju.'));
    if (sample) inputEl.value = sample.sample_no;
  } finally {
    inputEl.disabled = false;
  }
}

// Re-derives the GERK row's toggle-button dot from whatever rows are
// currently marked .wlg-sample-row--flagged in its table — called after
// either updateSampleComment() or updateSampleVzorcenje() patches one
// row's class, so a row flagged via the OTHER field (comment vs.
// Vzorčenje) isn't lost when this one field's value changes.
function refreshGerkFlagDot(wlgRow) {
  if (!wlgRow) return;
  const toggleBtn = wlgRow.querySelector('.wlg-samples-toggle');
  if (!toggleBtn) return;
  const anyFlagged = !!wlgRow.querySelector('.wlg-sample-row--flagged');
  const existingDot = toggleBtn.querySelector('.wlg-sample-flag-dot');
  if (anyFlagged && !existingDot) {
    toggleBtn.querySelector('.wlg-samples-chevron').insertAdjacentHTML('beforebegin', '<span class="wlg-sample-flag-dot" title="Vsaj en segment je označen »ne poberi«" aria-hidden="true"></span>');
  } else if (!anyFlagged && existingDot) {
    existingDot.remove();
  }
}

async function updateSampleComment(inputEl) {
  const sampleId = inputEl.dataset.sampleId;
  const value = inputEl.value.trim();
  const gerk = (currentDetailWorkOrder.delovni_nalogi_gerki || [])
    .find(g => (g.delovni_nalogi_vzorci || []).some(s => s.id === sampleId));
  const sample = gerk?.delovni_nalogi_vzorci.find(s => s.id === sampleId);
  if (sample && (sample.comment || '') === value) return;

  inputEl.disabled = true;
  try {
    const { error } = await supabase.rpc('update_sample_comment', { p_sample_id: sampleId, p_comment: value || null });
    if (error) throw error;
    if (sample) sample.comment = value || null;

    // Red flag updates live — no full re-render on every keystroke-save,
    // so this input/row/toggle-dot are patched directly instead of
    // waiting for the next loadDetailForDate(). Row flag uses the
    // combined check (comment OR Vzorčenje), not just this field, since
    // the row might already be flagged via Vzorčenje regardless of what
    // the comment says.
    const flagged = sample ? isNoCollectSample(sample) : isNoCollectComment(value);
    inputEl.classList.toggle('wlg-comment-input--flagged', isNoCollectComment(value));
    inputEl.closest('tr')?.classList.toggle('wlg-sample-row--flagged', flagged);
    refreshGerkFlagDot(inputEl.closest('.wlg-row'));
  } catch (e) {
    showFormError(e.message || 'Napaka pri shranjevanju.');
    if (sample) inputEl.value = sample.comment || '';
  } finally {
    inputEl.disabled = false;
  }
}

async function updateSampleVzorcenje(selectEl) {
  const sampleId = selectEl.dataset.sampleId;
  const value = selectEl.value || null;
  const gerk = (currentDetailWorkOrder.delovni_nalogi_gerki || [])
    .find(g => (g.delovni_nalogi_vzorci || []).some(s => s.id === sampleId));
  const sample = gerk?.delovni_nalogi_vzorci.find(s => s.id === sampleId);

  selectEl.disabled = true;
  try {
    const { error } = await supabase.from('delovni_nalogi_vzorci').update({ sampling_note: value }).eq('id', sampleId);
    if (error) throw error;
    if (sample) sample.sampling_note = value;

    // Same live red-flag patch as updateSampleComment() — "ne pobereš"
    // picked here flags the row just as much as writing it in Opomba.
    const flagged = sample ? isNoCollectSample(sample) : value === 'ne pobereš';
    selectEl.closest('tr')?.classList.toggle('wlg-sample-row--flagged', flagged);
    refreshGerkFlagDot(selectEl.closest('.wlg-row'));
  } catch (e) {
    showFormError(e.message || 'Napaka pri shranjevanju.');
    if (sample) selectEl.value = sample.sampling_note || '';
  } finally {
    selectEl.disabled = false;
  }
}

async function updateSampleGlobina(selectEl) {
  const sampleId = selectEl.dataset.sampleId;
  const value = selectEl.value ? parseInt(selectEl.value, 10) : null;
  const gerk = (currentDetailWorkOrder.delovni_nalogi_gerki || [])
    .find(g => (g.delovni_nalogi_vzorci || []).some(s => s.id === sampleId));
  const sample = gerk?.delovni_nalogi_vzorci.find(s => s.id === sampleId);

  selectEl.disabled = true;
  try {
    const { error } = await supabase.from('delovni_nalogi_vzorci').update({ sampling_depth_cm: value }).eq('id', sampleId);
    if (error) throw error;
    if (sample) sample.sampling_depth_cm = value;
  } catch (e) {
    showFormError(e.message || 'Napaka pri shranjevanju.');
    if (sample) selectEl.value = sample.sampling_depth_cm ?? '';
  } finally {
    selectEl.disabled = false;
  }
}

async function removeSample(btn) {
  const sampleId = btn.dataset.sampleId;
  if (!confirm('Izbrišem ta segment?')) return;

  btn.disabled = true;
  try {
    const { error } = await supabase.from('delovni_nalogi_vzorci').delete().eq('id', sampleId);
    if (error) throw error;

    for (const g of currentDetailWorkOrder.delovni_nalogi_gerki || []) {
      const idx = (g.delovni_nalogi_vzorci || []).findIndex(s => s.id === sampleId);
      if (idx !== -1) { g.delovni_nalogi_vzorci.splice(idx, 1); break; }
    }
    await loadDetailForDate();
  } catch (e) {
    showFormError(e.message || 'Napaka pri brisanju segmenta.');
    btn.disabled = false;
  }
}

// Deliberately watchPosition, not getCurrentPosition: Android Chrome has
// a long-standing bug where getCurrentPosition({enableHighAccuracy:true})
// stalls and hits its own timeout even though a fix becomes available
// shortly after — watchPosition reuses the OS's continuous location
// session instead of requesting a fresh one-shot fix, and resolves much
// more reliably in practice. We still enforce `timeout` ourselves since
// the option is unreliable in the same buggy scenario this works around.
function getCurrentPositionAsync(options) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Geolokacija ni podprta v tem brskalniku.')); return; }
    let settled = false;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (settled) return;
        settled = true;
        navigator.geolocation.clearWatch(watchId);
        resolve(pos);
      },
      (err) => {
        if (settled) return;
        settled = true;
        navigator.geolocation.clearWatch(watchId);
        reject(err);
      },
      options
    );
    setTimeout(() => {
      if (settled) return;
      settled = true;
      navigator.geolocation.clearWatch(watchId);
      reject({ code: 3, message: 'Timeout expired' });
    }, options?.timeout ?? 20000);
  });
}

// Standard GeolocationPositionError codes (1=denied, 2=unavailable, 3=timeout).
function geolocationErrorMessage(e) {
  switch (e?.code) {
    case 1: return 'Dostop do lokacije je bil zavrnjen. Omogočite dovoljenje za lokacijo v brskalniku.';
    case 2: return 'Lokacije trenutno ni mogoče določiti.';
    case 3: return 'Pridobivanje lokacije je preteklo (timeout). Poskusite znova.';
    default: return e?.message || 'Napaka pri zajemu lokacije.';
  }
}

// ── Operator location tracking ──────────────────────────────────
// Runs for every logged-in role, for as long as the app is open in the
// foreground (a PWA can't get GPS fixes while backgrounded/locked, so
// this is best-effort, not a guarantee of continuous coverage). A single
// watchPosition keeps a live fix cached — cheaper and more reliable than
// requesting a fresh one every tick (see getCurrentPositionAsync above) —
// and a 15s interval writes whatever fix is currently cached.
const LOCATION_PING_INTERVAL_MS = 15000;
let locationWatchId = null;
let locationIntervalId = null;
let locationDotIntervalId = null;
let lastKnownPosition = null;
let lastPositionReceivedAt = null; // Date.now() of the last watchPosition fix — drives the status dot, independent of the DB write cadence.

function startLocationTracking() {
  if (!navigator.geolocation || !currentUser) return;
  locationWatchId = navigator.geolocation.watchPosition(
    (pos) => { lastKnownPosition = pos; lastPositionReceivedAt = Date.now(); },
    (err) => {
      console.warn('Sledenje lokaciji ustavljeno:', geolocationErrorMessage(err));
      stopLocationTracking();
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
  );
  locationIntervalId = setInterval(sendLocationPing, LOCATION_PING_INTERVAL_MS);
  locationDotIntervalId = setInterval(updateLocationStatusDot, 3000);
  locationStatusDot.hidden = false;
  updateLocationStatusDot();
}

function stopLocationTracking() {
  if (locationWatchId != null) { navigator.geolocation.clearWatch(locationWatchId); locationWatchId = null; }
  if (locationIntervalId != null) { clearInterval(locationIntervalId); locationIntervalId = null; }
  if (locationDotIntervalId != null) { clearInterval(locationDotIntervalId); locationDotIntervalId = null; }
  locationStatusDot.hidden = true;
}

// Green = a GPS fix arrived in the last 15s (matches the ping cadence, so
// the dot reflects "a point was just written" rather than a stricter/looser
// window with no real meaning here). Red otherwise, including before the
// first fix ever arrives.
function updateLocationStatusDot() {
  const fresh = lastPositionReceivedAt != null && (Date.now() - lastPositionReceivedAt) <= 15000;
  locationStatusDot.classList.toggle('location-status-dot--active', fresh);
  locationStatusDot.title = fresh ? 'GPS sprejem — deluje' : 'GPS sprejem — ne deluje';
}

async function sendLocationPing() {
  if (!lastKnownPosition || !currentUser) return;
  const { latitude, longitude } = lastKnownPosition.coords;
  const { error } = await supabase.from('operator_locations').insert({
    operator_id: currentUser.id,
    operator_name: currentUserName,
    lat: latitude,
    lng: longitude,
  });
  if (error) console.warn('Zapis lokacije ni uspel:', error.message);
}

// ── GERK zone import (KML → gerk_segmentation/gerk_segment) ──────
// Parses this app's supported KML export shape: one <Placemark> with
// a <Polygon> per zone (ExtendedData's segment_id is the zone label),
// plus zero or more <Placemark>s with a <Point> per zone (same
// segment_id ties a point back to its zone, sample_point_id is its
// order). Not a general-purpose KML parser — built for this soil-
// sampling vendor's export format specifically; verified against a
// real sample file before wiring in.
function parseKmlSegments(kmlText) {
  const doc = new DOMParser().parseFromString(kmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Neveljavna KML datoteka.');

  const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
  const segmentsByLabel = new Map();

  function simpleData(pm, name) {
    const el = Array.from(pm.getElementsByTagName('SimpleData')).find(sd => sd.getAttribute('name') === name);
    return el ? el.textContent.trim() : null;
  }
  function parseCoordText(text) {
    return text.trim().split(/\s+/).map(pair => pair.split(',').map(Number).slice(0, 2));
  }
  function findCoordinatesText(polygonEl) {
    const outer  = polygonEl.getElementsByTagName('outerBoundaryIs')[0];
    const ring   = outer?.getElementsByTagName('LinearRing')[0];
    const coords = ring?.getElementsByTagName('coordinates')[0];
    return coords ? coords.textContent : null;
  }

  for (const pm of placemarks) {
    // getElementsByTagName searches all descendants, so this also picks up
    // every <Polygon> nested inside a <MultiGeometry> (a zone split into
    // several disconnected pieces, e.g. by a road) — not just a single
    // top-level one. Using only the first (the old behavior) silently
    // dropped every polygon after it, which could leave a multi-piece
    // zone reduced to a tiny sliver instead of its real shape.
    const polygonEls = Array.from(pm.getElementsByTagName('Polygon'));
    const pointEl    = pm.getElementsByTagName('Point')[0];
    const segmentId  = simpleData(pm, 'segment_id');
    if (!segmentId) continue;

    if (polygonEls.length) {
      const rings = polygonEls.map(findCoordinatesText).filter(Boolean).map(parseCoordText);
      if (!rings.length) continue;
      const existing = segmentsByLabel.get(segmentId) || { label: segmentId, geojson: null, points: [] };
      existing.geojson = rings.length > 1
        ? { type: 'MultiPolygon', coordinates: rings.map(ring => [ring]) }
        : { type: 'Polygon', coordinates: [rings[0]] };
      segmentsByLabel.set(segmentId, existing);
    } else if (pointEl) {
      const coordsEl = pointEl.getElementsByTagName('coordinates')[0];
      if (!coordsEl) continue;
      const [lng, lat] = coordsEl.textContent.trim().split(',').map(Number);
      const pointNo = parseInt(simpleData(pm, 'sample_point_id'), 10) || null;
      const existing = segmentsByLabel.get(segmentId) || { label: segmentId, geojson: null, points: [] };
      existing.points.push({ point_no: pointNo, geojson: { type: 'Point', coordinates: [lng, lat] } });
      segmentsByLabel.set(segmentId, existing);
    }
  }

  const segments = Array.from(segmentsByLabel.values()).filter(s => s.geojson);
  if (!segments.length) throw new Error('V datoteki ni najdenih con (poligonov).');

  // The GERK id isn't a proper labeled field anywhere in this export —
  // it's only ever seen baked into the Schema/Folder name, either as a
  // plain numeric prefix ("1677400Petrinic") or, when the same parcel
  // number covers several distinct sub-fields, a short letter+digit
  // code right after it ("1526437CH1Puklavec", "1526437MO7Puklavec" —
  // one file per sub-field). Not reliable enough to import against (a
  // customer name starting with a digit, or a different naming
  // convention, would silently point at the wrong GERK) — surfaced
  // only as a mismatch warning against the GERK you're actually
  // importing onto, never as the source of truth.
  const schemaName = doc.getElementsByTagName('Schema')[0]?.getAttribute('name')
    || doc.getElementsByTagName('Folder')[0]?.getElementsByTagName('name')[0]?.textContent
    || '';
  // Sub-field code only counts as one if it's immediately followed by
  // what looks like a Title-case customer surname — otherwise a plain
  // name like "Petrinic" (P + lowercase, no digit) would never match
  // the \d{1,2} part and this whole branch naturally falls through.
  const subFieldMatch = schemaName.match(/^(\d+)([A-Z]{1,3}\d{1,2})(?=[A-Z][a-z])/);
  const detectedGerkId = subFieldMatch
    ? `${subFieldMatch[1]}_${subFieldMatch[2]}`
    : (schemaName.match(/^\d+/) || [])[0] || null;

  return { segments, detectedGerkId };
}

// Shared by both KML import forms (detail view + create order) —
// import_gerk_segmentation always replaces any existing segmentation
// for the same (gerk_id, type) rather than adding another one
// alongside it, guaranteed server-side, but that replacement
// shouldn't happen silently. Returns false (caller should abort) if
// the admin declines.
async function confirmReplaceExistingSegmentation(gerkCode, type) {
  const { data } = await supabase.rpc('check_gerk_segmentation_exists', { p_gerk_id: gerkCode, p_type: type });
  const existing = data?.[0];
  if (!existing) return true;
  return confirm(
    `GERK "${gerkCode}" že ima uvožene cone tipa "${type}" (${existing.zone_count} ${existing.zone_count === 1 ? 'cona' : 'con'}, veljavno od ${fmtSampleDate(existing.valid_from)}).\n\n` +
    `Z uvozom bodo te cone zamenjane z novimi. Nadaljujem?`
  );
}

// Top-level (one instance per work order, above the GERK list) rather
// than per-row — importing enriches the matching GERK if it's already
// on this order, or adds it first if not, so it can't be scoped to a
// row that might not exist yet. One entry per selected file — Type/
// Globina/Date are shared across the whole batch (importing several
// KMLs in one go is normally the same kind of segmentation, same day),
// but each file gets its own target GERK since one file = one field.
let pendingKmlImports = [];

function showKmlImportError(msg) {
  woImportZonesError.textContent = msg;
  woImportZonesError.hidden = false;
}

function renderKmlImportFiles() {
  woImportZonesFiles.innerHTML = pendingKmlImports.map((imp, i) => `
    <div class="wlg-import-zones-file-row">
      <span class="wlg-import-zones-filename">${escHtml(imp.file.name)} (${imp.segments.length} ${imp.segments.length === 1 ? 'cona' : 'cone'})</span>
      <input type="text" class="sample-field-input wlg-import-zones-file-gerk" data-index="${i}" placeholder="GERK" list="woImportZonesGerkList" autocomplete="off" value="${escHtml(imp.gerkCode)}">
      ${pendingKmlImports.length > 1 ? `<button type="button" class="btn btn-icon wlg-import-zones-file-remove" data-index="${i}" aria-label="Odstrani datoteko" title="Odstrani datoteko">✕</button>` : ''}
    </div>`).join('');
  woImportZonesFiles.querySelectorAll('.wlg-import-zones-file-gerk').forEach(inp => {
    inp.addEventListener('change', () => { pendingKmlImports[parseInt(inp.dataset.index, 10)].gerkCode = inp.value.trim(); });
  });
  woImportZonesFiles.querySelectorAll('.wlg-import-zones-file-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingKmlImports.splice(parseInt(btn.dataset.index, 10), 1);
      if (!pendingKmlImports.length) { cancelKmlImport(); return; }
      renderKmlImportFiles();
    });
  });
}

async function onKmlFileSelected(input) {
  const files = Array.from(input.files);
  input.value = ''; // allow re-selecting the same file(s) afterward
  if (!files.length) return;
  woImportZonesError.hidden = true;

  const parseErrors = [];
  pendingKmlImports = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const { segments, detectedGerkId } = parseKmlSegments(text);
      // Pre-fill from the file's own Schema/Folder name when found —
      // still just a starting guess, editable, not trusted outright
      // (see parseKmlSegments' comment on why it isn't a real labeled
      // field).
      pendingKmlImports.push({ file, segments, gerkCode: detectedGerkId || '' });
    } catch (e) {
      parseErrors.push(`${file.name}: ${e.message || 'napaka pri branju'}`);
    }
  }
  if (parseErrors.length) showKmlImportError(parseErrors.join(' | '));
  if (!pendingKmlImports.length) { woImportZonesForm.hidden = true; return; }

  // GERK codes are free text now, so typing one that doesn't exactly
  // match this order's existing GERK silently creates zone data that
  // never links to anything and never renders — offering the real
  // codes here (not just a placeholder guess) is the actual fix.
  woImportZonesGerkList.innerHTML = (currentDetailWorkOrder.delovni_nalogi_gerki || [])
    .map(g => `<option value="${escHtml(g.gerk_code)}">`).join('');
  renderKmlImportFiles();
  woImportZonesType.value = 'vzorčenje';
  woImportZonesGlobina.value = '';
  updateImportZonesGlobinaVisibility();
  woImportZonesDate.value = todayISO();
  woImportZonesForm.hidden = false;
}

function cancelKmlImport() {
  pendingKmlImports = [];
  woImportZonesForm.hidden = true;
}

async function confirmKmlImport(btn) {
  if (!pendingKmlImports.length || !currentDetailWorkOrder) return;

  const type      = woImportZonesType.value.trim();
  const validFrom = woImportZonesDate.value;
  woImportZonesError.hidden = true;
  if (!type)      { showKmlImportError('Vpišite tip segmentacije.'); return; }
  if (!validFrom) { showKmlImportError('Izberite datum veljavnosti.'); return; }
  if (pendingKmlImports.some(imp => !imp.gerkCode.trim())) { showKmlImportError('Vpišite GERK za vsako datoteko.'); return; }

  // Globina only applies for Vzorčenje imports, and the one value
  // picked here is applied to every segment every file in this batch
  // creates.
  const globina = type === 'vzorčenje' && woImportZonesGlobina.value ? parseInt(woImportZonesGlobina.value, 10) : null;

  btn.disabled = true;
  let importedFiles = 0, importedZones = 0;
  const errors = [];
  try {
    for (const imp of pendingKmlImports) {
      const gerkCode = imp.gerkCode.trim();
      try {
        if (!(await confirmReplaceExistingSegmentation(gerkCode, type))) continue;

        let gerk = (currentDetailWorkOrder.delovni_nalogi_gerki || []).find(g => g.gerk_code === gerkCode);
        if (!gerk) {
          // No format requirement — a known field's own area is used when
          // there is one, a plain string name (not in the registry at all)
          // works too, same as adding a GERK anywhere else in the app.
          const known = (await supabase.from('fields').select('id, area_ha')
            .eq('customer_id', currentDetailWorkOrder.stranka_id).eq('cadastre_id', gerkCode).maybeSingle()).data;
          const { data, error } = await supabase
            .from('delovni_nalogi_gerki')
            .insert({
              delovni_nalog_id: currentDetailWorkOrder.id,
              gerk_code:        gerkCode,
              kolicina_ha:      known?.area_ha ?? null,
            })
            .select('id, gerk_code, kolicina_ha, lokacija, tip_lab_analize')
            .single();
          if (error) throw error;
          if (known?.id) {
            const { error: fieldIdError } = await supabase.from('delovni_nalogi_gerki').update({ field_id: known.id }).eq('id', data.id);
            if (fieldIdError) console.warn('field_id backfill failed for', gerkCode, fieldIdError);
          }
          gerk = { ...data, delovni_nalogi_vzorci: [] };
          currentDetailWorkOrder.delovni_nalogi_gerki = [...(currentDetailWorkOrder.delovni_nalogi_gerki || []), gerk];
        }

        const { data: segmentationId, error: importError } = await supabase.rpc('import_gerk_segmentation', {
          p_gerk_id:    gerkCode,
          p_type:       type,
          p_valid_from: validFrom,
          p_segments:   imp.segments,
        });
        if (importError) throw importError;

        // Backfill Ha from the imported zones' own area (gerk_segment.area_ha
        // is a generated column computed from the actual polygon geometry —
        // no registry lookup needed) when this GERK has none yet. Covers
        // custom/sub-divided codes with no registry match at all (e.g. a
        // large field split into "1526437_CH1", "1526437_MO7"...), which
        // otherwise show no Ha despite the zone geometry being right there.
        const { data: segRows } = await supabase.from('gerk_segment').select('label, area_ha').eq('segmentation_id', segmentationId);
        const areaByLabel = new Map((segRows || []).map(r => [r.label, Number(r.area_ha) || null]));
        if (!gerk.kolicina_ha) {
          const importedHa = (segRows || []).reduce((s, r) => s + (Number(r.area_ha) || 0), 0);
          if (importedHa > 0) {
            const { error: haError } = await supabase.from('delovni_nalogi_gerki').update({ kolicina_ha: importedHa }).eq('id', gerk.id);
            if (!haError) gerk.kolicina_ha = importedHa;
          }
        }

        // Each imported zone also becomes its own segment (delovni_nalogi_vzorci
        // row) on this GERK — its label (e.g. "10734") as the segment number,
        // and the zone's own polygon area as that segment's area_ha (export
        // granularity is per segment, so this needs to be set per row, not
        // just summed into the GERK's kolicina_ha above) — so it shows up in
        // the same segment list as manually/pasted-in ones, not only as a
        // shape on the map. Skips any label already present (re-importing the
        // same file, or one already added by hand).
        const existingSegmentNos = new Set((gerk.delovni_nalogi_vzorci || []).map(s => s.sample_no));
        const newSegmentRows = imp.segments
          .map(s => s.label)
          .filter(label => !existingSegmentNos.has(label))
          .map(label => ({ delovni_nalog_gerk_id: gerk.id, sample_no: label, sampling_depth_cm: globina, area_ha: areaByLabel.get(label) ?? null }));
        if (newSegmentRows.length) {
          const { data: insertedSegs, error: segError } = await supabase
            .from('delovni_nalogi_vzorci')
            .insert(newSegmentRows)
            .select('id, sample_no, sampling_date, sending_date, sampling_note, sending_note, sampling_depth_cm, area_ha, comment');
          if (segError) {
            console.warn('Napaka pri dodajanju segmentov iz uvoženih con:', segError);
          } else {
            // Without this, the segments existed in the DB but the
            // post-import re-render (loadDetailForDate(), below) read
            // from this same stale in-memory array — not a fresh fetch
            // — so newly imported segments stayed invisible until the
            // order was closed and reopened.
            gerk.delovni_nalogi_vzorci = [...(gerk.delovni_nalogi_vzorci || []), ...(insertedSegs || [])];
          }
        }

        importedFiles++;
        importedZones += imp.segments.length;
      } catch (e) {
        errors.push(`${gerkCode || imp.file.name}: ${e.message || 'napaka'}`);
      }
    }

    if (importedFiles) {
      cancelKmlImport();
      showFormSuccess(
        `✓ ${importedZones} ${importedZones === 1 ? 'cona' : 'cone'} uvoženih iz ${importedFiles} ${importedFiles === 1 ? 'datoteke' : 'datotek'}.` +
        (errors.length ? ` Napake: ${errors.join(' | ')}` : '')
      );
      await loadDetailForDate();
      await loadWorkOrders();
      await showWoDetailMap(currentDetailWorkOrder); // draw the newly imported zones (and any GERK's own shape, if it was just added)
    } else if (errors.length) {
      showKmlImportError(errors.join(' | '));
    }
  } finally {
    btn.disabled = false;
  }
}

function updateImportZonesGlobinaVisibility() {
  const isSampling = woImportZonesType.value === 'vzorčenje';
  woImportZonesGlobina.hidden = !isSampling;
  if (!isSampling) woImportZonesGlobina.value = '';
}

woImportZonesPickBtn.addEventListener('click', () => woKmlInput.click());
woKmlInput.addEventListener('change', () => onKmlFileSelected(woKmlInput));
woImportZonesType.addEventListener('change', updateImportZonesGlobinaVisibility);
woImportZonesCancelBtn.addEventListener('click', cancelKmlImport);
woImportZonesConfirmBtn.addEventListener('click', () => confirmKmlImport(woImportZonesConfirmBtn));

// ── Čas na poti: multiple add-a-line entries, summed server-side ──
function renderRoadTimeList() {
  if (!currentRoadTimeEntries.length) {
    roadTimeListEl.innerHTML = '';
    return;
  }
  roadTimeListEl.innerHTML = currentRoadTimeEntries.map(e => `
    <div class="road-time-row" data-id="${e.id}">
      <span><span class="road-time-type">${escHtml(e.vehicle_type || 'Traktor')}</span> · ${fmtHM(e.minutes)}${e.comment ? ` · <span class="road-time-comment">${escHtml(e.comment)}</span>` : ''}</span>
      <button type="button" class="road-time-remove" data-action="road-remove" aria-label="Odstrani">✕</button>
    </div>`).join('');

  roadTimeListEl.querySelectorAll('[data-action="road-remove"]').forEach(btn => {
    btn.addEventListener('click', () => removeRoadTime(btn.closest('.road-time-row').dataset.id));
  });
}

async function addRoadTime() {
  const minutes = getDurationMins(roadHourSel, roadMinSel);
  if (!minutes) return;

  roadAddBtn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('add_road_time', {
      p_work_order_id: currentDetailWorkOrder.id,
      p_minutes:        minutes,
      p_vehicle_type:   roadTypeSel.value,
      p_work_date:      currentDetailDate,
      p_comment:        roadCommentInput.value.trim() || null,
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    currentDetailLogId     = result.log_id;
    currentRoadTimeEntries = result.entries || [];
    renderRoadTimeList();
    roadHourSel.value = '0'; roadMinSel.value = '00'; roadCommentInput.value = '';
  } catch (e) {
    showFormError('Napaka pri shranjevanju časa na poti.');
  } finally {
    roadAddBtn.disabled = false;
  }
}

async function removeRoadTime(entryId) {
  try {
    const { data, error } = await supabase.rpc('remove_road_time', { p_entry_id: entryId });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    currentRoadTimeEntries = result.entries || [];
    renderRoadTimeList();
  } catch (e) {
    showFormError('Napaka pri brisanju.');
  }
}

roadAddBtn.addEventListener('click', addRoadTime);

async function saveOrderMeta() {
  try {
    const logId = await ensureTodaysLog();
    await supabase.from('work_logs').update({
      tractor:     tractorInput.value.trim() || null,
      description: descInput.value.trim()    || null,
    }).eq('id', logId);
    saveTractorToHistory(tractorInput.value.trim());
  } catch (e) {
    showFormError('Napaka pri shranjevanju.');
  }
}
tractorInput.addEventListener('blur',  saveOrderMeta);
descInput.addEventListener('blur',     saveOrderMeta);

// "Sprosti nalog" (release_work_order RPC) dropped from the UI when the
// header was redesigned — no button currently calls it. Needs a decision
// on where it belongs before it comes back; see backlog.

woStatusEdit.addEventListener('change', async () => {
  const newStatus = woStatusEdit.value;
  woStatusEdit.disabled = true;
  const { error } = await supabase
    .from('delovni_nalogi')
    .update({ status: newStatus })
    .eq('id', currentDetailWorkOrder.id);
  woStatusEdit.disabled = false;
  if (error) {
    woStatusEdit.value = currentDetailWorkOrder.status; // revert the select
    return showFormError('Napaka pri spreminjanju statusa.');
  }
  currentDetailWorkOrder.status = newStatus;
  updateOrderHeader();
  await loadWorkOrders();
});

// "Izbriši" = archive (deleted_at), not a hard delete — nothing is
// destroyed, just hidden from the main list and Evidenca dela (see
// filteredWorkOrders/loadLogs), and reversible via "Obnovi" in the
// "Izbrisani" list. Same single action regardless of logged time;
// there's no separate hard-delete path anymore. Shared with the main
// list's bulk-delete (see bulkDeleteSelectedWorkOrders) so both go
// through the same update.
async function softDeleteWorkOrders(ids) {
  return supabase.from('delovni_nalogi').update({ deleted_at: new Date().toISOString() }).in('id', ids);
}

woDeleteBtn.addEventListener('click', async () => {
  if (!confirm('Izbrišem ta delovni nalog? Ne bo več viden v glavnem seznamu ali v Evidenci dela, dokler ga ne obnovite (v seznamu "Izbrisani").')) return;
  woDeleteBtn.disabled = true;
  const { error } = await softDeleteWorkOrders([currentDetailWorkOrder.id]);
  woDeleteBtn.disabled = false;
  if (error) return showFormError('Napaka pri brisanju naloga.');
  closeModal();
  await loadWorkOrders();
});

woRestoreBtn.addEventListener('click', async () => {
  woRestoreBtn.disabled = true;
  const { error } = await supabase.from('delovni_nalogi').update({ deleted_at: null }).eq('id', currentDetailWorkOrder.id);
  woRestoreBtn.disabled = false;
  if (error) return showFormError('Napaka pri obnavljanju naloga.');
  currentDetailWorkOrder.deleted_at = null;
  const listRow = workOrders.find(w => w.id === currentDetailWorkOrder.id);
  if (listRow) listRow.deleted_at = null;
  updateOrderHeader();
  showFormSuccess('✓ Nalog obnovljen.');
  await loadWorkOrders();
});

// Manual "add GERK(s)" on an already-saved order — same paste component
// and parsing (parseGerkPasteText) as the create-order form, just
// applied as direct DB inserts instead of in-memory rows: a plain code
// list adds bare GERK lines, the lab's GERK/Ha/FMS/Sample no sheet also
// creates each line's delovni_nalogi_vzorci rows in the same action, so
// a manually-added GERK's segments get a real sample number exactly
// like a KML-imported one does — not a separate step with nothing to
// show afterward.
woAddExistingGerkBtn.addEventListener('click', async () => {
  const entries = parseGerkPasteText(woAddExistingGerkPaste.value);
  if (!entries.length) return;

  woAddExistingGerkBtn.disabled = true;
  try {
    const codes = entries.map(e => e.code);
    const { data: knownFields } = await supabase
      .from('fields')
      .select('id, cadastre_id, area_ha')
      .eq('customer_id', currentDetailWorkOrder.stranka_id)
      .in('cadastre_id', codes);
    const knownByCode = new Map((knownFields || []).map(f => [f.cadastre_id, f]));

    // field_id left out of the insert, backfilled best-effort after —
    // same reasoning as the create-order flow (see its comment): this
    // column's schema-cache entry has been unreliable, and nothing
    // currently reads it.
    const { data: insertedRows, error } = await supabase
      .from('delovni_nalogi_gerki')
      .insert(entries.map(({ code, hectares }) => ({
        delovni_nalog_id: currentDetailWorkOrder.id,
        gerk_code:        code,
        kolicina_ha:      knownByCode.get(code)?.area_ha ?? (hectares ? parseFloat(hectares) : null),
      })))
      .select('id, gerk_code, kolicina_ha, lokacija, tip_lab_analize');
    if (error) throw error;

    await Promise.all(insertedRows.map(row => {
      const known = knownByCode.get(row.gerk_code);
      return known?.id
        ? supabase.from('delovni_nalogi_gerki').update({ field_id: known.id }).eq('id', row.id)
        : Promise.resolve();
    }));

    // Segment-sheet paste also carries sample rows per code — insert
    // them against the GERK line id each code just got back.
    const segmentRows = [];
    for (const row of insertedRows) {
      const entry = entries.find(e => e.code === row.gerk_code);
      for (const s of (entry?.segments || [])) {
        segmentRows.push({ delovni_nalog_gerk_id: row.id, sample_no: s.sampleNo, sampling_note: s.vzorcenje || null });
      }
    }
    let insertedSamples = [];
    if (segmentRows.length) {
      const { data, error: segError } = await supabase
        .from('delovni_nalogi_vzorci')
        .insert(segmentRows)
        .select('id, delovni_nalog_gerk_id, sample_no, sampling_date, sending_date, sampling_note, sending_note, sampling_depth_cm, area_ha, comment');
      if (segError) throw segError;
      insertedSamples = data || [];
    }

    currentDetailWorkOrder.delovni_nalogi_gerki = [
      ...(currentDetailWorkOrder.delovni_nalogi_gerki || []),
      ...insertedRows.map(row => ({ ...row, delovni_nalogi_vzorci: insertedSamples.filter(s => s.delovni_nalog_gerk_id === row.id) })),
    ];
    woAddExistingGerkPaste.value = '';
    await loadDetailForDate();
    await loadWorkOrders();
    await showWoDetailMap(currentDetailWorkOrder);
  } catch (e) {
    // 23505 = unique_violation on (delovni_nalog_gerk_id, sample_no) —
    // same constraint as addSample/updateSampleNo.
    showFormError(e.code === '23505'
      ? 'Ta št. segmenta je znotraj GERK-a že v uporabi.'
      : (e.message || 'Napaka pri dodajanju GERK-ov.'));
  } finally {
    woAddExistingGerkBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  stopLocationTracking();
  await supabase.auth.signOut();
  window.location.replace('index.html');
});

// ── FAB menu ───────────────────────────────────────────────────
// Class toggle, not the `hidden` attribute — lets the open/close
// transition actually play (see .fab-menu's own CSS comment).
addBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fabMenu.classList.toggle('fab-menu--visible');
});
fabMenu.addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => { fabMenu.classList.remove('fab-menu--visible'); });

fabMenu.querySelectorAll('.fab-menu-item').forEach(btn => {
  btn.addEventListener('click', () => {
    fabMenu.classList.remove('fab-menu--visible');
    if (btn.dataset.action === 'new-work-order')  openWorkOrderModal();
    if (btn.dataset.action === 'customer-list')   openDeclModal();
    if (btn.dataset.action === 'operators-list')  openOperatorsModal();
    if (btn.dataset.action === 'reports')         openReportsView();
  });
});

modalClose.addEventListener('click', closeModal);
woBackBtn.addEventListener('click', closeModal);
cancelBtn.addEventListener('click', closeModal);

formModal.addEventListener('click', e => { if (e.target === formModal) closeModal(); });
declModal.addEventListener('click', e => { if (e.target === declModal) closeDeclModal(); });
declModalClose.addEventListener('click', closeDeclModal);
reportsBackBtn.addEventListener('click', closeReportsView);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!formModal.hidden)      closeModal();
    if (!workOrderModal.hidden) closeWorkOrderModal();
    if (!declModal.hidden)      closeDeclModal();
    if (!mapModal.hidden)       closeMapModal();
    if (!operatorsModal.hidden) closeOperatorsModal();
    if (!addCustomerModal.hidden) closeAddCustomerModal();
    if (currentTab === 'reports') closeReportsView();
  }
});

// ── Poročila (reports) full-screen view ─────────────────────────
// get_work_orders_report() does the aggregation server-side (tracked
// minutes, gap minutes between GERK-i within the same session, ha,
// capture counts) — see migration_work_orders_report*.sql. Everything
// below (filters, selection, per-hour/per-ha rates) works off that one
// fetch; filtering/selecting never re-queries.
async function loadReportsData() {
  reportsError.hidden = true;
  reportsListWrap.innerHTML = '<div class="state-loading"><div class="spinner"></div><p>Nalaganje...</p></div>';
  selectedReportIds = new Set();
  resetReportsStatusFilterDefault();
  const { data, error } = await supabase.rpc('get_work_orders_report');
  if (error) {
    reportsError.textContent = 'Napaka pri nalaganju poročila: ' + error.message;
    reportsError.hidden = false;
    reportsListWrap.innerHTML = '';
    return;
  }
  reportsData = data || [];
  populateReportsOperatorFilter();
  populateReportsCustomerFilter();
  renderReportsTable();
}

// Poročila opens defaulting to "Izvedeno" (the view the reports are
// normally wanted for — in-progress/planned orders skew the numbers)
// instead of showing everything — same checklist the status filter
// button already uses, just pre-checked.
function resetReportsStatusFilterDefault() {
  reportsStatusValues = new Set(['Izvedeno']);
  reportsStatusFilterMenu.querySelectorAll('.reports-status-filter-cb').forEach(cb => {
    cb.checked = reportsStatusValues.has(cb.value);
  });
  updateReportsStatusFilterButtonLabel();
}

// Only operators who actually appear in the data — not the full eligible
// roster (loadOperatorsList()'s own list), since a filter full of options
// that would always return zero rows isn't useful here.
function populateReportsOperatorFilter() {
  const names = new Map();
  reportsData.forEach(r => { if (r.izvajalec_id) names.set(r.izvajalec_id, r.izvajalec_name); });
  const sorted = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1], 'sl'));
  const current = reportsOperatorFilter.value;
  reportsOperatorFilter.innerHTML = '<option value="">Vsi izvajalci</option>' +
    sorted.map(([id, name]) => `<option value="${escHtml(id)}">${escHtml(name)}</option>`).join('');
  reportsOperatorFilter.value = sorted.some(([id]) => id === current) ? current : '';
}

// Multi-select checklist (same component as the status filter) — only
// customers who actually appear in the data. Selections that no longer
// exist after a reload are dropped rather than left dangling.
function populateReportsCustomerFilter() {
  const names = new Set();
  reportsData.forEach(r => { if (r.customer_name) names.add(r.customer_name); });
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'sl'));
  [...reportsCustomerValues].forEach(v => { if (!sorted.includes(v)) reportsCustomerValues.delete(v); });

  reportsCustomerFilterList.innerHTML = sorted.map(name => `
    <label class="wo-gerk-check-item">
      <input type="checkbox" class="reports-customer-filter-cb" value="${escHtml(name)}" ${reportsCustomerValues.has(name) ? 'checked' : ''}>
      <span class="wo-gerk-check-code">${escHtml(name)}</span>
    </label>`).join('');
  reportsCustomerFilterList.querySelectorAll('.reports-customer-filter-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) reportsCustomerValues.add(cb.value);
      else reportsCustomerValues.delete(cb.value);
      syncReportsCustomerSelectAllCb(sorted);
      updateReportsCustomerFilterButtonLabel();
      renderReportsTable();
    });
  });
  syncReportsCustomerSelectAllCb(sorted);
  updateReportsCustomerFilterButtonLabel();
}

function syncReportsCustomerSelectAllCb(allNames) {
  const selected = allNames.filter(n => reportsCustomerValues.has(n)).length;
  reportsCustomerSelectAllCb.checked = allNames.length > 0 && selected === allNames.length;
  reportsCustomerSelectAllCb.indeterminate = selected > 0 && selected < allNames.length;
}

function updateReportsCustomerFilterButtonLabel() {
  const n = reportsCustomerValues.size;
  reportsCustomerFilterBtn.textContent = n === 0 ? 'Vse stranke' : n === 1 ? [...reportsCustomerValues][0] : `${n} strank`;
  reportsCustomerFilterBtn.title = n > 1 ? [...reportsCustomerValues].join(', ') : '';
}

// Derived ratios shared by each order row and the totals row — totals
// recompute these from the summed fields rather than averaging each row's
// own ratio (averaging rates would be wrong), same principle already used
// in updateReportsSummary(). Every ha-based rate uses executed_ha (GERKs
// actually completed — start AND end time logged), not total_ha (every
// GERK assigned, including ones a "V delu" order hasn't touched yet) —
// otherwise a part-done order's rates would be diluted by ha nobody has
// worked. total_ha itself stays visible as its own column for context.
function reportsRowMetrics(r) {
  const hours = r.tracked_minutes / 60;
  const roadMinutes = (r.road_traktor_minutes || 0) + (r.road_avto_minutes || 0);
  const hoursWithRoad = (r.tracked_minutes + roadMinutes) / 60;
  const workRoadTotal = r.tracked_minutes + roadMinutes;
  const executedHa = r.executed_ha || 0;
  return {
    perHour: hours > 0 ? (r.captures_count / hours).toFixed(2) : '—',
    perHa: executedHa > 0 ? (r.captures_count / executedHa).toFixed(2) : '—',
    haPerCapture: r.captures_count > 0 ? (executedHa / r.captures_count).toFixed(3) : '—',
    timePerHa: executedHa > 0 ? fmtHM(Math.round(r.tracked_minutes / executedHa)) : '—',
    haPerHour: hours > 0 ? (executedHa / hours).toFixed(2) : '—',
    haPerHourWithRoad: hoursWithRoad > 0 ? (executedHa / hoursWithRoad).toFixed(2) : '—',
    workRoadPct: workRoadTotal > 0 ? `${Math.round(r.tracked_minutes / workRoadTotal * 100)}%` : '—',
    strosek: r.strosek != null ? `${Number(r.strosek).toFixed(2)} €` : '—',
  };
}

// Sums every raw field the per-row columns are built from, across whatever
// rows are currently "in scope" (selected, or filtered if none selected) —
// reportsRowMetrics() then turns this into the same ratio columns.
function reportsAggregateRow(rowsForTotal) {
  const agg = { total_ha: 0, executed_ha: 0, tracked_minutes: 0, gap_minutes: 0, total_minutes: 0, captures_count: 0, road_traktor_minutes: 0, road_avto_minutes: 0, strosek: 0 };
  for (const r of rowsForTotal) {
    agg.total_ha += Number(r.total_ha) || 0;
    agg.executed_ha += Number(r.executed_ha) || 0;
    agg.tracked_minutes += r.tracked_minutes || 0;
    agg.gap_minutes += r.gap_minutes || 0;
    agg.total_minutes += r.total_minutes || 0;
    agg.captures_count += r.captures_count || 0;
    agg.road_traktor_minutes += r.road_traktor_minutes || 0;
    agg.road_avto_minutes += r.road_avto_minutes || 0;
    agg.strosek += Number(r.strosek) || 0;
  }
  return agg;
}

function filteredReportsRows() {
  const fromVal = reportsDateFrom.value; // 'YYYY-MM-DD' or ''
  const toVal   = reportsDateTo.value;
  return reportsData.filter(r => {
    if (reportsStatusValues.size && !reportsStatusValues.has(r.status)) return false;
    if (reportsOperatorFilter.value && r.izvajalec_id !== reportsOperatorFilter.value) return false;
    if (reportsCustomerValues.size && !reportsCustomerValues.has(r.customer_name)) return false;
    if (fromVal || toVal) {
      const d = r.ustvarjen ? r.ustvarjen.slice(0, 10) : null;
      if (!d) return false;
      if (fromVal && d < fromVal) return false;
      if (toVal && d > toVal) return false;
    }
    return true;
  });
}

function updateReportsStatusFilterButtonLabel() {
  const n = reportsStatusValues.size;
  reportsStatusFilterBtn.textContent = n === 0 ? 'Vsi statusi' : n === 1 ? [...reportsStatusValues][0] : `${n} statusi`;
}

// Selected rows when one or more are checked, otherwise every currently
// filtered row — the summary chips and the chart both narrow to the
// checked rows this way, same pattern as the main list's ha chips
// (updateWoHaSummary()).
function reportsEffectiveRows(filteredRows) {
  return selectedReportIds.size
    ? reportsData.filter(r => selectedReportIds.has(r.work_order_id))
    : filteredRows;
}

// Rates are recomputed from the summed totals, not averaged per-row
// (averaging rates would be wrong here).
function updateReportsSummary(filteredRows) {
  const source = reportsEffectiveRows(filteredRows);
  let ha = 0, tracked = 0, gap = 0, captures = 0, cost = 0;
  for (const r of source) {
    ha += Number(r.total_ha) || 0;
    tracked += r.tracked_minutes || 0;
    gap += r.gap_minutes || 0;
    captures += r.captures_count || 0;
    cost += Number(r.strosek) || 0;
  }
  const label = selectedReportIds.size ? 'Izbrano' : 'Skupaj';
  reportsChipHa.textContent = `${label}: ${ha.toFixed(2)} ha`;
  reportsChipTracked.textContent = `Zabeležen: ${fmtHM(tracked)}`;
  reportsChipGap.textContent = `Med GERK-i: ${fmtHM(gap)}`;
  reportsChipTotal.textContent = `Skupaj čas: ${fmtHM(tracked + gap)}`;
  reportsChipCost.textContent = `Strošek: ${cost.toFixed(2)} €`;
}

function syncReportsSelectAllCheckbox(visibleIds) {
  const headCb = reportsListWrap.querySelector('#reportsSelectAllCb');
  if (!headCb) return;
  const anySelected = visibleIds.some(id => selectedReportIds.has(id));
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedReportIds.has(id));
  headCb.checked = allSelected;
  headCb.indeterminate = anySelected && !allSelected;
}

// Stacked bar chart above the table — total time per date (r.ustvarjen's
// date part), split Zabeležen (tracked) / Pot med GERK-i (gap), so the
// picture always matches whatever filteredReportsRows() currently
// returns. Vanilla SVG, no charting library. Colors are the dataviz
// skill's validated categorical slots 1 (blue) & 2 (orange) — the app's
// own chip green/amber sits in the CVD floor band at this surface
// (validate_palette.js), so the chart uses the cleanly-passing pair
// instead rather than carrying extra mitigations for chip-color parity.
const REPORTS_CHART_COLOR_TRACKED = '#2a78d6';
const REPORTS_CHART_COLOR_GAP     = '#eb6834';
// Third validated categorical slot (aqua) for the Ha measure — see
// palette.md; it sits under the 3:1 contrast floor on the light surface,
// so its relief is the Ha column already in the table below (never color
// alone), same reasoning as the two time colors above.
const REPORTS_CHART_COLOR_HA      = '#1baf7a';

function reportsChartNiceMax(value) {
  if (value <= 0) return 60;
  const step = value > 600 ? 120 : value > 120 ? 60 : 30;
  return Math.ceil(value / step) * step;
}

function reportsChartNiceMaxHa(value) {
  if (value <= 0) return 5;
  const step = value > 100 ? 20 : value > 40 ? 10 : value > 10 ? 5 : 2;
  return Math.ceil(value / step) * step;
}

function fmtHa(v) {
  return `${Math.round(v * 100) / 100} ha`;
}

function renderReportsChart(rows) {
  const weekly = reportsChartGrouping === 'week';
  const monthly = reportsChartGrouping === 'month';
  const metric = reportsChartMetric; // 'time' | 'ha'
  const bucketKey = d => weekly ? isoWeekStartStr(d) : monthly ? monthStartStr(d) : d;

  const byDate = new Map();
  rows.forEach(r => {
    const d = r.ustvarjen ? r.ustvarjen.slice(0, 10) : null;
    if (!d) return;
    const key = bucketKey(d);
    const bucket = byDate.get(key) || { tracked: 0, gap: 0, ha: 0 };
    bucket.tracked += r.tracked_minutes || 0;
    bucket.gap += r.gap_minutes || 0;
    bucket.ha += r.executed_ha || 0; // executed, not assigned — see reportsRowMetrics()' comment
    byDate.set(key, bucket);
  });
  const dates = [...byDate.keys()].sort();

  const modeToolbar = `
    <div class="reports-chart-toolbar">
      <div class="reports-chart-legend">
        ${metric === 'time' ? `
        <span class="reports-chart-legend-item"><span class="reports-chart-legend-swatch" style="background:${REPORTS_CHART_COLOR_TRACKED}"></span>Zabeležen čas</span>
        <span class="reports-chart-legend-item"><span class="reports-chart-legend-swatch" style="background:${REPORTS_CHART_COLOR_GAP}"></span>Pot med GERK-i</span>` : ''}
      </div>
      <div class="reports-chart-toggle-group">
        <div class="reports-chart-mode-toggle" role="group" aria-label="Prikaz po obdobju">
          <button type="button" class="reports-chart-mode-btn${monthly ? ' is-active' : ''}" data-mode="month">Mesečno</button>
          <button type="button" class="reports-chart-mode-btn${weekly ? ' is-active' : ''}" data-mode="week">Tedensko</button>
          <button type="button" class="reports-chart-mode-btn${!weekly && !monthly ? ' is-active' : ''}" data-mode="day">Dnevno</button>
        </div>
        <div class="reports-chart-mode-toggle" role="group" aria-label="Prikaz količine">
          <button type="button" class="reports-chart-metric-btn${metric === 'time' ? ' is-active' : ''}" data-metric="time">Čas</button>
          <button type="button" class="reports-chart-metric-btn${metric === 'ha' ? ' is-active' : ''}" data-metric="ha">Ha</button>
        </div>
      </div>
    </div>`;

  if (!dates.length) {
    reportsChartWrap.innerHTML = modeToolbar + '<div class="reports-chart-empty">Ni podatkov za graf.</div>';
    wireReportsChartToolbar();
    return;
  }

  // Weekly/monthly bars need a wider band than daily ones — their labels
  // ("11.9.–17.9.", "sep. 2026") run longer than a day label ("11.9."),
  // so every bar can carry its own label without the thinning fallback
  // below kicking in.
  const barW = 24, segGapPx = 2, bandPad = weekly ? 46 : monthly ? 38 : 14;
  const bandW = barW + bandPad;
  const plotH = 180, axisH = 34, topPad = 8;
  const leftPad = 44;
  const svgW = leftPad + dates.length * bandW + 8;
  const svgH = topPad + plotH + axisH;
  const baseline = topPad + plotH;

  // Thin out x-axis text so labels never overlap regardless of how many
  // bars there are — a day label ("11.9.") needs ~34px, a month one
  // ("sep. 2026") ~60px, a week-range one ("11.9.–17.9.") ~70px; skip
  // every Nth one once bars are narrower than that.
  const labelNeed = weekly ? 70 : monthly ? 60 : 34;
  const labelStep = Math.max(1, Math.ceil(labelNeed / bandW));

  const niceMax = metric === 'time'
    ? reportsChartNiceMax(Math.max(...dates.map(d => byDate.get(d).tracked + byDate.get(d).gap)))
    : reportsChartNiceMaxHa(Math.max(...dates.map(d => byDate.get(d).ha)));
  const yScale = v => (v / niceMax) * plotH;

  const gridSteps = 4;
  let gridlines = '';
  for (let i = 0; i <= gridSteps; i++) {
    const v = (niceMax / gridSteps) * i;
    const y = baseline - yScale(v);
    const label = metric === 'time' ? fmtHM(Math.round(v)) : fmtHa(v);
    gridlines += `<line class="reports-chart-gridline" x1="${leftPad}" y1="${y}" x2="${svgW - 8}" y2="${y}"></line>`;
    gridlines += `<text class="reports-chart-axis-label" x="${leftPad - 8}" y="${y + 3}" text-anchor="end">${escHtml(label)}</text>`;
  }

  let bars = '';
  dates.forEach((d, i) => {
    const b = byDate.get(d);
    const x = leftPad + i * bandW + bandPad / 2;
    let totalH, topY, r, clipShape, segs;
    const clipId = `reportsChartClip${i}`;

    if (metric === 'time') {
      const trackedH = yScale(b.tracked);
      const gapH = yScale(b.gap);
      const segGap = (trackedH > 0 && gapH > 0) ? segGapPx : 0;
      totalH = Math.max(trackedH + segGap + gapH, (b.tracked + b.gap) > 0 ? 1 : 0);
      topY = baseline - totalH;
      r = Math.min(4, totalH / 2);
      clipShape = totalH <= 8
        ? `<rect x="${x}" y="${topY}" width="${barW}" height="${totalH}" rx="${r}"></rect>`
        : `<path d="M${x},${topY + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${totalH - r} h-${barW} z"></path>`;
      segs = '';
      if (trackedH > 0) segs += `<rect x="${x}" y="${baseline - trackedH}" width="${barW}" height="${trackedH}" fill="${REPORTS_CHART_COLOR_TRACKED}"></rect>`;
      if (gapH > 0) segs += `<rect x="${x}" y="${baseline - trackedH - segGap - gapH}" width="${barW}" height="${gapH}" fill="${REPORTS_CHART_COLOR_GAP}"></rect>`;
    } else {
      const haH = yScale(b.ha);
      totalH = Math.max(haH, b.ha > 0 ? 1 : 0);
      topY = baseline - totalH;
      r = Math.min(4, totalH / 2);
      clipShape = totalH <= 8
        ? `<rect x="${x}" y="${topY}" width="${barW}" height="${totalH}" rx="${r}"></rect>`
        : `<path d="M${x},${topY + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${totalH - r} h-${barW} z"></path>`;
      segs = totalH > 0 ? `<rect x="${x}" y="${topY}" width="${barW}" height="${totalH}" fill="${REPORTS_CHART_COLOR_HA}"></rect>` : '';
    }

    let label, tooltipLabel;
    if (weekly) {
      const weekEnd = new Date(d + 'T00:00:00');
      weekEnd.setDate(weekEnd.getDate() + 6);
      const weekEndStr = weekEnd.toISOString().slice(0, 10);
      label = `${fmtDayMonth(d)}–${fmtDayMonth(weekEndStr)}`;
      tooltipLabel = `Teden ${fmtSampleDate(d)}–${fmtSampleDate(weekEndStr)}`;
    } else if (monthly) {
      label = fmtMonthShort(d);
      tooltipLabel = fmtMonthFull(d);
    } else {
      label = fmtDayMonth(d);
      tooltipLabel = fmtSampleDate(d);
    }
    const tooltipText = metric === 'time'
      ? `${tooltipLabel} — Zabeležen: ${fmtHM(b.tracked)}, Pot med GERK-i: ${fmtHM(b.gap)}, skupaj: ${fmtHM(b.tracked + b.gap)}`
      : `${tooltipLabel} — Ha: ${fmtHa(b.ha)}`;
    const showLabel = i % labelStep === 0;

    bars += `<g>
      <clipPath id="${clipId}">${clipShape}</clipPath>
      <g clip-path="url(#${clipId})">${segs}</g>
      <rect class="reports-chart-bar-hit" data-tooltip="${escHtml(tooltipText)}"
            x="${x - bandPad / 2}" y="${topPad}" width="${bandW}" height="${plotH}"
            fill="transparent" tabindex="0" aria-label="${escHtml(tooltipText)}"><title>${escHtml(tooltipText)}</title></rect>
      ${showLabel ? `<text class="reports-chart-axis-label" x="${x + barW / 2}" y="${baseline + 16}" text-anchor="middle">${escHtml(label)}</text>` : ''}
    </g>`;
  });

  reportsChartWrap.innerHTML = modeToolbar +
    `<svg class="reports-chart-svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">${gridlines}${bars}</svg>`;
  wireReportsChartToolbar();

  const tooltip = document.createElement('div');
  tooltip.className = 'reports-chart-tooltip';
  tooltip.hidden = true;
  reportsChartWrap.appendChild(tooltip);

  const showTooltip = (el, clientX, clientY) => {
    tooltip.textContent = el.dataset.tooltip;
    tooltip.hidden = false;
    tooltip.style.left = (clientX + 12) + 'px';
    tooltip.style.top = (clientY + 12) + 'px';
  };
  const hideTooltip = () => { tooltip.hidden = true; };

  reportsChartWrap.querySelectorAll('.reports-chart-bar-hit').forEach(el => {
    el.addEventListener('pointerenter', e => showTooltip(el, e.clientX, e.clientY));
    el.addEventListener('pointermove', e => showTooltip(el, e.clientX, e.clientY));
    el.addEventListener('pointerleave', hideTooltip);
    el.addEventListener('focus', () => {
      const r = el.getBoundingClientRect();
      showTooltip(el, r.left, r.top);
    });
    el.addEventListener('blur', hideTooltip);
  });
}

function wireReportsChartToolbar() {
  reportsChartWrap.querySelectorAll('.reports-chart-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (reportsChartGrouping === btn.dataset.mode) return;
      reportsChartGrouping = btn.dataset.mode;
      renderReportsChart(filteredReportsRows());
    });
  });
  reportsChartWrap.querySelectorAll('.reports-chart-metric-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (reportsChartMetric === btn.dataset.metric) return;
      reportsChartMetric = btn.dataset.metric;
      renderReportsChart(filteredReportsRows());
    });
  });
}

function renderReportsTable() {
  const rows = filteredReportsRows();
  updateReportsSummary(rows);
  renderReportsChart(reportsEffectiveRows(rows));

  if (!rows.length) {
    reportsListWrap.innerHTML = '<div class="state-empty"><p>Ni delovnih nalogov za izbrane filtre.</p></div>';
    return;
  }

  reportsListWrap.innerHTML = `
    <div class="reports-table-wrap">
      <table class="evidenca-table reports-data-table">
        <thead>
          <tr>
            <th><input type="checkbox" id="reportsSelectAllCb" aria-label="Izberi vse"></th>
            <th>Stranka</th>
            <th>Nalog</th>
            <th>Status</th>
            <th>Izvajalec</th>
            <th>Ha</th>
            <th title="Ha od dodeljenih GERK-ov, ki imajo zabeležen začetni IN končni čas — pri delno opravljenem nalogu manj kot Ha">Izvedeni ha</th>
            <th title="Zabeležen čas">Zabeležen</th>
            <th title="Čas med GERK-i">Med GERK-i</th>
            <th title="Skupni čas">Skupaj</th>
            <th title="Zajete točke">Točke</th>
            <th>Točk / h</th>
            <th title="Zajete točke / izvedeni ha">Točk / ha</th>
            <th title="Izvedeni ha / zajeto točko">Ha / točko</th>
            <th title="Zabeležen čas / izvedeni ha">Čas / ha</th>
            <th title="Izvedeni ha na uro zabeleženega časa, brez poti">Ha/h</th>
            <th title="Izvedeni ha na uro zabeleženega časa + poti (traktor + avto)">Ha/h s potjo</th>
            <th title="Prevoz s traktorjem (čas na poti)">Prevoz traktor</th>
            <th title="Prevoz z avtom (čas na poti)">Prevoz avto</th>
            <th title="Delež zabeleženega časa v skupnem času (delo + pot)">Delo / pot</th>
            <th title="Celotni strošek naloga">Strošek</th>
          </tr>
        </thead>
        <tbody>
          ${(() => {
            const effectiveRows = reportsEffectiveRows(rows);
            const totals = reportsAggregateRow(effectiveRows);
            const tm = reportsRowMetrics(totals);
            const totalsLabel = selectedReportIds.size ? `Izbrano (${effectiveRows.length})` : `Skupaj (${effectiveRows.length})`;
            return `<tr class="reports-totals-row">
              <td></td>
              <td colspan="4">${escHtml(totalsLabel)}</td>
              <td>${totals.total_ha.toFixed(2)}</td>
              <td>${totals.executed_ha.toFixed(2)}</td>
              <td>${fmtHM(totals.tracked_minutes)}</td>
              <td>${fmtHM(totals.gap_minutes)}</td>
              <td>${fmtHM(totals.total_minutes)}</td>
              <td>${totals.captures_count}</td>
              <td>${tm.perHour}</td>
              <td>${tm.perHa}</td>
              <td>${tm.haPerCapture}</td>
              <td>${tm.timePerHa}</td>
              <td>${tm.haPerHour}</td>
              <td>${tm.haPerHourWithRoad}</td>
              <td>${fmtHM(totals.road_traktor_minutes)}</td>
              <td>${fmtHM(totals.road_avto_minutes)}</td>
              <td>${tm.workRoadPct}</td>
              <td>${tm.strosek}</td>
            </tr>`;
          })()}
          ${rows.map(r => {
            const m = reportsRowMetrics(r);
            const checked = selectedReportIds.has(r.work_order_id) ? 'checked' : '';
            return `<tr>
              <td><input type="checkbox" class="reports-row-cb" data-id="${r.work_order_id}" ${checked}></td>
              <td>${escHtml(r.customer_name)}</td>
              <td>${escHtml(r.stevilka || '—')}</td>
              <td><span class="wo-status-badge wo-status--${slugStatus(r.status)}">${escHtml(r.status)}</span></td>
              <td>${escHtml(r.izvajalec_name)}</td>
              <td>${Number(r.total_ha).toFixed(2)}</td>
              <td>${Number(r.executed_ha || 0).toFixed(2)}</td>
              <td>${fmtHM(r.tracked_minutes)}</td>
              <td>${fmtHM(r.gap_minutes)}</td>
              <td>${fmtHM(r.total_minutes)}</td>
              <td>${r.captures_count}</td>
              <td>${m.perHour}</td>
              <td>${m.perHa}</td>
              <td>${m.haPerCapture}</td>
              <td>${m.timePerHa}</td>
              <td>${m.haPerHour}</td>
              <td>${m.haPerHourWithRoad}</td>
              <td>${fmtHM(r.road_traktor_minutes || 0)}</td>
              <td>${fmtHM(r.road_avto_minutes || 0)}</td>
              <td>${m.workRoadPct}</td>
              <td>${m.strosek}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  const visibleIds = rows.map(r => r.work_order_id);
  syncReportsSelectAllCheckbox(visibleIds);

  reportsListWrap.querySelector('#reportsSelectAllCb').addEventListener('click', () => {
    const anySelected = visibleIds.some(id => selectedReportIds.has(id));
    if (anySelected) visibleIds.forEach(id => selectedReportIds.delete(id));
    else visibleIds.forEach(id => selectedReportIds.add(id));
    renderReportsTable();
  });
  reportsListWrap.querySelectorAll('.reports-row-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedReportIds.add(cb.dataset.id);
      else selectedReportIds.delete(cb.dataset.id);
      updateReportsSummary(rows);
      syncReportsSelectAllCheckbox(visibleIds);
      renderReportsChart(reportsEffectiveRows(rows));
    });
  });
}

reportsStatusFilterBtn.addEventListener('click', e => {
  e.stopPropagation();
  reportsCustomerFilterMenu.hidden = true;
  reportsStatusFilterMenu.hidden = !reportsStatusFilterMenu.hidden;
});
reportsStatusFilterMenu.addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => { reportsStatusFilterMenu.hidden = true; });
reportsStatusFilterMenu.querySelectorAll('.reports-status-filter-cb').forEach(cb => {
  cb.addEventListener('change', () => {
    if (cb.checked) reportsStatusValues.add(cb.value);
    else reportsStatusValues.delete(cb.value);
    updateReportsStatusFilterButtonLabel();
    renderReportsTable();
  });
});

reportsOperatorFilter.addEventListener('change', renderReportsTable);
reportsDateFrom.addEventListener('change', renderReportsTable);
reportsDateTo.addEventListener('change', renderReportsTable);

reportsCustomerFilterBtn.addEventListener('click', e => {
  e.stopPropagation();
  reportsStatusFilterMenu.hidden = true;
  reportsCustomerFilterMenu.hidden = !reportsCustomerFilterMenu.hidden;
});
reportsCustomerFilterMenu.addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => { reportsCustomerFilterMenu.hidden = true; });
reportsCustomerSelectAllCb.addEventListener('change', () => {
  const cbs = reportsCustomerFilterList.querySelectorAll('.reports-customer-filter-cb');
  cbs.forEach(cb => {
    cb.checked = reportsCustomerSelectAllCb.checked;
    if (cb.checked) reportsCustomerValues.add(cb.value);
    else reportsCustomerValues.delete(cb.value);
  });
  reportsCustomerSelectAllCb.indeterminate = false;
  updateReportsCustomerFilterButtonLabel();
  renderReportsTable();
});

// ── Operators (Izvajalci) modal ───────────────────────────────
function showOperatorsError(msg) {
  operatorsErrorEl.textContent = msg;
  operatorsErrorEl.hidden = false;
  operatorsSuccessEl.hidden = true;
}
function showOperatorsSuccess(html) {
  // innerHTML, not textContent — this is the one spot that needs to
  // embed a live "send credentials" button, not just plain text.
  operatorsSuccessEl.innerHTML = html;
  operatorsSuccessEl.hidden = false;
  operatorsErrorEl.hidden = true;
  const sendBtn = operatorsSuccessEl.querySelector('[data-action="operator-send-credentials"]');
  if (sendBtn) sendBtn.addEventListener('click', () => sendOperatorCredentials(sendBtn));
}

function operatorsAppUrl() {
  return window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
}

// The button carries what it needs as data-* attributes rather than a
// closure, since it's injected via showOperatorsSuccess's raw
// innerHTML and wired up after the fact. Only ever built right after
// a create or a password reset, the only moments the plaintext
// password is known — it isn't retrievable afterward.
function renderCredentialsSentMessage(prefix, email, fullName, password) {
  return `${prefix} <button type="button" class="btn btn-secondary btn-sm" data-action="operator-send-credentials" data-email="${escHtml(email)}" data-name="${escHtml(fullName || '')}" data-password="${escHtml(password)}">📧 Pošlji podatke</button>`;
}

// Real send via the send-credentials Edge Function (Resend), not a
// mailto: draft — admin-gated server-side too, see that function.
async function sendOperatorCredentials(btn) {
  const email    = btn.dataset.email;
  const fullName = btn.dataset.name;
  const password = btn.dataset.password;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Pošiljam…';
  try {
    const { data, error } = await supabase.functions.invoke('send-credentials', {
      body: { email, full_name: fullName || null, password, app_url: operatorsAppUrl() },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    btn.textContent = '✓ Poslano';
  } catch (e) {
    showOperatorsError(e.message || 'Napaka pri pošiljanju e-pošte.');
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

async function openOperatorsModal() {
  operatorsErrorEl.hidden = true;
  operatorsSuccessEl.hidden = true;
  operatorsAddWrap.hidden = !isAdminView();
  toggleAddOperatorForm(false);
  await renderOperatorsList();
  showModalAnimated(operatorsModal);
  document.body.style.overflow = 'hidden';
}

async function renderOperatorsList() {
  const { data, error } = await supabase.rpc('get_operators_with_email');
  if (error) { showOperatorsError(error.message || 'Napaka pri nalaganju.'); return; }

  const isAdmin = isAdminView();
  const ROLE_LABELS = { admin: 'Administrator', supervisor: 'Vodja organizacije', operator: 'Operater' };
  operatorsListEl.innerHTML = (data || []).map(p => `
    <div class="operator-block">
      <div class="operator-row">
        <label class="wo-gerk-check-item">
          <input type="checkbox" class="operator-eligible-checkbox" data-profile-id="${escHtml(p.id)}" ${p.eligible_izvajalec ? 'checked' : ''}>
          <span class="wo-gerk-check-code">${escHtml(p.full_name || '—')}</span>
          <span class="wo-gerk-check-name">${escHtml(p.email || '')}</span>
        </label>
        ${isAdmin ? `
        <div class="operator-row-actions">
          <button type="button" class="btn btn-icon" data-action="operator-reset-pw" data-email="${escHtml(p.email)}" data-name="${escHtml(p.full_name || '')}" aria-label="Ponastavi geslo" title="Ponastavi geslo">🔑</button>
          <button type="button" class="btn btn-icon" data-action="operator-delete" data-email="${escHtml(p.email)}" aria-label="Izbriši uporabnika" title="Izbriši uporabnika">🗑</button>
        </div>` : ''}
      </div>
      ${isAdmin ? `
      <div class="operator-meta-row" data-profile-id="${escHtml(p.id)}">
        <select class="operator-role-select" data-profile-id="${escHtml(p.id)}">
          ${Object.entries(ROLE_LABELS).map(([v, label]) => `<option value="${v}"${p.role === v ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <input type="text" class="operator-org-input" data-profile-id="${escHtml(p.id)}" placeholder="Organizacija" value="${escHtml(p.organization || '')}" ${p.role === 'admin' ? 'hidden' : ''}>
      </div>` : `
      <div class="operator-meta-row operator-meta-row--readonly">${ROLE_LABELS[p.role] || p.role || '—'}${p.organization ? ` · ${escHtml(p.organization)}` : ''}</div>`}
    </div>`).join('');

  operatorsListEl.querySelectorAll('.operator-eligible-checkbox').forEach(cb => {
    cb.addEventListener('change', () => setOperatorEligibility(cb));
  });
  operatorsListEl.querySelectorAll('[data-action="operator-reset-pw"]').forEach(btn => {
    btn.addEventListener('click', () => resetOperatorPassword(btn));
  });
  operatorsListEl.querySelectorAll('[data-action="operator-delete"]').forEach(btn => {
    btn.addEventListener('click', () => deleteOperatorRow(btn));
  });
  operatorsListEl.querySelectorAll('.operator-role-select').forEach(sel => {
    sel.addEventListener('change', () => updateOperatorRoleOrg(sel));
  });
  operatorsListEl.querySelectorAll('.operator-org-input').forEach(input => {
    input.addEventListener('change', () => updateOperatorRoleOrg(input));
  });
}

// Shared by both the role <select> and the organization <input> in a
// row's meta line — whichever fired, read the CURRENT value of both
// (they're siblings under the same .operator-meta-row) and save both
// together, since set_operator_role_org always sets the full pair.
async function updateOperatorRoleOrg(el) {
  const profileId = el.dataset.profileId;
  const metaRow = el.closest('.operator-meta-row');
  const roleSel = metaRow.querySelector('.operator-role-select');
  const orgInput = metaRow.querySelector('.operator-org-input');
  const role = roleSel.value;
  const org  = orgInput.value.trim() || null;

  if (role === 'supervisor' && !org) {
    showOperatorsError('Za vodjo organizacije vpišite organizacijo.');
    return;
  }

  el.disabled = true;
  try {
    const { error } = await supabase.rpc('set_operator_role_org', {
      p_profile_id: profileId, p_role: role, p_organization: org,
    });
    if (error) throw error;
    orgInput.hidden = role === 'admin';
    if (role === 'admin') orgInput.value = '';
  } catch (e) {
    showOperatorsError(e.message || 'Napaka pri shranjevanju.');
    await renderOperatorsList(); // revert to last known-good state
  } finally {
    el.disabled = false;
  }
}

async function setOperatorEligibility(cb) {
  const profileId = cb.dataset.profileId;
  const eligible  = cb.checked;
  cb.disabled = true;
  try {
    const { error } = await supabase.rpc('set_operator_eligibility', { p_profile_id: profileId, p_eligible: eligible });
    if (error) throw error;
    operatorsList = []; // stale — force loadOperatorsList() to refetch next time the create-order form opens
  } catch (e) {
    cb.checked = !eligible; // revert the checkbox — the write didn't actually land
    showOperatorsError(e.message || 'Napaka pri shranjevanju.');
  } finally {
    cb.disabled = false;
  }
}

function toggleAddOperatorForm(show) {
  operatorsAddForm.hidden = !show;
  if (show) {
    newOperatorName.value = '';
    newOperatorEmail.value = '';
    newOperatorPassword.value = '';
    newOperatorRole.value = 'operator';
    newOperatorOrg.value = '';
    updateNewOperatorOrgHint();
    newOperatorName.focus();
  }
}

// Admin needs no organization (sees everything); supervisor requires
// one (it's what scopes who they supervise); operator's is optional
// (plenty of operators aren't under any supervisor's org at all).
function updateNewOperatorOrgHint() {
  const role = newOperatorRole.value;
  newOperatorOrg.hidden = role === 'admin';
  newOperatorOrg.placeholder = role === 'supervisor' ? 'Organizacija (obvezno)' : 'Organizacija (neobvezno)';
}
newOperatorRole.addEventListener('change', updateNewOperatorOrgHint);

async function createOperatorFromForm() {
  const fullName = newOperatorName.value.trim();
  const email    = newOperatorEmail.value.trim();
  const password = newOperatorPassword.value;
  const role     = newOperatorRole.value;
  const org      = newOperatorOrg.value.trim() || null;
  if (!fullName || !email || !password) {
    showOperatorsError('Izpolnite ime, e-pošto in geslo.');
    return;
  }
  if (role === 'supervisor' && !org) {
    showOperatorsError('Za vodjo organizacije vpišite organizacijo.');
    return;
  }

  operatorsAddConfirmBtn.disabled = true;
  try {
    const { error } = await supabase.rpc('create_operator', {
      p_email: email, p_password: password, p_full_name: fullName,
      p_role: role, p_organization: org,
    });
    if (error) throw error;
    toggleAddOperatorForm(false);
    await renderOperatorsList();
    showOperatorsSuccess(renderCredentialsSentMessage('✓ Uporabnik ustvarjen.', email, fullName, password));
  } catch (e) {
    showOperatorsError(e.message || 'Napaka pri ustvarjanju uporabnika.');
  } finally {
    operatorsAddConfirmBtn.disabled = false;
  }
}

async function resetOperatorPassword(btn) {
  const email = btn.dataset.email;
  const name  = btn.dataset.name;
  const password = prompt(`Novo geslo za ${name || email}:`);
  if (!password) return; // cancelled or left blank

  btn.disabled = true;
  try {
    const { error } = await supabase.rpc('set_operator_password', { p_email: email, p_password: password });
    if (error) throw error;
    showOperatorsSuccess(renderCredentialsSentMessage('✓ Geslo ponastavljeno.', email, name, password));
  } catch (e) {
    showOperatorsError(e.message || 'Napaka pri ponastavitvi gesla.');
  } finally {
    btn.disabled = false;
  }
}

async function deleteOperatorRow(btn) {
  const email = btn.dataset.email;
  if (!confirm(`Izbrišem uporabnika ${email}? Tega ni mogoče razveljaviti.`)) return;

  btn.disabled = true;
  try {
    const { error } = await supabase.rpc('delete_operator', { p_email: email });
    if (error) throw error;
    operatorsList = []; // stale — same as eligibility change above
    await renderOperatorsList();
    showOperatorsSuccess(`✓ Uporabnik ${escHtml(email)} izbrisan.`);
  } catch (e) {
    showOperatorsError(e.message || 'Napaka pri brisanju uporabnika.');
  } finally {
    btn.disabled = false;
  }
}

function closeOperatorsModal() {
  hideModalAnimated(operatorsModal);
  document.body.style.overflow = '';
}

operatorsModalClose.addEventListener('click', closeOperatorsModal);
operatorsModal.addEventListener('click', e => { if (e.target === operatorsModal) closeOperatorsModal(); });
operatorsAddToggleBtn.addEventListener('click', () => toggleAddOperatorForm(operatorsAddForm.hidden));
operatorsAddCancelBtn.addEventListener('click', () => toggleAddOperatorForm(false));
operatorsAddConfirmBtn.addEventListener('click', createOperatorFromForm);

// ── Add customer modal ────────────────────────────────────────
// context: 'decl' (from "Seznam strank") refreshes that list after
// saving; 'wo' (from the work-order form's customer search) selects
// the new customer straight into the order being created; 'wo-assign'
// (from an existing order's "+ Dodaj stranko") assigns it to that order.
function openAddCustomerModal(context, prefillNaziv = '') {
  addCustomerContext = context;
  addCustomerErrorEl.hidden = true;
  addCustomerForm.reset();
  newCustomerNazivInput.value = prefillNaziv;
  showModalAnimated(addCustomerModal);
  document.body.style.overflow = 'hidden';
  newCustomerNazivInput.focus();
}

function closeAddCustomerModal() {
  hideModalAnimated(addCustomerModal);
  document.body.style.overflow = '';
}

addCustomerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const naziv   = newCustomerNazivInput.value.trim();
  const kraj    = newCustomerKrajInput.value.trim();
  const country = newCustomerCountryInput.value;
  if (!naziv) {
    addCustomerErrorEl.textContent = 'Naziv je obvezen.';
    addCustomerErrorEl.hidden = false;
    return;
  }

  addCustomerErrorEl.hidden = true;
  addCustomerSaveBtn.disabled = true;
  addCustomerSaveBtn.querySelector('.btn-label').hidden = true;
  addCustomerSaveBtn.querySelector('.btn-spinner').hidden = false;
  try {
    // country drives two downstream things: the SI/HR registry lookup
    // when resolving a GERK code's map location (see
    // migration_gerk_country_match.sql), and create_field_declaration_link's
    // automatic sl/hr form-language pick — both already keyed off this
    // same column, just never had a UI to set it on creation before.
    const { data, error } = await supabase
      .from('customers')
      .insert({ naziv, company_name: naziv, address_city: kraj || null, country })
      .select('id, naziv, company_name, contact_name, email')
      .single();
    if (error) throw error;

    const newCustomer = {
      id: data.id,
      name: data.naziv || data.company_name || '—',
      contactName: data.contact_name || null,
      email: data.email || null,
    };
    customers.push(newCustomer);
    customers.sort((a, b) => a.name.localeCompare(b.name));

    closeAddCustomerModal();
    if (addCustomerContext === 'wo') {
      woStrankaInput.value = newCustomer.name;
      woStrankaIdInput.value = newCustomer.id;
      loadCustomerGerkChecklist(newCustomer.id);
    } else if (addCustomerContext === 'wo-assign') {
      assignCustomerToWorkOrder(newCustomer);
    } else if (addCustomerContext === 'decl') {
      renderDeclCustomerList();
    }
  } catch (err) {
    addCustomerErrorEl.textContent = err.message || 'Napaka pri dodajanju stranke.';
    addCustomerErrorEl.hidden = false;
  } finally {
    addCustomerSaveBtn.disabled = false;
    addCustomerSaveBtn.querySelector('.btn-label').hidden = false;
    addCustomerSaveBtn.querySelector('.btn-spinner').hidden = true;
  }
});

addCustomerModalClose.addEventListener('click', closeAddCustomerModal);
addCustomerCancelBtn.addEventListener('click', closeAddCustomerModal);
addCustomerModal.addEventListener('click', e => { if (e.target === addCustomerModal) closeAddCustomerModal(); });
declAddCustomerBtn.addEventListener('click', () => openAddCustomerModal('decl'));

// ── Map modal (Leaflet) ───────────────────────────────────────
// One map instance, reused across opens — Leaflet can't size itself
// inside a container that's still `hidden` (0×0) at init time, so the
// first open waits a frame for the modal to actually be laid out.
let leafletMap  = null;
let mapTargetMarker = null;
let mapMeMarker = null;
let mapMeWatchId = null;

function openMapModal(lat, lng, label) {
  mapModalTitle.textContent = label || 'Lokacija';
  mapOpenExternalLink.href = `https://www.google.com/maps?q=${lat},${lng}`;
  showModalAnimated(mapModal);
  document.body.style.overflow = 'hidden';

  requestAnimationFrame(() => {
    if (!leafletMap) {
      leafletMap = L.map(mapContainer);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      }).addTo(leafletMap);
    }
    leafletMap.invalidateSize();
    leafletMap.setView([lat, lng], 17);

    if (mapTargetMarker) mapTargetMarker.remove();
    mapTargetMarker = L.marker([lat, lng]).addTo(leafletMap);
  });

  startWatchingMyLocationOnMap();
}

// "You are here" — a live-updating marker, separate from the fixed
// target marker above, so you can see how far you are from the point
// you're looking at (e.g. walking back to a previously captured sample).
function startWatchingMyLocationOnMap() {
  if (!navigator.geolocation) return;
  stopWatchingMyLocationOnMap();
  mapMeWatchId = navigator.geolocation.watchPosition(pos => {
    if (!leafletMap) return;
    const { latitude, longitude } = pos.coords;
    if (mapMeMarker) {
      mapMeMarker.setLatLng([latitude, longitude]);
    } else {
      mapMeMarker = L.circleMarker([latitude, longitude], {
        radius: 8, color: '#fff', weight: 2, fillColor: '#2455AA', fillOpacity: 1,
      }).addTo(leafletMap).bindTooltip('Vi');
    }
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
}

function stopWatchingMyLocationOnMap() {
  if (mapMeWatchId != null) { navigator.geolocation.clearWatch(mapMeWatchId); mapMeWatchId = null; }
}

function closeMapModal() {
  hideModalAnimated(mapModal);
  document.body.style.overflow = '';
  stopWatchingMyLocationOnMap();
}

mapModalClose.addEventListener('click', closeMapModal);
mapModal.addEventListener('click', e => { if (e.target === mapModal) closeMapModal(); });

// ── Tabs ───────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  tabEvidenca.classList.toggle('tab-btn--active', tab === 'evidenca');
  tabNalogi.classList.toggle('tab-btn--active', tab === 'nalogi');
  tabPlaniranje.classList.toggle('tab-btn--active', tab === 'planiranje');
  tabGnojilni.classList.toggle('tab-btn--active', tab === 'gnojilni');
  // Poročila has no tab-bar button of its own (opened from the + menu) —
  // hide the whole bar rather than leave it showing with nothing active.
  tabBarEl.hidden         = tab === 'reports';
  panelEvidenca.hidden   = tab !== 'evidenca';
  panelNalogi.hidden     = tab !== 'nalogi';
  panelPlaniranje.hidden = tab !== 'planiranje';
  panelGnojilni.hidden   = tab !== 'gnojilni';
  panelReports.hidden    = tab !== 'reports';
  updateFabVisibility();
  if (tab === 'nalogi' && !workOrdersLoaded) loadWorkOrders();
  if (tab === 'reports') loadReportsData();
}

// Poročila is reached from the + menu, not the tab bar, so it needs to
// remember which real tab to return to on ← Nazaj instead of just always
// going to one fixed tab.
function openReportsView() {
  preReportsTab = currentTab;
  switchTab('reports');
}
function closeReportsView() {
  switchTab(preReportsTab);
}

// Also re-applies the Planiranje tab's admin-only visibility — same
// enforcement pattern as every other admin-only control (RLS is the real
// gate; this just keeps the UI matching it), called from the same two spots
// (switchTab, the admin-view-toggle handler) so it's correct on load and on
// toggle. See feedback_ask_admin_only memory.
function updateFabVisibility() {
  addBtn.hidden = !isAdminView();
  tabPlaniranje.hidden = !isAdminView();
  tabGnojilni.hidden = !isAdminView();
}

// Renders the header's Admin/Regular view switch (admin-only) and
// refreshes every admin-gated bit of UI currently on screen — needed
// because flipping the toggle doesn't reload anything, it just needs
// the same render functions that already branch on isAdminView() to
// run again against the new value.
function renderAdminViewToggle() {
  adminViewToggleWrap.hidden = currentRole !== 'admin';
  if (currentRole !== 'admin') return;
  adminViewToggle.checked = adminViewActive;
  adminViewSwitchLabel.textContent = adminViewActive ? 'Admin' : 'Uporabnik';
  adminViewToggleWrap.title = adminViewActive
    ? 'Administratorski način — izklopi za uporabniški način (skrije skrbniške gumbe)'
    : 'Uporabniški način — vklopi za administratorski način';
}

adminViewToggle.addEventListener('change', () => {
  adminViewActive = adminViewToggle.checked;
  localStorage.setItem('adminViewActive', adminViewActive ? '1' : '0');
  if (!isAdminView()) { woShowDeletedActive = false; clearWoSelection(); } // never leave the archived list or a bulk selection showing once out of Admin view
  if (!isAdminView() && (currentTab === 'planiranje' || currentTab === 'gnojilni')) switchTab('nalogi'); // its tab button is about to hide — don't strand them on it
  renderAdminViewToggle();
  updateFabVisibility();
  updateShowDeletedButton();
  updateWoMapToggleButton();
  if (currentDetailWorkOrder) updateOrderHeader();
  if (currentTab === 'nalogi' && workOrdersLoaded) renderWorkOrders();
});

tabEvidenca.addEventListener('click',   () => switchTab('evidenca'));
tabNalogi.addEventListener('click',     () => switchTab('nalogi'));
tabPlaniranje.addEventListener('click', () => switchTab('planiranje'));
tabGnojilni.addEventListener('click',   () => switchTab('gnojilni'));

// ── Work orders: load + render ───────────────────────────────────
function slugStatus(status) {
  return { 'Plan': 'plan', 'V delu': 'delo', 'Izvedeno': 'izvedeno', 'Izdan Račun': 'racun' }[status] || 'plan';
}

const WO_STATUS_ORDER = { 'Plan': 0, 'V delu': 1, 'Izvedeno': 2, 'Izdan Račun': 3 };
const WO_SORT_COLUMNS = [
  { key: 'stevilka', label: 'Št.' },
  { key: 'vnos',     label: 'Vnos' },
  { key: 'stranka',  label: 'Stranka' },
  { key: 'trajanje', label: 'Čas', center: true },
  { key: 'gerki',    label: 'GERKI', center: true },
  { key: 'ha',       label: 'Ha' },
  { key: 'izvajalec', label: 'Izvajalec' },
  { key: 'status',   label: 'Status' },
];

let woSortKey = 'vnos';   // 'stevilka' | 'vnos' | 'stranka' | 'gerki' | 'ha' | 'izvajalec' | 'status'
let woSortDir = 'desc';

function sortWorkOrderRows(rows) {
  if (!woSortKey) return rows;
  const dir = woSortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (woSortKey) {
      case 'stevilka': cmp = String(a.stevilka).localeCompare(String(b.stevilka), undefined, { numeric: true }); break;
      case 'vnos':     cmp = new Date(a.vnos) - new Date(b.vnos); break;
      case 'stranka':  cmp = a.stranka.localeCompare(b.stranka); break;
      case 'trajanje': cmp = a.totalMinutes - b.totalMinutes; break;
      case 'gerki':    cmp = a.gerkCount - b.gerkCount; break;
      case 'ha':       cmp = a.totalHa - b.totalHa; break;
      case 'izvajalec': cmp = a.izvajalec.localeCompare(b.izvajalec); break;
      case 'status':   cmp = (WO_STATUS_ORDER[a.status] ?? 99) - (WO_STATUS_ORDER[b.status] ?? 99); break;
    }
    return cmp * dir;
  });
}

async function loadWorkOrders() {
  workOrdersList.innerHTML = `
    <div class="state-loading">
      <div class="spinner"></div>
      <p>Nalaganje...</p>
    </div>`;

  const [{ data, error }, { data: centerPoints }, { data: durations }] = await Promise.all([
    supabase
      .from('delovni_nalogi')
      .select('*, customers(naziv, company_name), profiles(full_name), delovni_nalogi_gerki(id, gerk_code, kolicina_ha, lokacija, tip_lab_analize, delovni_nalogi_vzorci(id, sample_no, sampling_date, sending_date, sampling_note, sending_note, sampling_depth_cm, area_ha, comment))')
      .order('ustvarjen', { ascending: false }),
    // One batched call for every row's map point, instead of one RPC
    // round trip per row — see get_work_orders_center_points.
    supabase.rpc('get_work_orders_center_points'),
    // Same batching reasoning, for the Trajanje column — see
    // get_work_orders_durations.
    supabase.rpc('get_work_orders_durations'),
  ]);

  if (error) {
    workOrdersList.innerHTML = `<div class="state-empty"><p>Napaka pri nalaganju. Poskusite znova.</p></div>`;
    return;
  }

  workOrderCenterPoints = Object.fromEntries(
    (centerPoints || []).map(p => [p.work_order_id, { lat: p.lat, lng: p.lng }])
  );
  workOrderDurations = Object.fromEntries(
    (durations || []).map(d => [d.work_order_id, d.total_minutes])
  );
  workOrders = data ?? [];
  workOrdersLoaded = true;
  // Only re-fetch if the map overview was already opened at least once
  // this session — no reason to pay for it on every load otherwise.
  if (workOrdersGerkShapesLoaded) await loadWorkOrdersGerkShapes();
  renderWorkOrders();
}

function filteredWorkOrders() {
  // A map click takes over completely — one specific work order, no
  // other filter applies (matches what you clicked, not what's typed
  // in search/status at the time).
  if (woMapClickFilterId) return workOrders.filter(wo => wo.id === woMapClickFilterId);

  const q = woSearchStranka.value.trim().toLowerCase();
  const showDeleted = isAdminView() && woShowDeletedActive;
  return workOrders.filter(wo => {
    if (showDeleted ? !wo.deleted_at : !!wo.deleted_at) return false;
    if (woStatusFilterValues.size && !woStatusFilterValues.has(wo.status)) return false;
    if (!q) return true;
    const stranka = wo.customers?.naziv || wo.customers?.company_name || '';
    return stranka.toLowerCase().includes(q);
  });
}

function workOrderTotalHa(wo) {
  return (wo.delovni_nalogi_gerki || []).reduce((s, g) => s + (g.kolicina_ha || 0), 0);
}

// Sum of ha (split by status) and logged time, over whatever's currently
// relevant: the selected rows if any are checked (bulk-select, admin
// only), else every currently filtered/visible row — same totalHa/
// workOrderDurations sources as the list's own HA/ČAS columns, so this
// always agrees with what's shown row by row. Self-contained (reads
// selectedWorkOrderIds/filteredWorkOrders() itself) so it can be called
// from anywhere selection or filtering changes, not just a full list
// re-render.
function updateWoHaSummary() {
  const source = selectedWorkOrderIds.size
    ? workOrders.filter(wo => selectedWorkOrderIds.has(wo.id))
    : filteredWorkOrders();
  let total = 0, izvedeno = 0, plan = 0, minutes = 0;
  for (const wo of source) {
    const ha = workOrderTotalHa(wo);
    total += ha;
    if (wo.status === 'Izvedeno') izvedeno += ha;
    else if (wo.status === 'Plan') plan += ha;
    minutes += workOrderDurations[wo.id] || 0;
  }
  woHaChipTotal.textContent = `${selectedWorkOrderIds.size ? 'Izbrano' : 'Skupaj'}: ${total.toFixed(2)} ha`;
  woHaChipIzvedeno.textContent = `Izvedeno: ${izvedeno.toFixed(2)} ha`;
  woHaChipPlan.textContent = `Plan: ${plan.toFixed(2)} ha`;
  woHaChipTime.textContent = `Čas: ${fmtHM(minutes)}`;
}

function renderWorkOrders() {
  const fwo = filteredWorkOrders();

  // Prune any selected id that fell out of the filtered set (search,
  // status filter, or a re-sort) so the selection bar's count never
  // lies — same reasoning as the GERK selection's pruning.
  const validIds = new Set(fwo.map(wo => wo.id));
  for (const id of selectedWorkOrderIds) if (!validIds.has(id)) selectedWorkOrderIds.delete(id);

  if (fwo.length === 0) {
    const msg = woSearchStranka.value.trim() || woStatusFilterValues.size
      ? 'Ni zadetkov.'
      : (isAdminView() && woShowDeletedActive ? 'Ni arhiviranih nalogov.' : 'Ni delovnih nalogov.');
    workOrdersList.innerHTML = `<div class="state-empty"><p>${msg}</p></div>`;
    updateWoSelectionBar();
    updateWoHaSummary();
    return;
  }

  // Bulk-select checkboxes only make sense against the normal (not
  // already-archived) list, and only for admins actually in Admin view.
  const selectable = isAdminView() && !woShowDeletedActive;

  workOrdersList.className = 'logs-list logs-list--compact';

  const rowMod  = 'wo-compact--enhanced' + (selectable ? ' wo-compact--selectable' : '');
  const headMod = 'wo-lc-header--enhanced' + (selectable ? ' wo-lc-header--selectable' : '');

  const rowData = fwo.map(wo => {
    const gerks = wo.delovni_nalogi_gerki || [];
    const point = workOrderCenterPoints[wo.id];
    return {
      id:           wo.id,
      stevilka:     wo.stevilka,
      vnos:         wo.ustvarjen,
      stranka:      wo.customers?.naziv || wo.customers?.company_name || '—',
      totalMinutes: workOrderDurations[wo.id] || 0,
      gerkCount:    gerks.length,
      totalHa:      workOrderTotalHa(wo),
      izvajalec:    wo.profiles?.full_name || '—',
      status:       wo.status,
      deleted:      !!wo.deleted_at,
      lat:          point?.lat ?? null,
      lng:          point?.lng ?? null,
    };
  });

  const header = `
    <div class="lc-header wo-lc-header ${headMod}">
      ${selectable ? '<span class="wo-th wo-select-cell"><input type="checkbox" id="woSelectAllCheckbox" aria-label="Izberi vse"></span>' : ''}
      ${WO_SORT_COLUMNS.map(col => {
        const active = woSortKey === col.key;
        const arrow  = active ? (woSortDir === 'asc' ? ' ▲' : ' ▼') : '';
        return `<button type="button" class="wo-th${col.center ? ' wo-th-center' : ''}${active ? ' wo-th--active' : ''}" data-sort="${col.key}">${col.label}${arrow}</button>`;
      }).join('')}
      <span class="wo-th wo-th-center wo-c-maps" title="Zemljevid">📍</span>
    </div>`;

  const rows = sortWorkOrderRows(rowData).map(r => {
    const haStr = r.totalHa > 0 ? r.totalHa.toFixed(2) : '—';
    const mapsCell = r.lat != null && r.lng != null
      ? `<a class="wo-c-maps" href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank" rel="noopener" aria-label="Odpri na zemljevidu">📍</a>`
      : `<span class="wo-c-maps wo-c-maps--empty">—</span>`;
    const checkboxCell = selectable
      ? `<span class="wo-select-cell"><input type="checkbox" class="wo-select-checkbox" data-id="${escHtml(r.id)}" aria-label="Izberi nalog" ${selectedWorkOrderIds.has(r.id) ? 'checked' : ''}></span>`
      : '';
    return `
      <div class="log-compact wo-compact ${rowMod}${r.status === 'Izvedeno' ? ' wo-compact--izvedeno' : ''}${r.status === 'V delu' ? ' wo-compact--delo' : ''}${r.deleted ? ' wo-compact--deleted' : ''}" role="listitem" data-action="wo-open" data-id="${escHtml(r.id)}">
        ${checkboxCell}
        <span class="lc-date">${escHtml(r.stevilka)}</span>
        <span class="wo-c-vnos">${fmtSampleDate(r.vnos)}</span>
        <span class="wo-c-stranka">${escHtml(r.stranka)}</span>
        <span class="wo-c-duration">${r.totalMinutes > 0 ? fmtHM(r.totalMinutes) : '—'}</span>
        <span class="wo-c-gerki">${r.gerkCount || '—'}</span>
        <span class="lc-ha">${haStr}</span>
        <span class="wo-c-izvajalec">${escHtml(r.izvajalec)}</span>
        <span class="wo-status-badge wo-status--${slugStatus(r.status)}">${escHtml(r.status)}</span>
        ${mapsCell}
      </div>`;
  }).join('');

  workOrdersList.innerHTML = header + rows;
  wireWorkOrderButtons();
  updateWoSelectionBar();
  updateWoHaSummary();
  renderWoMapOverview();
}

function wireWorkOrderButtons() {
  workOrdersList.querySelectorAll('[data-action="wo-open"]').forEach(row => {
    row.addEventListener('click', () => {
      const wo = workOrders.find(w => w.id === row.dataset.id);
      if (wo) openWorkOrderDetail(wo);
    });
  });
  // Scoped to <button> — the static Zemljevid header label shares the
  // .wo-th class purely for visual consistency and isn't sortable (no
  // data-sort), so it's a plain <span>, not a button — matching this
  // selector to it would sort by "undefined".
  workOrdersList.querySelectorAll('button.wo-th').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      woSortDir = (woSortKey === key && woSortDir === 'asc') ? 'desc' : 'asc';
      woSortKey = key;
      renderWorkOrders();
    });
  });
  // stopPropagation so checking the box doesn't also trigger the row's
  // own click listener above and open the detail modal.
  workOrdersList.querySelectorAll('.wo-select-checkbox').forEach(cb => {
    cb.addEventListener('click', e => {
      e.stopPropagation();
      if (cb.checked) selectedWorkOrderIds.add(cb.dataset.id);
      else selectedWorkOrderIds.delete(cb.dataset.id);
      updateWoSelectionBar();
      updateWoHaSummary();
      updateSelectAllCheckboxState();
      renderWoMapOverview();
    });
  });
  // Header checkbox — selects/deselects every currently filtered row at
  // once. Any row already selected (full or partial/indeterminate) means
  // the next click clears the selection, not extends it to the rest —
  // "deselect all" is the default once anything is picked. Decides
  // direction from selectedWorkOrderIds itself (not the checkbox's own
  // post-click .checked/.indeterminate, which the browser sets per its
  // own indeterminate-click rules) — simplest to reason about, and a
  // full re-render right after keeps every row checkbox and this one in
  // sync regardless.
  const selectAllCb = workOrdersList.querySelector('#woSelectAllCheckbox');
  if (selectAllCb) {
    selectAllCb.addEventListener('click', () => {
      const fwo = filteredWorkOrders();
      const anySelected = fwo.some(wo => selectedWorkOrderIds.has(wo.id));
      if (anySelected) fwo.forEach(wo => selectedWorkOrderIds.delete(wo.id));
      else fwo.forEach(wo => selectedWorkOrderIds.add(wo.id));
      renderWorkOrders();
    });
  }
  updateSelectAllCheckboxState();
}

// Keeps the header checkbox's checked/indeterminate state matching
// selectedWorkOrderIds vs. the currently filtered set — called after any
// render and after every individual row checkbox toggle, since the
// header isn't rebuilt on the latter.
function updateSelectAllCheckboxState() {
  const cb = workOrdersList.querySelector('#woSelectAllCheckbox');
  if (!cb) return;
  const fwo = filteredWorkOrders();
  const selectedCount = fwo.filter(wo => selectedWorkOrderIds.has(wo.id)).length;
  cb.checked = fwo.length > 0 && selectedCount === fwo.length;
  cb.indeterminate = selectedCount > 0 && selectedCount < fwo.length;
}

function getAvailableStranke() {
  const set = new Set();
  workOrders.forEach(wo => {
    const name = wo.customers?.naziv || wo.customers?.company_name;
    if (name) set.add(name);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function showWoSearchSuggestions() {
  const q = woSearchStranka.value.trim().toLowerCase();
  const all = getAvailableStranke();
  const matches = q ? all.filter(n => n.toLowerCase().includes(q)) : all;
  if (!matches.length) { woSearchSuggestions.hidden = true; return; }
  woSearchSuggestions.innerHTML = matches.map(name =>
    `<li class="gerk-suggestion-item" data-name="${escHtml(name)}"><span class="gerk-suggestion-code">${escHtml(name)}</span></li>`
  ).join('');
  woSearchSuggestions.hidden = false;
}

function updateStatusFilterButtonLabel() {
  const n = woStatusFilterValues.size;
  woStatusFilterBtn.textContent = n === 0 ? 'Vsi statusi' : n === 1 ? [...woStatusFilterValues][0] : `${n} statusi`;
}

woStatusFilterBtn.addEventListener('click', e => {
  e.stopPropagation();
  woStatusFilterMenu.hidden = !woStatusFilterMenu.hidden;
});
woStatusFilterMenu.addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => { woStatusFilterMenu.hidden = true; });
woStatusFilterMenu.querySelectorAll('.wo-status-filter-cb').forEach(cb => {
  cb.addEventListener('change', () => {
    if (cb.checked) woStatusFilterValues.add(cb.value);
    else woStatusFilterValues.delete(cb.value);
    updateStatusFilterButtonLabel();
    renderWorkOrders();
  });
});

function updateShowDeletedButton() {
  woShowDeletedBtn.hidden = !isAdminView();
  woShowDeletedBtn.classList.toggle('wo-show-deleted-btn--active', woShowDeletedActive);
  woShowDeletedBtn.textContent = woShowDeletedActive ? '◀ Nazaj' : '🗑 Izbrisani';
  woShowDeletedBtn.title = woShowDeletedActive ? 'Nazaj na običajen seznam' : 'Prikaži arhivirane (izbrisane) naloge';
}

woShowDeletedBtn.addEventListener('click', () => {
  woShowDeletedActive = !woShowDeletedActive;
  updateShowDeletedButton();
  clearWoSelection();
  renderWorkOrders();
});

function updateWoMapToggleButton() {
  // Available to every user, not just admins — unlike woShowDeletedBtn.
  woMapToggleBtn.hidden = false;
  woMapToggleBtn.classList.toggle('wo-show-deleted-btn--active', woMapOverviewActive);
  // On phones the label stays short (the map has its own ✕ in the
  // corner and the button's active color already says it's open) so
  // all toolbar buttons fit on one row.
  const isPhone = isMobile();
  woMapToggleBtn.textContent = woMapOverviewActive && !isPhone ? '◀ Skrij zemljevid' : '🗺 Zemljevid';
  woMapToggleBtn.title = woMapOverviewActive ? 'Skrij pregled na zemljevidu' : 'Prikaži polja delovnih nalogov na zemljevidu';
}

async function loadWorkOrdersGerkShapes() {
  const { data, error } = await supabase.rpc('get_work_orders_gerk_shapes');
  if (error) { console.error('loadWorkOrdersGerkShapes', error); return; }
  workOrdersGerkShapes = data || [];
  workOrdersGerkShapesLoaded = true;
}

function ensureWoOverviewMap() {
  if (woOverviewMap) return woOverviewMap;
  woOverviewMap = L.map(woOverviewMapEl);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }).addTo(woOverviewMap);
  // Roads/borders/place-name overlay — created but not added (off by
  // default), toggled on/off via woOverviewMapLayersBtn.
  woOverviewLabelsLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri',
  });
  woOverviewMarkersLayer = L.layerGroup().addTo(woOverviewMap);
  new ResizeObserver(() => woOverviewMap?.invalidateSize()).observe(woOverviewMapEl.parentElement);
  // Only redraws the current shape set at whatever zoom it lands on —
  // never calls fitBounds/setView itself, or zooming would retrigger
  // this handler and fight the user's own zoom/pan. Only
  // renderWoMapOverview (a fresh filter/selection) re-fits bounds.
  woOverviewMap.on('zoomend', redrawWoOverviewLayer);
  return woOverviewMap;
}

// Colors a GERK shape by its own work order's status — Izvedeno/Izdan
// Račun (work actually done, billed or not) are green; Plan/V delu
// (not done yet) are orange. Same status set as slugStatus/WO_STATUS_ORDER.
function woMapOverviewColor(status) {
  if (status === 'Izvedeno' || status === 'Izdan Račun') return '#16A34A'; // green
  if (status === 'V delu') return '#F59E0B'; // orange
  return '#9CA3AF'; // Plan (and anything else) — grey, matches --text-muted
}

// Below this zoom, real field boundaries are too small/cluttered to
// read (or overlap each other) — show a simple colored pin at each
// shape's centroid instead. Lowered from 15 (was too late — shapes only
// appeared once basically fully zoomed in) so they show up a couple of
// zoom steps sooner instead.
const WO_MAP_OVERVIEW_SHAPE_ZOOM = 13;

let woOverviewCurrentShapes = []; // cached by renderWoMapOverview, read by the zoom-triggered redraw

// Draws whichever of the cached current shapes have geometry, as
// either real polygons (zoomed in) or centroid pins (zoomed out) —
// never touches the map's own view/zoom, see ensureWoOverviewMap.
// Stranka name for a shape's work order — looked up from the already-
// loaded main list (workOrders), not a new fetch; get_work_orders_gerk_shapes
// doesn't need to carry it too.
function woMapOverviewCustomerName(delovniNalogId) {
  const wo = workOrders.find(w => w.id === delovniNalogId);
  return wo?.customers?.naziv || wo?.customers?.company_name || '—';
}

function woMapOverviewTooltipHtml(s) {
  return `<div>${escHtml(woMapOverviewCustomerName(s.delovni_nalog_id))}</div><div>${escHtml(s.gerk_code || '')}</div>`;
}

// Clicking a shape/pin narrows the work-order list on the left to
// just that one order (filteredWorkOrders honors woMapClickFilterId),
// so it can be found and opened — same target work order for every
// sub-shape of a compound "A+B+C" GERK.
function woMapOverviewLayerClick(s) {
  woMapClickFilterId = s.delovni_nalog_id;
  updateWoMapFilterBanner();
  renderWorkOrders();
}

function redrawWoOverviewLayer() {
  if (!woOverviewMap) return;
  woOverviewMarkersLayer.clearLayers();
  const showShapes = woOverviewMap.getZoom() >= WO_MAP_OVERVIEW_SHAPE_ZOOM;

  for (const s of woOverviewCurrentShapes) {
    const color = woMapOverviewColor(s.status);
    const tooltipHtml = woMapOverviewTooltipHtml(s);
    let layer;
    if (showShapes) {
      layer = L.geoJSON(s.geojson, { style: { color: '#fff', weight: 2, fillColor: color, fillOpacity: .55 } })
        .bindTooltip(tooltipHtml, { direction: 'top', sticky: true, className: 'wo-overview-tooltip' })
        .addTo(woOverviewMarkersLayer);
    } else {
      const center = L.geoJSON(s.geojson).getBounds().getCenter();
      layer = L.circleMarker(center, { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: .9 })
        .bindTooltip(tooltipHtml, { direction: 'top', className: 'wo-overview-tooltip' })
        .addTo(woOverviewMarkersLayer);
    }
    layer.on('click', () => woMapOverviewLayerClick(s));
  }
}

// Recomputes the overview map's shape set — scoped to whichever work
// orders are checked (selectedWorkOrderIds), or every currently
// *filtered* row when nothing's checked (mirrors the list itself, not
// the whole unfiltered table) — then redraws and re-fits bounds. No-op
// while the map panel isn't open, so this is safe to call
// unconditionally after every list re-render/selection change instead
// of needing its own separate gating at each call site. One shape per
// GERK, or per imported zone for GERKs with no official registry
// boundary — see get_work_orders_gerk_shapes.
function renderWoMapOverview() {
  if (!woMapOverviewActive || !woOverviewMap || !workOrdersGerkShapesLoaded) return;

  const scopeIds = selectedWorkOrderIds.size
    ? selectedWorkOrderIds
    : new Set(filteredWorkOrders().map(wo => wo.id));

  woOverviewCurrentShapes = workOrdersGerkShapes.filter(s => scopeIds.has(s.delovni_nalog_id) && s.geojson);
  redrawWoOverviewLayer();

  if (woOverviewCurrentShapes.length) {
    let combined = L.geoJSON(woOverviewCurrentShapes[0].geojson).getBounds();
    for (const s of woOverviewCurrentShapes.slice(1)) combined = combined.extend(L.geoJSON(s.geojson).getBounds());
    woOverviewMap.fitBounds(combined, { padding: [30, 30], maxZoom: 16 });
  } else {
    woOverviewMap.setView([46.15, 14.99], 8); // Slovenia-wide fallback when nothing to show
  }
}

function updateWoMapFilterBanner() {
  woMapFilterBanner.hidden = !woMapClickFilterId;
  woMapFilterClearBtn.hidden = !woMapClickFilterId;
}

woMapFilterClearBtn.addEventListener('click', () => {
  woMapClickFilterId = null;
  updateWoMapFilterBanner();
  renderWorkOrders();
});

woMapToggleBtn.addEventListener('click', async () => {
  woMapOverviewActive = !woMapOverviewActive;
  updateWoMapToggleButton();
  woOverviewMapWrap.hidden = !woMapOverviewActive;
  // Closing the map overview also drops any map-click filter — the
  // banner explaining it would otherwise be orphaned with the map gone.
  if (!woMapOverviewActive && woMapClickFilterId) {
    woMapClickFilterId = null;
    updateWoMapFilterBanner();
    renderWorkOrders();
  }
  woListLayout.classList.toggle('wo-list-layout--map-active', woMapOverviewActive);
  if (!woMapOverviewActive) return;

  ensureWoOverviewMap();
  // invalidateSize() has to run — with the container actually part of
  // the visible layout — before fitBounds() runs inside
  // renderWoMapOverview() below, or it computes against Leaflet's
  // stale cached size (usually 0×0, from whenever the map was first
  // constructed while still hidden) instead of the real one. Same
  // fix as showWoDetailMap's own identical comment — awaiting a
  // frame here (right after woOverviewMapWrap.hidden = false above)
  // is the earliest point the container has real dimensions.
  await new Promise(resolve => requestAnimationFrame(resolve));
  woOverviewMap.invalidateSize();
  if (!workOrdersGerkShapesLoaded) await loadWorkOrdersGerkShapes();
  renderWoMapOverview();
});

// ✕ in the map's corner — reuses the toolbar toggle so closing goes
// through the exact same path (map-click filter cleared, label reset).
woOverviewMapCloseBtn.addEventListener('click', () => {
  if (woMapOverviewActive) woMapToggleBtn.click();
});

woOverviewMapLayersBtn.addEventListener('click', () => {
  if (!woOverviewMap || !woOverviewLabelsLayer) return;
  const active = woOverviewMap.hasLayer(woOverviewLabelsLayer);
  if (active) woOverviewMap.removeLayer(woOverviewLabelsLayer); else woOverviewLabelsLayer.addTo(woOverviewMap);
  woOverviewMapLayersBtn.setAttribute('aria-pressed', String(!active));
});

// ── Main list bulk-select (admin view only) — mirrors the GERK
// selection bar's structure/CSS (.wlg-selection-bar), just with a
// single action since "delete" is now the only thing it needs to do.
function buildWoSelectionBar() {
  woSelectionBar.setAttribute('role', 'toolbar');
  woSelectionBar.setAttribute('aria-label', 'Skupinska dejanja za izbrane naloge');
  woSelectionBar.innerHTML = `
    <span class="wlg-sel-summary"></span>
    <button type="button" class="wlg-sel-close" data-action="wo-sel-close" aria-label="Prekliči izbiro" title="Prekliči izbiro">${WLG_SEL_ICON_CLOSE}</button>
    <span class="wlg-sel-sep" aria-hidden="true"></span>
    <div class="wlg-sel-actions">
      <button type="button" class="wlg-sel-action" data-action-id="wo-sel-export" aria-label="Izvozi izbrane naloge v Excel" title="Izvozi izbrane naloge v Excel">
        ${WLG_SEL_ICON_DOWNLOAD}<span class="wlg-sel-action-label">Izvozi</span>
      </button>
      <button type="button" class="wlg-sel-action wlg-sel-action--danger" data-action-id="wo-sel-delete" aria-label="Izbriši izbrane naloge" title="Izbriši izbrane naloge">
        ${WLG_SEL_ICON_TRASH}<span class="wlg-sel-action-label">Izbriši</span>
      </button>
    </div>`;
  woSelectionBar.querySelector('[data-action="wo-sel-close"]').addEventListener('click', clearWoSelection);
  woSelectionBar.querySelector('[data-action-id="wo-sel-export"]').addEventListener('click', e => exportSelectedWorkOrdersToExcel(e.currentTarget));
  woSelectionBar.querySelector('[data-action-id="wo-sel-delete"]').addEventListener('click', e => bulkDeleteSelectedWorkOrders(e.currentTarget));
}
buildWoSelectionBar();

function updateWoSelectionBar() {
  const n = selectedWorkOrderIds.size;
  woSelectionBar.classList.toggle('wlg-selection-bar--visible', n > 0);
  if (n === 0) return;
  const summaryEl = woSelectionBar.querySelector('.wlg-sel-summary');
  if (summaryEl) summaryEl.textContent = `${n} ${n === 1 ? 'izbran' : 'izbranih'}`;
}

function clearWoSelection() {
  selectedWorkOrderIds = new Set();
  workOrdersList.querySelectorAll('.wo-select-checkbox').forEach(cb => { cb.checked = false; });
  updateWoSelectionBar();
  updateWoHaSummary();
  updateSelectAllCheckboxState();
  renderWoMapOverview();
}

async function bulkDeleteSelectedWorkOrders(btn) {
  const ids = [...selectedWorkOrderIds];
  if (!ids.length) return;
  if (!confirm(`Izbrišem ${ids.length} ${ids.length === 1 ? 'izbran nalog' : 'izbranih nalogov'}? Ne bodo več vidni v glavnem seznamu ali v Evidenci dela, dokler jih ne obnovite (v seznamu "Izbrisani").`)) return;

  btn.disabled = true;
  const { error } = await softDeleteWorkOrders(ids);
  btn.disabled = false;
  if (error) { alert(error.message || 'Napaka pri brisanju nalogov.'); return; }
  clearWoSelection();
  await loadWorkOrders();
}

// CSV, not a real .xlsx — Excel opens it directly, no binary format/library
// needed. Semicolon separator + UTF-8 BOM: Slovenian-locale Excel treats
// comma as the decimal separator, so a comma-delimited CSV mis-splits
// columns, and without the BOM č/š/ž render as mojibake.
function csvField(value) {
  const s = value == null ? '' : String(value);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A plain dot-decimal like "8.23" opens in Excel as a date serial (it reads
// the dot as an ambiguous date separator) — formatting with a comma instead
// matches the semicolon-CSV's own locale convention and avoids that misparse.
function csvHa(value) {
  return value == null ? '' : Number(value).toFixed(2).replace('.', ',');
}

// One row per segment — not per GERK — since export granularity needs to
// show each segment's own area, not just the GERK total (a GERK split into
// several KML-imported zones has a different Ha per zone). Falls back to
// one row per GERK (using the GERK's own kolicina_ha) only when it has no
// segments at all.
function exportSelectedWorkOrdersToExcel(btn) {
  const orders = workOrders.filter(wo => selectedWorkOrderIds.has(wo.id));
  if (!orders.length) return;

  btn.disabled = true;
  try {
    const header = ['Št. naloga', 'Datum', 'Stranka', 'Status', 'Izvajalec', 'GERK', 'Segment', 'Ha'];
    const lines = [header.map(csvField).join(';')];

    for (const wo of orders) {
      const datum = wo.ustvarjen ? fmtSampleDate(wo.ustvarjen.slice(0, 10)) : '';
      const stranka = wo.customers?.naziv || wo.customers?.company_name || '';
      const izvajalec = wo.profiles?.full_name || '';
      const base = [wo.stevilka || '', datum, stranka, wo.status || '', izvajalec];
      const gerks = wo.delovni_nalogi_gerki || [];
      for (const g of gerks) {
        const segments = g.delovni_nalogi_vzorci || [];
        if (!segments.length) {
          lines.push([...base, g.gerk_code || '', '', csvHa(g.kolicina_ha)].map(csvField).join(';'));
        } else {
          for (const s of segments) {
            lines.push([...base, g.gerk_code || '', s.sample_no || '', csvHa(s.area_ha)].map(csvField).join(';'));
          }
        }
      }
    }

    const csv = '﻿' + lines.join('\r\n');
    downloadTextFile(`delovni_nalogi_${todayISO()}.csv`, csv, 'text/csv;charset=utf-8');
  } finally {
    btn.disabled = false;
  }
}

function updateWoSearchClearBtn() {
  woSearchClearBtn.hidden = !woSearchStranka.value;
}

woSearchStranka.addEventListener('input', () => { updateWoSearchClearBtn(); renderWorkOrders(); showWoSearchSuggestions(); });
// ✕ inside the search box — one tap back to the unfiltered list. Doesn't
// refocus the input on purpose, so the phone keyboard doesn't pop up.
woSearchClearBtn.addEventListener('click', () => {
  woSearchStranka.value = '';
  woSearchSuggestions.hidden = true;
  updateWoSearchClearBtn();
  renderWorkOrders();
});
woSearchStranka.addEventListener('focus', showWoSearchSuggestions);
woSearchStranka.addEventListener('blur', () => {
  setTimeout(() => { woSearchSuggestions.hidden = true; }, 150);
});
woSearchSuggestions.addEventListener('mousedown', e => {
  const item = e.target.closest('.gerk-suggestion-item');
  if (!item) return;
  woSearchStranka.value = item.dataset.name;
  woSearchSuggestions.hidden = true;
  updateWoSearchClearBtn();
  renderWorkOrders();
});

// ── Work orders: customer + operator lookups ────────────────────
async function loadCustomers() {
  const { data } = await supabase
    .from('customers')
    .select('id, naziv, company_name, contact_name, email, deleted_at')
    .order('naziv');
  customers = (data ?? []).map(c => ({
    id: c.id,
    name: c.naziv || c.company_name || '—',
    contactName: c.contact_name || null,
    email: c.email || null,
    deletedAt: c.deleted_at || null,
  }));
}

async function loadOperatorsList() {
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('eligible_izvajalec', true)
    .order('full_name');
  operatorsList = data ?? [];
  woIzvajalecSel.innerHTML = '<option value="">— brez —</option>' +
    operatorsList.map(p => `<option value="${p.id}">${escHtml(p.full_name || '—')}</option>`).join('');
}

function filterCustomers(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  return customers.filter(c => !c.deletedAt && c.name.toLowerCase().includes(q)).slice(0, 8);
}

function showCustomerSuggestions(listEl, matches, query, addNewContext) {
  // Only admins can reach these forms (the FAB's "+ Nov delovni nalog" and
  // the work-order detail's "+ Dodaj stranko" are both admin-gated) and
  // only admins can insert into customers (see the "Admins can insert
  // customers" RLS policy) — so this is always safe to offer here, not
  // just when matches come up empty.
  const addNewItem = isAdminView() && query && addNewContext
    ? `<li class="gerk-suggestion-item gerk-suggestion-item--add" data-action="add-new"><span class="gerk-suggestion-code">+ Dodaj novo stranko: "${escHtml(query)}"</span></li>`
    : '';
  if (!matches.length && !addNewItem) { listEl.hidden = true; return; }
  listEl.innerHTML = matches.map(c =>
    `<li class="gerk-suggestion-item" data-id="${c.id}"><span class="gerk-suggestion-code">${escHtml(c.name)}</span></li>`
  ).join('') + addNewItem;
  listEl.hidden = false;
}

woStrankaInput.addEventListener('input', () => {
  woStrankaIdInput.value = '';
  const q = woStrankaInput.value.trim();
  showCustomerSuggestions(woStrankaSuggestions, filterCustomers(q), q, 'wo');
});
woStrankaInput.addEventListener('blur', () => {
  setTimeout(() => { woStrankaSuggestions.hidden = true; }, 150);
});
woStrankaSuggestions.addEventListener('mousedown', e => {
  if (e.target.closest('[data-action="add-new"]')) {
    woStrankaSuggestions.hidden = true;
    openAddCustomerModal('wo', woStrankaInput.value.trim());
    return;
  }
  const item = e.target.closest('.gerk-suggestion-item');
  if (!item) return;
  const c = customers.find(c => c.id === item.dataset.id);
  if (c) {
    woStrankaInput.value = c.name;
    woStrankaIdInput.value = c.id;
    loadCustomerGerkChecklist(c.id);
  }
  woStrankaSuggestions.hidden = true;
});

// ── Work order detail: assign a customer to an order that has none ──
woAssignCustomerBtn.addEventListener('click', async () => {
  woAssignCustomerBtn.hidden = true;
  woAssignCustomerWrap.hidden = false;
  woAssignCustomerInput.value = '';
  // Unlike the new-work-order form, this button can be the first thing
  // clicked in a session (e.g. straight from the main list into an
  // existing order's detail) — `customers` may still be empty here.
  if (!customers.length) await loadCustomers();
  woAssignCustomerInput.focus();
});

woAssignCustomerInput.addEventListener('input', () => {
  const q = woAssignCustomerInput.value.trim();
  showCustomerSuggestions(woAssignCustomerSuggestions, filterCustomers(q), q, 'wo-assign');
});

woAssignCustomerInput.addEventListener('blur', () => {
  setTimeout(() => { woAssignCustomerSuggestions.hidden = true; }, 150);
});

woAssignCustomerSuggestions.addEventListener('mousedown', e => {
  if (e.target.closest('[data-action="add-new"]')) {
    woAssignCustomerSuggestions.hidden = true;
    openAddCustomerModal('wo-assign', woAssignCustomerInput.value.trim());
    return;
  }
  const item = e.target.closest('.gerk-suggestion-item');
  if (!item) return;
  const c = customers.find(c => c.id === item.dataset.id);
  woAssignCustomerSuggestions.hidden = true;
  if (c) assignCustomerToWorkOrder(c);
});

async function assignCustomerToWorkOrder(customer) {
  if (!currentDetailWorkOrder) return;
  woAssignCustomerInput.disabled = true;
  try {
    const { error } = await supabase.from('delovni_nalogi').update({ stranka_id: customer.id }).eq('id', currentDetailWorkOrder.id);
    if (error) throw error;
    currentDetailWorkOrder.stranka_id = customer.id;
    currentDetailWorkOrder.customers = { naziv: customer.name };
    workLogOrderLabel.textContent = customer.name;
    updateOrderHeader();
    await loadWorkOrders(); // keeps the main list's stranka column/search in sync
  } catch (e) {
    showFormError(e.message || 'Napaka pri dodajanju stranke.');
  } finally {
    woAssignCustomerInput.disabled = false;
  }
}

// ── GERK checklist: the selected customer's own fields, checked ──
// instead of typed/searched one at a time. Checking/unchecking stays
// in sync with the plain row list below it (still the actual source
// of truth getFormGerks() reads at submit) — checking adds a row (or
// fills the first still-empty one), unchecking removes it.
async function loadCustomerGerkChecklist(customerId) {
  woCustomerGerksWrap.hidden = true;
  woCustomerGerksList.innerHTML = '';
  if (!customerId) return;

  const { data } = await supabase
    .from('fields')
    .select('cadastre_id, name, area_ha')
    .eq('customer_id', customerId)
    .order('name');
  if (!data || !data.length) return;

  woCustomerGerksList.innerHTML = data.map(f => `
    <label class="wo-gerk-check-item">
      <input type="checkbox" class="wo-gerk-checkbox" data-code="${escHtml(f.cadastre_id)}" data-area="${f.area_ha ?? ''}">
      <span class="wo-gerk-check-code">${escHtml(f.cadastre_id)}</span>
      <span class="wo-gerk-check-name">${escHtml(f.name || '')}${f.area_ha ? ` · ${f.area_ha} ha` : ''}</span>
    </label>`).join('');
  woCustomerGerksWrap.hidden = false;

  woCustomerGerksList.querySelectorAll('.wo-gerk-checkbox').forEach(cb => {
    cb.addEventListener('change', () => toggleGerkChecklistItem(cb));
  });
}

function findGerkRowByCode(code) {
  return Array.from(woGerksListEl.querySelectorAll('.gerk-row'))
    .find(r => r.querySelector('.gerk-code-input').value.trim() === code);
}

// Fills the first still-empty manual row instead of piling on a new
// one, if there is one (there always is exactly one on a fresh form).
function addOrFillGerkRow(code, hectares) {
  const emptyRow = Array.from(woGerksListEl.querySelectorAll('.gerk-row'))
    .find(r => !r.querySelector('.gerk-code-input').value.trim());
  if (emptyRow) {
    emptyRow.querySelector('.gerk-code-input').value = code;
    if (hectares) emptyRow.querySelector('.gerk-ha-input').value = hectares;
  } else {
    addGerkRow(woGerksListEl, code, hectares);
  }
}

function toggleGerkChecklistItem(cb) {
  const code = cb.dataset.code;
  if (cb.checked) {
    if (!findGerkRowByCode(code)) addOrFillGerkRow(code, cb.dataset.area);
  } else {
    const row = findGerkRowByCode(code);
    if (row) row.remove();
    if (!woGerksListEl.querySelector('.gerk-row')) addGerkRow(woGerksListEl);
  }
}

// Ensures `code` has a GERK row (via the customer checklist if it's a
// known field, otherwise a manual row) and returns that row.
function ensureGerkRowForPaste(code, hectares) {
  const checklistCb = woCustomerGerksList.querySelector(`.wo-gerk-checkbox[data-code="${CSS.escape(code)}"]`);
  if (checklistCb) {
    if (!checklistCb.checked) { checklistCb.checked = true; toggleGerkChecklistItem(checklistCb); }
    return findGerkRowByCode(code);
  }
  let row = findGerkRowByCode(code);
  if (!row) {
    addOrFillGerkRow(code, hectares);
    row = findGerkRowByCode(code);
  }
  return row;
}

// ── KML import on the create-order form ─────────────────────────
// gerk_segmentation/gerk_segment attach to the GERK's own numeric code,
// not to any work order, so this can import immediately — before the
// order itself is even saved — same import_gerk_segmentation RPC as
// the detail view. The GERK row it produces is added to the form the
// same way a pasted/typed one would be, so it's saved normally on
// submit. Globina (Vzorčenje imports only) doesn't have a per-segment
// slot at this stage — it feeds the existing "Globina (za vse
// segmente)" bulk select instead, same mechanism the create form
// already uses to apply depth to every segment at save time. One
// entry per selected file, same batch model as the detail-view import.
let pendingNewKmlImports = [];

function showNewKmlImportError(msg) {
  woNewImportZonesError.textContent = msg;
  woNewImportZonesError.hidden = false;
}

function updateNewImportZonesGlobinaVisibility() {
  const isSampling = woNewImportZonesType.value === 'vzorčenje';
  woNewImportZonesGlobina.hidden = !isSampling;
  if (!isSampling) woNewImportZonesGlobina.value = '';
}

function renderNewKmlImportFiles() {
  woNewImportZonesFiles.innerHTML = pendingNewKmlImports.map((imp, i) => `
    <div class="wlg-import-zones-file-row">
      <span class="wlg-import-zones-filename">${escHtml(imp.file.name)} (${imp.segments.length} ${imp.segments.length === 1 ? 'cona' : 'cone'})</span>
      <input type="text" class="sample-field-input wlg-import-zones-file-gerk" data-index="${i}" placeholder="GERK" list="woNewImportZonesGerkList" autocomplete="off" value="${escHtml(imp.gerkCode)}">
      ${pendingNewKmlImports.length > 1 ? `<button type="button" class="btn btn-icon wlg-import-zones-file-remove" data-index="${i}" aria-label="Odstrani datoteko" title="Odstrani datoteko">✕</button>` : ''}
    </div>`).join('');
  woNewImportZonesFiles.querySelectorAll('.wlg-import-zones-file-gerk').forEach(inp => {
    inp.addEventListener('change', () => { pendingNewKmlImports[parseInt(inp.dataset.index, 10)].gerkCode = inp.value.trim(); });
  });
  woNewImportZonesFiles.querySelectorAll('.wlg-import-zones-file-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingNewKmlImports.splice(parseInt(btn.dataset.index, 10), 1);
      if (!pendingNewKmlImports.length) { cancelNewKmlImport(); return; }
      renderNewKmlImportFiles();
    });
  });
}

async function onNewKmlFileSelected(input) {
  const files = Array.from(input.files);
  input.value = '';
  if (!files.length) return;
  woNewImportZonesError.hidden = true;

  const parseErrors = [];
  pendingNewKmlImports = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const { segments, detectedGerkId } = parseKmlSegments(text);
      pendingNewKmlImports.push({ file, segments, gerkCode: detectedGerkId || '' });
    } catch (e) {
      parseErrors.push(`${file.name}: ${e.message || 'napaka pri branju'}`);
    }
  }
  if (parseErrors.length) showNewKmlImportError(parseErrors.join(' | '));
  if (!pendingNewKmlImports.length) { woNewImportZonesForm.hidden = true; return; }

  // Same reasoning as the detail-view import — offer the GERK codes
  // already staged on this form so far, so typing one that doesn't
  // exactly match doesn't silently create orphaned zone data.
  woNewImportZonesGerkList.innerHTML = getFormGerks(woGerksListEl)
    .map(g => `<option value="${escHtml(g.code)}">`).join('');
  renderNewKmlImportFiles();
  woNewImportZonesType.value = 'vzorčenje';
  woNewImportZonesGlobina.value = '';
  updateNewImportZonesGlobinaVisibility();
  woNewImportZonesDate.value = todayISO();
  woNewImportZonesForm.hidden = false;
}

function cancelNewKmlImport() {
  pendingNewKmlImports = [];
  woNewImportZonesForm.hidden = true;
}

async function confirmNewKmlImport(btn) {
  if (!pendingNewKmlImports.length) return;

  const type      = woNewImportZonesType.value.trim();
  const validFrom = woNewImportZonesDate.value;
  const globina   = woNewImportZonesGlobina.value;
  woNewImportZonesError.hidden = true;
  if (!type)      { showNewKmlImportError('Vpišite tip segmentacije.'); return; }
  if (!validFrom) { showNewKmlImportError('Izberite datum veljavnosti.'); return; }
  if (pendingNewKmlImports.some(imp => !imp.gerkCode.trim())) { showNewKmlImportError('Vpišite GERK za vsako datoteko.'); return; }

  btn.disabled = true;
  let importedFiles = 0;
  const errors = [];
  try {
    for (const imp of pendingNewKmlImports) {
      const gerkCode = imp.gerkCode.trim();
      try {
        if (!(await confirmReplaceExistingSegmentation(gerkCode, type))) continue;

        const { data: segmentationId, error } = await supabase.rpc('import_gerk_segmentation', {
          p_gerk_id:    gerkCode,
          p_type:       type,
          p_valid_from: validFrom,
          p_segments:   imp.segments,
        });
        if (error) throw error;

        // Same Ha fallback as the detail-view import — gerk_segment.area_ha
        // is computed from the actual imported geometry, so a custom/
        // sub-divided code with no registry match still gets a real Ha
        // instead of showing nothing.
        const known = fields.find(f => f.code === gerkCode);
        let hectares = known?.area ?? null;
        const { data: segRows } = await supabase.from('gerk_segment').select('label, area_ha').eq('segmentation_id', segmentationId);
        if (!hectares) {
          const importedHa = (segRows || []).reduce((s, r) => s + (Number(r.area_ha) || 0), 0);
          if (importedHa > 0) hectares = importedHa;
        }
        const areaByLabel = new Map((segRows || []).map(r => [r.label, Number(r.area_ha) || null]));
        const row = ensureGerkRowForPaste(gerkCode, hectares);
        if (row) addGerkSegments(row, imp.segments.map(s => ({ fms: null, sampleNo: s.label, vzorcenje: null, areaHa: areaByLabel.get(s.label) ?? null })));

        importedFiles++;
      } catch (e) {
        errors.push(`${gerkCode || imp.file.name}: ${e.message || 'napaka'}`);
      }
    }

    if (type === 'vzorčenje' && globina && importedFiles) woBulkDepthSel.value = globina;

    if (errors.length) showNewKmlImportError(errors.join(' | '));
    if (importedFiles) cancelNewKmlImport(); // hides the form; errors (if any) stay visible below it
  } finally {
    btn.disabled = false;
  }
}

woNewImportZonesPickBtn.addEventListener('click', () => woNewKmlInput.click());
woNewKmlInput.addEventListener('change', () => onNewKmlFileSelected(woNewKmlInput));
woNewImportZonesType.addEventListener('change', updateNewImportZonesGlobinaVisibility);
woNewImportZonesCancelBtn.addEventListener('click', cancelNewKmlImport);
woNewImportZonesConfirmBtn.addEventListener('click', () => confirmNewKmlImport(woNewImportZonesConfirmBtn));

woGerkPasteBtn.addEventListener('click', () => {
  const entries = parseGerkPasteText(woGerkPasteInput.value);
  if (!entries.length) return;
  for (const { code, hectares, segments } of entries) {
    // Ha is only used as a fallback — the known field's own area (if
    // any) still wins, since that's the authoritative value once a
    // field exists; the pasted Ha only matters for a field that's
    // unknown, or known but missing an area.
    const known = fields.find(f => f.code === code);
    const row = ensureGerkRowForPaste(code, known?.area ?? hectares);
    if (segments && row) addGerkSegments(row, segments);
  }
  woGerkPasteInput.value = '';
});

// ── Seznam strank modal: open/close + list view ──────────────────
async function openDeclModal() {
  if (!customers.length) await loadCustomers();
  showModalAnimated(declModal);
  document.body.style.overflow = 'hidden'; // every other modal already locks background scroll — this one just hadn't
  showDeclList();
}

function closeDeclModal() {
  hideModalAnimated(declModal);
  document.body.style.overflow = '';
}

function showDeclList() {
  declListView.hidden = false;
  declDetailView.hidden = true;
  declListSearch.value = '';
  renderDeclCustomerList();
}

function renderDeclCustomerList() {
  const q = declListSearch.value.trim().toLowerCase();
  const scope = customers.filter(c => declShowDeletedActive ? c.deletedAt : !c.deletedAt);
  const matches = q ? scope.filter(c => c.name.toLowerCase().includes(q)) : scope;

  if (!matches.length) {
    declCustomerList.innerHTML = `<div class="state-empty"><p>${declShowDeletedActive ? 'Ni izbrisanih strank.' : 'Ni strank.'}</p></div>`;
    return;
  }

  declCustomerList.innerHTML = matches.map(c =>
    `<div class="decl-customer-row" data-id="${c.id}">${escHtml(c.name)}</div>`
  ).join('');

  declCustomerList.querySelectorAll('.decl-customer-row').forEach(row => {
    row.addEventListener('click', () => openDeclDetail(row.dataset.id));
  });
}

declListSearch.addEventListener('input', renderDeclCustomerList);
declBackBtn.addEventListener('click', showDeclList);

// Switches the "Seznam strank" list to archived (soft-deleted)
// customers instead of the normal list — mirrors woShowDeletedBtn.
function updateDeclShowDeletedButton() {
  declShowDeletedBtn.classList.toggle('wo-show-deleted-btn--active', declShowDeletedActive);
  declShowDeletedBtn.textContent = declShowDeletedActive ? '◀ Nazaj' : '🗑 Izbrisane';
  declShowDeletedBtn.title = declShowDeletedActive ? 'Nazaj na običajen seznam' : 'Prikaži arhivirane (izbrisane) stranke';
}

declShowDeletedBtn.addEventListener('click', () => {
  declShowDeletedActive = !declShowDeletedActive;
  updateDeclShowDeletedButton();
  renderDeclCustomerList();
});

// ── Seznam strank modal: one customer's detail view ──────────────
function openDeclDetail(customerId) {
  const customer = customers.find(c => c.id === customerId);
  if (!customer) return;

  declCustomerId = customerId;
  declListView.hidden = true;
  declDetailView.hidden = false;
  declLinkResult.hidden = true;

  const sub = [customer.contactName, customer.email].filter(Boolean).join(' · ');
  declCustomerInfo.innerHTML = `
    <p class="wo-order-label">${escHtml(customer.name)}</p>
    ${sub ? `<p class="decl-link-sub">${escHtml(sub)}</p>` : ''}`;

  declDeleteCustomerBtn.hidden  = !!customer.deletedAt;
  declRestoreCustomerBtn.hidden = !customer.deletedAt;

  loadDeclCustomerLinks();
  loadDeclCustomerTable();
}

// "Izbriši stranko" = archive (deleted_at), cascading to the
// customer's fields and work orders too (soft_delete_customer RPC) —
// same reversible pattern as softDeleteWorkOrders, just also touching
// fields/delovni_nalogi in one step since customers/fields have no
// write RLS policy of their own (see migration_soft_delete_customer.sql).
declDeleteCustomerBtn.addEventListener('click', async () => {
  if (!declCustomerId) return;
  if (!confirm('Izbrišem to stranko? Skupaj z njo se arhivirajo tudi njena polja in delovni nalogi — vse skupaj ne bo več vidno, dokler stranke ne obnovite.')) return;
  declDeleteCustomerBtn.disabled = true;
  const { error } = await supabase.rpc('soft_delete_customer', { p_customer_id: declCustomerId });
  declDeleteCustomerBtn.disabled = false;
  if (error) { alert('Napaka pri brisanju stranke: ' + error.message); return; }
  await Promise.all([loadCustomers(), loadFields(), loadWorkOrders()]);
  showDeclList();
});

declRestoreCustomerBtn.addEventListener('click', async () => {
  if (!declCustomerId) return;
  declRestoreCustomerBtn.disabled = true;
  const { error } = await supabase.rpc('restore_customer', { p_customer_id: declCustomerId });
  declRestoreCustomerBtn.disabled = false;
  if (error) { alert('Napaka pri obnavljanju stranke: ' + error.message); return; }
  await Promise.all([loadCustomers(), loadFields(), loadWorkOrders()]);
  showDeclList();
});

// ── Seznam strank modal: generate a customer link ────────────────
declGenerateBtn.addEventListener('click', async () => {
  if (!declCustomerId) return;
  const year = new Date().getFullYear();

  declGenerateBtn.disabled = true;
  const { data: token, error } = await supabase.rpc('create_field_declaration_link', {
    p_customer_id: declCustomerId,
    p_year: year,
  });
  declGenerateBtn.disabled = false;

  if (error) {
    declLinkResult.innerHTML = `<div class="alert alert-error">Napaka: ${escHtml(error.message)}</div>`;
    declLinkResult.hidden = false;
    return;
  }

  const url = new URL('deklaracija.html', location.href);
  url.searchParams.set('token', token);
  const customer = customers.find(c => c.id === declCustomerId);
  declLinkResult.innerHTML = `
    <div class="alert alert-success">
      Povezava ustvarjena.
      <button type="button" class="btn btn-secondary btn-sm" id="declCopyNewBtn">Kopiraj povezavo</button>
      ${customer?.email ? `<button type="button" class="btn btn-secondary btn-sm" id="declSendNewBtn" data-token="${token}">Pošlji e-pošto</button>` : ''}
    </div>`;
  declLinkResult.hidden = false;
  document.getElementById('declCopyNewBtn').addEventListener('click', () => navigator.clipboard.writeText(url.toString()));
  const sendNewBtn = document.getElementById('declSendNewBtn');
  if (sendNewBtn) wireSendEmailButton(sendNewBtn);
  loadDeclCustomerLinks();
});

// ── Deklaracije tab: send/resend the declaration email ───────────
function wireSendEmailButton(btn) {
  btn.addEventListener('click', async () => {
    const token = btn.dataset.token;
    btn.disabled = true;
    btn.textContent = 'Pošiljanje...';

    const { error } = await supabase.rpc('send_field_declaration_email', { p_token: token });

    if (error) {
      btn.title = `Napaka pri pošiljanju: ${error.message}`;
      btn.textContent = 'Napaka — poskusi znova';
      btn.disabled = false;
    } else {
      loadDeclCustomerLinks();
    }
  });
}

// ── Deklaracije tab: existing links list ─────────────────────────
async function loadDeclCustomerLinks() {
  const { data, error } = await supabase
    .from('customer_links')
    .select('*')
    .eq('customer_id', declCustomerId)
    .eq('purpose', 'field_declarations')
    .order('created_at', { ascending: false });

  if (error) { declLinksList.innerHTML = `<p class="state-empty-inline">Napaka pri nalaganju povezav.</p>`; return; }
  renderDeclLinks(data ?? []);
}

function renderDeclLinks(links) {
  if (!links.length) {
    declLinksList.innerHTML = `<p class="state-empty-inline">Za to stranko še ni ustvarjenih povezav.</p>`;
    return;
  }

  const customer = customers.find(c => c.id === declCustomerId);

  declLinksList.innerHTML = links.map(l => {
    const url = new URL('deklaracija.html', location.href);
    url.searchParams.set('token', l.token);
    const expired = l.expires_at && new Date(l.expires_at) < new Date();
    const created = new Date(l.created_at).toLocaleDateString('sl-SI');
    const lastUsed = l.last_used_at ? new Date(l.last_used_at).toLocaleDateString('sl-SI') : null;
    const emailSent = l.email_sent_at ? new Date(l.email_sent_at).toLocaleDateString('sl-SI') : null;

    return `
      <div class="decl-link-row">
        <div class="decl-link-meta">
          <strong>${l.year}</strong> · ${l.lang.toUpperCase()}
          ${expired ? '<span class="wo-status-badge wo-status--plan">Poteklo</span>' : ''}
          <div class="decl-link-sub">
            Ustvarjeno: ${created}${lastUsed ? ' · Zadnja uporaba: ' + lastUsed : ' · še ni uporabljeno'}
            ${emailSent ? ' · E-pošta poslana: ' + emailSent : ' · E-pošta še ni poslana'}
          </div>
        </div>
        <div class="decl-link-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-copy="${escHtml(url.toString())}">Kopiraj</button>
          ${customer?.email ? `<button type="button" class="btn btn-secondary btn-sm decl-send-btn" data-token="${l.token}">${emailSent ? 'Pošlji ponovno' : 'Pošlji e-pošto'}</button>` : ''}
          ${!expired ? `<button type="button" class="btn btn-danger btn-sm decl-revoke-btn" data-token="${l.token}">Prekliči</button>` : ''}
        </div>
      </div>`;
  }).join('');

  declLinksList.querySelectorAll('.decl-send-btn').forEach(wireSendEmailButton);
  declLinksList.querySelectorAll('.decl-revoke-btn').forEach(btn => {
    btn.addEventListener('click', () => revokeDeclLink(btn));
  });

  declLinksList.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => navigator.clipboard.writeText(btn.dataset.copy));
  });
}

// Soft-revoke, not delete — sets expires_at to now so the link stops
// working immediately, same as natural expiry, rather than removing
// the row (keeps the "created/last used" history intact).
async function revokeDeclLink(btn) {
  if (!confirm('Prekličem to povezavo?')) return;
  btn.disabled = true;
  try {
    const { error } = await supabase
      .from('customer_links')
      .update({ expires_at: new Date().toISOString() })
      .eq('token', btn.dataset.token);
    if (error) throw error;
    await loadDeclCustomerLinks();
  } catch (e) {
    btn.disabled = false;
  }
}

// ── Deklaracije tab: review table ────────────────────────────────
async function loadDeclCustomerTable() {
  const year = new Date().getFullYear();
  declTableWrap.innerHTML = `<div class="state-loading"><div class="spinner"></div><p>Nalaganje...</p></div>`;

  const [{ data: flds, error: fErr }, { data: decls, error: dErr }] = await Promise.all([
    supabase.from('fields').select('id, name, area_ha, cadastre_id').eq('customer_id', declCustomerId).order('name'),
    supabase.from('field_declarations').select('*').eq('customer_id', declCustomerId).eq('year', year),
  ]);

  if (fErr || dErr) { declTableWrap.innerHTML = `<div class="state-empty"><p>Napaka pri nalaganju.</p></div>`; return; }

  const byField = new Map((decls ?? []).map(d => [d.field_id, d]));
  const rows = (flds ?? []).map(f => ({ ...f, decl: byField.get(f.id) || null }));
  renderDeclTable(rows, year);
}

function renderDeclTable(rows, year) {
  if (!rows.length) {
    declTableWrap.innerHTML = `<p class="state-empty-inline">Ta stranka nima evidentiranih polj.</p>`;
    return;
  }

  const yn = (v) => (v === true ? 'Da' : v === false ? 'Ne' : '—');
  const body = rows.map(f => {
    const d = f.decl;
    const kolicina = d?.organic_fertilizer_amount != null
      ? `${d.organic_fertilizer_amount}${d.organic_fertilizer_unit ? ' ' + d.organic_fertilizer_unit : ''}`
      : '—';
    return `
      <tr>
        <td>${escHtml(f.name)}</td>
        <td>${escHtml(f.cadastre_id || '—')}</td>
        <td>${f.area_ha ?? '—'}</td>
        <td>${escHtml(d?.crop_current || '—')}</td>
        <td>${escHtml(d?.crop_next || '—')}</td>
        <td>${yn(d?.green_cover)}</td>
        <td>${yn(d?.straw_stays)}</td>
        <td>${d?.expected_yield_t_per_ha ?? '—'}</td>
        <td>${yn(d?.organic_fertilizer_used)}</td>
        <td>${escHtml(d?.organic_fertilizer_type || '—')}</td>
        <td>${kolicina}</td>
        <td>${d ? `<button type="button" class="btn btn-danger btn-sm decl-clear-btn" data-decl-id="${escHtml(d.id)}">Počisti</button>` : ''}</td>
      </tr>`;
  }).join('');

  declTableWrap.innerHTML = `
    <div class="decl-table-scroll">
      <table class="decl-table">
        <thead>
          <tr>
            <th>Polje</th><th>GERK</th><th>Ha</th>
            <th>Kultura ${year}</th><th>Kultura ${year + 1}</th>
            <th>Zel. gnojidba</th><th>Slama ostane</th><th>Prid. (t/ha)</th>
            <th>Org. gnojilo</th><th>Tip</th><th>Količina</th><th></th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;

  declTableWrap.querySelectorAll('.decl-clear-btn').forEach(btn => {
    btn.addEventListener('click', () => clearDeclaration(btn));
  });
}

// Deletes one field's submitted declaration for the year — admin
// correcting/resetting bad data the customer submitted, not something
// a customer can do themselves (they can only overwrite via the link).
async function clearDeclaration(btn) {
  if (!confirm('Počistim prijavljene podatke za to polje?')) return;
  btn.disabled = true;
  try {
    const { error } = await supabase.from('field_declarations').delete().eq('id', btn.dataset.declId);
    if (error) throw error;
    await loadDeclCustomerTable();
  } catch (e) {
    btn.disabled = false;
  }
}

// ── Work order modal (create only — there is no edit entry point) ──
async function openWorkOrderModal() {
  woModalTitle.textContent = 'Nov delovni nalog';
  workOrderForm.reset();
  woStrankaIdInput.value = '';
  hideWoFormFeedback();
  woStatusSel.value = 'Plan';
  woGerksListEl.innerHTML = '';
  woCustomerGerksWrap.hidden = true;
  woCustomerGerksList.innerHTML = '';
  woGerkPasteInput.value = '';
  woStevilkaLabel.textContent = 'Številka bo dodeljena samodejno ob shranjevanju';
  pendingNewKmlImports = [];
  woNewImportZonesForm.hidden = true;
  woNewImportZonesError.hidden = true;
  woNewImportZonesFiles.innerHTML = '';

  if (!customers.length) await loadCustomers();
  if (!operatorsList.length) await loadOperatorsList();

  addGerkRow(woGerksListEl);

  showModalAnimated(workOrderModal);
  document.body.style.overflow = 'hidden';
}

function closeWorkOrderModal() {
  hideModalAnimated(workOrderModal);
  document.body.style.overflow = '';
}

function hideWoFormFeedback() {
  woFormError.hidden   = true;
  woFormSuccess.hidden = true;
}

function showWoFormError(msg) {
  woFormError.textContent = msg;
  woFormError.hidden = false;
  woFormSuccess.hidden = true;
}

function showWoFormSuccess(msg) {
  woFormSuccess.textContent = msg;
  woFormSuccess.hidden = false;
  woFormError.hidden = true;
}

function setWoSaveLoading(on) {
  woSaveBtn.disabled   = on;
  woCancelBtn.disabled = on;
  woSaveBtn.querySelector('.btn-label').hidden   = on;
  woSaveBtn.querySelector('.btn-spinner').hidden = !on;
}

woAddGerkBtn.addEventListener('click', () => {
  const input = addGerkRow(woGerksListEl);
  input.focus();
});

workOrderForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideWoFormFeedback();

  const gerkRows = getFormGerks(woGerksListEl);

  if (!gerkRows.length) return showWoFormError('Dodajte vsaj en GERK.');

  // No numeric/7-digit format requirement — a GERK code is usually a
  // real registry number, but a field known only by a common name (not
  // in the official registry at all) is a plain string, and that's
  // valid too. It just won't have a known field to pull area/field_id/
  // map shapes from.
  for (const g of gerkRows) {
    const seen = new Set();
    for (const s of g.segments) {
      if (seen.has(s.sampleNo)) return showWoFormError(`GERK ${g.code}: podvojena št. segmenta "${s.sampleNo}".`);
      seen.add(s.sampleNo);
    }
  }

  setWoSaveLoading(true);

  const payload = {
    stranka_id:    woStrankaIdInput.value || null,
    izvajalec:     woIzvajalecSel.value || null,
    tip_storitve:  woTipSel.value || null,
    status:        woStatusSel.value,
    podrobnosti:   woPodrobnostiInput.value.trim() || null,
  };

  const { data, error: saveError } = await supabase.from('delovni_nalogi').insert(payload).select('id').single();
  const workOrderId = data?.id;

  if (saveError) {
    setWoSaveLoading(false);
    showWoFormError('Napaka pri shranjevanju. Preverite podatke in poskusite znova.');
    return;
  }

  // Resolve field_id per GERK scoped to this work order's own customer —
  // not the client-side `fields` array, which dedupes by code alone and
  // could resolve to the wrong customer if the same cadastre_id exists
  // under more than one (rare, but happened before this session's
  // customer dedup work). A code with no match yet (a brand new GERK)
  // just gets a null field_id — gerk_code is still the record of what
  // was actually entered.
  const { data: matchedFields } = await supabase
    .from('fields')
    .select('id, cadastre_id')
    .eq('customer_id', payload.stranka_id)
    .in('cadastre_id', gerkRows.map(g => g.code));
  const fieldIdByCode = Object.fromEntries((matchedFields || []).map(f => [f.cadastre_id, f.id]));

  // field_id deliberately left out of this insert — see the backfill
  // below. PostgREST's schema cache has been repeatedly, unpredictably
  // forgetting this specific column (confirmed via raw-Postgres EXPLAIN
  // that the column itself is always fine; a NOTIFY reload fixes it for
  // under two minutes before it reverts on its own), so keeping it out
  // of the one INSERT that MUST succeed for the order to save at all,
  // and treating its backfill as best-effort, stops that platform flake
  // from blocking work order creation entirely.
  const { data: insertedGerks, error: gerkError } = await supabase
    .from('delovni_nalogi_gerki')
    .insert(gerkRows.map(g => ({
      delovni_nalog_id: workOrderId,
      gerk_code:        g.code,
      kolicina_ha:      g.hectares,
      lokacija:         g.lokacija,
    })))
    .select('id, gerk_code');

  if (gerkError) {
    setWoSaveLoading(false);
    showWoFormError('Napaka pri shranjevanju GERKOV.');
    return;
  }

  // Best-effort field_id backfill (see note above) — a failure here
  // (same schema-cache flake) is swallowed rather than shown, since
  // nothing currently reads delovni_nalogi_gerki.field_id: the maps/
  // shapes RPCs key off gerk_code directly against gerk_polygon.
  for (const g of insertedGerks || []) {
    const fieldId = fieldIdByCode[g.gerk_code];
    if (!fieldId) continue;
    const { error } = await supabase.from('delovni_nalogi_gerki').update({ field_id: fieldId }).eq('id', g.id);
    if (error) console.warn('field_id backfill failed for', g.gerk_code, error);
  }

  // Segments (FMS + Sample no) pasted in from the lab's sheet — inserted
  // now that the GERK rows have real ids to hang off. gerk_code alone
  // would be ambiguous here (a code can repeat across other work
  // orders); every gerkIdByCode lookup below is scoped to the rows this
  // submit just created.
  const gerkIdByCode = Object.fromEntries((insertedGerks || []).map(g => [g.gerk_code, g.id]));
  const segmentRows = gerkRows.flatMap(g =>
    g.segments.map(s => ({
      delovni_nalog_gerk_id: gerkIdByCode[g.code],
      sample_no:     s.sampleNo,
      fms:           s.fms,
      sampling_note: s.vzorcenje || null,
      area_ha:       s.areaHa ?? null,
    }))
  );

  setWoSaveLoading(false);

  if (segmentRows.length) {
    const { error: segError } = await supabase.from('delovni_nalogi_vzorci').insert(segmentRows);
    if (segError) {
      showWoFormError('Nalog in GERKI so shranjeni, a segmenti niso — preverite jih v nalogu.');
      await loadWorkOrders();
      return;
    }

    // Globina applies to every segment on this order, once it's saved —
    // set now that the segments actually exist as real rows, rather
    // than baked into the insert above.
    if (woBulkDepthSel.value) {
      const gerkIds = Object.values(gerkIdByCode);
      const { error: depthError } = await supabase
        .from('delovni_nalogi_vzorci')
        .update({ sampling_depth_cm: parseInt(woBulkDepthSel.value, 10) })
        .in('delovni_nalog_gerk_id', gerkIds);
      if (depthError) console.warn('Bulk globina update failed', depthError);
    }
  }

  showWoFormSuccess('✓ Nalog shranjen!');
  await loadWorkOrders();
  setTimeout(closeWorkOrderModal, 1000);
});

woModalClose.addEventListener('click', closeWorkOrderModal);
woCancelBtn.addEventListener('click', closeWorkOrderModal);
workOrderModal.addEventListener('click', e => { if (e.target === workOrderModal) closeWorkOrderModal(); });

// ── Boot ───────────────────────────────────────────────────────
async function boot() {
  const authed = await initAuth();
  if (!authed) return;

  buildTimeOptions();
  renderMonthLabel();
  loadFields();

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role, organization')
    .eq('id', currentUser.id)
    .maybeSingle();

  const displayName = profile?.full_name ?? currentUser.email;
  currentRole = profile?.role ?? 'operator';
  currentOrg  = profile?.organization ?? null;
  currentUserName = displayName;
  operatorNameEl.textContent = displayName;
  if (currentRole === 'admin') {
    adminBadge.textContent = 'Admin';
    adminBadge.hidden = false;
  } else if (currentRole === 'supervisor') {
    adminBadge.textContent = 'Nadzornik';
    adminBadge.hidden = false;
  } else {
    adminBadge.hidden = true;
  }
  renderAdminViewToggle();
  renderGreeting(displayName);
  updateFabVisibility();
  updateShowDeletedButton();
  updateWoMapToggleButton();
  startLocationTracking();

  // Delovni Nalogi is the default visible tab now — load it first so the
  // user isn't staring at a spinner; Evidenca dela loads in the background
  // so switching to it later is instant.
  await loadWorkOrders();
  loadLogs();
}

boot();
