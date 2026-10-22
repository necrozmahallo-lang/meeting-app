// POST /api/summarise
// Verifies the user's login, enforces consent and a daily limit, then asks a paid AI model
// (through OpenRouter, with training/retention opt-out) to write the record. The API key never
// reaches the browser. Notes, photos and results are not logged or stored here.

const SYSTEM = [
  'You are an expert assistant for private bankers. Turn raw meeting input into a complete, accurate and detailed client record.',
  '',
  'INPUT: typed or spoken notes (spoken notes may contain transcription errors, so fix obvious ones using context) and sometimes photos of whiteboards or handwritten notes. If photos are attached, read them carefully and include everything they show. If no photos are attached, never mention photos at all.',
  '',
  'Return ONLY one JSON object with exactly these keys:',
  '- summary (string): a detailed summary in 2 to 4 short paragraphs (roughly 150 to 300 words when the input allows). Cover the context, what the client said, their concerns and preferences, what was explained or advised, decisions made, and agreed next steps. Keep every specific detail exactly as given: names, amounts, percentages, dates, products, deadlines and units (for example 5 crore). Never generalise a specific detail into a vague one.',
  '- key_points (array of strings): every distinct point, one per item, each specific and self-contained.',
  '- action_items (array of strings): every commitment, each with the owner if known and a due date in YYYY-MM-DD format when stated or clearly implied.',
  '- new_status (string), next_steps (string), follow_up_date (string, YYYY-MM-DD, empty if none). Work out relative dates from the date given in the input.',
  '- fields (object): used to fill the client\'s spreadsheet row (rules below). Keys are column headers, values are strings.',
  '- unsure_fields (array of strings): column headers you left empty because the meeting did not say, filled with low confidence, or guessed. Empty array only if every column is clearly supported.',
  '',
  'SPREADSHEET RULES',
  'The input may include the layout of the client\'s own spreadsheet as JSON: headers, a profile for each column (type, format example, allowed values, typical length, multi-value separator), example rows, and the ID column. Study it closely before writing.',
  '1. For every column except the ID column, decide what part of the meeting belongs there from the meaning of the header and from what the example rows contain, not just similar wording. Put each fact in the single column that fits best. Do not repeat the same text in several columns unless the header calls for it.',
  '2. Respect each column\'s type. Write dates in exactly the same format as the examples. Write numbers in the same units and format. For category columns, use one of the allowed values only when the meeting clearly supports it. When the column describes something the meeting does not state (relationship manager, tier, segment, owner, rating), leave it empty and list it in unsure_fields. Never guess, and never default to the most common example value.',
  '3. Read date headers by meaning. A column about the next meeting, next touchpoint, next review or next call holds the date of the next scheduled meeting or call. Use the earliest committed follow-up date only if no meeting is scheduled. Deadlines for tasks belong in action columns only. A column about the last meeting or last touchpoint holds the date of this meeting, which is today unless the notes say otherwise.',
  '4. Match the style and length of each column. Short-label columns get short labels. Columns that hold sentences, notes, discussion or summaries should be written in full, detailed sentences that keep the specifics.',
  '5. For multi-value columns use the same separator and numbering style as the examples.',
  '6. Compliance, remark and comment columns describe only what actually happened in this meeting. Example rows show wording style only: never reuse their sentences or boilerplate unless the meeting supports every word.',
  '7. Never invent facts. If the meeting contains nothing for a column, use an empty string. Never copy values from the example rows as facts about this meeting.',
  '8. If no layout is given, use the keys Status, Notes (detailed), Next Steps, Follow-up Date.',
  '',
  'Before answering, check every column value: it must be supported by the meeting, copied exactly for numbers and dates, and nothing may come from the example rows. Use only facts that appear in the notes or photos.'
].join('\n');

const bad = (res, code, msg) => res.status(code).json({ error: msg });
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

function cleanSheet(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const headers = (Array.isArray(raw.headers) ? raw.headers : []).slice(0, 60).map(h => str(h, 80)).filter(Boolean);
  if (!headers.length) return null;
  const idColumn = headers.includes(raw.idColumn) ? raw.idColumn : headers[0];
  const profile = (Array.isArray(raw.profile) ? raw.profile : []).slice(0, 60).map(p => {
    const q = { column: str(p && p.column, 80), type: str(p && p.type, 40) };
    if (p && p.example != null) q.example = str(p.example, 160);
    if (p && Array.isArray(p.allowedValues)) q.allowedValues = p.allowedValues.slice(0, 8).map(v => str(v, 60));
    if (p && p.averageLength != null) q.averageLength = Number(p.averageLength) || 0;
    if (p && p.multiValueSeparator) q.multiValueSeparator = str(p.multiValueSeparator, 60);
    return q;
  });
  const samples = (Array.isArray(raw.samples) ? raw.samples : []).slice(0, 8).map(r => {
    const o = {}; headers.forEach(h => { o[h] = str(r && r[h], 300); }); return o;
  });
  return { headers, idColumn, profile, samples };
}

