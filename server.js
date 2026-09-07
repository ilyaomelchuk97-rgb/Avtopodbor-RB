'use strict';

/**
 * Motor BY — keyless Belarus car listing aggregator.
 *
 * The service intentionally uses only Node.js built-ins. Data is read from
 * publicly reachable source pages/endpoints, cached, normalized, and always
 * attributed to the original source. No sample advert is ever returned as live.
 */

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const APP_VERSION = '1.2.2';
const USER_AGENT = process.env.SOURCE_USER_AGENT ||
  `MotorBY-Aggregator/${APP_VERSION} (+https://render.com; low-rate cached public catalogue reader)`;
const SEARCH_TTL = clampInt(process.env.SEARCH_CACHE_TTL, 30, 900, 180);
const DETAIL_TTL = clampInt(process.env.DETAIL_CACHE_TTL, 60, 3600, 600);
const CATALOG_TTL = clampInt(process.env.CATALOG_CACHE_TTL, 300, 86400, 21600);
const AV_TAXONOMY_TTL = clampInt(process.env.AV_TAXONOMY_CACHE_TTL, 1800, 172800, 43200);
const AV_REQUEST_TIMEOUT = clampInt(process.env.AV_SOURCE_TIMEOUT_MS, 5000, 30000, 14000);

const ONLINER_SEARCH = 'https://ab.onliner.by/sdapi/ab.api/search/vehicles';
const ONLINER_SCHEMA = 'https://ab.onliner.by/sdapi/ab.api/schemas/vehicles/search';
const ONLINER_API = 'https://ab.api.onliner.by';
const KUFAR_ROOT = 'https://auto.kufar.by/l/cars';
const AV_ROOT = 'https://cars.av.by/filter';
const AV_ANDROID_API = 'https://android-api.av.by/';
const JINA_READER = 'https://r.jina.ai/';
const ATLANT_STOCK_API = 'https://stock-service.atlantm.by/api';
const ATLANT_PUBLIC_ROOT = 'https://atlantm.by/cars';
const MEDIA_HOSTS = new Set([
  'content.onliner.by', 'imgproxy.onliner.by', 'rms.kufar.by', 'avcdn.av.by',
  'io.activecloud.com', 'dealers-service.atlantm.by',
]);
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

