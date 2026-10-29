// Gnojilni načrt — the fertilizer calculation itself, as pure functions (no
// DOM, no Supabase), so it can be tested directly against the Excel
// workbooks it replaces ("Kalkulacija <stranka>.xlsx", sheet "Izračun
// gnojila"; verified on 8 files / 164 segments, see project notes).
//
// Every number the calculation needs comes in through `params` / `lime` /
// `mapFactors` / `organic` — the plan's own copies (fert_plan_parameters,
// fert_plan_lime_ph, fert_plan_map_factor, fert_plan_organic), which start
// as the defaults from Nastavitve but can be changed per plan.

// Excel ROUND() rounds halves away from zero on the decimal value (5.85 → 5.9).
// Math.round(x * 10) / 10 gets that wrong for binary floats (5.85 * 10 =
// 58.49999…), so shift the decimal point through the string form instead.
export function roundHalfUp(value, decimals = 0) {
  const sign = value < 0 ? -1 : 1;
  const shifted = Math.round(Number(`${Math.abs(value)}e${decimals}`));
  return sign * Number(`${shifted}e-${decimals}`);
}

const num = v => (v == null || v === '' ? null : Number(v));

// Follow-up year ("Naslednje leto"): the soil is assumed to have moved one
// year of correction towards the target since sampling — P/K below target
// rise by (target − value) × correction_rate, pH below the cap rises by one
// step. Same as the Excel "zvišan P / zvišan K / povišan pH" columns.
export function raiseForFollowupYear(soil, params) {
  const p = num(soil.p2o5), k = num(soil.k2o), ph = num(soil.ph_kcl);
  const rate = num(params.correction_rate);
  const tp = num(params.target_p2o5), tk = num(params.target_k2o);
  return {
    p2o5: p == null ? null : (p > tp ? p : p + (tp - p) * rate),
    k2o: k == null ? null : (k > tk ? k : k + (tk - k) * rate),
    ph_kcl: ph == null ? null : (ph >= num(params.followup_ph_cap) ? ph : ph + num(params.followup_ph_step)),
  };
}

// Nutrient need (kg/ha) for one nutrient, before manure:
//   soil > high      : 0
//   soil > optimal   : reduced_factor × removal
//   soil > low       : removal
//   otherwise        : removal + (target − soil)/10 × correction_rate × soil_factor
// (/10 = mg/kg → mg/100 g; soil_factor = kg/ha per 1 mg/100 g)
export function nutrientNeed(soil, removal, { low, optimal, high, target }, params) {
  if (soil > high) return 0;
  if (soil > optimal) return num(params.reduced_factor) * removal;
  if (soil > low) return removal;
  return ((target - soil) / 10) * num(params.correction_rate) * num(params.soil_factor) + removal;
}

export function organicTotals(organic) {
  let p2o5 = 0, k2o = 0;
  for (const o of organic ?? []) {
    const amount = num(o.amount) ?? 0;
    p2o5 += amount * (num(o.p2o5_per_unit) ?? 0);
    k2o += amount * (num(o.k2o_per_unit) ?? 0);
  }
  return { p2o5, k2o };
}

// Range rows: { from, to } inclusive, null = open end.
function inRange(value, from, to) {
  return (from == null || value >= Number(from)) && (to == null || value <= Number(to));
}

export function limeForPh(ph, lime) {
  const rounded = roundHalfUp(ph, 1);
  const row = (lime ?? []).find(r => inRange(rounded, r.ph_from, r.ph_to));
  return row ? Number(row.kg_per_ha) : 0;
}

export function mapFactorFor(nutrient, soil, mapFactors) {
  const cls = roundHalfUp(soil / 10, 0);
  const row = (mapFactors ?? []).find(r => r.nutrient === nutrient && inRange(cls, r.class_from, r.class_to));
  return row ? Number(row.factor) : 1;
}

