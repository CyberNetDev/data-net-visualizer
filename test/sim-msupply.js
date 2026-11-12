// mSupply simulators, to test the connector without a real server. Usage: node test/sim-msupply.js [port] (4640)
//  • port      : Open mSupply GraphQL API (POST /graphql), schema written from the Open mSupply source code
//                (msupply-foundation/open-msupply, server/graphql). It is executed by graphql-js (dev dependency),
//                so queries are validated like a real server. This schema is an *older* one on purpose: it lacks
//                StockLineNode.supplierName, to check that the connector drops fields a server does not know.
//  • port + 1  : mSupply Desktop web server, REST API v4 (from the mSupply documentation): /api/v4/login (JWT
//                cookie, 2 hours), /storeCustomerInvoice (mSupply user), /stock and /customerInvoice (store contact).
// Accounts: Open mSupply  admin / pass (stores Pharmacie centrale + Dépôt Nord), pharmacien / pass (Dépôt Nord only)
//           Desktop       gestionnaire / pass (mSupply user), client1 / pass (store contact)
// Simulator controls: POST /sim/ship (an outbound shipment changes status), /sim/new-invoice ; GET /sim/stats

const http = require('node:http');
const crypto = require('node:crypto');
const { buildSchema, graphql } = require('graphql');

const PORT = Number(process.argv[2] || 4640);

let seed = 31;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = a => a[Math.floor(rnd() * a.length)];
const id = () => crypto.randomUUID();

