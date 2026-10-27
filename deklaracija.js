import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const LOGO_URL = 'https://proagrar.si/assets/img/Proagrar_LOGO2026-14.png';

const LABELS = {
  sl: {
    title: 'Napoved kultur',
    submit: 'Shrani',
    saving: 'Shranjujem…',
    success: 'Podatki so bili uspešno shranjeni. Hvala!',
    error: 'Prišlo je do napake pri shranjevanju. Poskusite znova.',
    empty: 'Za vas trenutno ni evidentiranih polj.',
    yes: 'Da',
    no: 'Ne',
    dash: '—',
    greenCover: 'Zelena gnojidba',
    strawStays: 'Slama ostane na polju',
    expectedYield: 'Pričakovan pridelek (t/ha)',
    organicFertilizerUsed: 'Organsko gnojilo',
    organicFertilizerType: 'Tip gnojila',
    organicFertilizerAmount: 'Količina',
    organicFertilizerUnit: 'Enota',
    cropCurrent: (y) => `Kultura ${y}`,
    cropNext: (y) => `Kultura ${y + 1}`,
  },
  hr: {
    title: 'Prijava kultura',
    submit: 'Spremi',
    saving: 'Spremam…',
    success: 'Podaci su uspješno spremljeni. Hvala!',
    error: 'Došlo je do pogreške prilikom spremanja. Pokušajte ponovno.',
    empty: 'Za vas trenutno nema evidentiranih polja.',
    yes: 'Da',
    no: 'Ne',
    dash: '—',
    greenCover: 'Zelena gnojidba',
    strawStays: 'Slama ostaje na polju',
    expectedYield: 'Očekivani prinos (t/ha)',
    organicFertilizerUsed: 'Organsko gnojivo',
    organicFertilizerType: 'Tip gnojiva',
    organicFertilizerAmount: 'Količina',
    organicFertilizerUnit: 'Jedinica',
    cropCurrent: (y) => `Kultura ${y}`,
    cropNext: (y) => `Kultura ${y + 1}`,
  },
};

const root = document.getElementById('root');
const token = new URLSearchParams(location.search).get('token');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function renderInvalidLink() {
  root.innerHTML = `
    <div class="decl-error-full">
      Neveljavna ali potekla povezava. Prosimo, obrnite se na Proagrar za novo povezavo.<br><br>
      Nevažeća ili istekla poveznica. Molimo obratite se Proagraru za novu poveznicu.
    </div>`;
}

function yesNoSelect(key, value, t) {
  return `
    <select class="field-select" data-key="${key}">
      <option value="">${t.dash}</option>
      <option value="true" ${value === true ? 'selected' : ''}>${t.yes}</option>
      <option value="false" ${value === false ? 'selected' : ''}>${t.no}</option>
    </select>`;
}

function fieldCardHtml(f, year, t) {
  const meta = [f.cadastre_id, f.area_ha != null ? `${f.area_ha} ha` : null].filter(Boolean).join(' · ');
  return `
    <div class="field-card" data-field-id="${f.field_id}">
      <div class="field-card-header">
        <span>${escapeHtml(f.name)}</span>
        <span class="gerk-meta">${escapeHtml(meta)}</span>
      </div>
      <div class="field-card-grid">
        <div class="field">
          <label class="field-label">${t.cropCurrent(year)}</label>
          <input class="field-input" data-key="crop_current" type="text" value="${escapeHtml(f.crop_current)}" />
        </div>
        <div class="field">
          <label class="field-label">${t.cropNext(year)}</label>
          <input class="field-input" data-key="crop_next" type="text" value="${escapeHtml(f.crop_next)}" />
        </div>
        <div class="field">
          <label class="field-label">${t.greenCover}</label>
          ${yesNoSelect('green_cover', f.green_cover, t)}
        </div>
        <div class="field">
          <label class="field-label">${t.strawStays}</label>
          ${yesNoSelect('straw_stays', f.straw_stays, t)}
        </div>
        <div class="field">
          <label class="field-label">${t.expectedYield}</label>
          <input class="field-input" data-key="expected_yield_t_per_ha" type="number" step="0.01" min="0" value="${f.expected_yield_t_per_ha ?? ''}" />
        </div>
        <div class="field">
          <label class="field-label">${t.organicFertilizerUsed}</label>
          ${yesNoSelect('organic_fertilizer_used', f.organic_fertilizer_used, t)}
        </div>
        <div class="field">
          <label class="field-label">${t.organicFertilizerType}</label>
          <input class="field-input" data-key="organic_fertilizer_type" type="text" value="${escapeHtml(f.organic_fertilizer_type)}" />
        </div>
        <div class="field">
          <label class="field-label">${t.organicFertilizerAmount}</label>
          <input class="field-input" data-key="organic_fertilizer_amount" type="number" step="0.01" min="0" value="${f.organic_fertilizer_amount ?? ''}" />
        </div>
        <div class="field">
          <label class="field-label">${t.organicFertilizerUnit}</label>
          <select class="field-select" data-key="organic_fertilizer_unit">
            <option value="">${t.dash}</option>
            <option value="t/ha" ${f.organic_fertilizer_unit === 't/ha' ? 'selected' : ''}>t/ha</option>
            <option value="m3/ha" ${f.organic_fertilizer_unit === 'm3/ha' ? 'selected' : ''}>m3/ha</option>
          </select>
        </div>
      </div>
    </div>`;
}

