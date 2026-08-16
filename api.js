// ============================================================
// api.js — Serviço de dados com múltiplas camadas de redundância
// 1. Rota Serverless /api/results (Vercel/Local)
// 2. Caixa Econômica Federal Oficial (CORS direto)
// 3. LoteriasCaixa Heroku API (CORS direto)
// 4. Guidi API via proxies CORS resilientes
// + Persistência em LocalStorage e backfill de concursos faltantes
// ============================================================

import { LOTTERY_DATA } from './data.js';

const LOTTERY_META = {
  megasena:   { caixa: 'megasena',   api: 'megasena' },
  lotofacil:  { caixa: 'lotofacil',  api: 'lotofacil' },
  quina:      { caixa: 'quina',      api: 'quina' },
  diadesorte: { caixa: 'diadesorte', api: 'diadesorte' },
};

// Cache em memória (TTL de 2 minutos para evitar requisições excessivas)
const memoryCache = {};
const CACHE_TTL_MS = 2 * 60 * 1000;

// Timeout utilitário
async function fetchWithTimeout(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// Normaliza formato retornado por qualquer uma das APIs
function normalizeDraw(data, lotteryKey) {
  if (!data) return null;

  const dezenas = data.dezenas || data.listaDezenas || data.numbers || data.result
    || data.dezenasSorteadasOrdemSorteio || data.dezenasOrdemSorteio;
  const concurso = (data.numero != null ? data.numero : null)
    ?? (data.concurso != null ? data.concurso : null)
    ?? (data.id != null ? data.id : null);
  const dataStr = data.dataApuracao || data.data || data.date || '';
  const mes = data.nomeTimeCoracaoMesSorte?.replace(/\0/g, '').trim() || data.mes || null;

  if (!dezenas || !Array.isArray(dezenas) || dezenas.length === 0) return null;
  if (concurso == null || isNaN(+concurso) || +concurso === 0) return null;

  const parsedNumbers = dezenas.map(n => +n).filter(n => !isNaN(n) && n > 0).sort((a, b) => a - b);
  if (parsedNumbers.length === 0) return null;

  const result = {
    concurso: +concurso,
    data: dataStr,
    dezenas: parsedNumbers,
    source: 'api'
  };

  if (lotteryKey === 'diadesorte' && mes) result.mes = mes;
  return result;
}

// ── PERSISTÊNCIA NO LOCALSTORAGE ─────────────────────────────
const STORAGE_PREFIX = 'sortudo_persisted_';

function getPersistedDraws(lotteryKey) {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${lotteryKey}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePersistedDraws(lotteryKey, newDraws) {
  try {
    const existing = getPersistedDraws(lotteryKey);
    const map = new Map();
    // Adiciona existentes
    existing.forEach(d => map.set(d.concurso, d));
    // Adiciona novos
    newDraws.forEach(d => map.set(d.concurso, { ...d, source: 'api' }));
    // Ordena decrescente
    const merged = Array.from(map.values()).sort((a, b) => b.concurso - a.concurso);
    localStorage.setItem(`${STORAGE_PREFIX}${lotteryKey}`, JSON.stringify(merged));
  } catch (e) {
    console.warn('[STORAGE] Falha ao salvar no localStorage:', e);
  }
}

// ── RETORNA A BASE COMPLETA (data.js + LocalStorage) ──────────
export function getLocalData(lotteryKey) {
  const staticData = LOTTERY_DATA[lotteryKey] || [];
  const persisted = getPersistedDraws(lotteryKey);

  if (persisted.length === 0) return staticData;

  const map = new Map();
  // Primeiro adiciona base estática
  staticData.forEach(d => map.set(d.concurso, d));
  // Sobrescreve/adiciona com dados persistidos do navegador
  persisted.forEach(d => map.set(d.concurso, d));

  return Array.from(map.values()).sort((a, b) => b.concurso - a.concurso);
}

// ── ESTRATÉGIAS DE FETCH ─────────────────────────────────────

// Estratégia 1: Rota Serverless Vercel / Local
async function tryServerlessRoute(lotteryKey, fromConcurso) {
  const url = `/api/results?lottery=${lotteryKey}&from=${fromConcurso}`;
  const data = await fetchWithTimeout(url, 5000);
  if (data && data.success && Array.isArray(data.newResults)) {
    return data.newResults;
  }
  return null;
}

// Estratégia 2: Caixa Oficial Direta (possui CORS)
async function tryCaixaDirect(lotteryKey) {
  const meta = LOTTERY_META[lotteryKey];
  const url = `https://servicebus2.caixa.gov.br/portaldeloterias/api/${meta.caixa}/`;
  const data = await fetchWithTimeout(url, 6000);
  const normalized = normalizeDraw(data, lotteryKey);
  return normalized ? [normalized] : null;
}

// Estratégia 3: LoteriasCaixa Heroku API (possui CORS)
async function tryLoteriasCaixa(lotteryKey) {
  const meta = LOTTERY_META[lotteryKey];
  const url = `https://loteriascaixa-api.herokuapp.com/api/${meta.api}/latest`;
  const data = await fetchWithTimeout(url, 6000);
  const normalized = normalizeDraw(data, lotteryKey);
  return normalized ? [normalized] : null;
}

// Estratégia 4: Guidi via Proxies CORS
async function tryGuidiViaProxy(lotteryKey) {
  const meta = LOTTERY_META[lotteryKey];
  const targetUrl = `https://api.guidi.dev.br/loteria/${meta.api}/ultimo`;
  const proxies = [
    `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
  ];

  for (const proxy of proxies) {
    try {
      const data = await fetchWithTimeout(proxy, 5000);
      const normalized = normalizeDraw(data, lotteryKey);
      if (normalized) return [normalized];
    } catch {
      // Continua
    }
  }
  return null;
}

// ── BUSCA RESULTADOS MAIS RECENTES ───────────────────────────
export async function fetchLiveResults(lotteryKey, fromConcurso = 0, onProgress = null) {
  // 1. Tenta Serverless Route
  try {
    if (onProgress) onProgress('Consultando servidor de resultados...');
    const res = await tryServerlessRoute(lotteryKey, fromConcurso);
    if (res && res.length > 0) return res;
  } catch (e) {
    console.warn('[API] Serverless route indisponível, usando fallback direto');
  }

  // 2. Tenta Caixa Oficial
  try {
    if (onProgress) onProgress('Consultando Caixa Econômica Federal...');
    const res = await tryCaixaDirect(lotteryKey);
    if (res && res.length > 0) return res;
  } catch (e) {
    console.warn('[API] Caixa direta indisponível:', e.message);
  }

  // 3. Tenta LoteriasCaixa Heroku
  try {
    if (onProgress) onProgress('Consultando LoteriasCaixa API...');
    const res = await tryLoteriasCaixa(lotteryKey);
    if (res && res.length > 0) return res;
  } catch (e) {
    console.warn('[API] LoteriasCaixa indisponível:', e.message);
  }

  // 4. Tenta Guidi via Proxies
  try {
    if (onProgress) onProgress('Consultando rede comunitária via proxy...');
    const res = await tryGuidiViaProxy(lotteryKey);
    if (res && res.length > 0) return res;
  } catch (e) {
    console.warn('[API] Proxies comunitários indisponíveis:', e.message);
  }

  return null;
}

// ── OBTÉM RESULTADOS COMPLETOS INTEGRADOS ─────────────────────
export async function getResults(lotteryKey, onProgress, forceRefresh = false) {
  const cacheKey = `results_${lotteryKey}`;
  const now = Date.now();

  // Verifica cache em memória
  if (!forceRefresh && memoryCache[cacheKey] && (now - memoryCache[cacheKey].cachedAt < CACHE_TTL_MS)) {
    return memoryCache[cacheKey].data;
  }

  // Dados locais consolidados (data.js + LocalStorage)
  const currentData = getLocalData(lotteryKey);
  const topConcurso = currentData[0]?.concurso || 0;

  try {
    if (onProgress) onProgress('Verificando novos sorteios...');
    const liveDraws = await fetchLiveResults(lotteryKey, topConcurso, onProgress);

    if (liveDraws && liveDraws.length > 0) {
      const highestConcurso = Math.max(...liveDraws.map(d => d.concurso));

      if (highestConcurso > topConcurso) {
        // Encontrou concursos novos!
        savePersistedDraws(lotteryKey, liveDraws);
        const updatedData = getLocalData(lotteryKey);

        if (onProgress) onProgress(`✅ Atualizado! Concurso #${highestConcurso}`);

        memoryCache[cacheKey] = {
          data: updatedData,
          cachedAt: now,
          isApi: true
        };
        return updatedData;
      }
    }
  } catch (e) {
    console.warn('[DATA] Erro ao buscar novos resultados ao vivo:', e);
  }

  if (onProgress) onProgress('Base de dados pronta.');

  memoryCache[cacheKey] = {
    data: currentData,
    cachedAt: now,
    isApi: currentData[0]?.source === 'api'
  };

  return currentData;
}

// ── FORÇA ATUALIZAÇÃO MANUAL (IGNORA CACHE) ───────────────────
export async function forceRefreshResults(lotteryKey, onProgress) {
  delete memoryCache[`results_${lotteryKey}`];
  return await getResults(lotteryKey, onProgress, true);
}

