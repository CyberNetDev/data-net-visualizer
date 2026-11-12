// DHIS2 analytics: the values DHIS2 computes itself — indicators, program indicators, data element totals
// and reporting rates — per period and per organisation unit level.
//
// API used (checked against the DHIS2 source code, github.com/dhis2/dhis2-core: AnalyticsController,
// AggregateAnalyticsQueryCriteria, HeaderHandler, JdbcAnalyticsManager, ErrorCode, SystemInfo):
//   GET /api/analytics.json?dimension=dx:<items>&dimension=pe:<periods>&dimension=ou:LEVEL-<n>;<roots>
//       &includeNumDen=true&skipMeta=true
//     → { headers: [{name:'dx'}, {name:'pe'}, {name:'ou'}, {name:'value'}, {name:'numerator'},
//         {name:'denominator'}, …], rows: [["<uid>", "202401", "<org unit uid>", "87.4", …], …] }
//     dx items: indicator, program indicator or data element uid, or <dataSet uid>.REPORTING_RATE (…)
//     409 E7128: more rows than the server's "maximum number of analytics records" → the request is split.
//     409 on one item (broken expression, value type that cannot be aggregated…) → that item is skipped
//     and reported, the others are kept.
//   GET /api/indicatorGroups, /api/indicators, /api/programIndicators, /api/dataElementGroups, /api/dataSets
//   GET /api/system/info → lastAnalyticsTableSuccess: analytics values only change when DHIS2 rebuilds its
//     analytics tables; that date is what triggers a reload here (there is no "modified since" query).
//
// "Projects" are the period types (an indicator cannot be summed over periods, so the periodicity is chosen
// up front); "forms" are groups of data items; the "tables" are the organisation unit levels (an indicator
// cannot be summed over organisation units either): one row per data item × period × organisation unit.

const { httpError, memoize, enc } = require('./common');

const DX_CHUNK = Math.max(1, Number(process.env.DHIS2_ANALYTICS_ITEMS || 20)); // data items per request
const PE_CHUNK = 60; // periods per request (keeps the URL short)
const MAX_ITEMS = Math.max(1, Number(process.env.DHIS2_ANALYTICS_MAX_ITEMS || 500)); // data items per group
const MAX_ROWS = Math.max(1000, Number(process.env.DHIS2_ANALYTICS_MAX_ROWS || 300000));
const MAX_PERIODS = 400;
const MONTHS = Number(process.env.DHIS2_DEFAULT_MONTHS || 12);

// default window = what is loaded when no dates are chosen
const PERIODICITY = {
  'ana-mois': { name: 'Analytics · indicateurs par mois', hint: 'month', months: MONTHS },
  'ana-trimestre': { name: 'Analytics · indicateurs par trimestre', hint: 'quarter', months: MONTHS * 2 },
  'ana-annee': { name: 'Analytics · indicateurs par année', hint: 'year', months: MONTHS * 5 },
  'ana-semaine': { name: 'Analytics · indicateurs par semaine', hint: 'week', months: Math.ceil(MONTHS / 2) },
};
const GROUPS = {
  ig: 'Indicateurs', pi: 'Indicateurs de programme', deg: 'Éléments de données · totaux par groupe',
  ds: 'Éléments de données · totaux par ensemble de données', rr: 'Complétude des rapports',
};
const RATES = [
  ['REPORTING_RATE', 'reporting_rate', 'Taux de complétude (%)'],
  ['REPORTING_RATE_ON_TIME', 'reporting_rate_on_time', 'Taux de complétude à temps (%)'],
  ['ACTUAL_REPORTS', 'actual_reports', 'Rapports reçus'],
  ['ACTUAL_REPORTS_ON_TIME', 'actual_reports_on_time', 'Rapports reçus à temps'],
  ['EXPECTED_REPORTS', 'expected_reports', 'Rapports attendus'],
];
const AGGREGATABLE = new Set(['NUMBER', 'INTEGER', 'INTEGER_POSITIVE', 'INTEGER_NEGATIVE', 'INTEGER_ZERO_OR_POSITIVE', 'PERCENTAGE', 'UNIT_INTERVAL', 'BOOLEAN', 'TRUE_ONLY']);
// errors that concern the whole request (rights, org units, periods): retrying item by item is pointless
const REQUEST_ERRORS = new Set(['E7100', 'E7101', 'E7104', 'E7105', 'E7106', 'E7120', 'E7122', 'E7123', 'E7124', 'E7125', 'E7143']);