const schema = buildSchema(`
  scalar DateTime
  scalar NaiveDate
  type Query {
    authToken(username: String!, password: String!): AuthTokenResponse!
    me: UserResponse!
    logout: LogoutResponse!
    stockLines(storeId: String!, page: PaginationInput, filter: StockLineFilterInput, sort: [StockLineSortInput!], timezoneOffset: Int): StockLinesResponse!
    invoices(storeId: String!, page: PaginationInput, filter: InvoiceFilterInput, sort: [InvoiceSortInput!]): InvoicesResponse!
    requisitions(storeId: String!, page: PaginationInput, filter: RequisitionFilterInput, sort: [RequisitionSortInput!]): RequisitionsResponse!
    temperatureLogs(storeId: String!, page: PaginationInput, filter: TemperatureLogFilterInput, sort: [TemperatureLogSortInput!]): TemperatureLogsResponse!
    temperatureBreaches(storeId: String!, page: PaginationInput, filter: TemperatureBreachFilterInput, sort: [TemperatureBreachSortInput!]): TemperatureBreachesResponse!
    sensors(storeId: String!, page: PaginationInput, filter: SensorFilterInput, sort: [SensorSortInput!]): SensorsResponse!
    assets(storeId: String!, page: PaginationInput, filter: AssetFilterInput, sort: [AssetSortInput!]): AssetsResponse!
  }
  type LocationNode { id: String! name: String! code: String! onHold: Boolean! }
  type NameNode { id: String! name: String! code: String! }
  type ProgramNode { id: String! name: String! }
  type CampaignNode { id: String! name: String! }
  type VvmStatusNode { id: String! code: String! description: String! level: Int! }
  enum TemperatureBreachNodeType { COLD_CONSECUTIVE COLD_CUMULATIVE HOT_CONSECUTIVE HOT_CUMULATIVE EXCURSION }
  enum SensorNodeType { BLUE_MAESTRO LAIRD BERLINGER LOG_TAG }
  input StringFilterInput { equalTo: String like: String }
  input LocationFilterInput { id: EqualFilterStringInput name: StringFilterInput }
  input SensorFilterInput { serial: StringFilterInput name: StringFilterInput isActive: Boolean id: EqualFilterStringInput }
  input TemperatureBreachFilterInput { id: EqualFilterStringInput startDatetime: DatetimeFilterInput endDatetime: DatetimeFilterInput unacknowledged: Boolean sensor: SensorFilterInput location: LocationFilterInput }
  input TemperatureLogFilterInput { datetime: DatetimeFilterInput id: EqualFilterStringInput sensor: SensorFilterInput location: LocationFilterInput temperatureBreach: TemperatureBreachFilterInput }
  enum TemperatureLogSortFieldInput { datetime temperature }
  input TemperatureLogSortInput { key: TemperatureLogSortFieldInput! desc: Boolean }
  enum TemperatureBreachSortFieldInput { startDatetime endDatetime }
  input TemperatureBreachSortInput { key: TemperatureBreachSortFieldInput! desc: Boolean }
  enum SensorSortFieldInput { serial name }
  input SensorSortInput { key: SensorSortFieldInput! desc: Boolean }
  union TemperatureLogsResponse = TemperatureLogConnector
  type TemperatureLogConnector { totalCount: Int! nodes: [TemperatureLogNode!]! }
  type TemperatureLogNode { id: String! temperature: Float! datetime: DateTime! sensorId: String! sensor: SensorNode location: LocationNode temperatureBreach: TemperatureBreachNode }
  union TemperatureBreachesResponse = TemperatureBreachConnector
  type TemperatureBreachConnector { totalCount: Int! nodes: [TemperatureBreachNode!]! }
  type TemperatureBreachNode { id: String! sensorId: String! sensor: SensorNode type: TemperatureBreachNodeType! startDatetime: DateTime! endDatetime: DateTime unacknowledged: Boolean!
    durationMilliseconds: Int! location: LocationNode maxOrMinTemperature: Float comment: String }
  union SensorsResponse = SensorConnector
  type SensorConnector { totalCount: Int! nodes: [SensorNode!]! }
  type SensorNode { id: String! name: String! serial: String type: SensorNodeType! isActive: Boolean! batteryLevel: Int logInterval: Int lastConnectionDatetime: DateTime location: LocationNode
    latestTemperatureLog: TemperatureLogConnector breach: TemperatureBreachNodeType }
  enum AssetLogStatusNodeType { NOT_IN_USE FUNCTIONING FUNCTIONING_BUT_NEEDS_ATTENTION NOT_FUNCTIONING DECOMMISSIONED UNSERVICEABLE NOT_INSTALLED }
  input AssetFilterInput { id: EqualFilterStringInput assetNumber: StringFilterInput }
  enum AssetSortFieldInput { serialNumber installationDate replacementDate modifiedDatetime assetNumber store notes }
  input AssetSortInput { key: AssetSortFieldInput! desc: Boolean }
  union AssetsResponse = AssetConnector
  type AssetConnector { totalCount: Int! nodes: [AssetNode!]! }
  type AssetCatalogueItemNode { id: String! code: String! manufacturer: String model: String! }
  type AssetClassNode { id: String! name: String! }
  type AssetCategoryNode { id: String! name: String! }
  type AssetTypeNode { id: String! name: String! }
  type AssetLogReasonNode { id: String! reason: String! }
  type AssetLogNode { id: String! status: AssetLogStatusNodeType logDatetime: DateTime! reason: AssetLogReasonNode comment: String }
  type StoreNode { id: String! code: String! storeName: String! }
  type AssetNode { id: String! assetNumber: String serialNumber: String notes: String installationDate: NaiveDate replacementDate: NaiveDate warrantyEnd: NaiveDate needsReplacement: Boolean
    createdDatetime: DateTime! store: StoreNode catalogueItem: AssetCatalogueItemNode assetClass: AssetClassNode assetCategory: AssetCategoryNode assetType: AssetTypeNode statusLog: AssetLogNode donor: NameNode }
  union AuthTokenResponse = AuthToken | AuthTokenError
  type AuthToken { token: String! expiryDate: Int! userId: String! }
  type AuthTokenError { error: AuthTokenErrorInterface! }
  interface AuthTokenErrorInterface { description: String! }
  type InvalidCredentials implements AuthTokenErrorInterface { description: String! }
  type AccountBlocked implements AuthTokenErrorInterface { description: String! timeoutRemaining: Int! }
  type NoSiteAccess implements AuthTokenErrorInterface { description: String! }
  union UserResponse = UserNode
  type UserNode { userId: String! username: String! email: String firstName: String lastName: String defaultStore: UserStoreNode stores: UserStoreConnector! }
  type UserStoreConnector { totalCount: Int! nodes: [UserStoreNode!]! }
  type UserStoreNode { id: String! code: String! nameId: String! name: String! }
  union LogoutResponse = Logout
  type Logout { userId: String! }
  input PaginationInput { first: Int offset: Int }
  input EqualFilterStringInput { equalTo: String equalAny: [String!] notEqualTo: String }
  input DatetimeFilterInput { equalTo: DateTime beforeOrEqualTo: DateTime afterOrEqualTo: DateTime }
  type ItemNode { id: String! code: String! name: String! unitName: String isVaccine: Boolean! doses: Int! }
  union StockLinesResponse = StockLineConnector
  type StockLineConnector { totalCount: Int! nodes: [StockLineNode!]! }
  type StockLineNode { id: String! itemId: String! itemName: String! storeId: String! batch: String packSize: Float! costPricePerPack: Float! sellPricePerPack: Float!
    availableNumberOfPacks: Float! totalNumberOfPacks: Float! expiryDate: NaiveDate onHold: Boolean! note: String locationName: String item: ItemNode!
    vvmStatus: VvmStatusNode donor(storeId: String!): NameNode program: ProgramNode campaign: CampaignNode }
  input StockLineFilterInput { isAvailable: Boolean itemId: EqualFilterStringInput }
  enum StockLineSortFieldInput { expiryDate numberOfPacks itemCode itemName batch packSize }
  input StockLineSortInput { key: StockLineSortFieldInput! desc: Boolean }
  enum InvoiceNodeType { OUTBOUND_SHIPMENT INBOUND_SHIPMENT PRESCRIPTION INVENTORY_ADDITION INVENTORY_REDUCTION SUPPLIER_RETURN CUSTOMER_RETURN REPACK }
  enum InvoiceNodeStatus { NEW ALLOCATED PICKED SHIPPED DELIVERED RECEIVED VERIFIED CANCELLED }
  enum InvoiceLineNodeType { STOCK_IN STOCK_OUT UNALLOCATED_STOCK SERVICE }
  input EqualFilterInvoiceTypeInput { equalTo: InvoiceNodeType equalAny: [InvoiceNodeType!] notEqualTo: InvoiceNodeType }
  input EqualFilterInvoiceStatusInput { equalTo: InvoiceNodeStatus equalAny: [InvoiceNodeStatus!] notEqualTo: InvoiceNodeStatus }
  input InvoiceFilterInput { id: EqualFilterStringInput type: EqualFilterInvoiceTypeInput status: EqualFilterInvoiceStatusInput createdDatetime: DatetimeFilterInput }
  enum InvoiceSortFieldInput { type otherPartyName invoiceNumber comment status createdDatetime shippedDatetime }
  input InvoiceSortInput { key: InvoiceSortFieldInput! desc: Boolean }
  union InvoicesResponse = InvoiceConnector
  type InvoiceConnector { totalCount: Int! nodes: [InvoiceNode!]! }
  type PricingNode { totalBeforeTax: Float! totalAfterTax: Float! }
  type InvoiceNode { id: String! invoiceNumber: Int! type: InvoiceNodeType! status: InvoiceNodeStatus! otherPartyName: String! otherPartyId: String! theirReference: String comment: String
    createdDatetime: DateTime! allocatedDatetime: DateTime pickedDatetime: DateTime shippedDatetime: DateTime deliveredDatetime: DateTime receivedDatetime: DateTime verifiedDatetime: DateTime
    pricing: PricingNode! user: UserNode lines: InvoiceLineConnector! }
  type InvoiceLineConnector { totalCount: Int! nodes: [InvoiceLineNode!]! }
  type InvoiceLineNode { id: String! invoiceId: String! type: InvoiceLineNodeType! itemId: String! itemCode: String! itemName: String! batch: String expiryDate: NaiveDate packSize: Float!
    numberOfPacks: Float! costPricePerPack: Float! sellPricePerPack: Float! totalBeforeTax: Float! totalAfterTax: Float! locationName: String note: String item: ItemNode! }
  enum RequisitionNodeType { REQUEST RESPONSE }
  enum RequisitionNodeStatus { DRAFT NEW SENT FINALISED }
  input EqualFilterRequisitionTypeInput { equalTo: RequisitionNodeType equalAny: [RequisitionNodeType!] }
  input EqualFilterRequisitionStatusInput { equalTo: RequisitionNodeStatus equalAny: [RequisitionNodeStatus!] }
  input RequisitionFilterInput { type: EqualFilterRequisitionTypeInput status: EqualFilterRequisitionStatusInput createdDatetime: DatetimeFilterInput }
  enum RequisitionSortFieldInput { requisitionNumber type status otherPartyName sentDatetime createdDatetime finalisedDatetime }
  input RequisitionSortInput { key: RequisitionSortFieldInput! desc: Boolean }
  union RequisitionsResponse = RequisitionConnector
  type RequisitionConnector { totalCount: Int! nodes: [RequisitionNode!]! }
  type PeriodNode { id: String! name: String! }
  type RequisitionNode { id: String! requisitionNumber: Int! type: RequisitionNodeType! status: RequisitionNodeStatus! otherPartyName: String! theirReference: String comment: String
    createdDatetime: DateTime! sentDatetime: DateTime finalisedDatetime: DateTime programName: String period: PeriodNode user: UserNode lines: RequisitionLineConnector! }
  type RequisitionLineConnector { totalCount: Int! nodes: [RequisitionLineNode!]! }
  type RequisitionLineNode { id: String! itemId: String! itemName: String! requestedQuantity: Float! suggestedQuantity: Float! approvedQuantity: Float! supplyQuantity: Float!
    averageMonthlyConsumption: Float! availableStockOnHand: Float! comment: String item: ItemNode! }
`);

