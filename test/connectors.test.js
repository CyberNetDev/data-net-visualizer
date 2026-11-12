// npm test — unit tests of the record normalisation + end-to-end tests of the IASO, CommCare, DHIS2 and
// mSupply connectors against the simulators (test/sim-*.js), through the real server (no network needed).
// The mSupply simulator needs the "graphql" dev dependency: run "npm install" once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Schema, explode, descriptorSchema } = require('../connectors/records');
const { toGeoPoint } = require('../connectors/common');
const { extractFields } = require('../xform');
const { periodStart, periodsOf } = require('../connectors/dhis2');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

test('geopoints become GeoJSON like ODK Central', () => {
  assert.deepEqual(toGeoPoint('12.5 -1.25 300 4'), { type: 'Point', coordinates: [-1.25, 12.5, 300], properties: { accuracy: 4 } });
  assert.deepEqual(toGeoPoint({ '#text': '1 2' }), { type: 'Point', coordinates: [2, 1] });
  assert.equal(toGeoPoint(''), null);
  assert.equal(toGeoPoint('0 0'), null);
});

test('XForm and pyxform descriptor give the same fields', () => {
  const a = extractFields(fs.readFileSync(path.join(FIX, 'menage.xml'), 'utf8')).filter(f => f.name !== 'merci');
  const b = descriptorSchema(JSON.parse(fs.readFileSync(path.join(FIX, 'menage.descriptor.json'), 'utf8'))).fields;
  assert.deepEqual(a.map(f => [f.path, f.type, f.selectMultiple, f.repeat]), b.map(f => [f.path, f.type, f.selectMultiple, f.repeat]));
});

test('explode: groups nested, repeats as child tables, single-entry repeat object', () => {
  const schema = new Schema([
    { path: 'g/n', name: 'n', type: 'int' }, { path: 'r', name: 'r', type: 'repeat', repeat: true },
    { path: 'r/x', name: 'x', type: 'decimal' }, { path: 'r/s', name: 's', type: 'repeat', repeat: true }, { path: 'r/s/y', name: 'y', type: 'string' },
  ]);
  const t = explode('A', { g: { n: '3' }, r: { x: '1.5', s: [{ y: 'a' }, { y: '' }] }, '@xmlns': 'x' }, schema, { submissionDate: 'd' });
  assert.deepEqual(t.Submissions, [{ __id: 'A', __system: { submissionDate: 'd' }, g: { n: 3 } }]);
  assert.deepEqual(t['Submissions.r'], [{ __id: 'A/r[1]', '__Submissions-id': 'A', __root: 'A', x: 1.5 }]);
  assert.deepEqual(t['Submissions.r.s'].map(r => [r.__id, r['__Submissions-r-id'], r.y]), [['A/r[1]/s[1]', 'A/r[1]', 'a'], ['A/r[1]/s[2]', 'A/r[1]', null]]);
});

test('DHIS2 periods → first day', () => {
  assert.equal(periodStart('202403'), '2024-03-01');
  assert.equal(periodStart('2024Q3'), '2024-07-01');
  assert.equal(periodStart('2025W01'), '2024-12-30');
  assert.equal(periodStart('2024April'), '2024-04-01');
  assert.equal(periodStart('2024NovQ1'), '2023-11-01');
  assert.equal(periodStart('202403B'), '2024-05-01');
});

test('DHIS2 analytics: periods covering an interval', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  assert.deepEqual(periodsOf('ana-mois', { from: '2025-11-20', to: '2026-02-03' }, now), ['202511', '202512', '202601', '202602']);
  assert.deepEqual(periodsOf('ana-trimestre', { from: '2025-02-15', to: '2025-07-01' }, now), ['2025Q1', '2025Q2', '2025Q3']);
  assert.deepEqual(periodsOf('ana-annee', { from: '2020-06-01', to: '2022-01-01' }, now), ['2020', '2021', '2022']);
  // ISO weeks: 28 Dec 2024 is in week 52 of 2024, 30 Dec 2024 opens week 1 of 2025
  assert.deepEqual(periodsOf('ana-semaine', { from: '2024-12-28', to: '2025-01-12' }, now), ['2024W52', '2025W1', '2025W2']);
  assert.ok(periodsOf('ana-semaine', { from: '2020-12-28', to: '2021-01-03' }, now).includes('2020W53'));
  // no dates: the last 12 months and the current one
  const def = periodsOf('ana-mois', {}, now);
  assert.equal(def.length, 13); assert.equal(def[0], '202511'); assert.equal(def[12], '202611');
  assert.deepEqual(periodsOf('ana-mois', { from: '2026-03-01', to: '2026-01-01' }, now), []);
  for (const p of periodsOf('ana-semaine', {}, now)) assert.match(periodStart(p), /^\d{4}-\d{2}-\d{2}$/);
});

