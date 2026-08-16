// ============================================================
// app.js — UI Principal do Sortudo Analyzer
// Renderização, eventos e orquestração
// ============================================================

import { LOTTERY_CONFIG } from './data.js';
import { getResults, forceRefreshResults, getLocalData } from './api.js';
import {
  analyzeFrequency, analyzeDelay, analyzeEvenOdd,
  analyzeSum, analyzeQuadrants, analyzeRepetition,
  analyzeComposition, computeLotoScores, generateSuggestions
} from './analyzer.js';

// ────────────────────────────────────────────────────────────
// UTILITÁRIO: CLIPBOARD COM FALLBACK
// ────────────────────────────────────────────────────────────
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback para HTTP ou navegadores mais antigos
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    return Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  } finally {
    ta.remove();
  }
}

// ────────────────────────────────────────────────────────────
// UTILITÁRIO: SANITIZAÇÃO BÁSICA PARA innerHTML
// ────────────────────────────────────────────────────────────
function sanitize(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ────────────────────────────────────────────────────────────
// UTILITÁRIO: TOAST NOTIFICATION
// ────────────────────────────────────────────────────────────
function showToast(message, icon = '🍀') {
  let toast = document.getElementById('sortudo-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'sortudo-toast';
    toast.className = 'sortudo-toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span style="font-size:1.2rem">${icon}</span> <span>${sanitize(message)}</span>`;
  toast.classList.add('show');
  clearTimeout(window.__toastTimeout);
  window.__toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 4000);
}

// ────────────────────────────────────────────────────────────
// ESTADO GLOBAL
// ────────────────────────────────────────────────────────────
const State = {
  currentLottery: 'megasena',
  results: {},
  loading: false,
  syncing: false,
  charts: {},
  currentSuggestions: null,
  analysisWindow: 0  // 0 = todos os concursos
};

// ────────────────────────────────────────────────────────────
// PREMIAÇÕES E VERIFICAÇÃO DE SALVOS
// ────────────────────────────────────────────────────────────
function getPrizeBadge(lotteryKey, hits) {
  if (lotteryKey === 'megasena') {
    if (hits === 6) return { name: '🏆 SENA!', cls: 'gold' };
    if (hits === 5) return { name: '🥇 QUINA!', cls: 'good' };
    if (hits === 4) return { name: '🥈 QUADRA!', cls: 'good' };
  } else if (lotteryKey === 'lotofacil') {
    if (hits === 15) return { name: '🏆 15 PONTOS!', cls: 'gold' };
    if (hits === 14) return { name: '🥇 14 PONTOS!', cls: 'good' };
    if (hits === 13) return { name: '🥈 13 PONTOS!', cls: 'good' };
    if (hits === 12) return { name: '🥉 12 PONTOS!', cls: 'good' };
    if (hits === 11) return { name: '✨ 11 PONTOS!', cls: 'good' };
  } else if (lotteryKey === 'quina') {
    if (hits === 5) return { name: '🏆 QUINA!', cls: 'gold' };
    if (hits === 4) return { name: '🥇 QUADRA!', cls: 'good' };
    if (hits === 3) return { name: '🥈 TERNO!', cls: 'good' };
    if (hits === 2) return { name: '🥉 DUQUE!', cls: 'good' };
  } else if (lotteryKey === 'diadesorte') {
    if (hits === 7) return { name: '🏆 7 ACERTOS!', cls: 'gold' };
    if (hits === 6) return { name: '🥇 6 ACERTOS!', cls: 'good' };
    if (hits === 5) return { name: '🥈 5 ACERTOS!', cls: 'good' };
    if (hits === 4) return { name: '🥉 4 ACERTOS!', cls: 'good' };
  }
  return null;
}

function getSavedGames(lotteryKey) {
  try {
    const raw = localStorage.getItem(`sortudo_saved_${lotteryKey}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Sanitiza e valida cada item
    return parsed.filter(g =>
      g &&
      typeof g === 'object' &&
      Array.isArray(g.numbers) &&
      g.numbers.every(n => typeof n === 'number' && isFinite(n))
    ).map(g => ({
      id: String(g.id || ('g_' + Math.random().toString(36).substr(2, 9))),
      lotteryKey: String(g.lotteryKey || lotteryKey),
      concursoAlvo: Number(g.concursoAlvo) || 0,
      strategyId: String(g.strategyId || 'unknown'),
      strategyName: String(g.strategyName || 'Jogo Salvo'),
      gameNum: Number(g.gameNum) || 1,
      numbers: g.numbers.map(Number),
      sum: Number(g.sum) || 0,
      evens: Number(g.evens) || 0,
      odds: Number(g.odds) || 0,
      avgScore: Number(g.avgScore) || 0,
      criadoEm: String(g.criadoEm || '-')
    }));
  } catch (e) {
    console.warn('[Storage] Dados corrompidos, limpando:', e);
    return [];
  }
}

function saveGamesToStorage(lotteryKey, gamesList) {
  try {
    localStorage.setItem(`sortudo_saved_${lotteryKey}`, JSON.stringify(gamesList));
  } catch (e) {
    console.error('Erro ao salvar jogos:', e);
  }
}

// ────────────────────────────────────────────────────────────
// CONTROLE DE SINCRONIZAÇÃO E STATUS VISUAL
// ────────────────────────────────────────────────────────────
function setSyncingState(isSyncing, label = 'Buscando...') {
  const pill = document.getElementById('live-status-pill');
  const text = document.getElementById('live-status-text');
  const btn = document.getElementById('btn-sync-results');
  const icon = btn?.querySelector('.sync-icon');
  const btnText = btn?.querySelector('.sync-text');

  if (isSyncing) {
    if (pill) pill.className = 'status-pill syncing';
    if (text) text.textContent = label;
    if (icon) icon.classList.add('spinning');
    if (btnText) btnText.textContent = 'Atualizando...';
    if (btn) btn.disabled = true;
  } else {
    if (pill) pill.className = 'status-pill online';
    if (text) text.textContent = 'Ao vivo';
    if (icon) icon.classList.remove('spinning');
    if (btnText) btnText.textContent = 'Atualizar';
    if (btn) btn.disabled = false;
  }
}

async function syncCurrentLottery(isManual = false) {
  if (State.syncing || State.loading) return;
  State.syncing = true;
  const key = State.currentLottery;
  const cfg = LOTTERY_CONFIG[key];
  const prevTop = State.results[key]?.[0]?.concurso || 0;

  setSyncingState(true, 'Verificando...');

  try {
    const results = await forceRefreshResults(key, (msg) => {
      setSyncingState(true, msg);
    });
    State.results[key] = results;
    renderAll(key, results);

    const newTop = results[0]?.concurso || 0;
    if (newTop > prevTop) {
      showToast(`${cfg?.name || key}: Concurso #${newTop} atualizado!`, '🎉');
      spawnConfetti();
    } else if (isManual) {
      showToast(`${cfg?.name || key}: Base já sincronizada no concurso #${newTop}.`, '✅');
    }
  } catch (e) {
    console.warn('[SYNC] Erro ao sincronizar:', e);
    if (isManual) showToast('Não foi possível atualizar das APIs no momento.', '⚠️');
  } finally {
    State.syncing = false;
    setSyncingState(false);
  }
}

// ────────────────────────────────────────────────────────────
// INICIALIZAÇÃO
// ────────────────────────────────────────────────────────────
function initApp() {
  setupTabs();
  setupResizeListener();
  setupSyncButton();
  setupAutoSync();
  loadLottery('megasena');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.lottery;
      if (key === State.currentLottery && State.results[key]) return;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.currentLottery = key;
      await loadLottery(key);
    });
  });
}

function setupSyncButton() {
  const btn = document.getElementById('btn-sync-results');
  if (btn) {
    btn.addEventListener('click', () => syncCurrentLottery(true));
  }
}

function setupAutoSync() {
  let lastFocusSync = Date.now();
  const handleFocusSync = () => {
    // Só sincroniza automaticamente se passou pelo menos 60 segundos
    if (Date.now() - lastFocusSync > 60000) {
      lastFocusSync = Date.now();
      syncCurrentLottery(false);
    }
  };

  window.addEventListener('focus', handleFocusSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handleFocusSync();
  });

  // Checagem periódica a cada 5 minutos
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      syncCurrentLottery(false);
    }
  }, 5 * 60 * 1000);
}

// Fix #22 — Resize listener debounced para corrigir grids
function setupResizeListener() {
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const topGrid = document.getElementById('top-grid');
      if (!topGrid) return;
      topGrid.style.gridTemplateColumns = window.innerWidth < 768 ? '1fr' : '1fr 1.4fr';
    }, 150);
  });
}

// ────────────────────────────────────────────────────────────
// CARREGAMENTO DE DADOS
// ────────────────────────────────────────────────────────────
async function loadLottery(key) {
  if (State.loading) return;
  State.loading = true;
  State.analysisWindow = 0; // reseta filtro de período ao trocar de loteria

  const cfg = LOTTERY_CONFIG[key];
  showLoadingState(cfg?.name || key);

  try {
    const results = await getResults(key, (msg) => updateLoadingMessage(msg));
    State.results[key] = results;
    renderAll(key, results);
  } catch (err) {
    console.error('[APP] Erro ao carregar dados:', err);
    showError('Erro ao carregar dados. Usando base local.');
  } finally {
    State.loading = false;
  }
}