// ------------------------------------------------------------------ data
const STORES = [{ id: 'store-central', code: 'PC', nameId: 'n1', name: 'Pharmacie centrale' }, { id: 'store-nord', code: 'DN', nameId: 'n2', name: 'Dépôt Nord' }];
const USERS = { admin: { pw: 'pass', first: 'Fatoumata', last: 'Keita', stores: ['store-central', 'store-nord'] }, pharmacien: { pw: 'pass', first: 'Moussa', last: 'Coulibaly', stores: ['store-nord'] } };
const ITEMS = [['AMOX500', 'Amoxicilline 500 mg gélule', 'gélule', 100], ['PARA500', 'Paracétamol 500 mg comprimé', 'comprimé', 1000], ['ACT-AL', 'Artéméther-luméfantrine 20/120', 'comprimé', 24],
  ['SRO', 'Sels de réhydratation orale', 'sachet', 50], ['ZINC20', 'Zinc 20 mg comprimé', 'comprimé', 100], ['TDR-PALU', 'Test de diagnostic rapide paludisme', 'test', 25],
  ['OXY10', 'Ocytocine 10 UI injectable', 'ampoule', 50], ['GANTS-M', 'Gants d\'examen taille M', 'paire', 100],
  ['BCG', 'Vaccin BCG', 'flacon', 20, 20], ['PENTA', 'Vaccin pentavalent', 'flacon', 10, 1], ['VPO', 'Vaccin polio oral (VPO)', 'flacon', 20, 20], ['RR', 'Vaccin rougeole-rubéole', 'flacon', 10, 10]]
  .map(([code, name, unitName, pack, doses]) => ({ id: 'item-' + code, code, name, unitName, pack, isVaccine: !!doses, doses: doses || 0 }));
