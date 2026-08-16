// ============================================================
// api/results.js — Vercel Serverless Function
// Busca resultados atualizados de múltiplas fontes com backfill
// ============================================================

import https from 'https';
import http from 'http';

const LOTTERY_CONFIG = {
  megasena:   { guidi: 'megasena',   caixa: 'megasena',   loteriasCaixa: 'megasena' },
  lotofacil:  { lotofacil: 'lotofacil', caixa: 'lotofacil',  loteriasCaixa: 'lotofacil', guidi: 'lotofacil' },
  quina:      { guidi: 'quina',      caixa: 'quina',       loteriasCaixa: 'quina' },
  diadesorte: { guidi: 'diadesorte', caixa: 'diadesorte', loteriasCaixa: 'diadesorte' },
};

function fetchJson(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (SortudoAnalyzer/2.0; +https://sortudo.app)',
        'Accept': 'application/json',
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout (${timeoutMs}ms)`));
    });
    req.on('error', reject);
  });
}

function normalizeResult(data, key) {
  if (!data) return null;

  const dezenas = data.dezenas || data.listaDezenas || data.numbers || data.result || data.dezenasSorteadasOrdemSorteio || data.dezenasOrdemSorteio;
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

  if (key === 'diadesorte' && mes) result.mes = mes;
  return result;
}

// Busca o último concurso de uma loteria
async function fetchLatestDraw(key) {
  const meta = LOTTERY_CONFIG[key];
  if (!meta) return null;

  const sources = [
    { name: 'Guidi', url: `https://api.guidi.dev.br/loteria/${meta.guidi}/ultimo` },
    { name: 'Caixa', url: `https://servicebus2.caixa.gov.br/portaldeloterias/api/${meta.caixa}/` },
    { name: 'LoteriasCaixa', url: `https://loteriascaixa-api.herokuapp.com/api/${meta.loteriasCaixa}/latest` },
  ];

  for (const src of sources) {
    try {
      const raw = await fetchJson(src.url);
      const res = normalizeResult(raw, key);
      if (res) return res;
    } catch (e) {
      // Tenta a próxima fonte
    }
  }
  return null;
}

// Busca um concurso específico por número
async function fetchSpecificDraw(key, concursoNum) {
  const meta = LOTTERY_CONFIG[key];
  if (!meta) return null;

  const sources = [
    { name: 'Guidi', url: `https://api.guidi.dev.br/loteria/${meta.guidi}/${concursoNum}` },
    { name: 'Caixa', url: `https://servicebus2.caixa.gov.br/portaldeloterias/api/${meta.caixa}/${concursoNum}` },
    { name: 'LoteriasCaixa', url: `https://loteriascaixa-api.herokuapp.com/api/${meta.loteriasCaixa}/${concursoNum}` },
  ];

  for (const src of sources) {
    try {
      const raw = await fetchJson(src.url);
      const res = normalizeResult(raw, key);
      if (res && res.concurso === +concursoNum) return res;
    } catch (e) {
      // Tenta próxima fonte
    }
  }
  return null;
}

export default async function handler(req, res) {
  // Configura CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Parse query params
  const urlObj = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
  const lottery = (req.query?.lottery || urlObj.searchParams.get('lottery') || 'megasena').toLowerCase();
  const fromConcurso = +(req.query?.from || urlObj.searchParams.get('from') || 0);

  if (!LOTTERY_CONFIG[lottery]) {
    return res.status(400).json({ error: `Loteria desconhecida: ${lottery}` });
  }

  try {
    const latest = await fetchLatestDraw(lottery);
    if (!latest) {
      return res.status(503).json({ error: 'Nao foi possivel obter dados das APIs externas' });
    }

    const missingResults = [];

    // Se 'from' foi informado e há concursos intermediários faltando
    if (fromConcurso > 0 && latest.concurso > fromConcurso) {
      missingResults.push(latest);
      const diff = latest.concurso - fromConcurso;
      const maxBackfill = Math.min(diff - 1, 10); // Limita a 10 concursos

      const promises = [];
      for (let c = latest.concurso - 1; c > latest.concurso - 1 - maxBackfill; c--) {
        promises.push(fetchSpecificDraw(lottery, c));
      }

      const backfilled = await Promise.all(promises);
      for (const r of backfilled) {
        if (r) missingResults.push(r);
      }

      // Ordena decrescente por concurso
      missingResults.sort((a, b) => b.concurso - a.concurso);
    }

    // Cache no Edge por 60s, stale por 5 min
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      success: true,
      lottery,
      latest,
      newResults: missingResults.length > 0 ? missingResults : [latest],
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