// ────────────────────────────────────────────────────────────
// RENDERIZAÇÃO PRINCIPAL
// ────────────────────────────────────────────────────────────
function getFilteredResults(results) {
  if (!State.analysisWindow || State.analysisWindow === 0) return results;
  return results.slice(0, State.analysisWindow);
}

function renderAll(key, results) {
  const cfg = LOTTERY_CONFIG[key];
  const filtered = getFilteredResults(results);

  // Fix #19-20: Calcula freq UMA VEZ e reutiliza nas funções que precisam
  const freq       = analyzeFrequency(filtered, key);
  const delay      = analyzeDelay(filtered, key);
  const evenOdd    = analyzeEvenOdd(filtered, key);
  const sumAna     = analyzeSum(filtered);
  const quadrants  = analyzeQuadrants(filtered, key);
  const repetition = analyzeRepetition(filtered);
  const composition = analyzeComposition(filtered, key, freq);  // passa freq reutilizado
  const scores     = computeLotoScores(filtered, key);

  // Render sections
  renderDataStatus(key, results, filtered);
  renderStats(key, filtered, freq, sumAna, repetition);
  renderLastResults(results.slice(0, 5), scores, key);  // sempre últimos 5 reais
  renderHeatmap(freq, delay, scores, key);
  renderFrequencyChart(freq, key);
  renderDelayTable(delay.slice(0, 20));
  renderEvenOdd(evenOdd, cfg);
  renderSumAnalysis(sumAna, cfg);
  renderQuadrants(quadrants, cfg);
  renderRepetition(repetition);
  renderComposition(composition, key);
  renderFechamento(key, results);
  renderSavedGamesSection(key, results);

  // Reset suggestions
  document.getElementById('suggestions-area').innerHTML = `
    <div style="text-align:center; padding:3rem; color:var(--text-secondary);">
      <div style="font-size:3rem; margin-bottom:1rem;">🎯</div>
      <div style="font-family:'Outfit',sans-serif; font-size:1.1rem; font-weight:600; margin-bottom:6px;">Pronto para gerar sugestões!</div>
      <div style="font-size:0.85rem;">Clique no botão acima para gerar 12 jogos com análise estatística completa</div>
    </div>
  `;
}