// ------------------------------------------------------------------ end to end
const procs = [];
const start = (args, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  p.stdout.on('data', d => { out += d; if (/http:\/\/localhost/.test(out)) resolve(p); });
  p.stderr.on('data', d => { out += d; });
  p.on('exit', c => reject(new Error(`exit ${c}: ${out}`)));
});
test.after(() => procs.forEach(p => p.kill()));

const port = 3900 + Math.floor(Math.random() * 50);
const B = `http://localhost:${port}`;
let cookie = '';
async function call(p, { method = 'GET', body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
  const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
  return { status: r.status, body: await r.json(), h: r.headers };
}

test('IASO, CommCare, DHIS2 and mSupply through the server', async t => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnv-'));
  await start(['test/sim-iaso.js', String(port + 100)]);
  await start(['test/sim-commcare.js', String(port + 110)]);
  await start(['test/sim-dhis2.js', String(port + 120), '2.41.3']);
  await start(['test/sim-dhis2.js', String(port + 122), '2.40.5']);
  await start(['test/sim-msupply.js', String(port + 130)]);
  await start(['server.js'], { PORT: String(port), CACHE_DIR: cacheDir });

  await t.test('IASO', async () => {
    assert.equal((await call('/api/login', { method: 'POST', body: { platform: 'iaso', server: `http://localhost:${port + 100}`, email: 'admin', password: 'x' } })).status, 401);
    const me = await call('/api/login', { method: 'POST', body: { platform: 'iaso', server: `http://localhost:${port + 100}/dashboard`, email: 'admin', password: 'admin123' } });
    assert.equal(me.body.platform, 'iaso');
    assert.deepEqual((await call('/api/projects/1/forms/11/tables')).body, ['Submissions', 'Submissions.membres']);
    const fields = (await call('/api/projects/1/forms/11/fields')).body;
    assert.ok(fields.some(f => f.path === '__system/level2' && /Département/.test(f.name)));
    const rows = (await call('/api/projects/1/forms/11/data')).body.rows;
    assert.equal(rows.length, 1200);
    assert.equal(typeof rows[0].menage.taille, 'number');
    const kids = (await call('/api/projects/1/forms/11/data?table=Submissions.membres')).body.rows;
    assert.ok(kids.every(k => rows.some(r => r.__id === k['__Submissions-id'])));
    // descriptor fallback (form file is private)
    assert.ok((await call('/api/projects/1/forms/12/labels')).body.choices.eau.oui);
  });

  await t.test('CommCare', async () => {
    cookie = '';
    const me = await call('/api/login', { method: 'POST', body: { platform: 'commcare', server: `http://localhost:${port + 110}`, email: 'enqueteur@demo.org', password: 'cle-api-123' } });
    assert.equal(me.body.platform, 'commcare');
    const forms = (await call('/api/projects/demo-nutrition/forms')).body;
    const fid = encodeURIComponent(forms[0].id);
    assert.deepEqual((await call(`/api/projects/demo-nutrition/forms/${fid}/tables`)).body, ['Submissions', 'Submissions.enfants']);
    const rows = (await call(`/api/projects/demo-nutrition/forms/${fid}/data`)).body.rows;
    assert.equal(rows.length, 11800); // more than the 10 000 Elasticsearch window: keyset paging works
    assert.equal(new Set(rows.map(r => r.__id)).size, rows.length);
    assert.ok(!rows.some(r => r.case || r.meta), 'case blocks and meta are not form fields');
    const L = (await call(`/api/projects/demo-nutrition/forms/${fid}/labels`)).body;
    assert.equal(L.choices['enfants/etat'].mas.fr, 'Malnutrition sévère');
  });

  for (const [version, p] of [['2.41', port + 120], ['2.40', port + 122]]) {
    await t.test(`DHIS2 ${version}`, async () => {
      cookie = '';
      const bad = await call("/api/login", { method: "POST", body: { platform: "dhis2", server: `http://localhost:${p}`, email: "admin", password: "x" } });
      assert.equal(bad.status, 401, JSON.stringify(bad.body));
      const me = await call('/api/login', { method: 'POST', body: { platform: 'dhis2', server: `http://localhost:${p}/dhis-web-dashboard/`, email: 'admin', password: 'district' } });
      assert.equal(me.body.platform, 'dhis2');
      assert.deepEqual((await call('/api/projects')).body.map(x => x.id), ['evenements', 'tracker', 'agrege', 'ana-mois', 'ana-trimestre', 'ana-annee', 'ana-semaine']);
      const ev = (await call('/api/projects/evenements/forms/prgPalu0001/data')).body.rows;
      assert.equal(ev.length, 2500);
      assert.equal(ev[0].__system.level1, 'Togo');
      const sept = (await call('/api/projects/evenements/forms/prgPalu0001/data?from=2026-09-01&to=2026-09-30')).body.rows;
      assert.ok(sept.length > 0 && sept.every(r => r.__system.submissionDate.startsWith('2026-09')));
      assert.deepEqual((await call('/api/projects/tracker/forms/prgCPN00001/tables')).body, ['Submissions', 'Submissions.stgVisite01', 'Submissions.stgAccouch1']);
      const en = (await call('/api/projects/tracker/forms/prgCPN00001/data')).body.rows;
      const visits = (await call('/api/projects/tracker/forms/prgCPN00001/data?table=Submissions.stgVisite01')).body.rows;
      const ids = new Set(en.map(r => r.__id));
      assert.ok(visits.length > en.length && visits.every(v => ids.has(v['__Submissions-id'])));
      const L = (await call('/api/projects/tracker/forms/prgCPN00001/labels')).body;
      assert.equal(L.fields['stgVisite01/dePoids0001'].fr, 'Poids (kg)');
      const agg = (await call('/api/projects/agrege/forms/dsSMI000001/data')).body.rows;
      assert.ok(agg.length > 1000 && agg.every(r => r.__system.submissionDate));

      // --- analytics: indicators, program indicators, totals and reporting rates per period and level
      const A = '/api/projects/ana-mois/forms', sim = q => fetch(`http://localhost:${p}${q}`, { method: 'POST' });
      const forms = (await call(A)).body;
      for (const id of ['ig-all', 'ig-igSMI000001', 'pi-prgPalu0001', 'deg-degSMI00001', 'ds-dsSMI000001', 'rr']) assert.ok(forms.some(f => f.id === id), id);
      assert.deepEqual(forms.find(f => f.id === 'ig-igSMI000001').measure, { agg: 'avg', field: 'value' });
      const levels = (await call(`${A}/ig-igSMI000001/tables`)).body;
      assert.deepEqual(levels.map(l => [l.id, l.default]), [['niveau1', false], ['niveau2', true], ['niveau3', false], ['niveau4', false]]);
      assert.equal(levels[1].label, 'Niveau 2 · Région');
      const F = (await call(`${A}/ig-igSMI000001/fields`)).body;
      assert.equal(F.find(f => f.path === '__system/submissionDate').period, 'month');
      assert.equal((await call(`${A}/ig-igSMI000001/labels`)).body.choices.indicator.indCPN1Cov1.fr, 'Couverture CPN1 (%)');
      const nat = (await call(`${A}/ig-igSMI000001/data?table=niveau1&from=2026-01-01&to=2026-03-31`)).body.rows;
      assert.equal(nat.length, 4 * 3); // 4 indicators × 3 months × 1 country
      const cov = nat.find(r => r.indicator === 'indAccAss01' && r.period === '202602');
      assert.equal(cov.__id, `indAccAss01|202602|${cov.__id.split('|')[2]}`);
      assert.equal(cov.__system.submissionDate, '2026-02-01');
      assert.equal(cov.__system.orgUnit, 'Togo');
      assert.ok(Math.abs(cov.value - (100 * cov.numerator) / cov.denominator) < 0.06, 'value = numerator / denominator × 100');
      // an indicator DHIS2 cannot compute is left out and reported; the others are kept
      const faulty = await call(`${A}/ig-igQualite01/data?table=niveau2`);
      assert.deepEqual([...new Set(faulty.body.rows.map(r => r.indicator))].sort(), ['indCPN1Cov1', 'indPenta3F1']);
      assert.match(decodeURIComponent(faulty.h.get('x-note')), /Broken indicator/);
      assert.equal((await call(`${A}/ig-nope/data?table=niveau2`)).status, 404);
      // data elements: text elements are left out; the country total is the sum of its districts, also when
      // the server's row limit forces the request to be split
      const Q = '/api/projects/ana-trimestre/forms/deg-degSMI00001/data';
      const country = (await call(`${Q}?table=niveau1`)).body.rows;
      assert.deepEqual([...new Set(country.map(r => r.dataElement))].sort(), ['deAccAgg001', 'deCPN1Agg01', 'dePenta3Agg']);
      await sim('/sim/analytics-limit?n=40');
      const districts = (await call(`${Q}?table=niveau3`)).body.rows;
      await sim('/sim/analytics-limit?n=50000');
      assert.ok(districts.length > 200 && districts.every(r => r.__system.level3 && !r.__system.level4));
      for (const c of country) assert.equal(districts.filter(r => r.dataElement === c.dataElement && r.period === c.period).reduce((n, r) => n + r.value, 0), c.value, `${c.dataElement} ${c.period}`);
      // weekly program indicators (computed from events) and yearly reporting rates
      const weekly = (await call('/api/projects/ana-semaine/forms/pi-prgPalu0001/data?table=niveau1')).body.rows;
      assert.ok(weekly.length > 20 && weekly.every(r => /^\d{4}W\d{1,2}$/.test(r.period) && r.__system.submissionDate));
      const rr = (await call('/api/projects/ana-annee/forms/rr/data?table=niveau2')).body.rows;
      assert.ok(rr.length >= 5 && rr.every(r => r.dataSet === 'dsSMI000001' && r.expected_reports >= r.actual_reports && Math.abs(r.reporting_rate - (100 * r.actual_reports) / r.expected_reports) < 0.06));
      // restricted user: only the Plateaux region
      cookie = '';
      await call('/api/login', { method: 'POST', body: { platform: 'dhis2', server: `http://localhost:${p}`, email: 'agent', password: 'agent123' } });
      const mine = (await call('/api/projects/evenements/forms/prgPalu0001/data')).body.rows;
      assert.ok(mine.length > 0 && mine.length < 2500 && mine.every(r => r.__system.level2 === 'Plateaux'));
      assert.deepEqual((await call('/api/projects/ana-mois/forms/ig-igSMI000001/tables')).body.map(l => [l.id, l.default]), [['niveau2', false], ['niveau3', true], ['niveau4', false]]);
      const own = (await call('/api/projects/ana-mois/forms/ig-igSMI000001/data?table=niveau3')).body.rows;
      assert.deepEqual([...new Set(own.map(r => r.__system.level2))], ['Plateaux']);
    });
  }

  await t.test('mSupply', async () => {
    cookie = '';
    assert.equal((await call('/api/login', { method: 'POST', body: { platform: 'msupply', server: `http://localhost:${port + 130}`, email: 'admin', password: 'x' } })).status, 401);
    const me = await call('/api/login', { method: 'POST', body: { platform: 'msupply', server: `http://localhost:${port + 130}/graphql`, email: 'admin', password: 'pass' } });
    assert.equal(me.body.platform, 'msupply');
    assert.equal((await call('/api/projects')).body.length, 2);
    const stock = (await call('/api/projects/store-central/forms/stock/data')).body.rows;
    assert.ok(stock.length > 0 && stock.every(r => r.packs_total > 0 && r.units_total === r.packs_total * r.pack_size));
    const out = (await call('/api/projects/store-central/forms/outbound/data')).body.rows;
    const lines = (await call('/api/projects/store-central/forms/outbound/data?table=Submissions.lignes')).body.rows;
    assert.equal(out.length, 700);
    assert.ok(lines.every(l => out.some(o => o.__id === l['__Submissions-id'])));
    // vaccines and cold chain
    const vac = (await call('/api/projects/store-central/forms/vaccines/data')).body.rows;
    assert.ok(vac.length > 0 && vac.every(r => r.is_vaccine === 'true' && r.doses_total > 0));
    const temps = (await call('/api/projects/store-central/forms/temperatures/data?from=2026-11-01&to=2026-11-02')).body.rows;
    assert.ok(temps.length > 100 && temps.every(r => r.datetime.startsWith('2026-11-0') && ['cold', 'ok', 'hot'].includes(r.range)));
    assert.ok((await call('/api/projects/store-central/forms/breaches/data')).body.rows.every(r => r.duration_minutes > 0));
    assert.equal((await call('/api/projects/store-central/forms/sensors/data')).body.rows.length, 3);
    const cce = (await call('/api/projects/store-central/forms/assets/data')).body.rows;
    assert.ok(cce.length === 18 && cce.some(r => r.status === 'FUNCTIONING'));
    // no "submission metadata" on a stock snapshot
    assert.ok(!(await call('/api/projects/store-central/forms/stock/fields')).body.some(f => f.system));
    // mSupply Desktop (REST v4), mSupply user
    cookie = '';
    const d = await call('/api/login', { method: 'POST', body: { platform: 'msupply', server: `http://localhost:${port + 131}`, email: 'gestionnaire', password: 'pass' } });
    assert.equal(d.status, 200);
    assert.deepEqual((await call('/api/projects/store/forms')).body.map(f => f.id), ['storeInvoices']);
    assert.ok((await call('/api/projects/store/forms/storeInvoices/data')).body.rows.length > 100);
  });
});