class SourceError extends Error {
  constructor(source, code, publicMessage, technicalMessage = '') {
    super(technicalMessage || publicMessage);
    this.name = 'SourceError';
    this.source = source;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

class TTLCache {
  constructor(maxEntries = 400) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.inflight = new Map();
  }

  get(key, allowStale = false) {
    const item = this.entries.get(key);
    if (!item) return undefined;
    if (!allowStale && item.expiresAt <= Date.now()) return undefined;
    // Touch the entry so Map order acts as a small LRU.
    this.entries.delete(key);
    this.entries.set(key, item);
    return item.value;
  }

  set(key, value, ttlSeconds, staleSeconds = 86400) {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
      staleUntil: Date.now() + (ttlSeconds + staleSeconds) * 1000,
    });
    return value;
  }

  async remember(key, ttlSeconds, loader, { staleIfError = true, staleSeconds = 86400 } = {}) {
    const fresh = this.get(key);
    if (fresh !== undefined) return fresh;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const promise = (async () => {
      try {
        const value = await loader();
        return this.set(key, value, ttlSeconds, staleSeconds);
      } catch (error) {
        const entry = this.entries.get(key);
        if (staleIfError && entry && entry.staleUntil > Date.now()) return entry.value;
        throw error;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  stats() {
    return { entries: this.entries.size, inflight: this.inflight.size };
  }
}

const cache = new TTLCache(600);
const syntheticBrands = new Map();
const syntheticModels = new Map();
const rateBuckets = new Map();
const jinaRequestTimes = [];
const avRuntime = {
  transport: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: '',
  // Do not retry a known-blocked direct route for every user request. Render
  // deployments with an allowed egress still discover and prefer it.
  directRetryAt: 0,
};

const LABELS = {
  transmission: { automatic: 'Автомат', mechanical: 'Механика' },
  body: {
    sedan: 'Седан', universal: 'Универсал', hatchback: 'Хэтчбек', minivan: 'Минивэн',
    minibus: 'Микроавтобус', suv: 'Внедорожник / SUV', coupe: 'Купе', cabriolet: 'Кабриолет',
    pickup: 'Пикап', van: 'Фургон', limousine: 'Лимузин', liftback: 'Лифтбек',
  },
  drivetrain: { front: 'Передний', rear: 'Задний', all: 'Полный' },
  engine: { gasoline: 'Бензин', diesel: 'Дизель', electric: 'Электро' },
  state: { new: 'Новый', owned: 'С пробегом', damaged: 'Аварийный' },
};

const KUFAR_ENUMS = {
  body: { sedan: '1', universal: '2', hatchback: '3', minivan: '4', suv: '5', coupe: '6', cabriolet: '7', minibus: '8', van: '9', pickup: '10', limousine: '11', liftback: '12' },
  fuel: { gasoline: '1', diesel: '2', gas: '3', hybrid: ['4', '7'], electric: '5', methane: '6' },
  transmission: { automatic: '1', mechanical: '2' },
  state: { owned: '1', new: '2' },
  drivetrain: { front: '1', rear: '2', all: '3' },
};

// IDs published by the AV.BY Android catalogue. Arrays are expanded as
// property[0]=id, property[1]=id, matching the native client's request format.
const AV_ENUMS = {
  body: {
    sedan: [5], universal: [2], hatchback: [3, 24], minivan: [4], suv: [6, 23],
    coupe: [1], cabriolet: [7], minibus: [11, 21], van: [20], pickup: [8],
    limousine: [22], liftback: [26],
  },
  fuel: { gasoline: [1], diesel: [5], gas: [2, 3], hybrid: [4, 6], electric: [7] },
  transmission: { automatic: [1, 3, 4], mechanical: [2] },
  state: { owned: [2], new: [5], damaged: [3] },
  drivetrain: { front: [1], rear: [2], all: [3, 4] },
};

const AV_CITY_REGIONS = {
  minsk: 1005, brest: 1001, vitebsk: 1002, gomel: 1003, grodno: 1004, mogilev: 1006,
  bobruisk: 1006, borisov: 1005, baranovichi: 1001, molodechno: 1005, soligorsk: 1005, polotsk: 1002,
  minsk_region: 1005, brest_region: 1001, vitebsk_region: 1002, gomel_region: 1003,
  grodno_region: 1004, mogilev_region: 1006,
};

const AV_REGION_KEYS = new Set([
  'minsk_region', 'brest_region', 'vitebsk_region', 'gomel_region', 'grodno_region', 'mogilev_region',
]);

const CITY_MAP = {
  all: {},
  minsk: { onliner: [248, 349, 269], kufar: { rgn: '7' }, label: 'Минск' },
  brest: { onliner: [248, 249, 255], kufar: { rgn: '1', ar: '1' }, label: 'Брест' },
  vitebsk: { onliner: [248, 272, 281], kufar: { rgn: '6', ar: '18' }, label: 'Витебск' },
  gomel: { onliner: [248, 304, 312], kufar: { rgn: '2', ar: '5' }, label: 'Гомель' },
  grodno: { onliner: [248, 330, 334], kufar: { rgn: '3', ar: '9' }, label: 'Гродно' },
  mogilev: { onliner: [248, 377, 393], kufar: { rgn: '4', ar: '13' }, label: 'Могилёв' },
  bobruisk: { onliner: [248, 377, 379], kufar: { rgn: '4', ar: '12' }, label: 'Бобруйск' },
  borisov: { onliner: [248, 349, 352], kufar: { rgn: '5', ar: '15' }, label: 'Борисов' },
  baranovichi: { onliner: [248, 249, 251], kufar: { rgn: '1', ar: '37' }, label: 'Барановичи' },
  molodechno: { onliner: [248, 349, 367], kufar: { rgn: '5', ar: '16' }, label: 'Молодечно' },
  soligorsk: { onliner: [248, 349, 372], kufar: { rgn: '5', ar: '45' }, label: 'Солигорск' },
  polotsk: { onliner: [248, 272, 295], kufar: { rgn: '6', ar: '20' }, label: 'Полоцк' },
  minsk_region: { onliner: [248, 349, null], kufar: { rgn: '5' }, label: 'Минская область' },
  brest_region: { onliner: [248, 249, null], kufar: { rgn: '1' }, label: 'Брестская область' },
  gomel_region: { onliner: [248, 304, null], kufar: { rgn: '2' }, label: 'Гомельская область' },
  grodno_region: { onliner: [248, 330, null], kufar: { rgn: '3' }, label: 'Гродненская область' },
  mogilev_region: { onliner: [248, 377, null], kufar: { rgn: '4' }, label: 'Могилёвская область' },
  vitebsk_region: { onliner: [248, 272, null], kufar: { rgn: '6' }, label: 'Витебская область' },
};

// Minimal cold-start fallback. The live schema normally supplies ~200 makes.
const FALLBACK_BRANDS = [
  [62, 'Volkswagen'], [5, 'BMW'], [47, 'Opel'], [19, 'Ford'], [52, 'Renault'],
  [2, 'Audi'], [41, 'Mercedes-Benz'], [48, 'Peugeot'], [12, 'Citroen'], [45, 'Nissan'],
  [39, 'Mazda'], [61, 'Toyota'], [20, 'Geely'], [32, 'Kia'], [25, 'Hyundai'],
].map(([id, name]) => ({ id, name, popular: true }));

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function asNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
  return value === null || value === undefined ? '' : String(value).replace(/\u00a0/g, ' ').trim();
}

function safeDate(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normaliseSearch(url) {
  const sourceValues = url.searchParams.getAll('source')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const defaultSources = ['onliner', 'kufar', 'av', 'dealer', 'autohouse'];
  const sources = [...new Set(sourceValues.length ? sourceValues : defaultSources)]
    .filter((source) => defaultSources.includes(source));

  return {
    sources: sources.length ? sources : defaultSources,
    brandId: asNumber(url.searchParams.get('brand')),
    brandName: cleanText(url.searchParams.get('brandName')),
    brandSlug: cleanText(url.searchParams.get('brandSlug')),
    modelId: asNumber(url.searchParams.get('model')),
    modelName: cleanText(url.searchParams.get('modelName')),
    modelSlug: cleanText(url.searchParams.get('modelSlug')),
    generationId: asNumber(url.searchParams.get('generation')),
    generationName: cleanText(url.searchParams.get('generationName')),
    priceFrom: asNumber(url.searchParams.get('priceFrom')),
    priceTo: asNumber(url.searchParams.get('priceTo')),
    yearFrom: asNumber(url.searchParams.get('yearFrom')),
    yearTo: asNumber(url.searchParams.get('yearTo')),
    mileageTo: asNumber(url.searchParams.get('mileageTo')),
    mode: ['all', 'owned', 'new', 'electric'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'all',
    body: cleanText(url.searchParams.get('body')),
    fuel: cleanText(url.searchParams.get('fuel')),
    transmission: cleanText(url.searchParams.get('transmission')),
    drivetrain: cleanText(url.searchParams.get('drivetrain')),
    city: CITY_MAP[url.searchParams.get('city')] ? url.searchParams.get('city') : 'all',
    page: clampInt(url.searchParams.get('page'), 1, 5, 1),
    limit: clampInt(url.searchParams.get('limit'), 4, 16, 8),
  };
}

function sourceHeaders(source, accept = '*/*') {
  const headers = {
    'user-agent': USER_AGENT,
    accept,
    'accept-language': 'ru-BY,ru;q=0.9,en;q=0.6',
    'cache-control': 'no-cache',
  };
  if (source === 'onliner') headers.referer = 'https://ab.onliner.by/';
  if (source === 'kufar') headers.referer = 'https://auto.kufar.by/';
  if (source === 'av') headers.referer = 'https://cars.av.by/';
  if (source === 'dealer' || source === 'autohouse' || source === 'atlant') {
    headers.referer = 'https://atlantm.by/';
    headers.origin = 'https://atlantm.by';
  }
  return headers;
}

async function sourceFetch(url, {
  source, type = 'text', timeout = 12000, method = 'GET', body = null,
} = {}) {
  let response;
  try {
    const headers = sourceHeaders(source, type === 'json' ? 'application/json' : 'text/html,application/xhtml+xml');
    if (body !== null) headers['content-type'] = 'application/json';
    response = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new SourceError(source, timedOut ? 'timeout' : 'network',
      timedOut ? 'Источник не ответил вовремя' : 'Не удалось связаться с источником', error.message);
  }

  if (!response.ok) {
    const blocked = [403, 429, 468].includes(response.status);
    throw new SourceError(source, blocked ? 'blocked' : `http_${response.status}`,
      blocked ? 'Источник временно ограничил автоматический доступ' : `Источник ответил с кодом ${response.status}`,
      `${response.status} ${response.statusText} — ${url}`);
  }

  try {
    return type === 'json' ? await response.json() : await response.text();
  } catch (error) {
    throw new SourceError(source, 'format_changed', 'Формат ответа источника изменился', error.message);
  }
}

async function getOnlinerSchema() {
  return cache.remember('onliner:schema', CATALOG_TTL, () => sourceFetch(ONLINER_SCHEMA, { source: 'onliner', type: 'json' }));
}

function syntheticCatalogId(kind, ...values) {
  const text = `${kind}:${values.map((value) => cleanText(value).toLocaleLowerCase('ru')).join(':')}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return -(100000000 + ((hash >>> 0) % 800000000));
}

function brandIdentity(value) {
  return taxonomyText(value).replace(/\bcn\b/g, '').replace(/\s+/g, '');
}

function modelIdentity(value) {
  return taxonomyText(value).replace(/\s+/g, '');
}

async function getAtlantCatalogSnapshots() {
  const settled = await Promise.allSettled([
    getAtlantCatalog('dealer'), getAtlantCatalog('autohouse'),
  ]);
  return {
    dealer: settled[0].status === 'fulfilled' ? settled[0].value : [],
    autohouse: settled[1].status === 'fulfilled' ? settled[1].value : [],
    warnings: settled.filter((result) => result.status === 'rejected')
      .map((result) => cleanText(result.reason?.publicMessage || result.reason?.message)),
  };
}

async function getBrands() {
  let brands;
  let onlinerLive = true;
  const warnings = [];
  try {
    const schema = await getOnlinerSchema();
    const field = schema?.properties?.car?.items?.properties?.manufacturer;
    const popular = new Set(field?.['x-popular'] || []);
    brands = (field?.['x-enum'] || []).map((item) => ({
      id: Number(item.value), name: item.title, popular: popular.has(Number(item.value)),
      taxonomySources: ['onliner'],
    }));
    if (!brands.length) throw new Error('Brand enum missing');
  } catch (error) {
    brands = FALLBACK_BRANDS.map((brand) => ({ ...brand, taxonomySources: ['fallback'] }));
    onlinerLive = false;
    warnings.push('Использован резервный список популярных марок Onlíner');
  }

  const snapshots = await getAtlantCatalogSnapshots();
  const byName = new Map(brands.map((brand) => [brandIdentity(brand.name), brand]));
  for (const [source, catalog] of [['dealer', snapshots.dealer], ['autohouse', snapshots.autohouse]]) {
    for (const stockBrand of catalog) {
      const identity = brandIdentity(stockBrand.name);
      if (!identity) continue;
      let brand = byName.get(identity);
      if (!brand) {
        const id = syntheticCatalogId('brand', identity);
        brand = {
          id, name: cleanText(stockBrand.name), popular: false,
          taxonomySources: [], external: true,
        };
        syntheticBrands.set(id, { name: brand.name, identity });
        brands.push(brand);
        byName.set(identity, brand);
      }
      if (!brand.taxonomySources.includes(source)) brand.taxonomySources.push(source);
    }
  }
  warnings.push(...snapshots.warnings.filter(Boolean));
  return {
    brands,
    live: onlinerLive,
    augmented: Boolean(snapshots.dealer.length || snapshots.autohouse.length),
    catalogs: {
      onliner: onlinerLive, dealer: Boolean(snapshots.dealer.length), autohouse: Boolean(snapshots.autohouse.length),
    },
    warning: warnings.filter(Boolean).join('. ') || undefined,
  };
}

function findStockBrand(snapshots, wantedName = '', wantedId = null) {
  for (const catalog of [snapshots.dealer, snapshots.autohouse]) {
    for (const brand of catalog) {
      const identity = brandIdentity(brand.name);
      if ((wantedName && identity === brandIdentity(wantedName))
        || (wantedId !== null && syntheticCatalogId('brand', identity) === wantedId)) return brand;
    }
  }
  return null;
}

async function getModels(brandId) {
  const snapshotsPromise = getAtlantCatalogSnapshots();
  let onlinerData = null;
  let brandName = syntheticBrands.get(brandId)?.name || '';
  if (brandId > 0) {
    onlinerData = await cache.remember(`onliner:models:${brandId}`, CATALOG_TTL,
      () => sourceFetch(`${ONLINER_API}/manufacturers/${brandId}`, { source: 'onliner', type: 'json' }));
    brandName = cleanText(onlinerData.name);
  }

  const snapshots = await snapshotsPromise;
  const stockBrands = [
    findStockBrand({ dealer: snapshots.dealer, autohouse: [] }, brandName, brandId < 0 ? brandId : null),
    findStockBrand({ dealer: [], autohouse: snapshots.autohouse }, brandName, brandId < 0 ? brandId : null),
  ].filter(Boolean);
  if (!brandName && stockBrands[0]) brandName = cleanText(stockBrands[0].name);
  if (!onlinerData && !stockBrands.length) {
    throw new SourceError('catalog', 'unknown_brand', 'Марка отсутствует в доступных справочниках');
  }

  const models = (onlinerData?.models || []).map((model) => ({
    id: model.id, name: model.name, slug: model.slug,
    generationCount: model.counters?.generations || 0,
    taxonomySources: ['onliner'],
  }));
  const byName = new Map(models.map((model) => [modelIdentity(model.name), model]));
  for (const stockBrand of stockBrands) {
    const source = snapshots.dealer.includes(stockBrand) ? 'dealer' : 'autohouse';
    for (const stockModel of stockBrand.models || []) {
      const identity = modelIdentity(stockModel.name);
      if (!identity) continue;
      let model = byName.get(identity);
      if (!model) {
        const id = syntheticCatalogId('model', brandIdentity(brandName), identity);
        model = {
          id, name: cleanText(stockModel.name), slug: cleanText(stockModel.slug),
          generationCount: 0, taxonomySources: [], external: true,
        };
        syntheticModels.set(id, { brandId, brandName, name: model.name, slug: model.slug });
        models.push(model);
        byName.set(identity, model);
      }
      if (!model.taxonomySources.includes(source)) model.taxonomySources.push(source);
    }
  }
  return {
    brand: {
      id: onlinerData?.id || brandId,
      name: onlinerData?.name || brandName,
      slug: onlinerData?.slug || cleanText(stockBrands[0]?.slug),
    },
    models,
    augmented: stockBrands.length > 0,
  };
}

async function getGenerations(brandId, modelId) {
  if (brandId < 0 || modelId < 0) {
    const model = syntheticModels.get(modelId) || {};
    return {
      brand: { id: brandId, name: model.brandName || '' },
      model: { id: modelId, name: model.name || '', slug: model.slug || '' },
      generations: [],
      live: true,
      message: 'Источник этой модели не публикует отдельный справочник поколений',
    };
  }
  const data = await cache.remember(`onliner:generations:${brandId}:${modelId}`, CATALOG_TTL,
    () => sourceFetch(`${ONLINER_API}/manufacturers/${brandId}/models/${modelId}`, { source: 'onliner', type: 'json' }));
  return {
    brand: { id: brandId },
    model: { id: data.id, name: data.name, slug: data.slug },
    generations: (data.generations || []).map((generation) => ({
      id: generation.id,
      name: generation.name,
      slug: generation.slug,
      yearFrom: generation.year?.from || null,
      yearTo: generation.year?.to || null,
      image: generation.images?.['256x192'] || generation['256x192'] || generation.images?.original || null,
    })),
  };
}

function appendRange(params, key, from, to) {
  if (from !== null) params.set(`${key}[from]`, String(from));
  if (to !== null) params.set(`${key}[to]`, String(to));
}

function buildOnlinerUrl(filters) {
  const params = new URLSearchParams();
  params.set('extended', 'true');
  params.set('limit', String(filters.limit));
  params.set('page', String(filters.page));

  if (filters.brandId) params.set('car[0][manufacturer]', String(filters.brandId));
  if (filters.modelId) params.set('car[0][model]', String(filters.modelId));
  if (filters.generationId) params.append('car[0][generation][]', String(filters.generationId));

  appendRange(params, 'price', filters.priceFrom, filters.priceTo);
  if (filters.priceFrom !== null || filters.priceTo !== null) params.set('price[currency]', 'BYN');
  appendRange(params, 'year', filters.yearFrom, filters.yearTo);
  appendRange(params, 'odometer', null, filters.mileageTo);

  if (filters.mode === 'owned' || filters.mode === 'new') params.append('state[]', filters.mode);
  if (filters.mode === 'electric') params.append('engine_type[]', 'electric');
  if (filters.body && LABELS.body[filters.body]) params.append('body_type[]', filters.body);
  if (filters.mode !== 'electric') {
    if (filters.fuel === 'hybrid') params.set('hybrid', 'true');
    else if (filters.fuel === 'gas') params.set('gas', 'true');
    else if (filters.fuel && filters.fuel !== 'all') params.append('engine_type[]', filters.fuel);
  }
  if (filters.transmission && LABELS.transmission[filters.transmission]) params.append('transmission[]', filters.transmission);
  if (filters.drivetrain && LABELS.drivetrain[filters.drivetrain]) params.append('drivetrain[]', filters.drivetrain);

  const city = CITY_MAP[filters.city]?.onliner;
  if (city) {
    params.set('location[country]', String(city[0]));
    params.set('location[region]', String(city[1]));
    if (city[2]) params.set('location[city]', String(city[2]));
  }
  return `${ONLINER_SEARCH}?${params}`;
}

function flattenEquipment(groups) {
  const result = [];
  for (const group of groups || []) {
    for (const item of group.items || []) {
      if (item.value === false || item.value === null || item.value === undefined || item.value === '') continue;
      const value = item.value === true || item.value === 'standard' ? '' : cleanText(item.value);
      result.push({ group: group.name, name: item.name, value });
    }
  }
  return result;
}

function normaliseOnliner(ad, generationInfo = null, description = null) {
  const specs = ad.specs || {};
  const engine = specs.engine || {};
  let fuel = LABELS.engine[engine.type] || cleanText(engine.type);
  if (engine.hybrid) fuel = `${fuel || 'Гибрид'} · гибрид`;
  if (engine.gas) fuel = `${fuel || 'Бензин'} · газ`;
  const images = (ad.images || []).map((image) =>
    image['md@x2'] || image['lg@x1'] || image['md@x1'] || image.original).filter(Boolean);
  const priceByn = asNumber(ad.price?.converted?.BYN?.amount);
  const priceUsd = asNumber(ad.price?.converted?.USD?.amount || (ad.price?.currency === 'USD' ? ad.price.amount : null));

  return {
    id: `onliner:${ad.id}`,
    source: 'onliner',
    sourceLabel: 'Onlíner Автобарахолка',
    sourceCatalog: 'Автобарахолка Onlíner',
    provider: 'Onlíner',
    sourceId: String(ad.id),
    sourceUrl: ad.html_url || `https://ab.onliner.by/vehicle/${ad.id}`,
    title: ad.title || [ad.manufacturer?.name, ad.model?.name, ad.generation?.name].filter(Boolean).join(' '),
    brand: ad.manufacturer?.name || '',
    brandId: ad.manufacturer?.id || ad.manufacturer_id || null,
    model: ad.model?.name || '',
    modelId: ad.model?.id || ad.model_id || null,
    generation: ad.generation?.name || '',
    generationId: ad.generation?.id || null,
    generationImage: generationInfo?.image || null,
    generationYears: generationInfo ? { from: generationInfo.yearFrom, to: generationInfo.yearTo } : null,
    priceByn,
    priceUsd,
    year: specs.year || null,
    mileage: specs.odometer?.value ?? null,
    mileageUnit: specs.odometer?.unit || 'km',
    transmission: LABELS.transmission[specs.transmission] || cleanText(specs.transmission),
    engineVolume: engine.capacity ?? null,
    enginePower: engine.power?.value ?? null,
    fuel,
    body: LABELS.body[specs.body_type] || cleanText(specs.body_type),
    drivetrain: LABELS.drivetrain[specs.drivetrain] || cleanText(specs.drivetrain),
    state: LABELS.state[specs.state] || cleanText(specs.state),
    color: cleanText(specs.color),
    modification: cleanText(specs.modification),
    vin: cleanText(specs.vin),
    location: [ad.location?.city?.name, ad.location?.region?.name].filter(Boolean).join(', '),
    seller: {
      type: ad.seller?.type || '',
      name: ad.seller?.name || ad.seller?.contact_name || 'Частный продавец',
      contactName: ad.seller?.contact_name || '',
    },
    images,
    description: description ?? null,
    descriptionLoaded: description !== null,
    detailLoaded: description !== null,
    detailAvailable: true,
    equipment: flattenEquipment(ad.equipment),
    dealTerms: {
      exchange: Boolean(ad.deal_terms?.exchange),
      customsClearance: ad.deal_terms?.customs_clearance ?? null,
      includeVat: ad.deal_terms?.include_vat ?? null,
    },
    createdAt: safeDate(ad.created_at),
    updatedAt: safeDate(ad.last_up_at || ad.updated_at),
    collectedAt: new Date().toISOString(),
    stats: ad.stats || null,
  };
}

async function generationMapForOnliner(adverts) {
  const pairs = new Map();
  for (const ad of adverts) {
    const brandId = ad.manufacturer?.id;
    const modelId = ad.model?.id;
    if (brandId && modelId && ad.generation?.id) pairs.set(`${brandId}:${modelId}`, [brandId, modelId]);
  }
  // Generation images are presentation enrichment only. Never break a live search for them.
  const maps = new Map();
  await Promise.all([...pairs].slice(0, 12).map(async ([key, [brandId, modelId]]) => {
    try {
      const catalog = await getGenerations(brandId, modelId);
      maps.set(key, new Map(catalog.generations.map((generation) => [generation.id, generation])));
    } catch (_) { /* optional enrichment */ }
  }));
  return maps;
}

async function searchOnliner(filters) {
  const started = performance.now();
  if ((filters.brandId !== null && filters.brandId < 0) || (filters.modelId !== null && filters.modelId < 0)) {
    return {
      items: [],
      status: {
        source: 'onliner', label: 'Onlíner', state: 'empty', count: 0, total: 0,
        latencyMs: Math.round(performance.now() - started), sourceUrl: 'https://ab.onliner.by/',
        message: 'Выбранная марка или модель добавлена из дилерского каталога и отсутствует в справочнике Onlíner; более широкая выдача не подставлена',
        notice: true,
      },
    };
  }
  const sourceUrl = buildOnlinerUrl(filters);
  const key = `onliner:search:${sourceUrl}`;
  const data = await cache.remember(key, SEARCH_TTL,
    () => sourceFetch(sourceUrl, { source: 'onliner', type: 'json', timeout: 14000 }),
    { staleSeconds: 1800 });
  if (!Array.isArray(data.adverts)) {
    throw new SourceError('onliner', 'format_changed', 'Onlíner изменил формат каталога');
  }
  const generationMaps = await generationMapForOnliner(data.adverts);
  const items = data.adverts.map((ad) => {
    const key = `${ad.manufacturer?.id}:${ad.model?.id}`;
    return normaliseOnliner(ad, generationMaps.get(key)?.get(ad.generation?.id) || null);
  });
  return {
    items,
    status: {
      source: 'onliner', label: 'Onlíner', state: items.length ? 'ok' : 'empty',
      count: items.length, total: Number(data.total || 0), latencyMs: Math.round(performance.now() - started),
      sourceUrl, message: items.length ? 'Живые объявления получены' : 'По этим фильтрам объявлений нет',
    },
  };
}

function extractNextData(html, source = 'kufar') {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new SourceError(source, 'format_changed', 'Источник изменил структуру страницы');
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new SourceError(source, 'format_changed', 'Не удалось прочитать структурированные данные источника', error.message);
  }
}

async function getKufarState(url, ttl = SEARCH_TTL) {
  const html = await cache.remember(`kufar:html:${url}`, ttl,
    () => sourceFetch(url, { source: 'kufar', timeout: 16000 }), { staleSeconds: 1800 });
  const json = extractNextData(html, 'kufar');
  const state = json?.props?.initialState;
  if (!state) throw new SourceError('kufar', 'format_changed', 'Kufar изменил формат каталога');
  return state;
}

function kufarOptions(state, urlName) {
  const refs = state?.filters?.metadata?.parameters?.refs || {};
  const candidates = Object.values(refs).filter((ref) => ref?.url_name === urlName && Array.isArray(ref.values));
  const populated = candidates.sort((a, b) => b.values.length - a.values.length)[0];
  return (populated?.values || []).map((option) => ({
    value: option.value,
    label: option.labels?.ru || option.labels?.by || String(option.value),
  }));
}

function taxonomyText(value) {
  return cleanText(value)
    .toLocaleLowerCase('ru')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ё/g, 'е')
    .replace(/citroen/g, 'citroen')
    .replace(/mercedes\s*benz/g, 'mercedesbenz')
    .replace(/li\s*(xiang|auto)/g, 'liauto')
    .replace(/lada|ваз/g, 'lada')
    .replace(/серия|серии|series?/g, '')
    .replace(/рестайлинг/g, 'rest')
    .replace(/поколение/g, '')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findTaxonomyOption(options, wanted, { generation = false } = {}) {
  const target = taxonomyText(wanted);
  if (!target) return null;
  const exact = options.find((option) => taxonomyText(option.label) === target);
  if (exact) return exact;

  let best = null;
  let bestScore = 0;
  const targetTokens = new Set(target.split(' ').filter(Boolean));
  for (const option of options) {
    const candidate = taxonomyText(option.label);
    if (!candidate) continue;
    if (candidate.includes(target) || target.includes(candidate)) {
      const score = Math.min(candidate.length, target.length) / Math.max(candidate.length, target.length) + 0.45;
      if (score > bestScore) { bestScore = score; best = option; }
      continue;
    }
    const tokens = new Set(candidate.split(' ').filter(Boolean));
    const overlap = [...targetTokens].filter((token) => tokens.has(token)).length;
    const score = overlap / Math.max(targetTokens.size, tokens.size, 1);
    if (score > bestScore) { bestScore = score; best = option; }
  }
  return bestScore >= (generation ? 0.34 : 0.58) ? best : null;
}

async function resolveKufarTaxonomy(filters) {
  if (!filters.brandName) return {};
  const rootState = await getKufarState(KUFAR_ROOT, CATALOG_TTL);
  const brandOption = findTaxonomyOption(kufarOptions(rootState, 'cbnd2'), filters.brandName);
  if (!brandOption) throw new SourceError('kufar', 'taxonomy', `Kufar не распознал марку «${filters.brandName}»`);
  const resolved = { brand: brandOption.value };

  if (filters.modelName) {
    const brandUrl = new URL(KUFAR_ROOT);
    brandUrl.searchParams.set('cbnd2', resolved.brand);
    const brandState = await getKufarState(brandUrl.toString(), CATALOG_TTL);
    const modelOption = findTaxonomyOption(kufarOptions(brandState, 'cmdl2'), filters.modelName);
    if (!modelOption) {
      resolved.warning = `Модель «${filters.modelName}» не сопоставлена: Kufar отфильтрован только по марке`;
      return resolved;
    }
    resolved.model = modelOption.value;

    if (filters.generationName) {
      const modelUrl = new URL(KUFAR_ROOT);
      modelUrl.searchParams.set('cbnd2', resolved.brand);
      modelUrl.searchParams.set('cmdl2', resolved.model);
      const modelState = await getKufarState(modelUrl.toString(), CATALOG_TTL);
      const generationOption = findTaxonomyOption(kufarOptions(modelState, 'cgen2'), filters.generationName, { generation: true });
      if (generationOption) resolved.generation = generationOption.value;
      else resolved.warning = `Поколение «${filters.generationName}» не сопоставлено: Kufar отфильтрован до модели`;
    }
  }
  return resolved;
}

function kufarRange(from, to, multiplier = 1) {
  if (from === null && to === null) return null;
  const minimum = from === null ? 0 : Math.round(from * multiplier);
  const maximum = to === null ? 999999999 : Math.round(to * multiplier);
  return `r:${minimum},${maximum}`;
}

function addKufarEnum(params, key, value) {
  if (!value) return;
  params.set(key, Array.isArray(value) ? `v.or:${value.join(',')}` : value);
}

async function buildKufarUrl(filters) {
  const taxonomy = await resolveKufarTaxonomy(filters);
  const url = new URL(KUFAR_ROOT);
  if (taxonomy.brand) url.searchParams.set('cbnd2', taxonomy.brand);
  if (taxonomy.model) url.searchParams.set('cmdl2', taxonomy.model);
  if (taxonomy.generation) url.searchParams.set('cgen2', taxonomy.generation);

  const price = kufarRange(filters.priceFrom, filters.priceTo, 100);
  const year = kufarRange(filters.yearFrom, filters.yearTo);
  const mileage = kufarRange(null, filters.mileageTo);
  if (price) url.searchParams.set('prc', price);
  if (year) url.searchParams.set('rgd', year);
  if (mileage) url.searchParams.set('mlg', mileage);

  if (filters.mode === 'owned' || filters.mode === 'new') addKufarEnum(url.searchParams, 'cnd', KUFAR_ENUMS.state[filters.mode]);
  if (filters.mode === 'electric') addKufarEnum(url.searchParams, 'cre', KUFAR_ENUMS.fuel.electric);
  if (filters.body) addKufarEnum(url.searchParams, 'crt', KUFAR_ENUMS.body[filters.body]);
  if (filters.mode !== 'electric' && filters.fuel && filters.fuel !== 'all') addKufarEnum(url.searchParams, 'cre', KUFAR_ENUMS.fuel[filters.fuel]);
  if (filters.transmission) addKufarEnum(url.searchParams, 'crg', KUFAR_ENUMS.transmission[filters.transmission]);
  if (filters.drivetrain) addKufarEnum(url.searchParams, 'crd', KUFAR_ENUMS.drivetrain[filters.drivetrain]);

  const city = CITY_MAP[filters.city]?.kufar;
  if (city?.rgn) url.searchParams.set('rgn', city.rgn);
  if (city?.ar) url.searchParams.set('ar', city.ar);
  return { url, warning: taxonomy.warning || '' };
}

function kufarParamMap(ad) {
  const result = {};
  for (const item of ad.ad_parameters || []) result[item.p] = item;
  return result;
}

function normaliseKufarList(ad) {
  const params = kufarParamMap(ad);
  const images = (ad.images || []).map((image) => image.path ? `https://rms.kufar.by/v1/list_thumbs_2x/${image.path}` : null).filter(Boolean);
  const brand = params.cars_brand_v2?.vl || '';
  const model = params.cars_model_v2?.vl || '';
  const generation = params.cars_gen_v2?.vl || '';
  return {
    id: `kufar:${ad.ad_id}`,
    source: 'kufar',
    sourceLabel: 'Kufar Авто',
    sourceCatalog: 'Каталог автомобилей Kufar',
    provider: 'Kufar',
    sourceId: String(ad.ad_id),
    sourceUrl: ad.ad_link || `https://auto.kufar.by/vi/${ad.ad_id}`,
    title: ad.subject || [brand, model, generation].filter(Boolean).join(' '),
    brand,
    brandId: null,
    model,
    modelId: null,
    generation,
    generationId: null,
    generationImage: images[0] || null,
    generationYears: null,
    priceByn: asNumber(ad.price_byn) !== null ? asNumber(ad.price_byn) / 100 : null,
    priceUsd: asNumber(ad.price_usd) !== null ? asNumber(ad.price_usd) / 100 : null,
    year: asNumber(params.regdate?.v),
    mileage: asNumber(params.mileage?.v),
    mileageUnit: 'km',
    transmission: params.cars_gearbox?.vl || '',
    engineVolume: params.cars_capacity?.vl ? asNumber(String(params.cars_capacity.vl).replace(/[^0-9,.]/g, '')) : null,
    enginePower: null,
    fuel: params.cars_engine?.vl || '',
    body: params.cars_type?.vl || '',
    drivetrain: params.cars_drive?.vl || '',
    state: params.condition?.vl || '',
    color: params.cars_color?.vl || '',
    modification: '',
    vin: '',
    location: [params.region?.vl, params.area?.vl].filter(Boolean).join(', '),
    seller: {
      type: ad.company_ad ? 'autohaus' : 'private',
      name: ad.company_name || ad.account_parameters?.find((item) => item.p === 'name')?.v || 'Частный продавец',
      contactName: '',
    },
    images,
    description: ad.body_short || ad.body || null,
    descriptionLoaded: Boolean(ad.body_short || ad.body),
    detailLoaded: false,
    detailAvailable: true,
    equipment: (ad.ad_parameters || []).filter((item) => !['category', 'cars_brand_v2', 'cars_model_v2', 'cars_gen_v2', 'regdate', 'mileage', 'cars_engine', 'cars_capacity', 'cars_gearbox', 'cars_type', 'cars_drive', 'condition', 'region', 'area'].includes(item.p)).map((item) => ({ group: 'Характеристики', name: item.pl, value: cleanText(item.vl || item.v) })),
    dealTerms: { exchange: false, customsClearance: null, includeVat: null },
    createdAt: safeDate(ad.list_time),
    updatedAt: safeDate(ad.list_time),
    collectedAt: new Date().toISOString(),
    stats: null,
  };
}

function uniqueKufarAds(listing) {
  const output = [];
  const seen = new Set();
  // Ordinary ads first: this keeps paid VIP repeats from crowding organic results.
  for (const ad of [...(listing?.ads || []), ...(listing?.vip || [])]) {
    const id = String(ad?.ad_id || '');
    if (!id || seen.has(id) || !ad.images?.length || asNumber(ad.price_byn, 0) <= 0) continue;
    seen.add(id);
    output.push(ad);
  }
  return output;
}

function locallyMatchesKufar(item, filters) {
  if (filters.priceFrom !== null && item.priceByn !== null && item.priceByn < filters.priceFrom) return false;
  if (filters.priceTo !== null && item.priceByn !== null && item.priceByn > filters.priceTo) return false;
  if (filters.yearFrom !== null && item.year !== null && item.year < filters.yearFrom) return false;
  if (filters.yearTo !== null && item.year !== null && item.year > filters.yearTo) return false;
  if (filters.mileageTo !== null && item.mileage !== null && item.mileage > filters.mileageTo) return false;
  return true;
}

async function searchKufar(filters) {
  const started = performance.now();
  const built = await buildKufarUrl(filters);
  let state = await getKufarState(built.url.toString(), SEARCH_TTL);
  if (filters.page > 1) {
    const token = state?.listing?.pagination?.find((page) => Number(page.num) === filters.page)?.token;
    if (token) {
      built.url.searchParams.set('cursor', token);
      state = await getKufarState(built.url.toString(), SEARCH_TTL);
    } else {
      return {
        items: [],
        status: {
          source: 'kufar', label: 'Kufar', state: 'empty', count: 0,
          total: Number(state?.listing?.total || 0), latencyMs: Math.round(performance.now() - started),
          sourceUrl: built.url.toString(), message: 'Следующей страницы у Kufar нет',
        },
      };
    }
  }
  if (!state.listing || (!Array.isArray(state.listing.ads) && !Array.isArray(state.listing.vip))) {
    throw new SourceError('kufar', 'format_changed', 'Kufar изменил формат каталога');
  }
  const items = uniqueKufarAds(state.listing)
    .map(normaliseKufarList)
    .filter((item) => locallyMatchesKufar(item, filters))
    .slice(0, filters.limit);
  const message = [items.length ? 'Живые объявления получены' : 'По этим фильтрам объявлений нет', built.warning].filter(Boolean).join('. ');
  return {
    items,
    status: {
      source: 'kufar', label: 'Kufar', state: items.length ? (built.warning ? 'partial' : 'ok') : 'empty',
      count: items.length, total: Number(state.listing.total || state.listing.count || 0),
      latencyMs: Math.round(performance.now() - started), sourceUrl: built.url.toString(), message,
    },
  };
}

function noteAvSuccess(transport) {
  avRuntime.transport = transport;
  avRuntime.lastSuccessAt = new Date().toISOString();
  avRuntime.lastError = '';
}

function noteAvFailure(error) {
  avRuntime.lastFailureAt = new Date().toISOString();
  avRuntime.lastError = cleanText(error?.publicMessage || error?.message || 'AV.BY недоступен');
}

function reserveJinaRequest() {
  const now = Date.now();
  while (jinaRequestTimes.length && jinaRequestTimes[0] <= now - 60000) jinaRequestTimes.shift();
  // Reader currently advertises a 20 requests / 60 seconds limit. Keep two
  // requests in reserve and fail this adapter cleanly instead of causing a burst.
  if (jinaRequestTimes.length >= 18) {
    throw new SourceError('av', 'relay_rate_limit',
      'Резервный транспорт AV.BY достиг минутного лимита; повторите поиск немного позже');
  }
  jinaRequestTimes.push(now);
}

function parseJsonText(text, publicMessage = 'AV.BY изменил формат ответа') {
  const normalized = cleanText(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new SourceError('av', 'format_changed', publicMessage, error.message);
  }
}

async function fetchAvDirect(target, timeout) {
  let response;
  try {
    response = await fetch(target, {
      headers: sourceHeaders('av', 'application/json'),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new SourceError('av', timedOut ? 'timeout' : 'network',
      timedOut ? 'AV.BY не ответил вовремя' : 'Не удалось связаться с AV.BY', error.message);
  }
  if (!response.ok) {
    const blocked = [403, 429, 468].includes(response.status);
    throw new SourceError('av', blocked ? 'blocked' : `http_${response.status}`,
      blocked ? 'Прямой мобильный канал AV.BY ограничил серверный доступ' : `AV.BY ответил с кодом ${response.status}`,
      `${response.status} ${response.statusText} — ${target}`);
  }
  const text = await response.text();
  return parseJsonText(text);
}

async function fetchAvViaReader(target, timeout) {
  reserveJinaRequest();
  let response;
  try {
    response = await fetch(`${JINA_READER}${target.href}`, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json',
        'x-return-format': 'markdown',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new SourceError('av', timedOut ? 'timeout' : 'network',
      timedOut ? 'Резервный транспорт AV.BY не ответил вовремя' : 'Резервный транспорт AV.BY недоступен', error.message);
  }
  if (!response.ok) {
    const limited = response.status === 429;
    throw new SourceError('av', limited ? 'relay_rate_limit' : `relay_http_${response.status}`,
      limited ? 'Резервный транспорт AV.BY достиг минутного лимита; повторите поиск позже'
        : `Резервный транспорт AV.BY ответил с кодом ${response.status}`,
      `${response.status} ${response.statusText} — ${target}`);
  }

  let wrapper;
  try { wrapper = await response.json(); }
  catch (error) {
    throw new SourceError('av', 'format_changed', 'Резервный транспорт AV.BY изменил формат ответа', error.message);
  }
  const targetStatus = asNumber(wrapper?.data?.httpStatus);
  if (targetStatus !== null && (targetStatus < 200 || targetStatus >= 300)) {
    const blocked = [403, 429, 468].includes(targetStatus);
    throw new SourceError('av', blocked ? 'blocked' : `http_${targetStatus}`,
      blocked ? 'AV.BY временно ограничил доступ к мобильному каталогу' : `AV.BY ответил с кодом ${targetStatus}`);
  }
  if (typeof wrapper?.data?.content !== 'string') {
    throw new SourceError('av', 'format_changed', 'Резервный транспорт не вернул данные AV.BY');
  }
  return parseJsonText(wrapper.data.content);
}

async function fetchAvJson(resource, { timeout = AV_REQUEST_TIMEOUT } = {}) {
  const target = new URL(resource, AV_ANDROID_API);
  if (target.origin !== new URL(AV_ANDROID_API).origin) {
    throw new SourceError('av', 'invalid_target', 'Некорректный адрес мобильного каталога AV.BY');
  }

  // Prefer AV.BY itself. A known SafeLine block is remembered briefly so one
  // public search does not make two doomed upstream requests every time.
  if (Date.now() >= avRuntime.directRetryAt) {
    try {
      const data = await fetchAvDirect(target, timeout);
      noteAvSuccess('direct');
      return { data, transport: 'direct', targetUrl: target.href };
    } catch (error) {
      avRuntime.directRetryAt = Date.now() + (error?.code === 'blocked' ? 15 * 60 : 2 * 60) * 1000;
    }
  }

  try {
    const data = await fetchAvViaReader(target, timeout);
    noteAvSuccess('reader');
    return { data, transport: 'reader', targetUrl: target.href };
  } catch (error) {
    noteAvFailure(error);
    throw error;
  }
}

async function getAvBrands() {
  const response = await cache.remember('av:taxonomy:brands', AV_TAXONOMY_TTL,
    () => fetchAvJson('offer-types/cars/modifications-catalog/brands'), { staleSeconds: 172800 });
  if (!Array.isArray(response.data)) throw new SourceError('av', 'format_changed', 'AV.BY изменил каталог марок');
  return response.data;
}

async function getAvModels(brandId) {
  const response = await cache.remember(`av:taxonomy:models:${brandId}`, AV_TAXONOMY_TTL,
    () => fetchAvJson(`offer-types/cars/modifications-catalog/brands/${encodeURIComponent(brandId)}/models`),
    { staleSeconds: 172800 });
  if (!Array.isArray(response.data)) throw new SourceError('av', 'format_changed', 'AV.BY изменил каталог моделей');
  return response.data;
}

async function getAvGenerations(modelId) {
  const response = await cache.remember(`av:taxonomy:generations:${modelId}`, AV_TAXONOMY_TTL,
    () => fetchAvJson(`offer-types/cars/modifications-catalog/models/${encodeURIComponent(modelId)}/generations`),
    { staleSeconds: 172800 });
  if (!Array.isArray(response.data)) throw new SourceError('av', 'format_changed', 'AV.BY изменил каталог поколений');
  return response.data;
}

async function getAvCities(regionId) {
  const response = await cache.remember(`av:places:${regionId}`, AV_TAXONOMY_TTL,
    () => fetchAvJson(`places?parent=${encodeURIComponent(regionId)}`), { staleSeconds: 172800 });
  if (!Array.isArray(response.data)) throw new SourceError('av', 'format_changed', 'AV.BY изменил каталог городов');
  return response.data;
}

function avTaxonomyOptions(items) {
  return (items || []).map((item) => ({
    value: item.id,
    label: cleanText(item.label || item.name),
    slug: cleanText(item.slug),
    raw: item,
  })).filter((item) => item.value !== null && item.value !== undefined && item.label);
}

async function resolveAvTaxonomy(filters) {
  const wantedBrand = filters.brandName || filters.brandSlug;
  if (!wantedBrand) return {};
  const brand = findTaxonomyOption(avTaxonomyOptions(await getAvBrands()), wantedBrand);
  if (!brand) return { unmapped: `Марка «${wantedBrand}» не сопоставлена с каталогом AV.BY` };
  const result = { brand: brand.value };

  const wantedModel = filters.modelName || filters.modelSlug;
  if (!wantedModel) return result;
  const model = findTaxonomyOption(avTaxonomyOptions(await getAvModels(result.brand)), wantedModel);
  if (!model) return { ...result, unmapped: `Модель «${wantedModel}» не сопоставлена с каталогом AV.BY` };
  result.model = model.value;

  if (!filters.generationName) return result;
  const generation = findTaxonomyOption(avTaxonomyOptions(await getAvGenerations(result.model)),
    filters.generationName, { generation: true });
  if (!generation) {
    return { ...result, unmapped: `Поколение «${filters.generationName}» не сопоставлено с каталогом AV.BY` };
  }
  result.generation = generation.value;
  result.generationData = generation.raw;
  return result;
}

async function resolveAvLocation(filters) {
  if (filters.city === 'all') return {};
  const region = AV_CITY_REGIONS[filters.city];
  if (!region) return { unmapped: `Регион «${filters.city}» не сопоставлен с каталогом AV.BY` };
  if (AV_REGION_KEYS.has(filters.city)) return { region };

  const wanted = CITY_MAP[filters.city]?.label || filters.city;
  const city = findTaxonomyOption(avTaxonomyOptions(await getAvCities(region)), wanted);
  if (!city) return { region, unmapped: `Город «${wanted}» не сопоставлен с каталогом AV.BY` };
  return { region, city: city.value };
}

function setAvArray(params, name, values) {
  [...new Set((values || []).filter((value) => value !== null && value !== undefined))]
    .forEach((value, index) => params.set(`${name}[${index}]`, String(value)));
}

function setAvRange(params, name, from, to) {
  // AV.BY silently ignores [from]/[to]. Its Android filter contract uses
  // [min]/[max], verified against initialValue and returned adverts.
  if (from !== null) params.set(`${name}[min]`, String(from));
  if (to !== null) params.set(`${name}[max]`, String(to));
}

async function buildAvRequest(filters) {
  const taxonomy = await resolveAvTaxonomy(filters);
  if (taxonomy.unmapped) return { unmapped: taxonomy.unmapped, publicUrl: AV_ROOT };
  const location = await resolveAvLocation(filters);
  if (location.unmapped) return { unmapped: location.unmapped, publicUrl: AV_ROOT };

  const params = new URLSearchParams();
  params.set('page', String(filters.page));
  params.set('sort', '4');
  if (taxonomy.brand) params.set('brands[0][brand]', String(taxonomy.brand));
  if (taxonomy.model) params.set('brands[0][model]', String(taxonomy.model));
  if (taxonomy.generation) params.set('brands[0][generation]', String(taxonomy.generation));

  setAvRange(params, 'price_byn', filters.priceFrom, filters.priceTo);
  if (filters.priceFrom !== null || filters.priceTo !== null) params.set('price_currency', '1');
  setAvRange(params, 'year', filters.yearFrom, filters.yearTo);
  setAvRange(params, 'mileage_km', null, filters.mileageTo);

  if (filters.mode === 'owned' || filters.mode === 'new') setAvArray(params, 'condition', AV_ENUMS.state[filters.mode]);
  if (filters.body) setAvArray(params, 'body_type', AV_ENUMS.body[filters.body]);
  if (filters.mode === 'electric') setAvArray(params, 'engine_type', AV_ENUMS.fuel.electric);
  else if (filters.fuel && filters.fuel !== 'all') setAvArray(params, 'engine_type', AV_ENUMS.fuel[filters.fuel]);
  if (filters.transmission) setAvArray(params, 'transmission_type', AV_ENUMS.transmission[filters.transmission]);
  if (filters.drivetrain) setAvArray(params, 'drive_type', AV_ENUMS.drivetrain[filters.drivetrain]);
  if (location.region) setAvArray(params, 'place_region', [location.region]);
  if (location.city) setAvArray(params, 'place_city', [location.city]);

  const apiPath = `offer-types/cars/filters/main/init?${params}`;
  const publicUrl = new URL(AV_ROOT);
  publicUrl.search = params.toString();
  return { apiPath, publicUrl: publicUrl.href, taxonomy, location };
}

function avPropertyMap(ad) {
  const values = Object.create(null);
  for (const property of ad?.properties || []) {
    if (property?.name) values[property.name] = property.value;
  }
  return values;
}

function avPhotoUrls(photos, detailed = false) {
  const urls = [];
  const seen = new Set();
  for (const photo of photos || []) {
    const url = detailed
      ? photo?.big?.url || photo?.file?.url || photo?.url || photo?.medium?.url
      : photo?.medium?.url || photo?.big?.url || photo?.file?.url || photo?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function avGenerationYears(value) {
  const match = cleanText(value).match(/\((\d{4})\s*[-–—]\s*(\d{4}|\.{2,})\)/);
  if (!match) return null;
  return { from: Number(match[1]), to: /^\d{4}$/.test(match[2]) ? Number(match[2]) : null };
}

function avEquipment(ad, properties) {
  const labels = {
    interior_color: 'Цвет салона',
    interior_material: 'Материал салона',
    registration_country: 'Регистрация',
    mixed_drive_fuel_consumption: 'Средний расход',
    mixed_driving_fuel_consumption_per_100_km: 'Средний расход',
  };
  const result = Object.entries(labels)
    .filter(([name]) => properties[name] !== null && properties[name] !== undefined && properties[name] !== '')
    .map(([name, label]) => ({ group: 'Характеристики', name: label, value: cleanText(properties[name]) }));
  for (const option of ad?.metadata?.options || []) {
    if (!option?.name) continue;
    result.push({
      group: cleanText(option.optionGroup?.name || 'Оснащение'),
      name: cleanText(option.name),
      value: '',
    });
  }
  const unique = new Map();
  for (const item of result) unique.set(`${item.group}:${item.name}:${item.value}`, item);
  return [...unique.values()];
}

function normaliseAv(ad, { detailed = false, generationData = null } = {}) {
  const properties = avPropertyMap(ad);
  const images = avPhotoUrls(ad.photos, detailed);
  const metadata = ad.metadata || {};
  const brand = cleanText(properties.brand);
  const model = cleanText(properties.model);
  const generation = cleanText(properties.generation);
  const fallbackUrl = metadata.brandSlug && metadata.modelSlug
    ? `https://cars.av.by/${encodeURIComponent(metadata.brandSlug)}/${encodeURIComponent(metadata.modelSlug)}/${ad.id}`
    : `https://cars.av.by/${ad.id}`;
  const exchangeAllowed = ad.exchange?.exchangeAllowed === 'allowed'
    || (ad.exchange?.type && ad.exchange.type !== 'without_exchange');
  const generationImage = generationData?.mainPhoto?.medium?.url
    || generationData?.mainPhoto?.big?.url || images[0] || null;

  return {
    id: `av:${ad.id}`,
    source: 'av',
    sourceLabel: 'AV.BY',
    sourceCatalog: 'Каталог автомобилей AV.BY',
    provider: 'AV.BY',
    sourceId: String(ad.id),
    sourceUrl: /^https:\/\/cars\.av\.by\//i.test(ad.publicUrl || '') ? ad.publicUrl : fallbackUrl,
    title: [brand, model, generation].filter(Boolean).join(' ') || `Автомобиль AV.BY №${ad.id}`,
    brand,
    brandId: metadata.brandId || null,
    model,
    modelId: metadata.modelId || null,
    generation,
    generationId: metadata.generationId || null,
    generationImage,
    generationYears: avGenerationYears(properties.generation_with_years),
    priceByn: asNumber(ad.price?.byn?.amountFiat ?? ad.price?.byn?.amount ?? properties.price_amount_byn),
    priceUsd: asNumber(ad.price?.usd?.amountFiat ?? ad.price?.usd?.amount),
    year: asNumber(properties.year ?? ad.year ?? metadata.year),
    mileage: asNumber(properties.mileage_km),
    mileageUnit: 'km',
    transmission: cleanText(properties.transmission_type),
    engineVolume: asNumber(properties.engine_capacity),
    enginePower: asNumber(properties.engine_power),
    fuel: cleanText(properties.engine_type),
    body: cleanText(properties.body_type),
    drivetrain: cleanText(properties.drive_type),
    state: cleanText(properties.condition || metadata.condition?.label),
    color: cleanText(properties.color),
    modification: cleanText(properties.modification || metadata.modificationTitle),
    vin: cleanText(metadata.vinInfo?.vin),
    location: cleanText(ad.locationName || ad.shortLocationName),
    seller: {
      type: ad.organizationId ? 'autohaus' : 'private',
      name: cleanText(ad.organizationTitle || ad.sellerName) || 'Частный продавец',
      contactName: cleanText(ad.sellerName),
    },
    images,
    description: cleanText(ad.description) || 'Описание не добавлено продавцом.',
    descriptionLoaded: true,
    detailLoaded: detailed,
    detailAvailable: true,
    equipment: avEquipment(ad, properties),
    dealTerms: { exchange: Boolean(exchangeAllowed), customsClearance: null, includeVat: null },
    createdAt: safeDate(ad.publishedAt),
    updatedAt: safeDate(ad.renewedAt || ad.publishedAt),
    collectedAt: new Date().toISOString(),
    stats: {
      originalDaysOnSale: asNumber(ad.originalDaysOnSale),
      status: cleanText(ad.publicStatus?.label || ad.status),
      top: Boolean(ad.top),
      vip: Boolean(ad.isVip),
    },
  };
}

function avUnmappedResult(message, started, sourceUrl = AV_ROOT) {
  return {
    items: [],
    status: {
      source: 'av', label: 'AV.BY', state: 'empty', count: 0, total: 0,
      latencyMs: Math.round(performance.now() - started), sourceUrl,
      message: `${message}; неподходящие объявления не подставлены`,
    },
  };
}

async function searchAv(filters) {
  const started = performance.now();
  const built = await buildAvRequest(filters);
  if (built.unmapped) return avUnmappedResult(built.unmapped, started, built.publicUrl);
  const response = await cache.remember(`av:search:${built.apiPath}`, SEARCH_TTL,
    () => fetchAvJson(built.apiPath), { staleSeconds: 1800 });
  const data = response.data;
  if (!Array.isArray(data?.adverts)) {
    throw new SourceError('av', 'format_changed', 'AV.BY изменил формат каталога объявлений');
  }
  const items = data.adverts
    .map((ad) => normaliseAv(ad, { generationData: built.taxonomy?.generationData || null }))
    // Do not replace a missing source photo with a card that looks complete.
    // AV.BY occasionally returns just-published records before media processing.
    .filter((item) => item.images.length && item.priceByn !== null)
    .slice(0, filters.limit);
  const transportMessage = response.transport === 'direct'
    ? 'напрямую из публичного мобильного каталога'
    : 'из публичного мобильного каталога через резервный reader';
  return {
    items,
    status: {
      source: 'av', label: 'AV.BY', state: items.length ? 'ok' : 'empty',
      count: items.length, total: asNumber(data.count, 0),
      latencyMs: Math.round(performance.now() - started), sourceUrl: built.publicUrl,
      message: items.length ? `Живые объявления получены ${transportMessage}` : 'По этим фильтрам объявлений AV.BY нет',
      transport: response.transport,
    },
  };
}

async function getAvDetail(id) {
  const response = await cache.remember(`av:detail:${id}`, DETAIL_TTL,
    () => fetchAvJson(`offers/${encodeURIComponent(id)}`), { staleSeconds: 3600 });
  if (!response.data?.id) throw new SourceError('av', 'format_changed', 'AV.BY изменил формат карточки объявления');
  return normaliseAv(response.data, { detailed: true });
}

const ATLANT_CONFIG = {
  dealer: {
    type: 'new', label: 'Дилеры', sourceLabel: 'Дилеры · Атлант-М',
    catalogLabel: 'Новые автомобили официальных дилеров', conditionLabel: 'Новый',
  },
  autohouse: {
    type: 'amp', label: 'Автохаусы', sourceLabel: 'Автохаус · Атлант-М',
    catalogLabel: 'Атлант-М Автомобили с пробегом', conditionLabel: 'С пробегом',
  },
};

const ATLANT_ENUMS = {
  body: {
    sedan: ['SEDAN'], universal: ['STATION_WAGON'], hatchback: ['HATCHBACK'],
    liftback: ['LIFT_BACK'], minivan: ['MINIVAN'], minibus: ['MINIBUS'],
    suv: ['SUV', 'CROSSOVER'], coupe: ['COUPE'], cabriolet: ['CABRIOLET'],
    pickup: ['PICKUP'], van: ['VAN'],
  },
  fuel: {
    gasoline: ['PETROL'], diesel: ['DIESEL'], gas: ['GAS'],
    hybrid: ['HYBRID'], electric: ['ELECTRIC'],
  },
  transmission: {
    automatic: ['AUTOMATIC', 'ROBOT', 'DSG', 'VARIATOR', 'REDUCTOR'],
    mechanical: ['MANUAL'],
  },
  drivetrain: { front: ['FRONT'], rear: ['BACK'], all: ['FULL'] },
};

function plainTextFromHtml(value) {
  return cleanText(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function atlantConfig(source) {
  const config = ATLANT_CONFIG[source];
  if (!config) throw new SourceError(source, 'invalid_source', 'Неизвестный дилерский источник');
  return config;
}

function atlantPublicUrl(type, filterPath = '/') {
  return `${ATLANT_PUBLIC_ROOT}/${type}${filterPath === '/' ? '' : filterPath}`;
}

async function fetchAtlantSearch(source, body, ttl = SEARCH_TTL) {
  const key = `atlant:search:${JSON.stringify(body)}`;
  return cache.remember(key, ttl, () => sourceFetch(`${ATLANT_STOCK_API}/cars/search`, {
    source, type: 'json', timeout: 14000, method: 'POST', body,
  }), { staleSeconds: 3600 });
}

async function getAtlantCatalog(source) {
  const config = atlantConfig(source);
  const data = await fetchAtlantSearch(source, {
    type: config.type, url: '/', offset: 0, limit: 1, sort: 'date',
  }, CATALOG_TTL);
  if (!Array.isArray(data?.catalog)) {
    throw new SourceError(source, 'format_changed', 'Атлант-М изменил формат каталога автомобилей');
  }
  return data.catalog;
}

async function resolveAtlantTaxonomy(filters, source) {
  const wantedBrand = filters.brandName || filters.brandSlug;
  if (!wantedBrand) return {};
  const catalog = await getAtlantCatalog(source);
  const brands = catalog.map((brand) => ({
    value: brand.id, label: cleanText(brand.name), slug: cleanText(brand.slug), raw: brand,
  }));
  const brand = brands.find((option) => brandIdentity(option.label) === brandIdentity(wantedBrand));
  if (!brand) return { unmapped: `Марка «${wantedBrand}» отсутствует в этом каталоге Атлант-М` };
  const result = { brand: brand.slug, brandData: brand.raw };

  const wantedModel = filters.modelName || filters.modelSlug;
  if (!wantedModel) return result;
  const models = (brand.raw?.models || []).map((model) => ({
    value: model.id, label: cleanText(model.name), slug: cleanText(model.slug), raw: model,
  }));
  const model = models.find((option) => modelIdentity(option.label) === modelIdentity(wantedModel)
    || (filters.modelSlug && cleanText(option.slug).toLowerCase() === cleanText(filters.modelSlug).toLowerCase()));
  if (!model) return { ...result, unmapped: `Модель «${wantedModel}» отсутствует в этом каталоге Атлант-М` };
  result.model = model.slug;
  result.modelData = model.raw;
  return result;
}

function addAtlantFilter(parts, key, value) {
  if (value === null || value === undefined || value === '') return;
  const safeValue = String(value).toLowerCase().replace(/[^a-zа-яё0-9_.-]/gi, '');
  if (!safeValue) return;
  parts.push(`${parts.length ? '--' : 'filter-'}${key}-${safeValue}`);
}

function atlantEmptyResult(source, started, message, sourceUrl = null) {
  const config = atlantConfig(source);
  return {
    items: [],
    status: {
      source, label: config.label, state: 'empty', count: 0, total: 0,
      latencyMs: Math.round(performance.now() - started),
      sourceUrl: sourceUrl || atlantPublicUrl(config.type), message, notice: true,
      provider: 'Атлант-М',
    },
  };
}

async function buildAtlantRequest(filters, source) {
  const config = atlantConfig(source);
  if (source === 'dealer' && filters.mode === 'owned') {
    return { unmapped: 'Источник «Дилеры» содержит только новые автомобили', publicUrl: atlantPublicUrl(config.type) };
  }
  if (source === 'autohouse' && filters.mode === 'new') {
    return { unmapped: 'Источник «Автохаусы» содержит автомобили с пробегом', publicUrl: atlantPublicUrl(config.type) };
  }
  if (!['all', 'minsk', 'minsk_region'].includes(filters.city)) {
    const location = CITY_MAP[filters.city]?.label || 'выбранном регионе';
    return {
      unmapped: `В каталоге Атлант-М сейчас нет площадки в регионе «${location}»`,
      publicUrl: atlantPublicUrl(config.type),
    };
  }
  if (source === 'autohouse' && filters.generationName) {
    return {
      unmapped: `Автохаус не публикует поколение «${filters.generationName}» в структурированном каталоге; более широкая выдача не подставлена`,
      publicUrl: atlantPublicUrl(config.type),
    };
  }

  const taxonomy = await resolveAtlantTaxonomy(filters, source);
  if (taxonomy.unmapped) return { unmapped: taxonomy.unmapped, publicUrl: atlantPublicUrl(config.type) };

  const parts = [];
  if (filters.body && ATLANT_ENUMS.body[filters.body]) {
    addAtlantFilter(parts, 'body', ATLANT_ENUMS.body[filters.body].join('-'));
  }
  const fuelValues = filters.mode === 'electric'
    ? ATLANT_ENUMS.fuel.electric
    : ATLANT_ENUMS.fuel[filters.fuel];
  if (fuelValues) addAtlantFilter(parts, 'fuel_types', fuelValues.join('-'));
  if (filters.drivetrain && ATLANT_ENUMS.drivetrain[filters.drivetrain]) {
    addAtlantFilter(parts, 'wheels', ATLANT_ENUMS.drivetrain[filters.drivetrain].join('-'));
  }
  if (filters.transmission && ATLANT_ENUMS.transmission[filters.transmission]) {
    addAtlantFilter(parts, 'gearboxes', ATLANT_ENUMS.transmission[filters.transmission].join('-'));
  }
  addAtlantFilter(parts, 'min_price', filters.priceFrom);
  addAtlantFilter(parts, 'max_price', filters.priceTo);
  addAtlantFilter(parts, 'min_year', filters.yearFrom);
  addAtlantFilter(parts, 'max_year', filters.yearTo);
  // New-car records intentionally have no odometer value. Treat them as new
  // instead of sending a max_mileage filter that would incorrectly remove all.
  if (source === 'autohouse') addAtlantFilter(parts, 'max_mileage', filters.mileageTo);
  addAtlantFilter(parts, 'brand', taxonomy.brand);
  addAtlantFilter(parts, 'model', taxonomy.model);

  const filterPath = parts.length ? `/${parts.join('')}` : '/';
  return {
    body: {
      type: config.type,
      url: filterPath,
      offset: (filters.page - 1) * filters.limit,
      limit: filters.limit,
      sort: 'date',
    },
    publicUrl: atlantPublicUrl(config.type, filterPath),
    taxonomy,
    filterPath,
  };
}

function atlantPrice(pricing, currency = 'price') {
  if (!pricing) return null;
  const discountKey = currency === 'priceUsd' ? 'discountPriceUsd' : 'discountPrice';
  return asNumber(pricing[discountKey]) ?? asNumber(pricing[currency]);
}

function atlantImages(ad, detailed = false) {
  const values = detailed ? ad?.media?.images : ad?.photos;
  return [...new Set((values || []).filter((value) => /^https:\/\//i.test(value)))];
}

function isLiveAtlantCar(ad, expectedType, detailed = false) {
  const status = cleanText(ad?.status?.id).toUpperCase();
  return Boolean(
    ad?.id && ad?.type === expectedType
    && asNumber(ad.inStockCount, 0) > 0
    && ['AVAILABLE', 'BOOKED'].includes(status)
    && ad.actionsDisabled !== true
    && atlantImages(ad, detailed).length
    && atlantPrice(ad.pricing) !== null,
  );
}

function atlantState(ad, source) {
  const config = atlantConfig(source);
  const parts = [config.conditionLabel];
  if (ad?.status?.id === 'BOOKED') parts.push(cleanText(ad.status.label) || 'Забронирован');
  else {
    if (ad?.stockStatus?.label) parts.push(cleanText(ad.stockStatus.label));
    if (source === 'autohouse' && ad?.status?.label) parts.push(cleanText(ad.status.label));
  }
  return [...new Set(parts.filter(Boolean))].join(' · ');
}

function normaliseAtlantList(ad, source, generationData = null) {
  const config = atlantConfig(source);
  const catalog = ad.catalog || {};
  const params = ad.params || {};
  const images = atlantImages(ad);
  const location = ad.locations?.[0] || {};
  const generation = generationData?.name || '';
  const title = [catalog.brand, catalog.model, generation, catalog.complectation].filter(Boolean).join(' ');
  const originalPriceByn = asNumber(ad.pricing?.price);
  const originalPriceUsd = asNumber(ad.pricing?.priceUsd);
  return {
    id: `${source}:${ad.id}`,
    source,
    sourceLabel: config.sourceLabel,
    sourceCatalog: config.catalogLabel,
    provider: 'Атлант-М',
    sourceId: String(ad.id),
    sourceUrl: atlantPublicUrl(config.type, `/${encodeURIComponent(ad.id)}`),
    title: title || `Автомобиль Атлант-М №${ad.id}`,
    brand: cleanText(catalog.brand),
    brandId: null,
    model: cleanText(catalog.model),
    modelId: null,
    generation,
    generationId: generationData?.id || null,
    generationImage: images[0] || null,
    generationYears: null,
    priceByn: atlantPrice(ad.pricing),
    priceUsd: atlantPrice(ad.pricing, 'priceUsd'),
    priceOriginalByn: originalPriceByn,
    priceOriginalUsd: originalPriceUsd,
    year: asNumber(ad.year),
    mileage: asNumber(ad.mileage),
    mileageUnit: 'km',
    transmission: cleanText(params.gearbox?.label),
    engineVolume: asNumber(params.engineCapacity),
    enginePower: null,
    fuel: cleanText(params.fuel?.label),
    body: cleanText(params.body?.label),
    drivetrain: cleanText(params.wheel?.label),
    state: atlantState(ad, source),
    color: '',
    modification: cleanText(catalog.complectation),
    vin: '',
    location: cleanText(location.address || location.name) || 'Минск',
    seller: {
      type: source === 'dealer' ? 'dealer' : 'autohaus',
      name: source === 'dealer' ? cleanText(location.name) || 'Официальный дилер Атлант-М' : config.catalogLabel,
      contactName: '',
      phone: cleanText(location.phone || ad.phone),
    },
    images,
    description: null,
    descriptionLoaded: false,
    descriptionLabel: source === 'dealer' ? 'Описание дилера' : 'Комментарий автохауса',
    detailLoaded: false,
    detailAvailable: true,
    equipment: [],
    dealTerms: { exchange: false, customsClearance: true, includeVat: null },
    createdAt: null,
    updatedAt: null,
    collectedAt: new Date().toISOString(),
    stats: {
      status: cleanText(ad.status?.label),
      statusId: cleanText(ad.status?.id),
      stockStatus: cleanText(ad.stockStatus?.label),
      inStockCount: asNumber(ad.inStockCount),
    },
  };
}

function atlantTechnicalEquipment(data) {
  const result = [];
  for (const group of data?.content?.equipment || []) {
    for (const option of group?.options || []) {
      if (!option?.name || option.value === false) continue;
      result.push({
        group: cleanText(group.section) || 'Оснащение',
        name: cleanText(option.name),
        value: option.value === true || option.value === null ? '' : cleanText(option.value),
      });
    }
  }
  for (const value of data?.content?.additional || []) {
    if (cleanText(value)) result.push({ group: 'Дополнительно', name: cleanText(value), value: '' });
  }

  const labels = {
    doorsCount: ['Количество дверей', ''], seatsCount: ['Количество мест', ''],
    height: ['Высота', ' мм'], width: ['Ширина', ' мм'], length: ['Длина', ' мм'],
    weight: ['Снаряжённая масса', ' кг'], weightFull: ['Полная масса', ' кг'],
    batteryCapacity: ['Ёмкость батареи', ' кВт·ч'], electricEnginesCount: ['Электродвигатели', ''],
    wltpExpense: ['Расход WLTP', ''], engineMaxTorque: ['Крутящий момент', ' Н·м'],
    maxSpeed: ['Максимальная скорость', ' км/ч'], time0To100: ['Разгон 0–100 км/ч', ' с'],
    clearance: ['Клиренс', ' мм'], trunkVolume: ['Объём багажника', ' л'],
    maxTrunkVolume: ['Максимальный объём багажника', ' л'], wheelBase: ['Колёсная база', ' мм'],
    distanceLimit: ['Запас хода', ' км'], gearboxCount: ['Количество передач', ''],
  };
  for (const [key, [label, unit]] of Object.entries(labels)) {
    const value = asNumber(data?.params?.[key]);
    if (value === null || value <= 0) continue;
    result.push({ group: 'Технические характеристики', name: label, value: `${value}${unit}` });
  }
  if (data?.pricing?.discountPrice && asNumber(data.pricing.price) > asNumber(data.pricing.discountPrice)) {
    result.push({ group: 'Цена', name: 'Цена до скидки', value: `${asNumber(data.pricing.price)} BYN` });
  }
  if (asNumber(data?.pricing?.minimalCreditPayment) !== null) {
    result.push({ group: 'Финансирование', name: 'Минимальный платёж', value: `${asNumber(data.pricing.minimalCreditPayment)} BYN/мес.` });
  }
  if (data?.warranty?.included || cleanText(data?.warranty?.text)) {
    result.push({ group: 'Гарантия', name: cleanText(data.warranty.text) || 'Гарантия включена', value: '' });
  }

  const unique = new Map();
  for (const item of result) {
    const key = `${item.group}:${item.name}:${item.value}`;
    if (item.name) unique.set(key, item);
  }
  return [...unique.values()];
}

function normaliseAtlantDetail(data, source, inferredGeneration = null) {
  const config = atlantConfig(source);
  const catalog = data.catalog || {};
  const params = data.params || {};
  const images = atlantImages(data, true);
  const generationData = catalog.generation || inferredGeneration;
  const generation = cleanText(generationData?.name);
  const dealer = data.dealers?.[0] || {};
  const title = [catalog.brand?.name, catalog.model?.name, generation, catalog.complectation].filter(Boolean).join(' ');
  const description = plainTextFromHtml(data.content?.description)
    || (source === 'dealer' ? 'Описание комплектации не опубликовано дилером.' : 'Комментарий к автомобилю не опубликован автохаусом.');
  return {
    id: `${source}:${data.id}`,
    source,
    sourceLabel: config.sourceLabel,
    sourceCatalog: config.catalogLabel,
    provider: 'Атлант-М',
    sourceId: String(data.id),
    sourceUrl: atlantPublicUrl(config.type, `/${encodeURIComponent(data.id)}`),
    title: title || `Автомобиль Атлант-М №${data.id}`,
    brand: cleanText(catalog.brand?.name),
    brandId: catalog.brand?.id || null,
    model: cleanText(catalog.model?.name),
    modelId: catalog.model?.id || null,
    generation,
    generationId: generationData?.id || null,
    generationImage: generationData?.media?.[0]?.url || generationData?.image || images[0] || null,
    generationYears: inferredGeneration
      ? { from: inferredGeneration.yearFrom || null, to: inferredGeneration.yearTo || null }
      : null,
    generationMethod: catalog.generation ? 'source' : inferredGeneration ? 'catalog-year-unique' : null,
    priceByn: atlantPrice(data.pricing),
    priceUsd: atlantPrice(data.pricing, 'priceUsd'),
    priceOriginalByn: asNumber(data.pricing?.price),
    priceOriginalUsd: asNumber(data.pricing?.priceUsd),
    year: asNumber(params.year),
    mileage: asNumber(params.mileage),
    mileageUnit: 'km',
    transmission: cleanText(params.gearbox?.label),
    engineVolume: asNumber(params.engineCapacity),
    enginePower: asNumber(params.enginePower),
    fuel: cleanText(params.fuel?.label),
    body: cleanText(params.body?.label),
    drivetrain: cleanText(params.wheel?.label),
    state: atlantState(data, source),
    color: cleanText(params.color?.label),
    modification: cleanText(catalog.complectation),
    vin: cleanText(data.vin),
    location: cleanText(data.location?.address || dealer.address) || 'Минск',
    seller: {
      type: source === 'dealer' ? 'dealer' : 'autohaus',
      name: cleanText(dealer.name) || (source === 'dealer' ? 'Официальный дилер Атлант-М' : config.catalogLabel),
      contactName: '',
      phone: cleanText(dealer.phone || data.location?.phone || data.phone),
    },
    images,
    description,
    descriptionLoaded: true,
    descriptionLabel: source === 'dealer' ? 'Описание дилера' : 'Комментарий автохауса',
    detailLoaded: true,
    detailAvailable: true,
    equipment: atlantTechnicalEquipment(data),
    dealTerms: {
      exchange: /trade[ -]?in|зач[её]т/i.test(description),
      customsClearance: true,
      includeVat: data.options?.withVat ?? null,
    },
    createdAt: null,
    updatedAt: null,
    collectedAt: new Date().toISOString(),
    stats: {
      status: cleanText(data.status?.label),
      statusId: cleanText(data.status?.id),
      stockStatus: cleanText(data.stockStatus?.label),
      inStockCount: asNumber(data.inStockCount),
      onlinePurchase: Boolean(data.onlinePurchase?.available),
      testDrive: Boolean(data.testDrive?.available),
      generationSource: catalog.generation ? 'Атлант-М' : inferredGeneration ? 'Onlíner: однозначный диапазон года' : '',
    },
  };
}

async function inferUnambiguousGeneration(brandName, modelName, year) {
  if (!brandName || !modelName || !Number.isFinite(Number(year))) return null;
  const key = `generation:infer:${brandIdentity(brandName)}:${modelIdentity(modelName)}:${year}`;
  return cache.remember(key, CATALOG_TTL, async () => {
    try {
      const schema = await getOnlinerSchema();
      const field = schema?.properties?.car?.items?.properties?.manufacturer;
      const brand = (field?.['x-enum'] || []).find((item) => brandIdentity(item.title) === brandIdentity(brandName));
      if (!brand) return null;
      const manufacturer = await cache.remember(`onliner:models:${brand.value}`, CATALOG_TTL,
        () => sourceFetch(`${ONLINER_API}/manufacturers/${brand.value}`, { source: 'onliner', type: 'json' }));
      const model = (manufacturer.models || []).find((item) => modelIdentity(item.name) === modelIdentity(modelName));
      if (!model) return null;
      const catalog = await getGenerations(Number(brand.value), Number(model.id));
      const candidates = catalog.generations.filter((generation) => {
        if (generation.yearFrom && Number(year) < generation.yearFrom) return false;
        if (generation.yearTo && Number(year) > generation.yearTo) return false;
        return true;
      });
      return candidates.length === 1 ? candidates[0] : null;
    } catch (_) {
      return null;
    }
  }, { staleIfError: true, staleSeconds: 86400 });
}

async function getAtlantRawDetail(id, source) {
  if (!/^[a-z0-9_-]{1,40}$/i.test(String(id))) {
    throw new SourceError(source, 'invalid_id', 'Некорректный идентификатор автомобиля');
  }
  const data = await cache.remember(`atlant:detail:${id}`, DETAIL_TTL,
    () => sourceFetch(`${ATLANT_STOCK_API}/cars/${encodeURIComponent(id)}`, {
      source, type: 'json', timeout: 14000,
    }), { staleSeconds: 3600 });
  if (!data?.id) throw new SourceError(source, 'format_changed', 'Атлант-М изменил формат карточки автомобиля');
  return data;
}

async function getAtlantDetail(id, source) {
  const config = atlantConfig(source);
  const data = await getAtlantRawDetail(id, source);
  if (!isLiveAtlantCar(data, config.type, true)) {
    throw new SourceError(source, 'not_available', 'Автомобиль больше не доступен в этом каталоге');
  }
  let inferredGeneration = null;
  if (source === 'autohouse' && !data.catalog?.generation) {
    inferredGeneration = await inferUnambiguousGeneration(
      data.catalog?.brand?.name, data.catalog?.model?.name, data.params?.year,
    );
  }
  return normaliseAtlantDetail(data, source, inferredGeneration);
}

async function searchAtlant(filters, source) {
  const started = performance.now();
  const config = atlantConfig(source);
  const built = await buildAtlantRequest(filters, source);
  if (built.unmapped) return atlantEmptyResult(source, started, built.unmapped, built.publicUrl);
  const data = await fetchAtlantSearch(source, built.body);
  if (!Array.isArray(data?.items) || !Number.isFinite(Number(data?.total))) {
    throw new SourceError(source, 'format_changed', 'Атлант-М изменил формат выдачи автомобилей');
  }

  const liveRecords = data.items.filter((item) => isLiveAtlantCar(item, config.type));
  let generationData = null;
  if (source === 'dealer' && filters.generationName && liveRecords.length) {
    const detail = await getAtlantRawDetail(liveRecords[0].id, source);
    const actualGeneration = detail.catalog?.generation;
    const matches = actualGeneration?.name
      && taxonomyText(actualGeneration.name) === taxonomyText(filters.generationName);
    if (!matches) {
      return atlantEmptyResult(source, started,
        `Поколение «${filters.generationName}» не подтверждено дилерским каталогом; более широкая выдача не подставлена`,
        built.publicUrl);
    }
    generationData = actualGeneration;
  }

  const items = liveRecords.map((item) => normaliseAtlantList(item, source, generationData));
  const booked = liveRecords.filter((item) => item.status?.id === 'BOOKED').length;
  const message = items.length
    ? [
      'Актуальные автомобили получены из публичного stock-каталога Атлант-М',
      booked ? `${booked} из показанных помечено как забронировано` : '',
    ].filter(Boolean).join('. ')
    : data.total ? 'На этой странице нет карточек с подтверждённой ценой, фотографией и активным статусом'
      : 'По этим фильтрам автомобилей нет';
  return {
    items,
    status: {
      source, label: config.label, state: items.length ? 'ok' : 'empty',
      count: items.length, total: Number(data.total || 0),
      latencyMs: Math.round(performance.now() - started), sourceUrl: built.publicUrl,
      message, provider: 'Атлант-М', catalog: config.catalogLabel,
    },
  };
}

function sourceFailureStatus(source, label, sourceUrl, error, elapsed) {
  return {
    source, label,
    state: error?.code === 'blocked' ? 'blocked' : 'error',
    count: 0, total: null, latencyMs: Math.round(elapsed), sourceUrl,
    message: error?.publicMessage || 'Источник сейчас недоступен',
    diagnostic: process.env.NODE_ENV === 'development' ? cleanText(error?.message) : undefined,
  };
}

async function getOnlinerDetail(id) {
  const data = await cache.remember(`onliner:detail:${id}`, DETAIL_TTL,
    () => sourceFetch(`${ONLINER_API}/adverts/${encodeURIComponent(id)}`, { source: 'onliner', type: 'json', timeout: 12000 }),
    { staleSeconds: 3600 });
  let generationInfo = null;
  if (data.manufacturer?.id && data.model?.id && data.generation?.id) {
    try {
      const catalog = await getGenerations(data.manufacturer.id, data.model.id);
      generationInfo = catalog.generations.find((generation) => generation.id === data.generation.id) || null;
    } catch (_) { /* optional */ }
  }
  return normaliseOnliner(data, generationInfo, data.description || 'Описание не добавлено продавцом.');
}

function normaliseKufarDetail(data) {
  const initial = data.initial || {};
  const base = normaliseKufarList({
    ...initial,
    ad_id: initial.ad_id || data.adId || data.id,
    ad_link: initial.ad_link || data.adViewLink,
    subject: initial.subject || data.subject || data.title,
    body: data.body || data.description,
    list_time: initial.list_time || data.date,
    images: initial.images || [],
    price_byn: initial.price_byn || data.calculator?.find((item) => item.currency === 'BYN')?.price,
    price_usd: initial.price_usd || data.calculator?.find((item) => item.currency === 'USD')?.price,
  });
  const params = data.adParams || {};
  const gallery = data.gallery?.images || data.images?.gallery || [];
  const equipment = Object.values(params)
    .filter((item) => item?.pl && !['Категория', 'Марка', 'Модель', 'Поколение', 'Год', 'Пробег, км', 'Тип двигателя', 'Объем, л', 'Коробка передач', 'Тип кузова', 'Привод', 'Состояние', 'Регион', 'Город / Район'].includes(item.pl))
    .map((item) => ({ group: 'Характеристики', name: item.pl, value: cleanText(item.vl || item.v) }));
  return {
    ...base,
    sourceUrl: data.adViewLink || base.sourceUrl,
    title: data.subject || data.title || base.title,
    images: gallery.length ? gallery : base.images,
    generationImage: gallery[0] || base.generationImage,
    description: data.body || data.description || 'Описание не добавлено продавцом.',
    descriptionLoaded: true,
    detailLoaded: true,
    detailAvailable: true,
    location: data.region || base.location,
    seller: {
      type: data.isCompanyAd ? 'autohaus' : 'private',
      name: data.companyName || data.userName || base.seller.name,
      contactName: data.userName || '',
    },
    equipment: equipment.length ? equipment : base.equipment,
  };
}

async function getKufarDetail(id) {
  const url = `https://auto.kufar.by/vi/cars/${encodeURIComponent(id)}`;
  const html = await cache.remember(`kufar:detail:${id}`, DETAIL_TTL,
    () => sourceFetch(url, { source: 'kufar', timeout: 16000 }), { staleSeconds: 3600 });
  const json = extractNextData(html, 'kufar');
  const data = json?.props?.initialState?.adView?.data;
  if (!data) throw new SourceError('kufar', 'format_changed', 'Kufar изменил формат карточки объявления');
  return normaliseKufarDetail(data);
}

async function runSearch(filters) {
  const tasks = filters.sources.map(async (source) => {
    const started = performance.now();
    try {
      if (source === 'onliner') return await searchOnliner(filters);
      if (source === 'kufar') return await searchKufar(filters);
      if (source === 'av') return await searchAv(filters);
      return await searchAtlant(filters, source);
    } catch (error) {
      const sourceUrl = source === 'onliner' ? buildOnlinerUrl(filters)
        : source === 'kufar' ? KUFAR_ROOT
          : source === 'av' ? AV_ROOT : atlantPublicUrl(atlantConfig(source).type);
      const labels = {
        onliner: 'Onlíner', kufar: 'Kufar', av: 'AV.BY', dealer: 'Дилеры', autohouse: 'Автохаусы',
      };
      return {
        items: [],
        status: sourceFailureStatus(source, labels[source] || source, sourceUrl, error, performance.now() - started),
      };
    }
  });
  const results = await Promise.all(tasks);
  const seen = new Set();
  const items = results.flatMap((result) => result.items).filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  items.sort((a, b) => (Date.parse(b.updatedAt || b.createdAt || 0) || 0) - (Date.parse(a.updatedAt || a.createdAt || 0) || 0));
  return {
    live: true,
    mock: false,
    query: filters,
    items,
    sourceStatus: results.map((result) => result.status),
    fetchedAt: new Date().toISOString(),
    notices: [
      'Данные принадлежат площадкам, дилерам и продавцам; цена и наличие подтверждаются на оригинальной странице.',
      'Полное описание загружается только для видимых карточек и кэшируется. Контакт показывается лишь тогда, когда сам источник публикует его структурированно.',
    ],
  };
}

function ipOf(req) {
  return cleanText(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').split(',')[0];
}

function rateAllowed(req, kind = 'api') {
  const now = Date.now();
  if (rateBuckets.size > 2000) {
    for (const [key, bucket] of rateBuckets) if (bucket.resetAt < now) rateBuckets.delete(key);
  }
  const key = `${ipOf(req)}:${kind}`;
  const max = kind === 'search' ? 18 : kind === 'detail' ? 60 : kind === 'media' ? 300 : 120;
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) bucket = { count: 0, resetAt: now + 60000 };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return { allowed: bucket.count <= max, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
}

function isAllowedMediaHost(hostname) {
  return MEDIA_HOSTS.has(hostname) || /^rms\d+\.kufar\.by$/i.test(hostname);
}

function validateMediaUrl(value) {
  let url;
  try { url = new URL(value); }
  catch (_) { throw new SourceError('media', 'invalid_url', 'Некорректный адрес изображения'); }
  if (url.protocol !== 'https:' || !isAllowedMediaHost(url.hostname)) {
    throw new SourceError('media', 'forbidden_host', 'Домен изображения не разрешён');
  }
  return url;
}

async function fetchMediaResponse(initialUrl) {
  let current = validateMediaUrl(initialUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const source = current.hostname.endsWith('onliner.by') ? 'onliner'
      : current.hostname.endsWith('av.by') ? 'av'
        : ['io.activecloud.com', 'dealers-service.atlantm.by'].includes(current.hostname) ? 'atlant' : 'kufar';
    let response;
    try {
      response = await fetch(current, {
        headers: sourceHeaders(source, 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9,*/*;q=0.5'),
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new SourceError('media', timedOut ? 'timeout' : 'network',
        timedOut ? 'Изображение не ответило вовремя' : 'Не удалось загрузить изображение', error.message);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw new SourceError('media', 'redirect', 'Ошибка перенаправления изображения');
      current = validateMediaUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) {
      throw new SourceError('media', `http_${response.status}`, `Источник изображения ответил с кодом ${response.status}`);
    }
    const contentType = cleanText(response.headers.get('content-type')).toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new SourceError('media', 'not_image', 'Источник вернул данные, не являющиеся изображением');
    }
    const declaredLength = asNumber(response.headers.get('content-length'), 0);
    if (declaredLength > MAX_MEDIA_BYTES) throw new SourceError('media', 'too_large', 'Изображение слишком большое');
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > MAX_MEDIA_BYTES) throw new SourceError('media', 'too_large', 'Изображение пустое или слишком большое');
    return { data, contentType, upstreamCache: response.headers.get('cache-control') || '' };
  }
  throw new SourceError('media', 'redirect', 'Слишком много перенаправлений изображения');
}

async function serveMedia(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) return sendJson(res, 400, { error: 'missing_url', message: 'Не указан адрес изображения' });
  try {
    const validatedTarget = validateMediaUrl(target);
    // AV.BY's image CDN returns HTTP 423 to shared Render egress addresses,
    // even while the same public file is available to a visitor's browser.
    // Redirect only this strictly allowlisted host and suppress the referrer.
    if (validatedTarget.hostname === 'avcdn.av.by') {
      res.writeHead(307, {
        location: validatedTarget.href,
        'cache-control': 'public, max-age=86400',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      res.end();
      return;
    }
    const media = await fetchMediaResponse(validatedTarget.href);
    res.writeHead(200, {
      'content-type': media.contentType,
      'content-length': media.data.length,
      'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    });
    if (req.method === 'HEAD') res.end(); else res.end(media.data);
  } catch (error) {
    apiError(res, error, error?.code === 'forbidden_host' || error?.code === 'invalid_url' ? 400 : 502);
  }
}

function securityHeaders(contentType = '') {
  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    // Do not set X-Frame-Options/frame-ancestors: Render and Arena previews use a sandboxed iframe.
    'content-security-policy': "default-src 'self'; img-src 'self' data: https://content.onliner.by https://imgproxy.onliner.by https://rms.kufar.by https://avcdn.av.by https://io.activecloud.com https://dealers-service.atlantm.by; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'", 
  };
  if (contentType) headers['content-type'] = contentType;
  return headers;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...securityHeaders('application/json; charset=utf-8'),
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function apiError(res, error, status = 500) {
  const payload = {
    error: error?.code || (status === 404 ? 'not_found' : 'internal_error'),
    message: error?.publicMessage || (status === 404 ? 'Endpoint не найден' : 'Внутренняя ошибка сервиса'),
  };
  if (process.env.NODE_ENV === 'development') payload.diagnostic = cleanText(error?.stack || error?.message);
  sendJson(res, status, payload);
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const safePath = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const allowed = safePath === 'index.html' || safePath.startsWith(`assets${path.sep}`);
  if (!allowed) return false;
  const filePath = path.join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) return false;
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };
    const headers = {
      ...securityHeaders(types[ext] || 'application/octet-stream'),
      'cache-control': ext === '.html' ? 'no-store, max-age=0' : 'public, max-age=604800, immutable',
      'content-length': data.length,
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end(); else res.end(data);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const started = performance.now();
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (!['GET', 'HEAD'].includes(req.method)) {
      sendJson(res, 405, { error: 'method_not_allowed', message: 'Разрешены только GET-запросы' }, { allow: 'GET, HEAD' });
      return;
    }

    if (pathname.startsWith('/api/')) {
      const kind = pathname === '/api/search' ? 'search' : pathname.startsWith('/api/listing/') ? 'detail' : pathname === '/api/media' ? 'media' : 'api';
      const rate = rateAllowed(req, kind);
      if (!rate.allowed) {
        sendJson(res, 429, { error: 'rate_limit', message: 'Слишком много запросов. Повторите через минуту.' }, {
          'retry-after': String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))),
        });
        return;
      }

      if (pathname === '/api/media') {
        await serveMedia(req, res, url);
        return;
      }

      if (pathname === '/api/health') {
        sendJson(res, 200, {
          status: 'ok', service: 'motor-by', version: APP_VERSION, time: new Date().toISOString(),
          adapters: {
            onliner: 'enabled', kufar: 'enabled', av: 'enabled',
            dealer: 'enabled', autohouse: 'enabled',
          },
          atlantM: {
            dealerCatalog: 'new', autohouseCatalog: 'amp',
            api: 'public-keyless-stock',
          },
          av: {
            transport: avRuntime.transport,
            imageDelivery: 'browser-direct-avcdn',
            lastSuccessAt: avRuntime.lastSuccessAt,
            lastFailureAt: avRuntime.lastFailureAt,
            lastError: avRuntime.lastError || null,
            readerBudgetUsed: jinaRequestTimes.filter((time) => time > Date.now() - 60000).length,
          },
          cache: cache.stats(),
        });
        return;
      }

      if (pathname === '/api/catalog/brands') {
        sendJson(res, 200, await getBrands());
        return;
      }

      if (pathname === '/api/catalog/models') {
        const brandId = asNumber(url.searchParams.get('brand'));
        if (!brandId) return sendJson(res, 400, { error: 'invalid_brand', message: 'Укажите числовой id марки' });
        try { sendJson(res, 200, await getModels(brandId)); }
        catch (error) { apiError(res, error, error?.code ? 502 : 500); }
        return;
      }

      if (pathname === '/api/catalog/generations') {
        const brandId = asNumber(url.searchParams.get('brand'));
        const modelId = asNumber(url.searchParams.get('model'));
        if (!brandId || !modelId) return sendJson(res, 400, { error: 'invalid_model', message: 'Укажите id марки и модели' });
        try { sendJson(res, 200, await getGenerations(brandId, modelId)); }
        catch (error) { apiError(res, error, error?.code ? 502 : 500); }
        return;
      }

      if (pathname === '/api/search') {
        const filters = normaliseSearch(url);
        const payload = await runSearch(filters);
        sendJson(res, 200, payload, {
          'server-timing': `app;dur=${Math.round(performance.now() - started)}`,
          'x-ratelimit-remaining': String(rate.remaining),
        });
        return;
      }

      const detailMatch = pathname.match(/^\/api\/listing\/(onliner|kufar|av|dealer|autohouse)\/([a-z0-9_-]{1,40})$/i);
      if (detailMatch) {
        const [, source, id] = detailMatch;
        try {
          const item = source === 'onliner' ? await getOnlinerDetail(id)
            : source === 'kufar' ? await getKufarDetail(id)
              : source === 'av' ? await getAvDetail(id) : await getAtlantDetail(id, source);
          sendJson(res, 200, { live: true, mock: false, item, fetchedAt: new Date().toISOString() }, {
            'server-timing': `app;dur=${Math.round(performance.now() - started)}`,
          });
        } catch (error) {
          apiError(res, error, ['http_404', 'not_available'].includes(error?.code) ? 404 : 502);
        }
        return;
      }

      apiError(res, null, 404);
      return;
    }

    if (await serveStatic(req, res, pathname)) return;
    // Client-side paths deliberately fall back to the single application shell.
    if (!path.extname(pathname)) {
      if (await serveStatic(req, res, '/')) return;
    }
    res.writeHead(404, securityHeaders('text/plain; charset=utf-8'));
    res.end('404 — файл не найден');
  } catch (error) {
    console.error('[request error]', error);
    if (!res.headersSent) apiError(res, error);
    else res.end();
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Motor BY listening on 0.0.0.0:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('unhandledRejection', (error) => console.error('[unhandled rejection]', error));