const VVM = [{ id: 'vvm1', code: '1', description: 'Stade 1', level: 1 }, { id: 'vvm2', code: '2', description: 'Stade 2', level: 2 }, { id: 'vvm3', code: '3', description: 'Stade 3 (à jeter)', level: 3 }];
const CUSTOMERS = ['CS Kati', 'CS Koulikoro', 'CSRéf Ségou', 'CS Sikasso', 'Hôpital de Kayes'];
const SUPPLIERS = ['CAMEG', 'PPM', 'UNICEF', 'Fonds mondial'];
const now = Date.now();
const dt = t => new Date(t).toISOString();
const dayOf = t => new Date(t).toISOString().slice(0, 10);

const stock = [];
for (const s of STORES) for (const it of ITEMS) for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
  const packs = Math.floor(rnd() * 300) - 20;
  stock.push({ id: id(), storeId: s.id, itemId: it.id, itemName: it.name, item: it, batch: `L${Math.floor(rnd() * 90000 + 10000)}`, packSize: it.pack,
    costPricePerPack: Math.round(rnd() * 20000) / 100, sellPricePerPack: Math.round(rnd() * 30000) / 100, totalNumberOfPacks: Math.max(0, packs), availableNumberOfPacks: Math.max(0, packs - 5),
    expiryDate: rnd() < 0.05 ? null : dayOf(now + (rnd() * 900 - 120) * 864e5), onHold: rnd() < 0.05, locationName: it.isVaccine ? 'Chambre froide' : pick(['Étagère A', 'Étagère B', null]),
    vvmStatus: it.isVaccine ? pick(VVM) : null, donor: it.isVaccine ? { id: 'gavi', name: 'Gavi', code: 'GAVI' } : null, program: it.isVaccine ? { id: 'pev', name: 'PEV' } : null, campaign: null });
}
// cold chain: 3 sensors per store, a reading every 30 minutes for 60 days, a few breaches
const LOCS = [{ id: 'loc1', name: 'Chambre froide', code: 'CF', onHold: false }, { id: 'loc2', name: 'Réfrigérateur 1', code: 'R1', onHold: false }, { id: 'loc3', name: 'Réfrigérateur 2', code: 'R2', onHold: false }];
const sensors = [], tlogs = [], breaches = [];
for (const s of STORES) LOCS.forEach((loc, k) => {
  const sensor = { id: id(), storeId: s.id, name: `${loc.name} (${s.code})`, serial: `BM-${s.code}-${k + 1}`, type: pick(['BLUE_MAESTRO', 'BERLINGER', 'LAIRD']), isActive: k !== 2 || rnd() < 0.5,
    batteryLevel: Math.floor(rnd() * 100), logInterval: 1800, lastConnectionDatetime: dt(now - rnd() * 5 * 864e5), location: loc, breach: null };
  sensors.push(sensor);
  let t = 4 + rnd() * 2;
  for (let i = 60 * 48; i > 0; i--) {
    const when = now - i * 1800e3;
    t = Math.max(-1, Math.min(14, t + (rnd() - 0.5) * 0.8 + (5 - t) * 0.1));
    tlogs.push({ id: id(), storeId: s.id, temperature: Math.round(t * 10) / 10, datetime: dt(when), sensorId: sensor.id, sensor, location: loc, temperatureBreach: null });
  }
  for (let b = 0; b < 2 + Math.floor(rnd() * 4); b++) {
    const start = now - rnd() * 55 * 864e5, dur = (30 + rnd() * 600) * 60e3, hot = rnd() < 0.7;
    const br = { id: id(), storeId: s.id, sensorId: sensor.id, sensor, type: hot ? pick(['HOT_CONSECUTIVE', 'HOT_CUMULATIVE', 'EXCURSION']) : 'COLD_CONSECUTIVE', startDatetime: dt(start), endDatetime: dt(start + dur),
      unacknowledged: rnd() < 0.4, durationMilliseconds: Math.round(dur), location: loc, maxOrMinTemperature: hot ? 8 + Math.round(rnd() * 60) / 10 : 2 - Math.round(rnd() * 30) / 10, comment: rnd() < 0.3 ? 'Coupure de courant' : null };
    breaches.push(br);
    for (const l of tlogs) if (l.sensorId === sensor.id && Date.parse(l.datetime) >= start && Date.parse(l.datetime) <= start + dur) { l.temperatureBreach = br; l.temperature = hot ? br.maxOrMinTemperature : br.maxOrMinTemperature; }
  }
  const open = breaches.find(b => b.sensorId === sensor.id && b.unacknowledged && Date.parse(b.endDatetime) > now - 864e5);
  if (open) sensor.breach = open.type;
});
const CCE = [['E003/002', 'Vestfrost', 'MK 304', 'Réfrigérateur', 'Réfrigérateurs à vaccins'], ['E003/107', 'B Medical', 'TCW 3000 AC', 'Réfrigérateur', 'Réfrigérateurs à vaccins'],
  ['E003/045', 'Haier', 'HBC-80', 'Congélateur', 'Congélateurs'], ['E006/011', 'Sure Chill', 'ZLF 150', 'Réfrigérateur solaire', 'Réfrigérateurs à vaccins'], ['E004/073', 'Blowkings', 'BK-VC 44', 'Glacière', 'Glacières et porte-vaccins']];
