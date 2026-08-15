// ============================================================
// api.js — Serviço de dados com fallback robusto
// Tenta buscar dados reais da API pública, usa dados locais
// ============================================================

import { LOTTERY_DATA } from './data.js';

// Mapeamento de nomes de loteria para a API Guidi
const API_NAMES = {
  megasena:   'megasena',
  lotofacil:  'lotofacil',
  quina:      'quina',
  diadesorte: 'diadesorte'
};

// URL da API pública comunitária (Guidi)
const API_BASE = 'https://api.guidi.dev.br/loteria';

// CORS proxy (para contornar CORS no browser)
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

// Cache em memória com TTL de 10 minutos
const cache = {};
const CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchWithTimeout(url, timeoutMs = 5000) {
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

async function fetchLastResult(lotteryKey) {
  const cacheKey = `last_${lotteryKey}`;
  const cached = cache[cacheKey];
  if (cached && (Date.now() - cached._cachedAt < CACHE_TTL_MS)) return cached;

  const apiName = API_NAMES[lotteryKey];

  // Tentativa 1: API direta
  try {
    const url = `${API_BASE}/${apiName}/ultimo`;
    const data = await fetchWithTimeout(url);
    const result = normalizeApiResponse(data, lotteryKey);
    if (result) {
      cache[cacheKey] = { ...result, _cachedAt: Date.now() };
      return result;
    }
  } catch (e) {
    console.warn('[API] Tentativa direta falhou:', e.message);
  }

  // Tentativa 2: Via proxy CORS
  try {
    const proxied = `${CORS_PROXY}${encodeURIComponent(`${API_BASE}/${apiName}/ultimo`)}`;
    const data = await fetchWithTimeout(proxied);
    const result = normalizeApiResponse(data, lotteryKey);
    if (result) {
      cache[cacheKey] = { ...result, _cachedAt: Date.now() };
      return result;
    }
  } catch (e) {
    console.warn('[API] Tentativa via proxy falhou:', e.message);
  }

  // Fallback: usar dado mais recente do banco local
  const local = LOTTERY_DATA[lotteryKey][0];
  return { ...local, source: 'local' };
}

function normalizeApiResponse(data, lotteryKey) {
  if (!data) return null;

  // Suporte a diferentes formatos de resposta da API Guidi
  const dezenas = data.dezenas || data.listaDezenas || data.numbers || data.result;

  // data.numero pode ser null na API Guidi; testar explicitamente
  const concurso = (data.numero != null ? data.numero : null)
    ?? (data.concurso != null ? data.concurso : null)
    ?? (data.id != null ? data.id : null);

  const dataStr = data.dataApuracao || data.data || data.date || '';

  if (!dezenas || !Array.isArray(dezenas) || dezenas.length === 0) return null;
  if (concurso == null || isNaN(+concurso) || +concurso === 0) return null;

  return {
    concurso: +concurso,
    data: dataStr,
    dezenas: dezenas.map(n => +n).filter(n => !isNaN(n)).sort((a, b) => a - b),
    source: 'api'
  };
}

// Retorna os dados históricos locais (sempre disponível)
export function getLocalData(lotteryKey) {
  return LOTTERY_DATA[lotteryKey] || [];
}

// Retorna dados combinados: API (se disponível) + locais
export async function getResults(lotteryKey, onProgress) {
  const localData = getLocalData(lotteryKey);

  let apiLatest = null;
  try {
    if (onProgress) onProgress('Buscando último resultado da Caixa...');
    apiLatest = await fetchLastResult(lotteryKey);
  } catch (e) {
    console.warn('[DATA] Usando apenas dados locais');
  }

  // Se API retornou resultado mais recente que o local, insere no início
  if (apiLatest && apiLatest.source === 'api') {
    const latestLocal = localData[0];
    if (!latestLocal || apiLatest.concurso > latestLocal.concurso) {
      if (onProgress) onProgress(`✅ Novo concurso encontrado: #${apiLatest.concurso}`);
      return [apiLatest, ...localData];
    }
  }

  if (onProgress) onProgress('Usando base de dados local...');
  return localData;
}

export { fetchLastResult };