// ---- tidy-up applied to the model's answer (dates in the sheet's own format, no copied text) ----
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const p2 = n => String(n).padStart(2, '0');
const monthIndex = name => MON.findIndex(x => name.toLowerCase().indexOf(x.toLowerCase()) === 0);
function parseDate(v) {
  v = String(v || '').trim(); let m;
  m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/); if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  m = v.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,]*(\d{4})$/); if (m && monthIndex(m[2]) >= 0) return { y: +m[3], m: monthIndex(m[2]) + 1, d: +m[1] };
  m = v.match(/^([A-Za-z]{3,9})[- ](\d{4})$/); if (m && monthIndex(m[1]) >= 0) return { y: +m[2], m: monthIndex(m[1]) + 1, d: null };
  return null;
}
function formatDate(dt, ex) {
  let m; const d = dt.d || 1;
  if (/^\d{4}-\d{2}-\d{2}$/.test(ex)) return dt.y + '-' + p2(dt.m) + '-' + p2(d);
  m = ex.match(/^(\d{1,2})([\/.-])(\d{1,2})[\/.-](\d{4})$/); if (m) return p2(d) + m[2] + p2(dt.m) + m[2] + dt.y;
  m = ex.match(/^(\d{1,2})([- ])([A-Za-z]{3,9})([- ])(\d{4})$/); if (m) return (m[1].length === 2 ? p2(d) : String(d)) + m[2] + (m[3].length > 3 ? FULL[dt.m - 1] : MON[dt.m - 1]) + m[4] + dt.y;
  m = ex.match(/^([A-Za-z]{3,9})([- ])(\d{4})$/); if (m) return (m[1].length > 3 ? FULL[dt.m - 1] : MON[dt.m - 1]) + m[2] + dt.y;
  return null;
}
const toArr = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : String(v || '').split(/\n|(?<=[.;])\s+(?=[A-Z])/).map(x => x.trim()).filter(Boolean);

function tidy(out, sheet, clientId) {
  const res = {
    summary: str(out.summary, 6000), key_points: toArr(out.key_points).slice(0, 60), action_items: toArr(out.action_items).slice(0, 60),
    new_status: str(out.new_status, 200), next_steps: str(out.next_steps, 1000), follow_up_date: str(out.follow_up_date, 40)
  };
  let f = out.fields && typeof out.fields === 'object' && !Array.isArray(out.fields) ? out.fields : {};
  const unsure = new Set(toArr(Array.isArray(out.unsure_fields) ? out.unsure_fields : String(out.unsure_fields || '').split(',')));
  const clean = {};
  if (sheet) {
    sheet.headers.filter(h => h !== sheet.idColumn).forEach(h => { clean[h] = str(f[h], 4000); });
    const examples = sheet.samples.filter(sm => String(sm[sheet.idColumn] || '') !== String(clientId));
    sheet.profile.forEach(p => {
      if (p.type === 'date' && p.example && clean[p.column]) {
        const dt = parseDate(clean[p.column]); const r = dt ? formatDate(dt, p.example) : null; if (r) clean[p.column] = r;
      }
      if (p.type === 'text' && clean[p.column]) {
        let val = clean[p.column], changed = false;
        examples.forEach(sm => String(sm[p.column] || '').split(/(?<=[.;])\s+|\s*\d\)\s*/).map(x => x.trim()).filter(x => x.length >= 12).forEach(piece => {
          if (val.indexOf(piece) >= 0) { val = val.split(piece).join(''); changed = true; }
        }));
        if (changed) { clean[p.column] = val.replace(/\s*\d\)\s*(?=\d\)|$)/g, ' ').replace(/\s{2,}/g, ' ').trim(); unsure.add(p.column); }
      }
    });
  } else {
    ['Status', 'Notes', 'Next Steps', 'Follow-up Date'].forEach(h => { clean[h] = str(f[h], 4000); });
  }
  res.fields = clean;
  res.unsure_fields = Array.from(unsure).join(', ');
  return res;
}