const assets = [];
const ASSET_STATUSES = ['FUNCTIONING', 'FUNCTIONING', 'FUNCTIONING', 'FUNCTIONING_BUT_NEEDS_ATTENTION', 'NOT_FUNCTIONING', 'NOT_IN_USE', 'DECOMMISSIONED'];
for (const s of STORES) for (let i = 0; i < 18; i++) {
  const [code, manufacturer, model, type, category] = pick(CCE);
  const inst = dayOf(now - (rnd() * 12 + 0.2) * 365 * 864e5);
  const status = rnd() < 0.1 ? null : pick(ASSET_STATUSES);
  assets.push({ id: id(), storeId: s.id, assetNumber: `${s.code}-CCE-${String(i + 1).padStart(3, '0')}`, serialNumber: `SN${Math.floor(rnd() * 9e6 + 1e6)}`, notes: rnd() < 0.2 ? 'Porte à remplacer' : null,
    installationDate: inst, replacementDate: dayOf(Date.parse(inst) + 10 * 365 * 864e5), warrantyEnd: dayOf(Date.parse(inst) + 2 * 365 * 864e5), needsReplacement: Date.parse(inst) < now - 9 * 365 * 864e5, createdDatetime: dt(now - 1e9),
    store: { id: s.id, code: s.code, storeName: s.name }, catalogueItem: { id: 'cat-' + code, code, manufacturer, model }, assetClass: { id: 'cce', name: 'Chaîne du froid' },
    assetCategory: { id: 'cat', name: category }, assetType: { id: 'type', name: type },
    statusLog: status ? { id: id(), status, logDatetime: dt(now - rnd() * 200 * 864e5), reason: status === 'NOT_FUNCTIONING' ? { id: 'r1', reason: pick(['Compresseur en panne', 'Thermostat défaillant', 'Fuite de gaz']) } : null, comment: null } : null,
    donor: rnd() < 0.5 ? { id: 'unicef', name: 'UNICEF', code: 'UNICEF' } : null });
}
const invoices = [];
let invNo = 1;
const ORDER = ['NEW', 'ALLOCATED', 'PICKED', 'SHIPPED', 'DELIVERED', 'VERIFIED'];
function addInvoice(store, type, t, status) {
  const party = type === 'INBOUND_SHIPMENT' ? pick(SUPPLIERS) : type === 'PRESCRIPTION' ? `Patient ${Math.floor(rnd() * 900 + 100)}` : type.startsWith('INVENTORY') ? 'Inventaire' : pick(CUSTOMERS);
  const inv = { id: id(), storeId: store, invoiceNumber: invNo++, type, status, otherPartyName: party, otherPartyId: 'n-' + party, theirReference: rnd() < 0.5 ? `REF-${Math.floor(rnd() * 9999)}` : null,
    comment: rnd() < 0.2 ? 'Livraison partielle' : null, createdDatetime: dt(t), user: { userId: 'u1', username: pick(['admin', 'pharmacien']), stores: { totalCount: 0, nodes: [] } }, lines: [] };
  const idx = ORDER.indexOf(status);
  if (idx >= 3) inv.shippedDatetime = dt(t + 864e5);
  if (idx >= 4) inv.deliveredDatetime = dt(t + 3 * 864e5);
  if (idx >= 5) inv.verifiedDatetime = dt(t + 4 * 864e5);
  if (type === 'INBOUND_SHIPMENT' && idx >= 4) inv.receivedDatetime = dt(t + 3 * 864e5);
  const n = 1 + Math.floor(rnd() * 5);
  for (let k = 0; k < n; k++) {
    const it = pick(ITEMS);
    const packs = Math.ceil(rnd() * 40), price = Math.round(rnd() * 20000) / 100;
    inv.lines.push({ id: id(), invoiceId: inv.id, type: type === 'INBOUND_SHIPMENT' || type === 'INVENTORY_ADDITION' ? 'STOCK_IN' : 'STOCK_OUT', itemId: it.id, itemCode: it.code, itemName: it.name,
      batch: `L${Math.floor(rnd() * 90000 + 10000)}`, expiryDate: dayOf(t + 500 * 864e5), packSize: it.pack, numberOfPacks: packs, costPricePerPack: price, sellPricePerPack: price * 1.2,
      totalBeforeTax: Math.round(packs * price * 120) / 100, totalAfterTax: Math.round(packs * price * 120) / 100, locationName: null, note: null, item: it });
  }
  inv.pricing = { totalBeforeTax: inv.lines.reduce((a, l) => a + l.totalAfterTax, 0), totalAfterTax: Math.round(inv.lines.reduce((a, l) => a + l.totalAfterTax, 0) * 100) / 100 };
  invoices.push(inv);
  return inv;
}
for (const s of STORES) {
  for (let i = 0; i < 700; i++) addInvoice(s.id, 'OUTBOUND_SHIPMENT', now - rnd() * 400 * 864e5, pick([...ORDER, 'VERIFIED', 'VERIFIED', 'SHIPPED']));
  for (let i = 0; i < 120; i++) addInvoice(s.id, 'INBOUND_SHIPMENT', now - rnd() * 400 * 864e5, pick(['NEW', 'DELIVERED', 'VERIFIED', 'VERIFIED']));
  for (let i = 0; i < 300; i++) addInvoice(s.id, 'PRESCRIPTION', now - rnd() * 200 * 864e5, pick(['PICKED', 'VERIFIED']));
  for (let i = 0; i < 30; i++) addInvoice(s.id, pick(['INVENTORY_ADDITION', 'INVENTORY_REDUCTION']), now - rnd() * 300 * 864e5, 'VERIFIED');
}
const requisitions = [];
for (const s of STORES) for (const type of ['REQUEST', 'RESPONSE']) for (let i = 0; i < 60; i++) {
  const t = now - rnd() * 360 * 864e5;
  const r = { id: id(), storeId: s.id, requisitionNumber: i + 1, type, status: pick(['DRAFT', 'SENT', 'FINALISED', 'FINALISED']), otherPartyName: type === 'REQUEST' ? pick(SUPPLIERS) : pick(CUSTOMERS),
    theirReference: null, comment: null, createdDatetime: dt(t), sentDatetime: dt(t + 864e5), finalisedDatetime: dt(t + 10 * 864e5), programName: pick(['Paludisme', 'Santé maternelle', null]),
    period: { id: 'p' + i, name: new Date(t).toISOString().slice(0, 7) }, user: null, lines: [] };
  for (const it of ITEMS.filter(() => rnd() < 0.5)) {
    const amc = Math.round(rnd() * 400), soh = Math.round(rnd() * 900);
    r.lines.push({ id: id(), itemId: it.id, itemName: it.name, requestedQuantity: Math.max(0, amc * 3 - soh), suggestedQuantity: Math.max(0, amc * 3 - soh), approvedQuantity: 0,
      supplyQuantity: type === 'RESPONSE' ? Math.max(0, amc * 2 - soh) : 0, averageMonthlyConsumption: amc, availableStockOnHand: soh, comment: null, item: it });
  }
  requisitions.push(r);
}

