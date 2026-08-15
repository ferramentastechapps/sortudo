#!/usr/bin/env node
// ============================================================
// update-results.js — Atualiza data.js com os resultados mais
// recentes das loterias automaticamente.
//
// USO: node update-results.js
// ============================================================

import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data.js');

// Mapeamento dos nomes internos para cada API
const LOTTERY_META = {
  megasena:   { guidi: 'megasena',   caixa: 'megasena',   varName: 'MEGA_SENA_RESULTS' },
  lotofacil:  { guidi: 'lotofacil',  caixa: 'lotofacil',  varName: 'LOTOFACIL_RESULTS' },
  quina:      { guidi: 'quina',      caixa: 'quina',       varName: 'QUINA_RESULTS' },
  diadesorte: { guidi: 'diadesorte', caixa: 'diadesorte', varName: 'DIA_DE_SORTE_RESULTS' },
};

// ── Utilitários ───────────────────────────────────────────────
function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (sortudo-updater/1.0)',
        'Accept': 'application/json',
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} em ${url}`));
      }
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON invalido em ${url}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout em ${url}`)); });
    req.on('error', reject);
  });
}

function normalizeResult(data, key) {
  if (!data) return null;

  const dezenas = data.dezenas || data.listaDezenas || data.numbers || data.result;
  const concurso = (data.numero != null ? data.numero : null)
    ?? (data.concurso != null ? data.concurso : null)
    ?? (data.id != null ? data.id : null);
  const dataStr = data.dataApuracao || data.data || data.date || '';
  const mes = data.nomeTimeCoracaoMesSorte?.replace(/\0/g, '').trim() || data.mes || null;

  if (!dezenas || !Array.isArray(dezenas) || dezenas.length === 0) return null;
  if (concurso == null || isNaN(+concurso) || +concurso === 0) return null;

  const result = {
    concurso: +concurso,
    data: dataStr,
    dezenas: dezenas.map(n => +n).filter(n => !isNaN(n)).sort((a, b) => a - b),
  };

  if (key === 'diadesorte' && mes) result.mes = mes;

  return result;
}

async function fetchLatest(key) {
  const meta = LOTTERY_META[key];
  const urls = [
    `https://api.guidi.dev.br/loteria/${meta.guidi}/ultimo`,
    `https://servicebus2.caixa.gov.br/portaldeloterias/api/${meta.caixa}/`,
  ];

  for (const url of urls) {
    try {
      console.log(`  -> Tentando: ${url}`);
      const data = await fetchJson(url);
      const result = normalizeResult(data, key);
      if (result) {
        console.log(`  OK Obtido da API: concurso #${result.concurso} (${result.data})`);
        return result;
      }
    } catch (e) {
      console.log(`  FALHOU: ${e.message}`);
    }
  }
  return null;
}

// ── Leitura do data.js atual ──────────────────────────────────
function getCurrentTopConcurso(content, varName) {
  const re = new RegExp(`const ${varName}\\s*=\\s*\\[\\s*\\{\\s*concurso:\\s*(\\d+)`);
  const m = content.match(re);
  return m ? +m[1] : 0;
}

function buildEntryLine(key, result) {
  const d = result.dezenas.join(', ');
  if (key === 'diadesorte') {
    const mes = result.mes ? `, mes: "${result.mes}"` : '';
    return `  { concurso: ${result.concurso}, data: "${result.data}", dezenas: [${d}]${mes} },`;
  }
  return `  { concurso: ${result.concurso}, data: "${result.data}", dezenas: [${d}] },`;
}

function insertIntoArray(content, varName, newLine) {
  const re = new RegExp(`(const ${varName}\\s*=\\s*\\[)(\n)`);
  if (!re.test(content)) {
    throw new Error(`Nao encontrou a variavel ${varName} no data.js`);
  }
  return content.replace(re, `$1$2${newLine}\n`);
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Sortudo — Atualizador de Resultados ===\n');

  let content = fs.readFileSync(DATA_FILE, 'utf8');
  let totalAdded = 0;

  for (const key of Object.keys(LOTTERY_META)) {
    const meta = LOTTERY_META[key];
    const currentTop = getCurrentTopConcurso(content, meta.varName);

    console.log(`[${key.toUpperCase()}]`);
    console.log(`  Ultimo local: #${currentTop}`);

    const latest = await fetchLatest(key);

    if (!latest) {
      console.log(`  ERRO: Nao foi possivel obter resultado da API.\n`);
      continue;
    }

    if (latest.concurso <= currentTop) {
      console.log(`  Ja atualizado (API: #${latest.concurso} = local: #${currentTop})\n`);
      continue;
    }

    const diff = latest.concurso - currentTop;
    if (diff > 1) {
      console.log(`  AVISO: pulou ${diff - 1} concurso(s) intermediario(s) — inserindo apenas o mais recente.`);
    }

    const newLine = buildEntryLine(key, latest);
    content = insertIntoArray(content, meta.varName, newLine);
    totalAdded++;
    console.log(`  ADICIONADO: concurso #${latest.concurso} (${latest.data}) — [${latest.dezenas.join(', ')}]\n`);
  }

  if (totalAdded > 0) {
    fs.writeFileSync(DATA_FILE, content, 'utf8');
    console.log(`=== data.js atualizado com ${totalAdded} novo(s) resultado(s)! ===\n`);
  } else {
    console.log('=== Nenhum resultado novo. data.js nao foi alterado. ===\n');
  }
}

main().catch(err => {
  console.error('\nErro fatal:', err.message);
  process.exit(1);
});
