#!/usr/bin/env node
// ============================================================
// ship.js — Atualiza resultados + commit + push em um comando
//
// USO: node ship.js
//      npm run ship
// ============================================================

import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data.js');

// ── Configuração das loterias ─────────────────────────────────
const LOTTERY_META = {
  megasena:   { guidi: 'megasena',   caixa: 'megasena',   varName: 'MEGA_SENA_RESULTS' },
  lotofacil:  { guidi: 'lotofacil',  caixa: 'lotofacil',  varName: 'LOTOFACIL_RESULTS' },
  quina:      { guidi: 'quina',      caixa: 'quina',       varName: 'QUINA_RESULTS' },
  diadesorte: { guidi: 'diadesorte', caixa: 'diadesorte', varName: 'DIA_DE_SORTE_RESULTS' },
};

// ── HTTP helper ───────────────────────────────────────────────
function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (sortudo-ship/1.0)',
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
        catch { reject(new Error('JSON invalido')); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

// ── Normaliza resposta da API ─────────────────────────────────
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

// ── Busca o resultado mais recente na API ─────────────────────
async function fetchLatest(key) {
  const meta = LOTTERY_META[key];
  const urls = [
    `https://api.guidi.dev.br/loteria/${meta.guidi}/ultimo`,
    `https://servicebus2.caixa.gov.br/portaldeloterias/api/${meta.caixa}/`,
  ];
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      const result = normalizeResult(data, key);
      if (result) return result;
    } catch { /* tenta proxima */ }
  }
  return null;
}

// ── Helpers do data.js ────────────────────────────────────────
function getTopConcurso(content, varName) {
  const m = content.match(new RegExp(`const ${varName}\\s*=\\s*\\[\\s*\\{\\s*concurso:\\s*(\\d+)`));
  return m ? +m[1] : 0;
}

function buildLine(key, r) {
  const d = r.dezenas.join(', ');
  if (key === 'diadesorte') {
    return `  { concurso: ${r.concurso}, data: "${r.data}", dezenas: [${d}]${r.mes ? `, mes: "${r.mes}"` : ''} },`;
  }
  return `  { concurso: ${r.concurso}, data: "${r.data}", dezenas: [${d}] },`;
}

function insertLine(content, varName, line) {
  return content.replace(
    new RegExp(`(const ${varName}\\s*=\\s*\\[)(\n)`),
    `$1$2${line}\n`
  );
}

// ── Git helper ────────────────────────────────────────────────
function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: __dirname, encoding: 'utf8' }).trim();
}

function hasChanges() {
  const status = git('status --porcelain');
  return status.length > 0;
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  const LINE = '='.repeat(48);
  console.log(`\n${LINE}`);
  console.log('  SORTUDO SHIP — Atualiza, commita e faz deploy');
  console.log(`${LINE}\n`);

  // ── ETAPA 1: Atualizar resultados ──────────────────────────
  console.log('ETAPA 1/3  Buscando novos resultados...\n');

  let content = fs.readFileSync(DATA_FILE, 'utf8');
  const added = [];

  for (const key of Object.keys(LOTTERY_META)) {
    const meta = LOTTERY_META[key];
    const top = getTopConcurso(content, meta.varName);
    process.stdout.write(`  [${key.padEnd(11)}] local #${top} ... `);

    const latest = await fetchLatest(key);

    if (!latest) {
      console.log('API indisponivel');
      continue;
    }

    if (latest.concurso <= top) {
      console.log(`ok (API: #${latest.concurso})`);
      continue;
    }

    content = insertLine(content, meta.varName, buildLine(key, latest));
    added.push(`  + ${key} #${latest.concurso} (${latest.data}) [${latest.dezenas.join(', ')}]`);
    console.log(`NOVO! #${latest.concurso} (${latest.data})`);
  }

  if (added.length === 0) {
    console.log('\n  Nenhum resultado novo encontrado.');
    console.log('  A API pode estar atrasada. Tente novamente mais tarde.\n');
    console.log(`${LINE}\n`);
    return;
  }

  fs.writeFileSync(DATA_FILE, content, 'utf8');
  console.log(`\n  Adicionados ${added.length} resultado(s):\n${added.join('\n')}\n`);

  // ── ETAPA 2: Git commit ────────────────────────────────────
  console.log('ETAPA 2/3  Commitando no Git...\n');

  if (!hasChanges()) {
    console.log('  Sem mudancas para commitar.\n');
  } else {
    const today = new Date().toLocaleDateString('pt-BR');
    const names = added.map(l => l.match(/^\s+\+ (\w+)/)?.[1]).filter(Boolean).join(', ');
    const msg = `resultados ${today} — ${names}`;

    git('add -A');
    const commitOut = git(`commit -m "${msg}"`);
    console.log(`  Commit: ${commitOut.split('\n')[0]}\n`);
  }

  // ── ETAPA 3: Push + Deploy ─────────────────────────────────
  console.log('ETAPA 3/3  Enviando para GitHub (Vercel vai deployar)...\n');

  try {
    git('pull --rebase');
    const pushOut = git('push');
    console.log(`  ${pushOut || 'Push concluido!'}`);
    console.log('\n  Deploy iniciado na Vercel automaticamente.');
    console.log('  Em 1-2 minutos o site estara atualizado.\n');
  } catch (e) {
    console.error('  ERRO no push:', e.message);
    process.exit(1);
  }

  console.log(`${LINE}`);
  console.log('  TUDO PRONTO!');
  console.log(`${LINE}\n`);
}

main().catch(err => {
  console.error('\nErro:', err.message);
  process.exit(1);
});