// ---------------------------------------------------------------- periods
// DHIS2 period codes covering [from, to] (a period is kept as soon as it overlaps the interval):
// "202401", "2024Q1", "2024", "2024W5" (ISO weeks, not zero-padded, like DHIS2 writes them)
function periodsOf(pid, q = {}, now = new Date()) {
  const P = PERIODICITY[pid];
  if (!P) return [];
  const day = s => new Date(`${s}T00:00:00Z`);
  const end = q.to ? day(q.to) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = q.from ? day(q.from) : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - P.months, 1));
  if (Number.isNaN(+start) || Number.isNaN(+end) || start > end) return [];
  const out = [];
  if (P.hint === 'week') {
    const monday = new Date(start.getTime() - ((start.getUTCDay() + 6) % 7) * 864e5);
    for (let t = monday.getTime(); t <= end.getTime(); t += 7 * 864e5) {
      const thursday = new Date(t + 3 * 864e5), y = thursday.getUTCFullYear(); // ISO 8601: the week belongs to the year of its Thursday
      out.push(`${y}W${Math.floor((thursday.getTime() - Date.UTC(y, 0, 1)) / (7 * 864e5)) + 1}`);
    }
  } else if (P.hint === 'year') {
    for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) out.push(String(y));
  } else {
    const step = P.hint === 'quarter' ? 3 : 1;
    const first = start.getUTCFullYear() * 12 + start.getUTCMonth(), last = end.getUTCFullYear() * 12 + end.getUTCMonth();
    for (let i = first - (first % step); i <= last; i += step) {
      const y = Math.floor(i / 12), m = i % 12;
      out.push(step === 3 ? `${y}Q${m / 3 + 1}` : `${y}${String(m + 1).padStart(2, '0')}`);
    }
  }
  return out;
}

const num = v => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// runs fn over the jobs, a few at a time (analytics queries are heavy for the DHIS2 server)
async function pool(jobs, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => { while (next < jobs.length) await fn(jobs[next++]); }));
}