// Fix #12 + #13 — Painel de status de dados e filtro de período
function renderDataStatus(key, allResults, filteredResults) {
  const el = document.getElementById('data-status-bar');
  if (!el) return;

  const latest = allResults[0];
  const isApi = latest?.source === 'api';
  const total = allResults.length;
  const usingAll = !State.analysisWindow || State.analysisWindow === 0;

  const options = [
    { val: 0,   label: `Todos (${total})` },
    { val: 100,  label: 'Últimos 100' },
    { val: 300,  label: 'Últimos 300' },
    { val: 500,  label: 'Últimos 500' },
  ].filter(o => o.val === 0 || o.val < total);

  el.innerHTML = `
    <div class="data-status-inner">
      <div class="data-status-left">
        <span class="source-tag ${isApi ? 'api' : 'local'}">
          ${isApi ? '● API ao vivo' : '● Base consolidada'}
        </span>
        <span class="data-status-text">
          Analisando <strong>${sanitize(String(filteredResults.length))}</strong> concursos
          ${usingAll ? '(base completa)' : `de ${sanitize(String(total))} disponíveis`}
          · Último: <strong>#${sanitize(String(latest?.concurso || '?'))}</strong> (${sanitize(String(latest?.data || '-'))})
        </span>
      </div>
      <div class="data-status-right">
        <label class="period-label">📅 Período:</label>
        <select id="analysis-window-select" class="period-select">
          ${options.map(o => `<option value="${o.val}" ${State.analysisWindow === o.val ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </div>
    </div>
  `;

  document.getElementById('analysis-window-select')?.addEventListener('change', (e) => {
    State.analysisWindow = +e.target.value;
    renderAll(key, allResults);
  });
}

// ────────────────────────────────────────────────────────────
// STATS CARDS
// ────────────────────────────────────────────────────────────
function renderStats(key, results, freq, sumAna, repetition) {
  const container = document.getElementById('stats-row');
  if (!container) return;
  const cfg = LOTTERY_CONFIG[key];
  const latest = results[0];
  const hotNums = freq.filter(f => f.isHot).length;
  const coldNums = freq.filter(f => f.isCold).length;

  document.getElementById('stats-row').innerHTML = `
    <div class="stat-card">
      <span class="stat-value">${results.length}</span>
      <div class="stat-label">Concursos Analisados</div>
      <div class="stat-sub">desde #${results[results.length-1]?.concurso || '?'}</div>
    </div>
    <div class="stat-card">
      <span class="stat-value">#${latest?.concurso || '?'}</span>
      <div class="stat-label">Último Concurso</div>
      <div class="stat-sub">${latest?.data || '-'}</div>
    </div>
    <div class="stat-card">
      <span class="stat-value" style="color:var(--red)">${hotNums}</span>
      <div class="stat-label">Números Quentes</div>
      <div class="stat-sub">Acima da média histórica</div>
    </div>
    <div class="stat-card">
      <span class="stat-value" style="color:var(--blue)">${coldNums}</span>
      <div class="stat-label">Números Frios</div>
      <div class="stat-sub">Abaixo da média histórica</div>
    </div>
    <div class="stat-card">
      <span class="stat-value" style="color:var(--gold)">${sumAna.sweetMin}–${sumAna.sweetMax}</span>
      <div class="stat-label">Zona Ideal de Soma</div>
      <div class="stat-sub">Média: ${sumAna.mean}</div>
    </div>
    <div class="stat-card">
      <span class="stat-value" style="color:var(--purple)">${repetition.avg}</span>
      <div class="stat-label">Média de Repetições</div>
      <div class="stat-sub">Números repetidos entre sorteios</div>
    </div>
  `;
}

// ────────────────────────────────────────────────────────────
// ÚLTIMOS RESULTADOS
// ────────────────────────────────────────────────────────────
function renderLastResults(results, scores, key) {
  const container = document.getElementById('last-results');
  if (!container) return;
  container.innerHTML = '';
  results.forEach((draw, i) => {
    const el = document.createElement('div');
    el.className = 'result-item';
    el.style.animationDelay = `${i * 0.08}s`;

    const source = draw.source === 'api'
      ? '<span class="source-tag api">● API</span>'
      : '<span class="source-tag local">● Local</span>';

    el.innerHTML = `
      <div class="result-meta">
        <div class="result-concurso">#${draw.concurso} ${source}</div>
        <div class="result-date">${draw.data}</div>
      </div>
      <div class="result-balls">
        ${draw.dezenas.map(n => {
          const s = scores[n];
          const cls = s?.isHot ? 'hot' : s?.isCold ? 'cold' : 'neutral';
          return `<div class="ball ${cls} sm" data-tip="LotoScore: ${s?.lotoScore ?? '-'}">${String(n).padStart(2,'0')}</div>`;
        }).join('')}
      </div>
    `;
    container.appendChild(el);
  });
}

// COMPOSIÇÃO HISTÓRICA
// ──────────────────────────────────────────────────
// ──────────────────────────────────────────────────
function renderComposition(comp, key) {
  const container = document.getElementById('composition-content');
  if (!container) return;
  const cfg = LOTTERY_CONFIG[key];

  container.innerHTML = `
    <!-- Perfil médio -->
    <div style="background:var(--gold-dim);border:1px solid rgba(245,158,11,0.3);border-radius:var(--radius-md);padding:14px 16px;margin-bottom:1rem">
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">Perfil Médio por Sorteio (${comp.totalDraws} concursos)</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <span style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);color:#fca5a5;padding:6px 14px;border-radius:20px;font-family:'Outfit',sans-serif;font-weight:700">
          🔥 ${comp.avgHot} Quentes
        </span>
        <span style="background:rgba(100,116,139,0.15);border:1px solid rgba(100,116,139,0.4);color:#cbd5e1;padding:6px 14px;border-radius:20px;font-family:'Outfit',sans-serif;font-weight:700">
          ⚪ ${comp.avgNormal} Normais
        </span>
        <span style="background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.4);color:#93c5fd;padding:6px 14px;border-radius:20px;font-family:'Outfit',sans-serif;font-weight:700">
          ❄️ ${comp.avgCold} Frios
        </span>
        <span style="background:rgba(168,85,247,0.15);border:1px solid rgba(168,85,247,0.4);color:#c4b5fd;padding:6px 14px;border-radius:20px;font-family:'Outfit',sans-serif;font-weight:700">
          🔄 ${comp.avgRepeated} Repetidos
        </span>
      </div>
      <div style="margin-top:10px;font-size:0.8rem;color:var(--text-secondary)">
        Perfil ideal: <strong style="color:var(--gold)">${comp.idealHot}Q + ${comp.idealNormal}N + ${comp.idealCold}F + ${comp.idealRepeated}R</strong>
      </div>
    </div>

    <!-- Padrões mais frequentes -->
    <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:8px">Padrões de composição mais comuns:</div>
    ${comp.topProfiles.map((p, i) => `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <span style="font-family:'Outfit',sans-serif;font-weight:700;font-size:0.8rem;min-width:160px;color:${i===0?'var(--gold)':'var(--text-primary)'}">${p.key}</span>
        <div style="flex:1;background:var(--border);border-radius:3px;height:7px;overflow:hidden">
          <div style="height:100%;width:${p.pct}%;background:${i===0?'var(--gold)':'var(--blue)'};border-radius:3px;transition:width 1s"></div>
        </div>
        <span style="font-size:0.75rem;color:var(--text-secondary);min-width:65px;text-align:right">${p.count}× (${p.pct}%)</span>
      </div>
    `).join('')}

    <!-- Repetições -->
    <div style="margin-top:1rem;font-size:0.8rem;color:var(--text-secondary);margin-bottom:8px">Quantos números se repetem do sorteio anterior:</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${comp.repeatDist.map(d => `
        <div style="background:var(--bg-card);border:1px solid ${+d.count===comp.idealRepeated?'var(--gold)':'var(--border)'};border-radius:var(--radius-sm);padding:8px 12px;text-align:center;min-width:70px">
          <div style="font-family:'Outfit',sans-serif;font-size:1.3rem;font-weight:700;color:${+d.count===comp.idealRepeated?'var(--gold)':'var(--text-primary)'}">${d.count}</div>
          <div style="font-size:0.7rem;color:var(--text-secondary)">repetidos</div>
          <div style="font-size:0.75rem;color:var(--gold);font-weight:600;margin-top:2px">${d.pct}%</div>
        </div>
      `).join('')}
    </div>
    <div style="margin-top:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;font-size:0.78rem;color:var(--text-secondary)">
      💡 A <strong style="color:var(--gold)">Estratégia Composição Histórica</strong> usa exatamente este padrão para gerar os 3 jogos, incluindo aproximadamente <strong style="color:var(--text-primary)">${comp.idealRepeated}</strong> número(s) do último concurso + <strong style="color:#fca5a5">${comp.idealHot}</strong> quente(s) + <strong style="color:#93c5fd">${comp.idealCold}</strong> frio(s).
    </div>
  `;
}

// ────────────────────────────────────────────────────────────
// HEATMAP
// ────────────────────────────────────────────────────────────
function renderHeatmap(freq, delay, scores, key) {
  const cfg = LOTTERY_CONFIG[key];
  const container = document.getElementById('heatmap-grid');
  if (!container) return;
  const freqMap = {};
  const delayMap = {};
  for (const f of freq)  freqMap[f.number]  = f;
  for (const d of delay) delayMap[d.number] = d;

  const counts = freq.map(f => f.count);
  const maxC = Math.max(...counts);
  const minC = Math.min(...counts);
  const range = maxC - minC || 1;

  // Determine grid columns based on lottery
  const cols = cfg.max <= 25 ? 5 : cfg.max <= 31 ? 8 : cfg.max <= 60 ? 10 : 10;
  container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  container.innerHTML = '';
  for (let n = cfg.min; n <= cfg.max; n++) {
    const f = freqMap[n] || { count: 0, isHot: false, isCold: false };
    const d = delayMap[n] || { delay: 0 };
    const s = scores[n] || { lotoScore: 50 };

    const intensity = (f.count - minC) / range;
    const r = Math.round(intensity * 220 + 20);
    const g = Math.round((1 - intensity) * 180 + 30);
    const b = 40;
    const alpha = 0.4 + intensity * 0.55;

    const el = document.createElement('div');
    el.className = 'heatmap-cell';
    el.setAttribute('data-count', f.count);
    el.setAttribute('data-tip', `${String(n).padStart(2,'0')} | Freq: ${f.count}× | Atraso: ${d.delay} | Score: ${s.lotoScore}`);
    el.style.background = `rgba(${r},${g},${b},${alpha})`;
    el.style.borderColor = f.isHot ? '#ef4444' : f.isCold ? '#3b82f6' : 'transparent';
    el.style.color = intensity > 0.7 ? 'white' : '#cbd5e1';
    el.innerHTML = `<span class="cell-delay">⏱${d.delay}</span>${String(n).padStart(2,'0')}`;

    // Fix #6: Tooltip touch-friendly para mobile
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showTouchTooltip(el);
    });

    container.appendChild(el);
  }

  // Fix #10: Legenda de intensidade do heatmap
  const legendContainer = document.getElementById('heatmap-intensity-legend');
  if (legendContainer) {
    legendContainer.innerHTML = `
      <div class="heatmap-legend">
        <span class="heatmap-legend-label">Menos frequente</span>
        <div class="heatmap-legend-bar"></div>
        <span class="heatmap-legend-label">Mais frequente</span>
        <span class="heatmap-legend-range">(${minC}× – ${maxC}×)</span>
      </div>
    `;
  }
}

// Fix #6: Tooltip touch — mostra/esconde via clique
let activeTooltipEl = null;
function showTouchTooltip(el) {
  if (activeTooltipEl && activeTooltipEl !== el) {
    activeTooltipEl.classList.remove('tooltip-active');
  }
  el.classList.toggle('tooltip-active');
  activeTooltipEl = el.classList.contains('tooltip-active') ? el : null;
}
document.addEventListener('click', () => {
  if (activeTooltipEl) {
    activeTooltipEl.classList.remove('tooltip-active');
    activeTooltipEl = null;
  }
});

// ────────────────────────────────────────────────────────────
// FREQUENCY CHART
// ────────────────────────────────────────────────────────────
function renderFrequencyChart(freq, key) {
  const canvas = document.getElementById('freq-chart');
  if (!canvas) return;
  const cfg = LOTTERY_CONFIG[key];
  const ctx = canvas.getContext('2d');

  if (State.charts.freq) {
    State.charts.freq.destroy();
    State.charts.freq = null;
  }

  const top20 = freq.slice(0, 20);

  State.charts.freq = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: top20.map(f => String(f.number).padStart(2,'0')),
      datasets: [{
        label: 'Frequência',
        data: top20.map(f => f.count),
        backgroundColor: top20.map(f =>
          f.isHot ? 'rgba(239,68,68,0.7)' : 'rgba(245,158,11,0.6)'
        ),
        borderColor: top20.map(f =>
          f.isHot ? '#ef4444' : '#f59e0b'
        ),
        borderWidth: 1.5,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b',
          borderColor: '#f59e0b',
          borderWidth: 1,
          callbacks: {
            label: ctx => ` ${ctx.parsed.y} sorteios (${freq[ctx.dataIndex]?.percentage}%)`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#94a3b8', font: { family: 'Outfit', weight: '600' } }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#94a3b8' },
          beginAtZero: true
        }
      }
    }
  });
}

// ────────────────────────────────────────────────────────────
// DELAY TABLE
// ────────────────────────────────────────────────────────────
function renderDelayTable(delay) {
  const container = document.getElementById('delay-table-body');
  if (!container) return;
  container.innerHTML = delay.map(d => `
    <tr>
      <td class="num-cell" style="font-family:'Outfit',sans-serif;font-weight:700;">${String(d.number).padStart(2,'0')}</td>
      <td><span class="badge badge-${d.status}">${d.statusLabel}</span></td>
      <td>${d.delay}</td>
      <td style="color:var(--text-secondary);font-size:0.8rem;">${d.lastSeenDate}</td>
    </tr>
  `).join('');
}

// ────────────────────────────────────────────────────────────
// PAR/ÍMPAR
// ────────────────────────────────────────────────────────────
function renderEvenOdd(evenOdd, cfg) {
  const container = document.getElementById('even-odd-content');
  if (!container) return;
  const top5 = evenOdd.sorted.slice(0, 5);

  container.innerHTML = `
    <div style="margin-bottom:1rem">
      <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:8px">Distribuições mais frequentes nos ${cfg.pick} números sorteados:</div>
      ${top5.map((d, i) => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <span style="font-family:'Outfit',sans-serif;font-weight:700;font-size:0.9rem;min-width:60px;color:${i===0?'var(--gold)':'var(--text-primary)'}">${d.distribution}</span>
          <div style="flex:1;background:var(--border);border-radius:3px;height:8px;overflow:hidden">
            <div style="height:100%;width:${d.percentage}%;background:${i===0?'var(--gold)':'var(--blue)'};border-radius:3px;transition:width 1s"></div>
          </div>
          <span style="font-size:0.78rem;color:var(--text-secondary);min-width:50px;text-align:right">${d.count}× (${d.percentage}%)</span>
        </div>
      `).join('')}
    </div>
    <div style="background:var(--bg-card);border:1px solid var(--gold-dim);border-radius:var(--radius-sm);padding:10px 14px">
      <div style="font-size:0.75rem;color:var(--text-secondary)">💡 Distribuição ideal para próximo jogo</div>
      <div style="font-family:'Outfit',sans-serif;font-weight:700;font-size:1.1rem;color:var(--gold);margin-top:4px">
        ${evenOdd.best.evens} Pares + ${evenOdd.best.odds} Ímpares
      </div>
    </div>
  `;
}

// ────────────────────────────────────────────────────────────
// SOMA DAS DEZENAS
// ────────────────────────────────────────────────────────────
function renderSumAnalysis(sumAna, cfg) {
  const container = document.getElementById('sum-content');
  if (!container) return;
  const totalRange = sumAna.max - sumAna.min || 1;
  const zoneStart = ((sumAna.sweetMin - sumAna.min) / totalRange) * 100;
  const zoneWidth = ((sumAna.sweetMax - sumAna.sweetMin) / totalRange) * 100;

  container.innerHTML = `
    <div class="stat-mini-grid">
      <div class="stat-mini">
        <div class="stat-mini-val">${sumAna.mean}</div>
        <div class="stat-mini-lbl">Soma Média</div>
      </div>
      <div class="stat-mini">
        <div class="stat-mini-val">${sumAna.sweetMin}–${sumAna.sweetMax}</div>
        <div class="stat-mini-lbl">Zona Ideal</div>
      </div>
      <div class="stat-mini">
        <div class="stat-mini-val">${sumAna.min}</div>
        <div class="stat-mini-lbl">Soma Mínima</div>
      </div>
      <div class="stat-mini">
        <div class="stat-mini-val">${sumAna.max}</div>
        <div class="stat-mini-lbl">Soma Máxima</div>
      </div>
    </div>
    <div style="margin-top:1rem">
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:4px">
        Zona Ideal de Soma (±1 desvio padrão = ${sumAna.stdDev})
      </div>
      <div style="position:relative;height:24px;background:var(--bg-card);border-radius:12px;overflow:hidden;border:1px solid var(--border)">
        <div style="
          position:absolute;
          left:${zoneStart}%;
          width:${zoneWidth}%;
          height:100%;
          background:linear-gradient(90deg,var(--gold-dim),rgba(245,158,11,0.4),var(--gold-dim));
          display:flex;align-items:center;justify-content:center;
          font-size:0.65rem;color:var(--gold);font-weight:600;
        ">Zona Ideal</div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:0.65rem;color:var(--text-dim);margin-top:3px">
        <span>${sumAna.min}</span><span>${sumAna.max}</span>
      </div>
    </div>
  `;
}

// ────────────────────────────────────────────────────────────
// QUADRANTES
// ────────────────────────────────────────────────────────────
function renderQuadrants(qData, cfg) {
  const container = document.getElementById('quadrant-content');
  if (!container) return;
  const maxAvg = Math.max(...qData.quadrants.map(q => parseFloat(q.avgPerDraw))) || 1;

  container.innerHTML = `
    <div class="quadrant-grid">
      ${qData.quadrants.map(q => `
        <div class="quadrant-cell">
          <div class="quadrant-name">${q.name}</div>
          <div class="quadrant-range">${q.min}–${q.max}</div>
          <div style="font-family:'Outfit',sans-serif;font-size:1.4rem;font-weight:700;color:var(--text-primary)">${q.avgPerDraw}</div>
          <div style="font-size:0.7rem;color:var(--text-secondary)">média por sorteio</div>
          <div class="quadrant-bar-outer">
            <div class="quadrant-bar-inner" style="width:${(parseFloat(q.avgPerDraw)/maxAvg)*100}%"></div>
          </div>
          <div class="quadrant-avg">${q.percentage}% dos sorteios</div>
        </div>
      `).join('')}
    </div>
    <div style="margin-top:12px;font-size:0.75rem;color:var(--text-secondary);text-align:center">
      Esperado por quadrante: ${qData.expected.toFixed(2)} números/sorteio
    </div>
  `;
}

// ────────────────────────────────────────────────────────────
// REPETIÇÃO
// ────────────────────────────────────────────────────────────
function renderRepetition(repData) {
  const container = document.getElementById('repetition-content');
  if (!container) return;

  container.innerHTML = `
    <div class="stat-mini-grid">
      <div class="stat-mini">
        <div class="stat-mini-val" style="color:var(--gold)">${repData.avg}</div>
        <div class="stat-mini-lbl">Média de Repetições</div>
      </div>
      <div class="stat-mini">
        <div class="stat-mini-val" style="color:var(--red)">${repData.max}</div>
        <div class="stat-mini-lbl">Máximo</div>
      </div>
      <div class="stat-mini">
        <div class="stat-mini-val" style="color:var(--blue)">${repData.min}</div>
        <div class="stat-mini-lbl">Mínimo</div>
      </div>
      <div class="stat-mini">
        <div class="stat-mini-val">${repData.repeats.length}</div>
        <div class="stat-mini-lbl">Sorteios Analisados</div>
      </div>
    </div>
    <div style="margin-top:1rem;font-size:0.8rem;color:var(--text-secondary);margin-bottom:8px">Distribuição de repetições:</div>
    <div class="repeat-dist">
      ${repData.distribution.map(d => `
        <div class="repeat-dist-item">
          <div class="repeat-dist-count">${d.count}</div>
          <div class="repeat-dist-label">repetições</div>
          <div style="font-size:0.75rem;color:var(--gold);font-weight:600;margin-top:4px">${d.pct}%</div>
        </div>
      `).join('')}
    </div>
    <div style="margin-top:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;font-size:0.78rem;color:var(--text-secondary)">
      💡 <strong style="color:var(--text-primary)">Dica:</strong> Em média ${repData.avg} números se repetem entre sorteios consecutivos. Considere incluir ${Math.round(repData.avg)} números do último resultado na sua aposta.
    </div>
  `;
}

// ────────────────────────────────────────────────────────────
// SUGESTÕES
// ────────────────────────────────────────────────────────────
async function handleGenerateClick() {
  const key = State.currentLottery;
  const results = State.results[key];
  if (!results) return;

  const btn = document.getElementById('generate-btn');
  if (!btn) return;
  btn.classList.add('loading');
  btn.innerHTML = '⏳ Gerando...';

  await new Promise(r => setTimeout(r, 400));

  try {
    const suggestions = generateSuggestions(results, key);
    renderSuggestions(suggestions, key);
    spawnConfetti();
  } catch (err) {
    console.error('[SUGGEST] Erro:', err);
  } finally {
    btn.classList.remove('loading');
    btn.innerHTML = '🎯 Gerar Sugestões';
  }
}

// Fix #1: Listener do generate-btn está SOMENTE em rebuildMainContent() para evitar duplicação

function renderSuggestions(suggestions, key) {
  State.currentSuggestions = suggestions;
  const cfg = LOTTERY_CONFIG[key];
  const container = document.getElementById('suggestions-area');
  const targetConcurso = (State.results[key]?.[0]?.concurso || 0) + 1;

  container.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 16px;margin-bottom:1.5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap">
      <div style="display:flex;gap:1rem;flex-wrap:wrap">
        <div style="font-size:0.8rem;color:var(--text-secondary)">
          📊 <strong style="color:var(--text-primary)">Zona Ideal de Soma:</strong> <span style="color:var(--gold)">${suggestions.meta.sweetZone.min} – ${suggestions.meta.sweetZone.max}</span>
        </div>
        <div style="font-size:0.8rem;color:var(--text-secondary)">
          ⚖️ <strong style="color:var(--text-primary)">Distribuição ideal:</strong> <span style="color:var(--gold)">${suggestions.meta.bestBalance}</span>
        </div>
        <div style="font-size:0.8rem;color:var(--text-secondary)">
          🔄 <strong style="color:var(--text-primary)">Avg repetições:</strong> <span style="color:var(--gold)">${suggestions.meta.avgRepetition}</span>
        </div>
      </div>
      <button class="save-all-btn" id="save-all-suggestions-btn" style="background:var(--gold-dim);border:1px solid var(--gold);color:var(--gold);padding:6px 14px;border-radius:var(--radius-sm);font-weight:600;font-size:0.8rem;cursor:pointer;transition:var(--transition-fast)">
        💾 Salvar Todos os 12 Jogos para o Conc. #${targetConcurso}
      </button>
    </div>
    ${suggestions.strategies.map((strat, si) => `
      <div class="strategy-section">
        <div class="strategy-title">${strat.name}</div>
        <div class="strategy-desc">${strat.description}</div>
        <div class="games-row">
          ${strat.games.map((game, gi) => renderGameCard(game, gi + 1, si, key, suggestions.meta, strat.name, targetConcurso)).join('')}
        </div>
      </div>
    `).join('')}
    <div style="margin-top:1.5rem;padding:12px 16px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:var(--radius-md);font-size:0.78rem;color:#fca5a5">
      ⚠️ <strong>Atenção:</strong> Estas sugestões são baseadas em análise estatística de dados históricos. Loterias são eventos aleatórios e independentes — nenhum sistema garante acertos. Jogue com responsabilidade.
    </div>
  `;

  // Bind copy buttons — Fix #11: fallback de clipboard
  container.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nums = btn.dataset.numbers;
      copyToClipboard(nums).then(() => {
        btn.classList.add('copied');
        btn.textContent = '✅ Copiado!';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.textContent = '📋 Copiar';
        }, 2000);
      }).catch(() => {
        btn.textContent = '⚠️ Erro ao copiar';
        setTimeout(() => { btn.textContent = '📋 Copiar'; }, 2000);
      });
    });
  });

  // Bind save single game buttons
  container.querySelectorAll('.save-game-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const gameData = JSON.parse(btn.dataset.game);
      const savedList = getSavedGames(key);
      // Evita duplicados
      const exists = savedList.some(g => g.numbers.join(',') === gameData.numbers.join(',') && g.concursoAlvo === gameData.concursoAlvo);
      if (!exists) {
        savedList.push(gameData);
        saveGamesToStorage(key, savedList);
        renderSavedGamesSection(key, State.results[key]);
      }
      btn.textContent = '💾 Salvo!';
      btn.style.background = 'var(--green-dim)';
      btn.style.borderColor = 'var(--green)';
      btn.style.color = '#86efac';
    });
  });

  // Bind save all button
  document.getElementById('save-all-suggestions-btn')?.addEventListener('click', () => {
    const savedList = getSavedGames(key);
    let addedCount = 0;

    suggestions.strategies.forEach(strat => {
      strat.games.forEach((game, gi) => {
        const item = {
          id: 'g_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
          lotteryKey: key,
          concursoAlvo: targetConcurso,
          strategyId: strat.id,
          strategyName: strat.name,
          gameNum: gi + 1,
          numbers: game.numbers,
          sum: game.sum,
          evens: game.evens,
          odds: game.odds,
          avgScore: game.avgScore,
          criadoEm: new Date().toLocaleDateString('pt-BR')
        };
        if (!savedList.some(g => g.numbers.join(',') === item.numbers.join(',') && g.concursoAlvo === targetConcurso)) {
          savedList.push(item);
          addedCount++;
        }
      });
    });

    if (addedCount > 0) {
      saveGamesToStorage(key, savedList);
      renderSavedGamesSection(key, State.results[key]);
      const b = document.getElementById('save-all-suggestions-btn');
      if (b) {
        b.textContent = `✅ ${addedCount} Jogos Salvos!`;
        b.style.background = 'var(--green-dim)';
        b.style.borderColor = 'var(--green)';
        b.style.color = '#86efac';
      }
    }
  });
}

function renderGameCard(game, gameNum, stratNum, key, meta, strategyName, targetConcurso) {
  const inZone = game.sum >= meta.sweetZone.min && game.sum <= meta.sweetZone.max;
  const delay = stratNum * 0.1 + (gameNum - 1) * 0.15;
  const numbersStr = game.numbers.join(', ');
  const isComposition = game.strategyId === 'composition';

  const gameJson = JSON.stringify({
    id: 'g_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    lotteryKey: key,
    concursoAlvo: targetConcurso,
    strategyId: game.strategyId || 'strat_' + stratNum,
    strategyName: strategyName || 'Estratégia ' + (stratNum + 1),
    gameNum,
    numbers: game.numbers,
    sum: game.sum,
    evens: game.evens,
    odds: game.odds,
    avgScore: game.avgScore,
    criadoEm: new Date().toLocaleDateString('pt-BR')
  }).replace(/"/g, '&quot;');

  return `
    <div class="game-card" style="animation-delay:${delay}s${isComposition ? ';border-color:rgba(168,85,247,0.4)' : ''}">
      <div class="game-header">
        <div class="game-label">🎰 Jogo ${gameNum}</div>
        <div class="game-score">⭐ Score: ${game.avgScore}</div>
      </div>
      <div class="game-balls">
        ${game.numbers.map(n => {
          const d = game.numberDetails.find(nd => nd.number === n);
          const cls = d?.isHot ? 'hot' : d?.isCold ? 'cold' : 'neutral';
          const isFib = d?.isFib ? ' fib' : '';
          return `<div class="ball ${cls}${isFib} sm" data-tip="Score: ${d?.lotoScore ?? '-'}">${String(n).padStart(2,'0')}</div>`;
        }).join('')}
      </div>
      <div class="game-meta">
        <span class="meta-chip ${inZone ? 'gold' : ''}">&#931; ${game.sum}${inZone ? ' ✓' : ''}</span>
        <span class="meta-chip">${game.evens}P / ${game.odds}I</span>
        <span class="meta-chip ${game.quadrantCoverage >= 3 ? 'good' : ''}">Q: ${game.quadrantCoverage}/4</span>
        ${game.hotInGame !== undefined ? `<span class="meta-chip" style="background:rgba(239,68,68,0.12);border-color:rgba(239,68,68,0.3);color:#fca5a5">🔥${game.hotInGame}</span>` : ''}
        ${game.normalInGame !== undefined ? `<span class="meta-chip" style="background:rgba(100,116,139,0.12);border-color:rgba(100,116,139,0.3);color:#cbd5e1">⚪${game.normalInGame}</span>` : ''}
        ${game.coldInGame !== undefined ? `<span class="meta-chip" style="background:rgba(59,130,246,0.12);border-color:rgba(59,130,246,0.3);color:#93c5fd">❄️${game.coldInGame}</span>` : ''}
        ${game.repeatedInGame !== undefined ? `<span class="meta-chip" style="background:rgba(168,85,247,0.12);border-color:rgba(168,85,247,0.3);color:#c4b5fd">🔄${game.repeatedInGame}</span>` : ''}
      </div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="copy-btn" data-numbers="${numbersStr}" style="flex:1">📋 Copiar</button>
        <button class="save-game-btn" data-game="${gameJson}" style="flex:1;background:var(--gold-dim);border:1px solid var(--gold);color:var(--gold);border-radius:var(--radius-sm);font-size:0.8rem;cursor:pointer;transition:var(--transition-fast)">💾 Salvar</button>
      </div>
    </div>
  `;
}

// ────────────────────────────────────────────────────────────
// CONFETTI
// ────────────────────────────────────────────────────────────
function spawnConfetti() {
  const colors = ['#f59e0b','#22c55e','#3b82f6','#a855f7','#ef4444','#f97316','#fcd34d'];
  for (let i = 0; i < 50; i++) {
    setTimeout(() => {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.cssText = `
        left: ${Math.random() * 100}vw;
        top: -10px;
        background: ${colors[Math.floor(Math.random() * colors.length)]};
        transform: rotate(${Math.random() * 360}deg);
        width: ${6 + Math.random() * 8}px;
        height: ${6 + Math.random() * 8}px;
        animation-duration: ${2 + Math.random() * 2}s;
        animation-delay: ${Math.random() * 0.5}s;
      `;
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 4000);
    }, i * 30);
  }
}

// ────────────────────────────────────────────────────────────
// LOADING STATE
// ────────────────────────────────────────────────────────────
function showLoadingState(lotteryName) {
  const name = lotteryName || 'Loteria';
  document.getElementById('main-content').innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <div class="loading-text" id="loading-msg">Carregando ${name}...</div>
      <div class="loading-steps" id="loading-steps">
        <div class="loading-step active" id="step-api">🌐 Buscando API</div>
        <div class="loading-step" id="step-analyze">📊 Analisando</div>
        <div class="loading-step" id="step-render">🎨 Renderizando</div>
      </div>
    </div>
  `;
  // Recreate main-content structure
  rebuildMainContent();
}

function updateLoadingMessage(msg) {
  const el = document.getElementById('loading-msg');
  if (el) el.textContent = msg;
  // Atualiza step visual
  if (msg.includes('API') || msg.includes('Caixa')) {
    document.getElementById('step-api')?.classList.add('done');
    document.getElementById('step-analyze')?.classList.add('active');
  } else if (msg.includes('local') || msg.includes('base')) {
    document.getElementById('step-api')?.classList.add('done');
    document.getElementById('step-analyze')?.classList.add('done');
    document.getElementById('step-render')?.classList.add('active');
  }
}

function rebuildMainContent() {
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <!-- BARRA DE STATUS DE DADOS (Fix #12 + #13) -->
    <div id="data-status-bar" class="data-status-bar"></div>

    <!-- STATS -->
    <div class="card">
      <div class="card-header">
        <span class="card-icon">📊</span>
        <span class="card-title">Resumo Estatístico</span>
      </div>
      <div class="stats-row" id="stats-row">
        ${Array(6).fill('<div class="stat-card skeleton" style="height:88px"></div>').join('')}
      </div>
    </div>

    <!-- ÚLTIMOS RESULTADOS + HEATMAP -->
    <div class="top-grid" id="top-grid">
      <div class="card">
        <div class="card-header">
          <span class="card-icon">🏆</span>
          <span class="card-title">Últimos Resultados</span>
          <span class="card-subtitle">5 mais recentes</span>
        </div>
        <div class="last-results-list" id="last-results">
          ${Array(5).fill('<div class="skeleton" style="height:56px;border-radius:12px"></div>').join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-icon">🌡️</span>
          <span class="card-title">Mapa de Calor</span>
          <span class="card-subtitle">🔴 Quente · 🔵 Frio</span>
        </div>
        <div class="legend">
          <div class="legend-item"><div class="legend-dot" style="background:#ef4444"></div> Quente (acima da média)</div>
          <div class="legend-item"><div class="legend-dot" style="background:#3b82f6"></div> Frio (abaixo da média)</div>
          <div class="legend-item"><div class="legend-dot" style="background:#4b5563"></div> Normal</div>
        </div>
        <div class="heatmap-grid" id="heatmap-grid"></div>
        <!-- Fix #10: Legenda de intensidade -->
        <div id="heatmap-intensity-legend"></div>
      </div>
    </div>

    <!-- FREQUÊNCIA CHART + DELAY TABLE -->
    <div class="analysis-grid">
      <div class="card">
        <div class="card-header">
          <span class="card-icon">📈</span>
          <span class="card-title">Top 20 Mais Sorteados</span>
        </div>
        <div class="chart-container">
          <canvas id="freq-chart"></canvas>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-icon">⏱️</span>
          <span class="card-title">Atraso por Número</span>
          <span class="card-subtitle">Top 20 mais atrasados</span>
        </div>
        <div class="delay-table-wrapper">
          <table class="delay-table">
            <thead>
              <tr>
                <th>Número</th>
                <th>Status</th>
                <th>Atraso</th>
                <th>Último Sorteio</th>
              </tr>
            </thead>
            <tbody id="delay-table-body"></tbody>

          </table>
        </div>
      </div>
    </div>

    <!-- PAR/ÍMPAR + SOMA + QUADRANTES + REPETIÇÃO -->
    <div class="analysis-grid">
      <div class="card">
        <div class="card-header">
          <span class="card-icon">⚖️</span>
          <span class="card-title">Distribuição Par/Ímpar</span>
        </div>
        <div id="even-odd-content"></div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-icon">➕</span>
          <span class="card-title">Análise de Soma</span>
        </div>
        <div id="sum-content"></div>
      </div>
    </div>

    <div class="analysis-grid">
      <div class="card">
        <div class="card-header">
          <span class="card-icon">📐</span>
          <span class="card-title">Distribuição por Quadrantes</span>
        </div>
        <div id="quadrant-content"></div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-icon">🔄</span>
          <span class="card-title">Análise de Repetições</span>
        </div>
        <div id="repetition-content"></div>
      </div>
    </div>

    <!-- COMPOSIÇÃO HISTÓRICA -->
    <div class="card">
      <div class="card-header">
        <span class="card-icon">🧬</span>
        <span class="card-title">Composição Histórica dos Sorteios</span>
        <span class="card-subtitle">Padrão de tipos de números que saem juntos</span>
      </div>
      <div id="composition-content"></div>
    </div>

    <!-- FECHAMENTO MATEMÁTICO -->
    <div class="card">
      <div class="card-header">
        <span class="card-icon">🔐</span>
        <span class="card-title">Fechamento Matemático</span>
        <span class="card-subtitle">Cobertura garantida com o menor número de jogos</span>
      </div>
      <div id="fechamento-content"></div>
    </div>

    <!-- MEUS JOGOS SALVOS E CONFERÊNCIA DE DESEMPENHO -->
    <div class="card">
      <div class="card-header">
        <span class="card-icon">📌</span>
        <span class="card-title">Palpites Salvos & Análise de Desempenho</span>
        <span class="card-subtitle">Conferência automática com resultados oficiais</span>
      </div>
      <div id="saved-games-content"></div>
    </div>

    <!-- SUGESTÕES -->
    <div class="card">
      <div class="suggestions-header">
        <div>
          <div class="section-title">🎯 Sugestões de Jogos</div>
          <div class="section-subtitle">4 estratégias × 3 jogos = 12 sugestões baseadas em análise estatística + composição histórica</div>
        </div>
        <button class="generate-btn" id="generate-btn">
          🎯 Gerar Sugestões
        </button>
      </div>
      <div id="suggestions-area">
        <div style="text-align:center; padding:3rem; color:var(--text-secondary);">
          <div style="font-size:3rem; margin-bottom:1rem;">🎯</div>
          <div style="font-family:'Outfit',sans-serif; font-size:1.1rem; font-weight:600; margin-bottom:6px;">Pronto para gerar sugestões!</div>
          <div style="font-size:0.85rem;">Clique no botão acima para gerar 12 jogos com análise estatística completa</div>
        </div>
      </div>
    </div>
  `;

  // Rebind generate button
  document.getElementById('generate-btn')?.addEventListener('click', handleGenerateClick);

  // Fix responsive grid
  const topGrid = document.getElementById('top-grid');
  if (window.innerWidth < 768) {
    topGrid.style.gridTemplateColumns = '1fr';
  }
}

function showError(msg) {
  document.getElementById('main-content').innerHTML = `
    <div style="text-align:center;padding:3rem;color:var(--text-secondary)">
      <div style="font-size:2rem;margin-bottom:1rem">⚠️</div>
      <div>${msg}</div>
    </div>
  `;
}

// ────────────────────────────────────────────────────────────
// SEÇÃO DE JOGOS SALVOS E CONFERÊNCIA AUTOMÁTICA
// ────────────────────────────────────────────────────────────
function renderSavedGamesSection(key, results) {
  const container = document.getElementById('saved-games-content');
  if (!container) return;

  const savedList = getSavedGames(key);

  if (savedList.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:2rem;color:var(--text-secondary)">
        <div style="font-size:2.5rem;margin-bottom:8px">💾</div>
        <div style="font-family:'Outfit',sans-serif;font-weight:600;font-size:1rem;color:var(--text-primary);margin-bottom:4px">Nenhum palpite salvo para esta loteria</div>
        <div style="font-size:0.82rem">Gere sugestões acima e clique em <strong>"💾 Salvar"</strong> ou <strong>"💾 Salvar Todos"</strong> para acompanhar a taxa de acertos nos próximos concursos!</div>
      </div>
    `;
    return;
  }

  // Conferir cada jogo contra o concurso-alvo E TODOS os posteriores
  const checkedGames = savedList.map(g => {
    const multiChecks = checkGameAcrossDraws(g, results, key);
    const bestResult  = getBestResult(multiChecks);
    const hasAnyPrize = multiChecks.some(c => c.prize);
    return { ...g, multiChecks, bestResult, hasAnyPrize };
  });

  // Estatísticas por estratégia (baseado no melhor resultado de cada jogo)
  const stratStats = {};
  checkedGames.forEach(g => {
    const sId = g.strategyName || g.strategyId;
    if (!stratStats[sId]) {
      stratStats[sId] = { name: sId, total: 0, checked: 0, totalHits: 0, prizes: 0, maxHits: 0 };
    }
    stratStats[sId].total++;
    if (g.bestResult) {
      stratStats[sId].checked++;
      stratStats[sId].totalHits += g.bestResult.hits;
      if (g.bestResult.hits > stratStats[sId].maxHits) stratStats[sId].maxHits = g.bestResult.hits;
      if (g.bestResult.prize) stratStats[sId].prizes++;
    }
  });

  const stratRanking = Object.values(stratStats)
    .map(s => ({ ...s, avgHits: s.checked > 0 ? (s.totalHits / s.checked).toFixed(2) : '0.00' }))
    .sort((a, b) => parseFloat(b.avgHits) - parseFloat(a.avgHits));

  const bestStrat = stratRanking.find(s => s.checked > 0);
  const anyPrize  = checkedGames.some(g => g.hasAnyPrize);

  container.innerHTML = `
    <!-- Banner de premiação global -->
    ${anyPrize ? `
      <div style="background:linear-gradient(135deg,rgba(245,158,11,0.25),rgba(234,179,8,0.12));border:1px solid var(--gold);border-radius:var(--radius-md);padding:16px 20px;margin-bottom:1.5rem;display:flex;align-items:center;gap:14px">
        <div style="font-size:2.2rem">🎉</div>
        <div>
          <div style="font-family:'Outfit',sans-serif;font-weight:700;font-size:1.05rem;color:var(--gold)">Premiação encontrada nos seus jogos salvos!</div>
          <div style="font-size:0.82rem;color:var(--text-secondary);margin-top:3px">Um ou mais jogos acertaram dezenas suficientes para prêmio. Veja o destaque 🏆 em cada card abaixo.</div>
        </div>
      </div>
    ` : ''}

    <!-- Top Estratégia Mais Assertiva -->
    ${bestStrat ? `
      <div style="background:var(--gold-dim);border:1px solid var(--gold);border-radius:var(--radius-md);padding:14px 16px;margin-bottom:1.5rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:0.75rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em">🏆 Estratégia Mais Assertiva Salva</div>
          <div style="font-family:'Outfit',sans-serif;font-weight:700;font-size:1.1rem;color:var(--gold);margin-top:2px">${bestStrat.name}</div>
        </div>
        <div style="display:flex;gap:1rem">
          <div style="text-align:right">
            <div style="font-family:'Outfit',sans-serif;font-weight:700;font-size:1.3rem;color:var(--text-primary)">${bestStrat.avgHits} dezenas</div>
            <div style="font-size:0.7rem;color:var(--text-secondary)">Melhor acerto médio</div>
          </div>
          ${bestStrat.prizes > 0 ? `
            <div style="text-align:right">
              <div style="font-family:'Outfit',sans-serif;font-weight:700;font-size:1.3rem;color:#86efac">${bestStrat.prizes} prêmio(s)</div>
              <div style="font-size:0.7rem;color:var(--text-secondary)">Acertos premiados</div>
            </div>
          ` : ''}
        </div>
      </div>
    ` : ''}

    <!-- Ranking de Estratégias -->
    ${stratRanking.length > 0 ? `
      <div style="margin-bottom:1.5rem">
        <div style="font-size:0.82rem;font-weight:600;color:var(--text-secondary);margin-bottom:8px">Desempenho por Estratégia (conferência em todos os concursos posteriores):</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:10px">
          ${stratRanking.map(s => `
            <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px">
              <div style="font-family:'Outfit',sans-serif;font-weight:700;font-size:0.9rem;color:var(--text-primary);margin-bottom:6px">${s.name}</div>
              <div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--text-secondary)">
                <span>Jogos conferidos:</span><strong style="color:var(--text-primary)">${s.checked}/${s.total}</strong>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--text-secondary);margin-top:2px">
                <span>Melhor acerto (médio):</span><strong style="color:var(--gold)">${s.avgHits} dezenas</strong>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--text-secondary);margin-top:2px">
                <span>Maior acerto:</span><strong style="color:var(--green)">${s.maxHits} acertos</strong>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <!-- Lista de Jogos Salvos -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
      <div style="font-size:0.9rem;font-weight:700;color:var(--text-primary)">Palpites Armazenados (${checkedGames.length})</div>
      <button id="clear-all-saved-btn" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;padding:4px 12px;border-radius:var(--radius-sm);font-size:0.78rem;cursor:pointer;transition:var(--transition-fast)">🗑️ Limpar Todos os Salvos</button>
    </div>

    <div class="games-row">
      ${checkedGames.map(g => renderSavedGameCard(g, key)).join('')}
    </div>
  `;

  document.getElementById('clear-all-saved-btn')?.addEventListener('click', () => {
    if (confirm('Tem certeza que deseja apagar todos os palpites salvos desta loteria?')) {
      saveGamesToStorage(key, []);
      renderSavedGamesSection(key, results);
    }
  });

  container.querySelectorAll('.delete-game-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const gId = btn.dataset.id;
      const updated = getSavedGames(key).filter(g => g.id !== gId);
      saveGamesToStorage(key, updated);
      renderSavedGamesSection(key, results);
    });
  });

  container.querySelectorAll('.toggle-history-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById(`history-panel-${btn.dataset.gid}`);
      if (!panel) return;
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : 'block';
      btn.textContent = isOpen ? '📅 Ver histórico por concurso' : '🔼 Fechar histórico';
    });
  });
}