// ------------------------------------------------------------------ GraphQL resolvers
const tokens = new Map();
let served = 0;
const err = (message, details) => Object.assign(new Error(message), { extensions: { details } });
function page(list, { page: pg, sort }, sortKeys) {
  let out = [...list];
  const s = Array.isArray(sort) ? sort[0] : sort;
  if (s) { const k = sortKeys[s.key] || s.key; out.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (s.desc ? -1 : 1)); }
  const first = pg && pg.first != null ? pg.first : 100, offset = (pg && pg.offset) || 0;
  return { totalCount: out.length, nodes: out.slice(offset, offset + first) };
}
const eq = (f, v) => !f || (f.equalTo == null || f.equalTo === v) && (!f.equalAny || f.equalAny.includes(v)) && (f.notEqualTo == null || f.notEqualTo !== v);
const dtf = (f, v) => !f || ((!f.afterOrEqualTo || v >= new Date(f.afterOrEqualTo).toISOString()) && (!f.beforeOrEqualTo || v <= new Date(f.beforeOrEqualTo).toISOString()));
function guard(ctx, storeId) {
  if (!ctx.user) throw err('Unauthenticated', 'Missing or invalid authentication token');
  if (storeId && !USERS[ctx.user].stores.includes(storeId)) throw err('Forbidden', `User has no access to store ${storeId}`);
}
const root = {
  authToken: ({ username, password }) => {
    const u = USERS[username];
    if (!u || u.pw !== password) return { __typename: 'AuthTokenError', error: { __typename: 'InvalidCredentials', description: 'Invalid credentials' } };
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, username);
    return { __typename: 'AuthToken', token, expiryDate: Math.floor(Date.now() / 1000) + 3600, userId: username };
  },
  me: (a, ctx) => { guard(ctx); const u = USERS[ctx.user]; const st = STORES.filter(s => u.stores.includes(s.id));
    return { __typename: 'UserNode', userId: ctx.user, username: ctx.user, firstName: u.first, lastName: u.last, defaultStore: st[0], stores: { totalCount: st.length, nodes: st } }; },
  logout: (a, ctx) => { tokens.delete(ctx.token); return { __typename: 'Logout', userId: ctx.user || '' }; },
  stockLines: (a, ctx) => { guard(ctx, a.storeId); const r = page(stock.filter(x => x.storeId === a.storeId), a, {}); served += r.nodes.length; return { __typename: 'StockLineConnector', ...r }; },
  temperatureLogs: (a, ctx) => { guard(ctx, a.storeId); const f = a.filter || {}; const r = page(tlogs.filter(x => x.storeId === a.storeId && dtf(f.datetime, x.datetime)), a, {}); served += r.nodes.length; return { __typename: 'TemperatureLogConnector', ...r }; },
  temperatureBreaches: (a, ctx) => { guard(ctx, a.storeId); const f = a.filter || {}; return { __typename: 'TemperatureBreachConnector', ...page(breaches.filter(x => x.storeId === a.storeId && dtf(f.startDatetime, x.startDatetime)), a, {}) }; },
  sensors: (a, ctx) => { guard(ctx, a.storeId); return { __typename: 'SensorConnector', ...page(sensors.filter(x => x.storeId === a.storeId).map(x => {
    const logs = tlogs.filter(l => l.sensorId === x.id); return { ...x, latestTemperatureLog: { totalCount: 1, nodes: logs.slice(-1) } }; }), a, {}) }; },
  assets: (a, ctx) => { guard(ctx, a.storeId); return { __typename: 'AssetConnector', ...page(assets.filter(x => x.storeId === a.storeId), a, {}) }; },
  invoices: (a, ctx) => {
    guard(ctx, a.storeId);
    const f = a.filter || {};
    const list = invoices.filter(x => x.storeId === a.storeId && eq(f.type, x.type) && eq(f.status, x.status) && dtf(f.createdDatetime, x.createdDatetime) && eq(f.id, x.id))
      .map(x => ({ ...x, lines: { totalCount: x.lines.length, nodes: x.lines } }));
    const r = page(list, a, {});
    if (!a.page || a.page.first !== 1) served += r.nodes.length;
    return { __typename: 'InvoiceConnector', ...r };
  },
  requisitions: (a, ctx) => {
    guard(ctx, a.storeId);
    const f = a.filter || {};
    const list = requisitions.filter(x => x.storeId === a.storeId && eq(f.type, x.type) && eq(f.status, x.status) && dtf(f.createdDatetime, x.createdDatetime))
      .map(x => ({ ...x, lines: { totalCount: x.lines.length, nodes: x.lines } }));
    return { __typename: 'RequisitionConnector', ...page(list, a, {}) };
  },
};