// One segment. `segment` carries the lab values ({ ph_kcl, p2o5, k2o }) and
// area_ha. Returns everything fert_plan_segment stores, plus `warning` when the
// segment can't be calculated.
export function calculateSegment(segment, { params, lime, mapFactors, organic, yieldTPerHa, isFollowupYear }) {
  const area = num(segment.area_ha);
  let soil = { ph_kcl: num(segment.ph_kcl), p2o5: num(segment.p2o5), k2o: num(segment.k2o) };
  const missing = [];
  if (soil.p2o5 == null) missing.push('P₂O₅');
  if (soil.k2o == null) missing.push('K₂O');
  if (soil.ph_kcl == null) missing.push('pH');
  if (missing.length) return { warning: `Manjka ${missing.join(', ')} — segment ni izračunan` };
  if (!area) return { warning: 'Manjka površina segmenta — segment ni izračunan' };
  if (yieldTPerHa == null || params.crop_p2o5_per_t == null || params.crop_k2o_per_t == null) {
    return { warning: 'Manjka pridelek ali odvzem kulture' };
  }
  if (isFollowupYear) soil = raiseForFollowupYear(soil, params);

  const removalP = num(yieldTPerHa) * num(params.crop_p2o5_per_t);
  const removalK = num(yieldTPerHa) * num(params.crop_k2o_per_t);
  const needP = nutrientNeed(soil.p2o5, removalP,
    { low: num(params.p_low_max), optimal: num(params.p_optimal_max), high: num(params.p_high_max), target: num(params.target_p2o5) }, params);
  const needK = nutrientNeed(soil.k2o, removalK,
    { low: num(params.k_low_max), optimal: num(params.k_optimal_max), high: num(params.k_high_max), target: num(params.target_k2o) }, params);
  const org = organicTotals(organic);
  const netP = Math.max(0, needP - org.p2o5);
  const netK = Math.max(0, needK - org.k2o);

  const pFertHa = num(params.p_fertilizer_content) ? netP / num(params.p_fertilizer_content) : null;
  const kFertHa = num(params.k_fertilizer_content) ? netK / num(params.k_fertilizer_content) : null;
  const limeHa = limeForPh(soil.ph_kcl, lime);   // table is already kg of the lime product per ha

  const pFactor = mapFactorFor('P2O5', soil.p2o5, mapFactors);
  const kFactor = mapFactorFor('K2O', soil.k2o, mapFactors);
  const pReal = pFertHa == null ? null : pFertHa * area;
  const kReal = kFertHa == null ? null : kFertHa * area;
  const limeReal = limeHa * area;

  return {
    used_ph_kcl: soil.ph_kcl, used_p2o5: soil.p2o5, used_k2o: soil.k2o,
    need_p2o5_kg_ha: netP, need_k2o_kg_ha: netK,
    p_fert_kg_ha: pFertHa, k_fert_kg_ha: kFertHa, lime_kg_ha: limeHa,
    p_fert_real_kg: pReal, k_fert_real_kg: kReal, lime_real_kg: limeReal,
    p_map_factor: pFactor, k_map_factor: kFactor,
    p_fert_map_kg: pReal == null ? null : pReal * pFactor,
    k_fert_map_kg: kReal == null ? null : kReal * kFactor,
    lime_map_kg: limeReal,
    warning: null,
  };
}

// Report sentence from the organic fertilizer entries, e.g.
// "Izračun potrebnega gnojenja vključuje uporabo goveje gnojevke v količini 33 m3/ha."
// (the wording used in the Excel workbooks' Sheet1 "General comment for the field").
const GENITIVE = { 'goveja gnojevka': 'goveje gnojevke', 'goveji gnoj': 'govejega gnoja' };
export function reportText(organic) {
  const parts = (organic ?? [])
    .filter(o => num(o.amount))
    .map(o => `${GENITIVE[String(o.name).toLowerCase()] ?? String(o.name).toLowerCase()} v količini ${String(roundHalfUp(num(o.amount), 2)).replace('.', ',')} ${o.unit}`);
  if (!parts.length) return 'Izračun potrebnega gnojenja ne vključuje organskih gnojil.';
  return `Izračun potrebnega gnojenja vključuje uporabo ${parts.join(' ter ')}.`;
}