// ── Verifica o jogo contra todos os concursos >= concursoAlvo ──
function checkGameAcrossDraws(game, results, key) {
  return results
    .filter(r => r.concurso >= game.concursoAlvo)
    .sort((a, b) => a.concurso - b.concurso)
    .map(draw => {
      const drawSet = new Set(draw.dezenas);
      const hitsNumbers = game.numbers.filter(n => drawSet.has(n));
      const hits = hitsNumbers.length;
      return { concurso: draw.concurso, data: draw.data, hits, hitsNumbers, prize: getPrizeBadge(key, hits) };
    });
}

// ── Retorna o resultado com mais acertos ──
function getBestResult(checks) {
  if (!checks || checks.length === 0) return null;
  return checks.reduce((best, c) => c.hits > (best?.hits ?? -1) ? c : best, null);
}

// ── Renderiza um card de jogo salvo com histórico multi-concurso ──
function renderSavedGameCard(g, key) {
  const safeid   = (g.id || '').replace(/[^a-z0-9_]/gi, '_');
  const isPending = g.multiChecks.length === 0;
  const best     = g.bestResult;

  const statusBadge = isPending
    ? `<span class="badge badge-late">⏳ Conc. #${g.concursoAlvo} Aguardando</span>`
    : `<span class="badge badge-normal">✅ ${g.multiChecks.length} concurso(s) verificado(s)</span>`;

  const bestPrizeTag = best?.prize
    ? `<span class="meta-chip ${best.prize.cls}" style="font-weight:700">${best.prize.name}</span>` : '';

  // Bolas com destaque no MELHOR resultado
  const ballsHtml = g.numbers.map(n => {
    const isHit = best && best.hitsNumbers?.includes(n);
    return `<div class="ball ${isHit ? 'hot' : 'neutral'} sm"
      style="${isHit ? 'box-shadow:0 0 12px #22c55e;border-color:#22c55e;background:linear-gradient(135deg,#15803d,#22c55e)' : ''}"
      data-tip="${isHit ? '✓ Acertou' : ''}">${String(n).padStart(2,'0')}</div>`;
  }).join('');

  // Linha do tempo por concurso
  const timelineHtml = g.multiChecks.map((c, idx) => {
    const isTarget = c.concurso === g.concursoAlvo;
    const prizeTag = c.prize
      ? `<span style="margin-left:6px;background:${c.prize.cls==='gold'?'rgba(245,158,11,0.2)':'rgba(34,197,94,0.15)'};border:1px solid ${c.prize.cls==='gold'?'var(--gold)':'var(--green)'};color:${c.prize.cls==='gold'?'var(--gold)':'#86efac'};padding:2px 8px;border-radius:10px;font-size:0.72rem;font-weight:700">${c.prize.name}</span>`
      : '';
    const barW   = Math.round((c.hits / g.numbers.length) * 100);
    const barClr = c.prize ? (c.prize.cls==='gold' ? 'var(--gold)' : 'var(--green)') : 'var(--blue)';
    return `
      <div style="display:flex;align-items:center;padding:7px 10px;border-radius:8px;margin-bottom:4px;
        background:${isTarget?'rgba(245,158,11,0.08)':idx%2===0?'rgba(255,255,255,0.02)':'transparent'};
        border:1px solid ${c.prize?'rgba(34,197,94,0.3)':isTarget?'rgba(245,158,11,0.3)':'transparent'}">
        <div style="width:6px;height:6px;border-radius:50%;background:${c.prize?(c.prize.cls==='gold'?'var(--gold)':'var(--green)'):'var(--text-dim)'};margin-right:8px;flex-shrink:0"></div>
        <div style="flex:1;min-width:0">
          <span style="font-family:'Outfit',sans-serif;font-size:0.8rem;font-weight:700;color:${isTarget?'var(--gold)':'var(--text-primary)'}">
            #${c.concurso}${isTarget?' <span style="font-size:0.68rem;opacity:0.7">(alvo)</span>':''}
          </span>
          <span style="font-size:0.72rem;color:var(--text-secondary);margin-left:6px">${c.data}</span>
          <span style="display:inline-block;width:${barW}%;min-width:4px;height:5px;background:${barClr};border-radius:3px;vertical-align:middle;margin-left:8px"></span>
          ${prizeTag}
        </div>
        <div style="font-family:'Outfit',sans-serif;font-weight:700;font-size:0.85rem;color:${c.prize?(c.prize.cls==='gold'?'var(--gold)':'var(--green)'):'var(--text-secondary)'};margin-left:8px;white-space:nowrap">
          ${c.hits} acerto${c.hits!==1?'s':''}
        </div>
      </div>`;
  }).join('');

  return `
    <div class="game-card" style="position:relative${g.hasAnyPrize?';border-color:rgba(34,197,94,0.5)':''}">
      <div class="game-header">
        <div>
          <div class="game-label">${g.strategyName || 'Jogo Salvo'} #${g.gameNum || 1}</div>
          <div style="font-size:0.7rem;color:var(--text-secondary)">Alvo: Conc. #${g.concursoAlvo} · Salvo em ${g.criadoEm}</div>
        </div>
        <div>${statusBadge}</div>
      </div>

      <div class="game-balls">${ballsHtml}</div>

      <div class="game-meta">
        ${best
          ? `<span class="meta-chip ${best.hits >= 4 ? 'gold' : ''}">🏆 Melhor: ${best.hits} acertos (Conc. #${best.concurso})</span>`
          : '<span class="meta-chip">Aguardando sorteio</span>'}
        ${bestPrizeTag}
        <span class="meta-chip">&#931; ${g.sum}</span>
        <span class="meta-chip">${g.evens}P / ${g.odds}I</span>
      </div>

      ${g.multiChecks.length > 0 ? `
        <div style="margin-top:10px">
          <button class="toggle-history-btn" data-gid="${safeid}"
            style="width:100%;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.25);color:#93c5fd;padding:6px 12px;border-radius:var(--radius-sm);font-size:0.78rem;cursor:pointer;transition:var(--transition-fast);text-align:center">
            📅 Ver histórico por concurso
          </button>
          <div id="history-panel-${safeid}" style="display:none;margin-top:10px">
            <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">Acertos por concurso:</div>
            ${timelineHtml}
          </div>
        </div>
      ` : ''}

      <div style="display:flex;justify-content:flex-end;margin-top:8px">
        <button class="delete-game-btn" data-id="${g.id}"
          style="background:transparent;border:1px solid var(--border);color:var(--text-dim);padding:4px 10px;border-radius:var(--radius-sm);font-size:0.75rem;cursor:pointer;transition:var(--transition-fast)">
          🗑️ Excluir
        </button>
      </div>
    </div>
  `;
}

// ============================================================
// FECHAMENTO MATEMÁTICO — Cobertura garantida
// ============================================================
const FState = { pool: {} };

function getFPool(key) {
  if (!FState.pool[key]) FState.pool[key] = new Set();
  return FState.pool[key];
}

// Limites: [min dezenas no pool, max dezenas no pool]
const FECH_LIMITS = {
  megasena:   { min: 7,  max: 10 },
  lotofacil:  { min: 16, max: 17 },
  quina:      { min: 6,  max: 9  },
  diadesorte: { min: 8,  max: 10 },
};

function comb(n, k) {
  if (k > n || k < 0) return 0;
  if (k === 0 || k === n) return 1;
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return Math.round(r);
}

function generateAllCombinations(arr, k) {
  const result = [];
  function go(start, cur) {
    if (cur.length === k) { result.push([...cur]); return; }
    const rem = k - cur.length;
    for (let i = start; i <= arr.length - rem; i++) {
      cur.push(arr[i]); go(i + 1, cur); cur.pop();
    }
  }
  go(0, []);
  return result;
}

function getFechGuarantee(key, m) {
  const k = LOTTERY_CONFIG[key].pick;
  const out = [];
  for (let d = k; d >= Math.max(k - 3, 1); d--) {
    const p = getPrizeBadge(key, d);
    out.push({
      label:     p ? p.name : `${d} acertos`,
      condition: `se ${d} das suas ${m} dezenas forem sorteadas`,
      cls:       p?.cls || ''
    });
  }
  return out;
}

function renderFechamento(key, results) {
  const container = document.getElementById('fechamento-content');
  if (!container) return;

  const cfg    = LOTTERY_CONFIG[key];
  const pool   = getFPool(key);
  const lim    = FECH_LIMITS[key] || { min: cfg.pick + 1, max: cfg.pick + 4 };
  const k      = cfg.pick;
  const m      = pool.size;
  const aposta = parseFloat(cfg.aposta.replace('R$ ', '').replace(',', '.'));
  const nGames = m >= k ? comb(m, k) : 0;
  const cost   = (nGames * aposta).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const ready  = m >= lim.min && m <= lim.max;

  container.innerHTML = `
    <!-- Cabeçalho + controles numa linha -->
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <span style="font-size:0.8rem;color:var(--text-secondary)">
        Selecione <strong style="color:var(--text-primary)">${lim.min}–${lim.max} dezenas</strong>
        para desdobramento de ${k} dezenas
      </span>
      <button onclick="fechSuggest('${key}')" style="margin-left:auto;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);color:var(--gold);padding:3px 10px;border-radius:20px;font-size:0.72rem;cursor:pointer">⭐ Auto</button>
      <button onclick="fechClear('${key}')" style="background:transparent;border:1px solid var(--border);color:var(--text-dim);padding:3px 8px;border-radius:20px;font-size:0.72rem;cursor:pointer">✕</button>
    </div>

    <!-- Grade compacta: bolas 30px fixas, flex-wrap -->
    <div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px">
      ${Array.from({ length: cfg.max - cfg.min + 1 }, (_, i) => i + cfg.min).map(n => {
        const sel = pool.has(n);
        return `<div onclick="fechToggle(${n},'${key}')"
          style="width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;
            font-family:'Outfit',sans-serif;font-weight:700;font-size:0.67rem;cursor:pointer;user-select:none;flex-shrink:0;transition:all 0.1s;
            ${sel
              ? `background:${cfg.color};color:#fff;border:2px solid ${cfg.color}`
              : 'background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)'
            }">${String(n).padStart(2,'0')}</div>`;
      }).join('')}
    </div>

    <!-- Status numa linha só -->
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:0.78rem">
      <strong>${m}</strong> selecionado${m!==1?'s':''}
      ${m < lim.min
        ? `<span style="color:var(--gold)">· selecione mais ${lim.min-m}</span>`
        : m > lim.max
          ? `<span style="color:#fca5a5">· máximo ${lim.max}</span>`
          : `<span style="background:rgba(34,197,94,0.12);border:1px solid var(--green);color:#86efac;padding:2px 10px;border-radius:10px">✅ ${nGames} jogo${nGames!==1?'s':''} · R$ ${cost}</span>`
      }
    </div>

    <!-- Garantia matemática -->
    ${ready ? `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px 16px;margin-bottom:1rem">
        <div style="font-size:0.78rem;font-weight:700;color:var(--text-primary);margin-bottom:8px">📐 Garantia Matemática do Desdobramento</div>
        ${getFechGuarantee(key, m).map(g => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:0.79rem">
            <span style="background:${g.cls==='gold'?'rgba(245,158,11,0.2)':'rgba(59,130,246,0.12)'};
              border:1px solid ${g.cls==='gold'?'var(--gold)':'rgba(59,130,246,0.4)'};
              color:${g.cls==='gold'?'var(--gold)':'#93c5fd'};
              padding:2px 10px;border-radius:12px;font-weight:600;white-space:nowrap">${g.label}</span>
            <span style="color:var(--text-secondary)">${g.condition}</span>
          </div>
        `).join('')}
        <div style="margin-top:8px;font-size:0.75rem;color:var(--text-dim);line-height:1.5">
          ⚠️ A garantia vale apenas se os números sorteados estiverem <strong>dentro</strong> do seu grupo de ${m} dezenas.
        </div>
      </div>
    ` : ''}

    <!-- Botão gerar -->
    <button id="fech-gen-btn" onclick="fechGenerate('${key}')" ${!ready ? 'disabled' : ''}
      style="width:100%;padding:13px;border-radius:var(--radius-md);font-family:'Outfit',sans-serif;font-weight:700;font-size:1rem;
        cursor:${ready ? 'pointer' : 'not-allowed'};transition:all 0.2s;
        background:${ready ? `linear-gradient(135deg,${cfg.color}bb,${cfg.color})` : 'var(--bg-card)'};
        border:1px solid ${ready ? cfg.color : 'var(--border)'};
        color:${ready ? '#fff' : 'var(--text-dim)'}">
      🔐 Gerar Fechamento${ready ? ` — ${nGames} jogo${nGames!==1?'s':''}` : ''}
    </button>

    <div id="fech-results" style="margin-top:1.5rem"></div>
  `;
}