function render(data) {
  const t = LABELS[data.lang] || LABELS.sl;
  document.documentElement.lang = data.lang;
  document.title = `${t.title} — ${data.customer_name}`;

  const body = data.fields.length
    ? `
      <form id="declForm">
        ${data.fields.map((f) => fieldCardHtml(f, data.year, t)).join('')}
        <div class="decl-submit-bar">
          <button type="submit" class="btn btn-primary btn-block" id="submitBtn">
            <span class="btn-label">${t.submit}</span>
          </button>
        </div>
        <div id="declSuccess" class="alert alert-success" hidden role="status"></div>
        <div id="declError" class="alert alert-error" hidden role="alert"></div>
      </form>`
    : `<div class="decl-empty">${t.empty}</div>`;

  root.innerHTML = `
    <div class="decl-header">
      <img src="${LOGO_URL}" alt="Proagrar" width="160" height="54" />
      <h1 class="decl-title">${t.title}</h1>
      <p class="decl-sub">${escapeHtml(data.customer_name)} · ${data.year}</p>
    </div>
    ${body}`;

  const form = document.getElementById('declForm');
  if (form) form.addEventListener('submit', (e) => onSubmit(e, t));
}

async function onSubmit(e, t) {
  e.preventDefault();
  const submitBtn = document.getElementById('submitBtn');
  const successEl = document.getElementById('declSuccess');
  const errorEl = document.getElementById('declError');

  successEl.hidden = true;
  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.querySelector('.btn-label').textContent = t.saving;

  const toBool = (v) => (v === '' ? null : v === 'true');
  const toNum = (v) => (v === '' ? null : Number(v));

  const declarations = Array.from(document.querySelectorAll('.field-card')).map((card) => {
    const get = (key) => card.querySelector(`[data-key="${key}"]`).value;
    return {
      field_id: card.dataset.fieldId,
      crop_current: get('crop_current') || null,
      crop_next: get('crop_next') || null,
      green_cover: toBool(get('green_cover')),
      straw_stays: toBool(get('straw_stays')),
      expected_yield_t_per_ha: toNum(get('expected_yield_t_per_ha')),
      organic_fertilizer_used: toBool(get('organic_fertilizer_used')),
      organic_fertilizer_type: get('organic_fertilizer_type') || null,
      organic_fertilizer_amount: toNum(get('organic_fertilizer_amount')),
      organic_fertilizer_unit: get('organic_fertilizer_unit') || null,
    };
  });

  const { error } = await supabase.rpc('submit_field_declarations', {
    p_token: token,
    p_declarations: declarations,
  });

  submitBtn.disabled = false;
  submitBtn.querySelector('.btn-label').textContent = t.submit;

  if (error) {
    errorEl.textContent = t.error;
    errorEl.hidden = false;
  } else {
    successEl.textContent = t.success;
    successEl.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

async function init() {
  if (!token) {
    renderInvalidLink();
    return;
  }

  const { data, error } = await supabase.rpc('get_field_declaration_form', { p_token: token });

  if (error || !data) {
    renderInvalidLink();
    return;
  }

  render(data);
}

init();