function parseJson(text) {
  const s = String(text || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

// Free models: some reject the JSON setting, and none can promise "no data collection".
// So those two settings are only sent for paid models. The answer is still parsed as JSON either way.
function isFree(model) { return /:free$/.test(model) || model === 'openrouter/free'; }

async function askModel(apiKey, userContent, model, timeoutMs) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'X-Title': 'Meeting notes app' },
      body: JSON.stringify(Object.assign({
        model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userContent }],
        temperature: 0.2, max_tokens: 4000
      }, isFree(model) ? {} : { response_format: { type: 'json_object' }, provider: { data_collection: 'deny' } },
         /gpt-oss/.test(model) ? { reasoning: { effort: 'low' } } : {}))
    });
    if (!r.ok) throw new Error('model status ' + r.status);
    const d = await r.json();
    return parseJson(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
  } finally { clearTimeout(timer); }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed.');
  const { SUPABASE_URL, SUPABASE_ANON_KEY, OPENROUTER_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !OPENROUTER_API_KEY) return bad(res, 500, 'The server is not configured yet.');

  // 1. Who is calling?
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return bad(res, 401, 'Please sign in.');
  const auth = { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY };
  let user;
  try {
    const ur = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: auth });
    if (!ur.ok) return bad(res, 401, 'Your session has expired. Please sign in again.');
    user = await ur.json();
  } catch (e) { return bad(res, 503, 'Could not verify your login. Try again.'); }
  if (!user || !user.id) return bad(res, 401, 'Please sign in.');

  // 2. Consent on record?
  try {
    const cr = await fetch(SUPABASE_URL + '/rest/v1/consents?select=version&limit=1', { headers: auth });
    const rows = cr.ok ? await cr.json() : [];
    if (!rows.length) return bad(res, 403, 'Please accept the terms first.');
  } catch (e) { return bad(res, 503, 'Could not check your account. Try again.'); }

  // 3. Daily limit (counted per user, enforced by the database rules)
  const limit = parseInt(process.env.DAILY_LIMIT || '40', 10);
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const lr = await fetch(SUPABASE_URL + '/rest/v1/usage_log?select=id&created_at=gte.' + encodeURIComponent(since),
      { headers: Object.assign({ Prefer: 'count=exact', Range: '0-0' }, auth) });
    const total = parseInt(String(lr.headers.get('content-range') || '').split('/')[1] || '0', 10);
    if (total >= limit) return bad(res, 429, 'You have reached today\'s limit. Try again tomorrow.');
    await fetch(SUPABASE_URL + '/rest/v1/usage_log', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }, auth), body: '{}' });
  } catch (e) { return bad(res, 503, 'Could not check your usage. Try again.'); }

  // 4. Validate input
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const clientId = str(b.clientId, 64).trim();
  const notes = str(b.notes, 15000);
  const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 4).filter(p => typeof p === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p));
  const sheet = cleanSheet(b.sheet);
  if (!clientId) return bad(res, 400, 'Enter the client ID.');
  if (!notes.trim() && !photos.length) return bad(res, 400, 'There is nothing to summarise yet.');
  if (photos.reduce((a, p) => a + p.length, 0) > 3500000) return bad(res, 413, 'The photos are too large. Use fewer or smaller photos.');

  // 5. Ask the model (one retry if the answer is not valid JSON)
  const today = new Date().toISOString().slice(0, 10);
  const text = 'Today\'s date: ' + today + '\nClient ID: ' + clientId + '\n\nMeeting notes:\n' + notes +
    '\n\nClient\'s spreadsheet layout (JSON, may be empty):\n' + JSON.stringify(sheet || {});
  const content = [{ type: 'text', text }].concat(photos.map(url => ({ type: 'image_url', image_url: { url } })));
  try {
    const textModel = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
    const model = photos.length && process.env.OPENROUTER_VISION_MODEL ? process.env.OPENROUTER_VISION_MODEL : textModel;
    // Vercel stops the function at 60 seconds, so keep everything inside a 56 second budget.
    const t0 = Date.now(), budget = 56000;
    let out = null, firstErr = null;
    try { out = await askModel(OPENROUTER_API_KEY, content, model, 46000); } catch (e1) { firstErr = e1; console.error('first try failed:', e1 && e1.message); }
    const left = budget - (Date.now() - t0);
    if (!out && left > 12000) out = await askModel(OPENROUTER_API_KEY, content, model, left - 2000);
    if (!out && firstErr) throw firstErr;
    if (!out) return bad(res, 502, 'The AI did not return a usable answer. Please try again.');
    return res.status(200).json(Object.assign({ clientId }, tidy(out, sheet, clientId)));
  } catch (e) {
    const m = String((e && e.message) || ''), st = (m.match(/model status (\d+)/) || [])[1];
    console.error('summarise failed:', m);
    let why = 'The AI service is busy. Please try again in a moment.';
    if (st === '401' || st === '403') why = 'The AI key was rejected (' + st + '). Check OPENROUTER_API_KEY in Vercel.';
    else if (st === '402') why = 'The AI account has no credit for this model (402). Use a free model or add credit.';
    else if (st === '404') why = 'That AI model is not available (404). Change OPENROUTER_MODEL, for example to openrouter/free.';
    else if (st === '429') why = 'The free AI limit was reached (429). Wait a few minutes, or switch the model.';
    else if (st) why = 'The AI service returned an error (' + st + '). Try again, or change the model.';
    else if (/abort/i.test(m)) why = 'The AI took too long to answer. Try shorter notes, or switch the model.';
    return bad(res, 502, why);
  }
};