function fechToggle(n, key) {
  const pool = getFPool(key);
  const lim  = FECH_LIMITS[key];
  if (pool.has(n)) pool.delete(n);
  else if (pool.size < lim.max) pool.add(n);
  renderFechamento(key, State.results[key]);
}

function fechClear(key) {
  FState.pool[key] = new Set();
  renderFechamento(key, State.results[key]);
}

function fechSuggest(key) {
  const results = State.results[key];
  if (!results) return;
  const lim    = FECH_LIMITS[key];
  const cfg    = LOTTERY_CONFIG[key];
  const scores = computeLotoScores(results, key);
  const nums   = Array.from({ length: cfg.max - cfg.min + 1 }, (_, i) => i + cfg.min)
    .sort((a, b) => (scores[b]?.lotoScore || 50) - (scores[a]?.lotoScore || 50))
    .slice(0, lim.min);
  FState.pool[key] = new Set(nums);
  renderFechamento(key, results);
}

function fechGenerate(key) {
  const pool    = getFPool(key);
  const cfg     = LOTTERY_CONFIG[key];
  const results = State.results[key];
  const poolArr = Array.from(pool).sort((a, b) => a - b);
  const games   = generateAllCombinations(poolArr, cfg.pick);
  const scores  = computeLotoScores(results, key);
  const aposta  = parseFloat(cfg.aposta.replace('R$ ', '').replace(',', '.'));
  const nextC   = (results[0]?.concurso || 0) + 1;

  const container = document.getElementById('fech-results');
  if (!container) return;

  container.innerHTML = `
    <div style="border-top:1px solid var(--border);padding-top:1.5rem">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:1.2rem">
        <div>
          <div style="font-family:'Outfit',sans-serif;font-weight:700;font-size:1.15rem;color:var(--text-primary)">
            ✅ ${games.length} jogos gerados
          </div>
          <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px">
            Custo total: <strong style="color:var(--gold)">R$ ${(games.length * aposta).toLocaleString('pt-BR',{minimumFractionDigits:2})}</strong>
            &nbsp;·&nbsp; ${games.length} × ${cfg.aposta} · Alvo: Concurso #${nextC}
          </div>
        </div>
        <button onclick="fechSaveAll('${key}', ${nextC})"
          style="background:rgba(34,197,94,0.15);border:1px solid var(--green);color:#86efac;padding:7px 16px;border-radius:var(--radius-sm);font-size:0.82rem;cursor:pointer;font-weight:600">
          💾 Salvar todos os jogos
        </button>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(265px,1fr));gap:8px">
        ${games.map((game, idx) => {
          const sum   = game.reduce((a, b) => a + b, 0);
          const evens = game.filter(n => n % 2 === 0).length;
          return `
            <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px">
              <div style="font-size:0.7rem;color:var(--text-secondary);margin-bottom:6px;font-weight:600">Jogo ${idx + 1}</div>
              <div style="display:flex;flex-wrap:wrap;gap:3px">
                ${game.map(n => {
                  const s = scores[n];
                  return `<div style="width:27px;height:27px;border-radius:50%;display:flex;align-items:center;justify-content:center;
                    font-family:'Outfit',sans-serif;font-weight:700;font-size:0.7rem;
                    background:${s?.isHot?'rgba(239,68,68,0.2)':s?.isCold?'rgba(59,130,246,0.2)':'var(--bg)'};
                    border:1px solid ${s?.isHot?'#ef4444':s?.isCold?'#3b82f6':'var(--border)'};
                    color:${s?.isHot?'#fca5a5':s?.isCold?'#93c5fd':'var(--text-secondary)'}">
                    ${String(n).padStart(2,'00')}
                  </div>`;
                }).join('')}
              </div>
              <div style="font-size:0.7rem;color:var(--text-secondary);margin-top:6px">Σ ${sum} · ${evens}P/${game.length-evens}I</div>
            </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

function fechSaveAll(key, targetConcurso) {
  const pool    = getFPool(key);
  const cfg     = LOTTERY_CONFIG[key];
  const poolArr = Array.from(pool).sort((a, b) => a - b);
  const games   = generateAllCombinations(poolArr, cfg.pick);
  const saved   = getSavedGames(key);
  let added     = 0;

  games.forEach((game, idx) => {
    if (saved.some(g => g.numbers.join(',') === game.join(',') && g.concursoAlvo === targetConcurso)) return;
    saved.push({
      id:           'fech_' + Date.now() + '_' + Math.random().toString(36).substr(2,5),
      lotteryKey:   key,
      concursoAlvo: targetConcurso,
      strategyId:   'fechamento',
      strategyName: 'Fechamento Matemático',
      gameNum:      idx + 1,
      numbers:      game,
      sum:          game.reduce((a, b) => a + b, 0),
      evens:        game.filter(n => n % 2 === 0).length,
      odds:         game.filter(n => n % 2 !== 0).length,
      avgScore:     0,
      criadoEm:     new Date().toLocaleDateString('pt-BR')
    });
    added++;
  });

  if (added > 0) {
    saveGamesToStorage(key, saved);
    renderSavedGamesSection(key, State.results[key]);
    document.getElementById('saved-games-content')?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const btn = document.querySelector('[onclick*="fechSaveAll"]');
  if (btn) {
    btn.textContent = `✅ ${added} jogos salvos!`;
    btn.style.background = 'var(--green-dim)';
    btn.style.borderColor = 'var(--green)';
  }
}

// ── Expõe funções de onclick inline ao window (necessário em ES modules) ──
window.fechToggle  = fechToggle;
window.fechClear   = fechClear;
window.fechSuggest = fechSuggest;
window.fechGenerate = fechGenerate;
window.fechSaveAll  = fechSaveAll;