module.exports = function analytics({ d2, userKey, dataSets, levels, orgUnits, placeOf, placeFields, labelOf, periodStart, META_MS }) {
  const fld = (path, type) => ({ path, name: path, type, selectMultiple: false, repeat: false });
  const byName = (a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'fr', { numeric: true, sensitivity: 'base' });
  // one list the account cannot read (or an older DHIS2 without it) must not hide the others
  const soft = p => p.catch(e => { if (e.relogin) throw e; return null; });

  // -------------------------------------------------------------- what can be analysed
  const catalog = sess => memoize(`${userKey(sess)}|ana|catalog`, async () => {
    const [igs, ind, pis, degs, dss] = await Promise.all([
      soft(d2(sess, '/api/indicatorGroups?fields=id,displayName&paging=false')),
      soft(d2(sess, '/api/indicators?fields=id&page=1&pageSize=1')),
      soft(d2(sess, '/api/programIndicators?fields=id,program[id,displayName]&paging=false')),
      soft(d2(sess, '/api/dataElementGroups?fields=id,displayName&paging=false')),
      soft(dataSets(sess)),
    ]);
    const out = [];
    const total = ind ? (ind.pager && ind.pager.total != null ? ind.pager.total : (ind.indicators || []).length) : 0;
    // groups first: the list opens on its first entry, and "all indicators" can be a heavy one
    for (const g of [...((igs && igs.indicatorGroups) || [])].sort(byName)) out.push({ id: `ig-${g.id}`, kind: 'ig', name: g.displayName });
    if (total > 0) out.push({ id: 'ig-all', kind: 'ig', name: total > MAX_ITEMS ? `Tous les indicateurs (les ${MAX_ITEMS} premiers sur ${total})` : `Tous les indicateurs (${total})` });
    const progs = new Map();
    for (const p of (pis && pis.programIndicators) || []) {
      if (!p.program || !p.program.id) continue;
      const x = progs.get(p.program.id) || { displayName: p.program.displayName || p.program.id, n: 0 };
      x.n++; progs.set(p.program.id, x);
    }
    for (const [id, x] of [...progs].sort((a, b) => byName(a[1], b[1]))) out.push({ id: `pi-${id}`, kind: 'pi', name: `${x.displayName} (${x.n})` });
    for (const g of [...((degs && degs.dataElementGroups) || [])].sort(byName)) out.push({ id: `deg-${g.id}`, kind: 'deg', name: g.displayName });
    for (const d of [...(dss || [])].sort(byName)) out.push({ id: `ds-${d.id}`, kind: 'ds', name: d.displayName });
    if (dss && dss.length) out.push({ id: 'rr', kind: 'rr', name: 'Taux de complétude des ensembles de données' });
    return out;
  }, META_MS);

  // -------------------------------------------------------------- data items of a group
  function structure(sess, fid) {
    return memoize(`${userKey(sess)}|ana|structure|${fid}`, async () => {
      const langs = new Set([sess.locale || '']);
      const TR = 'translations[locale,property,value]';
      const IND = `id,code,displayName,${TR},indicatorType[displayName]`;
      const DE = `id,code,displayName,displayFormName,valueType,domainType,aggregationType,${TR}`;
      const labels = { languages: [], defaultLang: sess.locale || '', fields: {}, choices: {} };
      const m = String(fid).match(/^(ig|pi|deg|ds)-(\w+)$/);
      let kind, dim, list = [], total = 0;

      if (fid === 'rr') {
        kind = 'rr'; dim = 'dataSet';
        list = [...await dataSets(sess)].sort(byName);
        total = list.length;
        list = list.slice(0, Math.max(1, Math.floor(MAX_ITEMS / RATES.length)));
        labels.choices.dataSet = Object.fromEntries(list.map(d => [d.id, { '': d.displayName }]));
        labels.fields = { dataSet: { '': 'Ensemble de données' }, period: { '': 'Période (code DHIS2)' }, ...Object.fromEntries(RATES.map(([, path, name]) => [path, { '': name }])) };
        labels.languages = [...langs];
        return { kind, dim, items: list, total, dx: list.flatMap(d => RATES.map(([k]) => `${d.id}.${k}`)), labels,
          fields: [fld('dataSet', 'string'), ...RATES.map(([, path]) => fld(path, 'decimal')), fld('period', 'string')] };
      }
      if (!m) { const e = httpError(404, 'Groupe analytics DHIS2 inconnu.'); e.notFound = true; throw e; }
      const aggregatable = d => d && d.id && d.domainType !== 'TRACKER' && AGGREGATABLE.has(d.valueType) && d.aggregationType !== 'NONE';
      if (m[1] === 'ig') {
        kind = 'indicators'; dim = 'indicator';
        if (m[2] === 'all') {
          const r = await d2(sess, `/api/indicators?fields=${IND}&order=displayName:asc&page=1&pageSize=${MAX_ITEMS}`);
          list = r.indicators || []; total = r.pager && r.pager.total != null ? r.pager.total : list.length;
        } else {
          list = (await d2(sess, `/api/indicatorGroups/${enc(m[2])}?fields=id,displayName,indicators[${IND}]`)).indicators || [];
          total = list.length;
        }
      } else if (m[1] === 'pi') {
        kind = 'programIndicators'; dim = 'indicator';
        list = (await d2(sess, `/api/programIndicators?filter=program.id:eq:${enc(m[2])}&fields=id,code,displayName,${TR}&paging=false`)).programIndicators || [];
        total = list.length;
      } else {
        kind = 'dataElements'; dim = 'dataElement';
        if (m[1] === 'deg') list = (await d2(sess, `/api/dataElementGroups/${enc(m[2])}?fields=id,displayName,dataElements[${DE}]`)).dataElements || [];
        else list = ((await d2(sess, `/api/dataSets/${enc(m[2])}?fields=id,displayName,dataSetElements[dataElement[${DE}]]`)).dataSetElements || []).map(x => x.dataElement);
        // text, dates, files… cannot be aggregated: DHIS2 would refuse the whole request (E7115)
        list = list.filter(aggregatable);
        total = list.length;
      }
      list = [...list].sort(byName).slice(0, MAX_ITEMS);
      labels.choices[dim] = Object.fromEntries(list.map(o => [o.id, labelOf(sess, o, langs)]));
      const fields = [fld(dim, 'string')];
      labels.fields[dim] = { '': kind === 'dataElements' ? 'Élément de données' : kind === 'programIndicators' ? 'Indicateur de programme' : 'Indicateur' };
      const types = new Map();
      if (kind === 'indicators') {
        for (const o of list) if (o.indicatorType && o.indicatorType.displayName) types.set(o.id, o.indicatorType.displayName);
        if (types.size) { fields.push(fld('indicator_type', 'string')); labels.fields.indicator_type = { '': 'Type d\'indicateur' }; }
      }
      fields.push(fld('value', 'decimal'));
      labels.fields.value = { '': 'Valeur' };
      if (kind === 'indicators') {
        fields.push(fld('numerator', 'decimal'), fld('denominator', 'decimal'));
        Object.assign(labels.fields, { numerator: { '': 'Numérateur' }, denominator: { '': 'Dénominateur' } });
      }
      fields.push(fld('period', 'string'));
      labels.fields.period = { '': 'Période (code DHIS2)' };
      labels.languages = [...langs];
      return { kind, dim, items: list, total, dx: list.map(o => o.id), types, labels, fields };
    }, META_MS);
  }

  // -------------------------------------------------------------- organisation unit levels = tables
  const tables = sess => memoize(`${userKey(sess)}|ana|tables`, async () => {
    let lv = await levels(sess);
    if (!lv.length) { // no level was ever named on this server: DHIS2 lists them with default names
      const r = await soft(d2(sess, '/api/filledOrganisationUnitLevels'));
      lv = (Array.isArray(r) ? r : (r && r.organisationUnitLevels) || []).filter(l => l && l.level).map(l => ({ level: l.level, displayName: l.displayName || l.name || '' })).sort((a, b) => a.level - b.level);
    }
    const roots = await orgUnits(sess, sess.roots || []);
    const top = Math.min(...[...roots.values()].map(o => o.level).filter(Boolean), Infinity);
    const first = Number.isFinite(top) ? top : 1;
    let list = lv.filter(l => l.level >= first);
    if (!list.length) list = [0, 1, 2, 3].map(k => ({ level: first + k, displayName: '' }));
    // opened on the level just under the user's own: small, and already a comparison between places
    const open = Math.min(1, list.length - 1);
    return list.map((l, i) => ({ id: `niveau${l.level}`, label: `Niveau ${l.level}${l.displayName ? ` · ${l.displayName}` : ''}`, variant: true, level: l.level, default: i === open }));
  }, META_MS);

  // -------------------------------------------------------------- queries
  // one analytics request; split on the server's row limit, and item by item when DHIS2 refuses an item
  async function query(sess, dx, pe, ouDim, numDen, skipped) {
    try {
      const g = await d2(sess, `/api/analytics.json?dimension=dx:${dx.map(enc).join(';')}&dimension=pe:${pe.join(';')}&dimension=ou:${ouDim}&skipMeta=true&displayProperty=NAME${numDen ? '&includeNumDen=true' : ''}`);
      skipped.ok = true;
      if (!g.rows || !g.rows.length) return [];
      const ix = Object.fromEntries((g.headers || []).map((h, i) => [h.name, i]));
      if (ix.dx == null || ix.pe == null || ix.ou == null || ix.value == null) throw httpError(502, 'Réponse analytics DHIS2 inattendue (colonnes dx, pe, ou ou value absentes).');
      return g.rows.map(r => ({ dx: r[ix.dx], pe: r[ix.pe], ou: r[ix.ou], value: num(r[ix.value]), numerator: ix.numerator == null ? null : num(r[ix.numerator]), denominator: ix.denominator == null ? null : num(r[ix.denominator]) }));
    } catch (e) {
      if (e.relogin || !e.d2status || e.d2status === 401 || e.d2status === 403 || e.d2status === 404) throw e;
      const halves = list => [list.slice(0, Math.ceil(list.length / 2)), list.slice(Math.ceil(list.length / 2))];
      const tooMany = e.d2code === 'E7128' || /exceeded max limit/i.test(e.message);
      if (!tooMany && REQUEST_ERRORS.has(e.d2code)) throw e;
      if (dx.length > 1) { const [a, b] = halves(dx); return [...await query(sess, a, pe, ouDim, numDen, skipped), ...await query(sess, b, pe, ouDim, numDen, skipped)]; }
      if (tooMany) {
        if (pe.length > 1) { const [a, b] = halves(pe); return [...await query(sess, dx, a, ouDim, numDen, skipped), ...await query(sess, dx, b, ouDim, numDen, skipped)]; }
        throw httpError(400, 'DHIS2 refuse cette requête : trop de valeurs pour une seule période à ce niveau (réglage « nombre maximal d\'enregistrements analytics » du serveur). Choisissez un niveau plus élevé.');
      }
      // this item cannot be computed (broken expression, no right on it…): the others are kept. When the
      // first items all fail and nothing has succeeded, the problem is not the items: stop there.
      skipped.set(dx[0], e.message);
      if (!skipped.ok && skipped.size >= 3) throw e;
      return [];
    }
  }

  const info = sess => memoize(`${userKey(sess)}|ana|info`, async () => {
    const i = await soft(d2(sess, '/api/system/info'));
    return i ? `${i.lastAnalyticsTableSuccess || ''}/${i.lastAnalyticsTablePartitionSuccess || ''}` : '';
  }, 60_000);

  async function load(sess, pid, fid, table, q) {
    const st = await structure(sess, fid);
    const level = Number((String(table).match(/^niveau(\d+)$/) || [])[1]);
    if (!level) throw httpError(404, 'Choisissez un niveau d\'unité d\'organisation (menu « Niveau »).');
    if (!(sess.roots || []).length) throw httpError(403, 'Votre compte DHIS2 n\'est rattaché à aucune unité d\'organisation.');
    const periods = periodsOf(pid, q);
    if (periods.length > MAX_PERIODS) throw httpError(400, `Trop de périodes demandées (${periods.length}) : réduisez l'intervalle de dates ou choisissez une périodicité plus large.`);
    if (!periods.length || !st.dx.length) return { rows: [], note: '' };
    const ouDim = `LEVEL-${level};${sess.roots.map(enc).join(';')}`;
    const jobs = [];
    for (let i = 0; i < st.dx.length; i += DX_CHUNK) for (let j = 0; j < periods.length; j += PE_CHUNK) jobs.push([st.dx.slice(i, i + DX_CHUNK), periods.slice(j, j + PE_CHUNK)]);
    const cells = [], skipped = new Map();
    await pool(jobs, 3, async ([dx, pe]) => {
      const part = await query(sess, dx, pe, ouDim, st.kind === 'indicators', skipped);
      for (const c of part) cells.push(c);
      if (cells.length > MAX_ROWS) throw httpError(400, `Trop de valeurs (plus de ${MAX_ROWS.toLocaleString('fr-FR')}) : choisissez un niveau plus élevé, moins de périodes ou un groupe plus petit.`);
    });
    if (skipped.size && skipped.size === st.dx.length) throw httpError(400, `DHIS2 n'a pu calculer aucun élément de ce groupe : ${[...skipped.values()][0]}`);

    const ous = await orgUnits(sess, [...new Set(cells.map(c => c.ou))]);
    const sysOf = new Map(); // pe|ou → shared metadata object
    const sys = c => {
      const k = `${c.pe}|${c.ou}`;
      let s = sysOf.get(k);
      if (!s) { s = { submissionDate: periodStart(c.pe) }; placeOf(s, ous.get(c.ou) || { displayName: c.ou }); sysOf.set(k, s); }
      return s;
    };
    let rows;
    if (st.kind === 'rr') {
      const paths = Object.fromEntries(RATES.map(([k, path]) => [k, path]));
      const map = new Map();
      for (const c of cells) {
        const cut = String(c.dx).lastIndexOf('.'), ds = String(c.dx).slice(0, cut), path = paths[String(c.dx).slice(cut + 1)];
        if (cut < 0 || !path) continue;
        const id = `${ds}|${c.pe}|${c.ou}`;
        let r = map.get(id);
        if (!r) { r = { __id: id, __system: sys(c), dataSet: ds, period: c.pe }; for (const [, p] of RATES) r[p] = null; map.set(id, r); }
        r[path] = c.value;
      }
      rows = [...map.values()];
    } else {
      rows = cells.map(c => {
        const r = { __id: `${c.dx}|${c.pe}|${c.ou}`, __system: sys(c), [st.dim]: c.dx, value: c.value, period: c.pe };
        if (st.kind === 'indicators') { if (st.types.size) r.indicator_type = st.types.get(c.dx) || null; r.numerator = c.numerator; r.denominator = c.denominator; }
        return r;
      });
    }
    // same order whatever the order in which the requests came back
    const order = new Map(periods.map((p, i) => [p, i]));
    rows.sort((a, b) => (order.get(a.period) ?? 1e9) - (order.get(b.period) ?? 1e9) || (a.__id < b.__id ? -1 : a.__id > b.__id ? 1 : 0));

    let note = '';
    if (skipped.size) {
      const names = [...skipped.keys()].map(id => { const o = st.items.find(x => id === x.id || String(id).startsWith(`${x.id}.`)); return o ? o.displayName : id; });
      const uniq = [...new Set(names)];
      note = `${uniq.length} élément(s) n'ont pas pu être calculés par DHIS2 et sont absents : ${uniq.slice(0, 5).join(', ')}${uniq.length > 5 ? '…' : ''} (${[...skipped.values()][0]})`;
      console.warn(`dhis2 analytics ${fid}: ${note}`);
    }
    if (st.total > st.items.length) note = `${note ? note + ' — ' : ''}Groupe limité à ses ${st.items.length} premiers éléments (sur ${st.total}).`;
    return { rows, note };
  }

  return {
    is: pid => Object.prototype.hasOwnProperty.call(PERIODICITY, pid),
    projects: () => Object.entries(PERIODICITY).map(([id, p]) => ({ id, name: p.name })),

    async forms(sess) {
      return (await catalog(sess)).map(f => ({
        id: f.id, name: f.name, group: GROUPS[f.kind], unit: 'valeurs', dates: 'Périodes du', tablesLabel: 'Niveau',
        hint: 'Ces valeurs sont calculées par DHIS2 pour le niveau choisi dans le menu « Niveau ». Pour un total ou un taux national, régional… choisissez ce niveau : la moyenne de plusieurs unités n\'est pas pondérée, et un taux ne s\'additionne pas.',
        // rates are averaged, counts are summed (an average over places is unweighted: the note of the help page)
        measure: f.kind === 'rr' ? { agg: 'avg', field: 'reporting_rate' } : { agg: f.kind === 'ig' ? 'avg' : 'sum', field: 'value' },
      }));
    },

    access: (sess, pid, fid) => structure(sess, fid),
    tables,

    async fields(sess, pid, fid) {
      const [st, lv] = await Promise.all([structure(sess, fid), levels(sess)]);
      return [...st.fields.map(f => ({ ...f })),
        { path: '__system/submissionDate', name: 'Période', type: 'date', system: true, group: 'Période', period: PERIODICITY[pid].hint },
        ...placeFields(lv)];
    },

    async labels(sess, pid, fid) { return (await structure(sess, fid)).labels; },

    source(sess, pid, fid, params) {
      const q = { from: params.from || '', to: params.to || '' };
      // (the memo spares a second download when several requests arrive together)
      const data = table => memoize(`${userKey(sess)}|ana|data|${pid}|${fid}|${table}|${q.from}|${q.to}`, () => load(sess, pid, fid, table, q), 10_000);
      return {
        fetch: async table => { const d = await data(table); return { rows: d.rows, filtered: true, note: d.note }; },
        // values change when DHIS2 rebuilds its analytics tables, or when a new period enters the default window
        rootSig: async () => { const pe = periodsOf(pid, q); return `analytics:${await info(sess)}:${pe[0] || ''}-${pe[pe.length - 1] || ''}`; },
        changedSince: async () => 0,
        count: null,
        delta: null,
        reloadReason: 'tables analytics DHIS2 mises à jour',
        fullRefreshHours: 12,
      };
    },
  };
};
module.exports.periodsOf = periodsOf; // (tests)