http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const u = new URL(req.url, 'http://x');
  const json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/sim/stats') { const s = served; served = 0; return json({ served: s }); }
  if (u.pathname === '/sim/ship') { const inv = invoices.find(x => x.storeId === 'store-central' && x.type === 'OUTBOUND_SHIPMENT' && x.status === 'PICKED'); inv.status = 'SHIPPED'; inv.shippedDatetime = dt(Date.now()); return json({ id: inv.id }); }
  if (u.pathname === '/sim/new-invoice') return json({ id: addInvoice('store-central', 'OUTBOUND_SHIPMENT', Date.now(), 'NEW').id });
  if (u.pathname !== '/graphql' || req.method !== 'POST') { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html>Not found</html>'); }
  let q; try { q = JSON.parse(body); } catch { return json({ errors: [{ message: 'Invalid JSON' }] }, 400); }
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const result = await graphql({ schema, source: q.query, rootValue: root, variableValues: q.variables, contextValue: { user: tokens.get(token) || null, token } });
  json(result);
}).listen(PORT, () => console.log(`Open mSupply simulé sur http://localhost:${PORT}/graphql`));

// ------------------------------------------------------------------ mSupply Desktop (REST API v4)
const DESK_USERS = { gestionnaire: { pw: 'pass', loginType: 'storeInvoice', first: 'Aminata', last: 'Diarra' }, client1: { pw: 'pass', loginType: 'invoice', first: 'CS', last: 'Kati' } };
const jwts = new Map();
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const u = new URL(req.url, 'http://x');
  const json = (o, c = 200, h = {}) => { res.writeHead(c, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/api/v4/login' && req.method === 'POST') {
    let b; try { b = JSON.parse(body); } catch { b = {}; }
    if (!b.username || !b.password || !b.loginType) return json({ error: 'Username/password/login type missing' }, 400);
    const usr = DESK_USERS[b.username];
    if (!usr || usr.pw !== b.password || usr.loginType !== b.loginType) return json({ error: 'Failed to authenticate/No store found for user' }, 401);
    const token = `${b64({ alg: 'HS256' })}.${b64({ user: b.username, exp: Math.floor(Date.now() / 1000) + 7200 })}.${crypto.randomBytes(12).toString('base64url')}`;
    jwts.set(token, b.username);
    // the JWT comes as a cookie (the documentation shows no token in the body)
    return json({ status: 'success', authenticated: true, username: b.username, userFirstName: usr.first, userLastName: usr.last, userJobTitle: '', userType: b.loginType === 'invoice' ? 'contact' : 'user',
      service: b.loginType, storeName: 'Pharmacie centrale' }, 200, { 'Set-Cookie': `jwt=${token}; Path=/; HttpOnly` });
  }
  const cookieJwt = ((req.headers.cookie || '').match(/(?:^|;\s*)jwt=([^;]+)/) || [])[1];
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  const who = jwts.get(bearer) || jwts.get(cookieJwt);
  if (!who) return json({ error: 'JWT token/user ID/store ID not found' }, 401);
  const usr = DESK_USERS[who];
  const lines = inv => inv.lines.map(l => ({ itemCode: l.itemCode, itemName: l.itemName, batchName: l.batch, expiryDate: `${l.expiryDate}T00:00:00.000Z`, unit: l.item.unitName, barcode: '',
    packPrice: l.sellPricePerPack, packSize: l.packSize, quantity: l.numberOfPacks, comment: '', lineTotal: l.totalAfterTax }));
  if (u.pathname === '/api/v4/storeCustomerInvoice') {
    if (usr.loginType !== 'storeInvoice') return json({ error: 'Selected store is not default for user' }, 401);
    const a = u.searchParams.get('startDate'), b = u.searchParams.get('endDate');
    if (!a || !b) return json({ error: 'End date/Start date is mandatory' }, 401);
    const list = invoices.filter(x => x.storeId === 'store-central' && x.type === 'OUTBOUND_SHIPMENT' && x.shippedDatetime && x.createdDatetime.slice(0, 10) >= a && x.createdDatetime.slice(0, 10) <= b);
    return json(list.map(x => ({ ID: x.id, customerName: x.otherPartyName, customerCode: x.otherPartyName.slice(0, 4).toUpperCase(), invoiceNumber: x.invoiceNumber, orderNumber: x.invoiceNumber + 1000,
      confirmedDate: x.createdDatetime, receivedDate: x.createdDatetime, invoiceReference: x.theirReference || '', comment: x.comment || '', storeName: 'Pharmacie centrale',
      invoiceTotal: x.pricing.totalAfterTax, lines: lines(x) })));
  }
  if (usr.loginType !== 'invoice') return json({ error: 'JWT token/user ID/store ID not found' }, 401);
  if (u.pathname === '/api/v4/stock') return json(stock.filter(s => s.storeId === 'store-central' && s.totalNumberOfPacks > 0).map(s => ({ itemCode: s.item.code, itemName: s.itemName, batchName: s.batch,
    expiryDate: s.expiryDate ? `${s.expiryDate}T00:00:00.000Z` : '', unit: s.item.unitName, barcode: '', packSize: s.packSize, quantity: s.totalNumberOfPacks, costPricePerPack: s.costPricePerPack,
    sellPricePerPack: s.sellPricePerPack, storeName: 'Pharmacie centrale' })));
  if (u.pathname === '/api/v4/customerInvoice') return json(invoices.filter(x => x.storeId === 'store-central' && x.otherPartyName === 'CS Kati' && x.status === 'SHIPPED').map(x => ({
    ID: x.id, invoiceNumber: x.invoiceNumber, confirmedDate: x.createdDatetime, receivedDate: '', acknowledgedDate: '', cancelledDate: '', invoiceReference: x.theirReference || '', comment: x.comment || '',
    orderNumber: x.invoiceNumber + 1000, storeName: 'Pharmacie centrale', invoiceTotal: x.pricing.totalAfterTax, lines: lines(x) })));
  json({ error: 'Not found' }, 404);
}).listen(PORT + 1, () => console.log(`mSupply Desktop (API REST v4) simulé sur http://localhost:${PORT + 1}`));
