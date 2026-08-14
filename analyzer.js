// ============================================================
// analyzer.js — 7 Engines de Análise Estatística
// LotoScore™ = sistema de pontuação composta
// ============================================================

import { LOTTERY_CONFIG, FIBONACCI, isPrime } from './data.js';

// ────────────────────────────────────────────────────────────
// ENGINE 1 — FREQUÊNCIA HISTÓRICA
// ────────────────────────────────────────────────────────────
export function analyzeFrequency(results, lotteryKey) {
  const cfg = LOTTERY_CONFIG[lotteryKey];
  const freq = {};
  for (let n = cfg.min; n <= cfg.max; n++) freq[n] = 0;

  for (const draw of results) {
    for (const num of draw.dezenas) freq[num]++;
  }

  const total = results.length;
  const expected = (total * cfg.pick) / (cfg.max - cfg.min + 1);

  return Object.entries(freq).map(([num, count]) => ({
    number: +num,
    count,
    total,
    percentage: ((count / total) * 100).toFixed(1),
    expected: +expected.toFixed(2),
    deviation: ((count - expected) / expected * 100).toFixed(1),
    isHot: count > expected * 1.15,
    isCold: count < expected * 0.85
  })).sort((a, b) => b.count - a.count);
}

// ────────────────────────────────────────────────────────────
// ENGINE 2 — ATRASO (DELAY SCORE)
// ────────────────────────────────────────────────────────────
export function analyzeDelay(results, lotteryKey) {
  const cfg = LOTTERY_CONFIG[lotteryKey];
  const lastSeenIdx = {};
  for (let n = cfg.min; n <= cfg.max; n++) lastSeenIdx[n] = -1;

  for (let i = 0; i < results.length; i++) {
    for (const num of results[i].dezenas) {
      if (lastSeenIdx[num] === -1) lastSeenIdx[num] = i;
    }
  }

  // Usa diferença real de concursos quando possível, para ser preciso
  // mesmo quando a API inseriu um concurso novo no início do array
  const latestConcurso = results[0]?.concurso || 0;
  const maxDelay = results.length;

  return Object.entries(lastSeenIdx).map(([num, idx]) => {
    let delay;
    if (idx === -1) {
      delay = maxDelay;
    } else {
      // Diferença real entre o último concurso e o concurso em que o número saiu
      const concursoDoUltimoAcerto = results[idx].concurso;
      delay = latestConcurso - concursoDoUltimoAcerto;
    }

    const status = delay >= 20 ? 'urgent' : delay >= 10 ? 'late' : delay >= 5 ? 'normal' : 'recent';
    return {
      number: +num,
      delay,
      lastSeenDraw: idx === -1 ? null : results[idx].concurso,
      lastSeenDate: idx === -1 ? 'Nunca (no período)' : results[idx].data,
      status,
      statusLabel: { urgent: '🔴 Urgente', late: '🟡 Atrasado', normal: '🟢 Normal', recent: '🔵 Recente' }[status]
    };
  }).sort((a, b) => b.delay - a.delay);
}

// ────────────────────────────────────────────────────────────
// ENGINE 3 — EQUILÍBRIO PAR/ÍMPAR
// ────────────────────────────────────────────────────────────
export function analyzeEvenOdd(results, lotteryKey) {
  const cfg = LOTTERY_CONFIG[lotteryKey];
  const distributions = {};

  for (const draw of results) {
    const evens = draw.dezenas.filter(n => n % 2 === 0).length;
    const odds = cfg.pick - evens;
    const key = `${evens}P/${odds}I`;
    distributions[key] = (distributions[key] || 0) + 1;
  }

  const sorted = Object.entries(distributions)
    .map(([key, count]) => ({
      distribution: key,
      evens: +key.split('P')[0],
      odds: cfg.pick - +key.split('P')[0],
      count,
      percentage: ((count / results.length) * 100).toFixed(1)
    }))
    .sort((a, b) => b.count - a.count);

  const best = sorted[0];
  const allNums = Array.from({ length: cfg.max - cfg.min + 1 }, (_, i) => i + cfg.min);
  const evenNums = allNums.filter(n => n % 2 === 0);
  const oddNums  = allNums.filter(n => n % 2 !== 0);

  return { sorted, best, evenNums, oddNums };
}

// ────────────────────────────────────────────────────────────
// ENGINE 4 — SOMA DAS DEZENAS (SWEET ZONE)
// ────────────────────────────────────────────────────────────
export function analyzeSum(results) {
  const sums = results.map(r => r.dezenas.reduce((a, b) => a + b, 0));
  const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
  const stdDev = Math.sqrt(sums.reduce((acc, s) => acc + (s - mean) ** 2, 0) / sums.length);

  const sweetMin = Math.round(mean - stdDev);
  const sweetMax = Math.round(mean + stdDev);

  // Histogram (10 buckets)
  const min = Math.min(...sums);
  const max = Math.max(...sums);
  const bucketSize = Math.ceil((max - min) / 10) || 1;
  const histogram = {};
  for (let i = min; i <= max; i += bucketSize) {
    histogram[`${i}-${i + bucketSize - 1}`] = 0;
  }
  for (const s of sums) {
    const bucket = Math.floor((s - min) / bucketSize) * bucketSize + min;
    const key = `${bucket}-${bucket + bucketSize - 1}`;
    if (histogram[key] !== undefined) histogram[key]++;
  }

  return {
    sums, mean: +mean.toFixed(1), stdDev: +stdDev.toFixed(1),
    sweetMin, sweetMax, min, max,
    histogram: Object.entries(histogram).map(([range, count]) => ({ range, count }))
  };
}

// ────────────────────────────────────────────────────────────
// ENGINE 5 — DISTRIBUIÇÃO POR QUADRANTES
// ────────────────────────────────────────────────────────────
export function analyzeQuadrants(results, lotteryKey) {
  const cfg = LOTTERY_CONFIG[lotteryKey];
  const range = cfg.max - cfg.min + 1;
  const qSize = Math.ceil(range / 4);

  const quadrants = [
    { name: 'Q1', min: cfg.min, max: cfg.min + qSize - 1, count: 0 },
    { name: 'Q2', min: cfg.min + qSize, max: cfg.min + qSize * 2 - 1, count: 0 },
    { name: 'Q3', min: cfg.min + qSize * 2, max: cfg.min + qSize * 3 - 1, count: 0 },
    { name: 'Q4', min: cfg.min + qSize * 3, max: cfg.max, count: 0 }
  ];

  const perDraw = [];
  for (const draw of results) {
    const q = [0, 0, 0, 0];
    for (const num of draw.dezenas) {
      const qi = Math.min(3, Math.floor((num - cfg.min) / qSize));
      q[qi]++;
      quadrants[qi].count++;
    }
    perDraw.push(q);
  }

  const totalNums = results.length * cfg.pick;
  const expected = cfg.pick / 4;
  for (const q of quadrants) {
    q.percentage = ((q.count / totalNums) * 100).toFixed(1);
    q.avgPerDraw = (q.count / results.length).toFixed(2);
    q.expectedPerDraw = expected.toFixed(2);
  }

  return { quadrants, expected };
}

// ────────────────────────────────────────────────────────────
// ENGINE 6 — REPETIÇÃO ENTRE SORTEIOS
// ────────────────────────────────────────────────────────────
export function analyzeRepetition(results) {
  const repeats = [];

  for (let i = 0; i < results.length - 1; i++) {
    const curr = new Set(results[i].dezenas);
    const prev = new Set(results[i + 1].dezenas);
    const repeated = [...curr].filter(n => prev.has(n));
    repeats.push({
      concurso: results[i].concurso,
      count: repeated.length,
      numbers: repeated.sort((a, b) => a - b)
    });
  }

  const avg = repeats.reduce((a, b) => a + b.count, 0) / repeats.length;
  const maxRepeat = Math.max(...repeats.map(r => r.count));
  const minRepeat = Math.min(...repeats.map(r => r.count));

  const distribution = {};
  for (const r of repeats) {
    distribution[r.count] = (distribution[r.count] || 0) + 1;
  }

  return {
    repeats,
    avg: +avg.toFixed(2),
    max: maxRepeat,
    min: minRepeat,
    distribution: Object.entries(distribution)
      .map(([k, v]) => ({ count: +k, occurrences: v, pct: ((v / repeats.length) * 100).toFixed(1) }))
      .sort((a, b) => a.count - b.count)
  };
}

// ────────────────────────────────────────────────────────────
// ENGINE 7 — COMPOSIÇÃO HISTÓRICA DOS SORTEIOS
// Analisa o perfil típico de um sorteio vencedor:
// quantos números quentes, normais, frios e repetidos
// costumam sair juntos no mesmo concurso
// ────────────────────────────────────────────────────────────
export function analyzeComposition(results, lotteryKey, freqData = null) {
  const freq = freqData || analyzeFrequency(results, lotteryKey);
  const freqMap = {};
  for (const f of freq) freqMap[f.number] = f;

  const profiles = [];

  for (let i = 0; i < results.length; i++) {
    const draw = results[i];
    const prevDraw = i < results.length - 1 ? results[i + 1] : null;
    const prevSet = prevDraw ? new Set(prevDraw.dezenas) : new Set();

    let hotCount = 0, coldCount = 0, normalCount = 0, repeatedCount = 0;

    for (const num of draw.dezenas) {
      const f = freqMap[num];
      if (f?.isHot)  hotCount++;
      else if (f?.isCold) coldCount++;
      else normalCount++;

      if (prevSet.has(num)) repeatedCount++;
    }

    profiles.push({ hotCount, coldCount, normalCount, repeatedCount });
  }

  // Médias
  const avgOf = key => +(profiles.reduce((acc, p) => acc + p[key], 0) / profiles.length).toFixed(2);
  const avgHot      = avgOf('hotCount');
  const avgCold     = avgOf('coldCount');
  const avgNormal   = avgOf('normalCount');
  const avgRepeated = avgOf('repeatedCount');

  // Perfis mais comuns (label: "2Q/3N/1F/1R")
  const profileCounts = {};
  for (const p of profiles) {
    const key = `${p.hotCount}Q+${p.normalCount}N+${p.coldCount}F+${p.repeatedCount}R`;
    profileCounts[key] = (profileCounts[key] || 0) + 1;
  }

  const topProfiles = Object.entries(profileCounts)
    .map(([key, count]) => ({
      key,
      count,
      pct: ((count / profiles.length) * 100).toFixed(1),
      parts: {
        hot:      +key.split('Q')[0],
        normal:   +key.split('+')[1].replace('N',''),
        cold:     +key.split('+')[2].replace('F',''),
        repeated: +key.split('+')[3].replace('R','')
      }
    }))
    .sort((a, b) => b.count - a.count);

  // Perfil ideal (arredondado, garantindo que soma = pick)
  const cfg = LOTTERY_CONFIG[lotteryKey];
  const idealRepeated = Math.round(avgRepeated);
  const idealHot      = Math.round(avgHot);
  const idealCold     = Math.round(avgCold);
  const idealNormal   = Math.max(0, cfg.pick - idealHot - idealCold - idealRepeated);

  // Distribuição de contagem de repetições
  const repeatDist = {};
  for (const p of profiles) {
    repeatDist[p.repeatedCount] = (repeatDist[p.repeatedCount] || 0) + 1;
  }

  return {
    avgHot, avgCold, avgNormal, avgRepeated,
    idealHot, idealCold, idealNormal, idealRepeated,
    topProfiles: topProfiles.slice(0, 6),
    mostCommonProfile: topProfiles[0],
    repeatDist: Object.entries(repeatDist)
      .map(([k, v]) => ({ count: +k, occurrences: v, pct: ((v/profiles.length)*100).toFixed(1) }))
      .sort((a, b) => a.count - b.count),
    totalDraws: profiles.length
  };
}

// ────────────────────────────────────────────────────────────
// LOTO SCORE™ — Pontuação Composta (0–100)
// ────────────────────────────────────────────────────────────
export function computeLotoScores(results, lotteryKey) {
  const cfg = LOTTERY_CONFIG[lotteryKey];
  const freqData  = analyzeFrequency(results, lotteryKey);
  const delayData = analyzeDelay(results, lotteryKey);
  const qData     = analyzeQuadrants(results, lotteryKey);

  const freqMap  = {};
  const delayMap = {};
  const qMap     = {};

  const maxFreq  = Math.max(...freqData.map(f => f.count)) || 1;
  const minFreq  = Math.min(...freqData.map(f => f.count));
  const maxDelay = Math.max(...delayData.map(d => d.delay)) || 1;

  for (const f of freqData)  freqMap[f.number]  = f;
  for (const d of delayData) delayMap[d.number] = d;

  const range = cfg.max - cfg.min + 1;
  const qSize = Math.ceil(range / 4);
  const qAvgs = qData.quadrants.map(q => parseFloat(q.avgPerDraw));
  const qExpected = parseFloat(qData.expected);

  const scores = {};
  for (let n = cfg.min; n <= cfg.max; n++) {
    const f = freqMap[n];
    const d = delayMap[n];

    // Frequência: score normalizado (mais frequente = mais pontos)
    const freqScore = ((f.count - minFreq) / (maxFreq - minFreq || 1)) * 100;

    // Atraso: score de equilíbrio (muito atrasado OU muito recente = médio)
    // Ideal = delay entre 3 e 15 draws
    const delayNorm = d.delay / maxDelay;
    const delayScore = delayNorm < 0.5
      ? delayNorm * 2 * 100          // até 50% do max: cresce
      : (1 - delayNorm) * 2 * 100;  // depois: decresce

    // Quadrante: quanto o quadrante deste número está sub/sobre-representado
    const qi = Math.min(3, Math.floor((n - cfg.min) / qSize));
    const qDeviation = Math.abs(qAvgs[qi] - qExpected) / (qExpected || 1);
    const quadrantScore = Math.max(0, 100 - qDeviation * 100);

    // Padrão: Fibonacci/Primo bônus
    const isFib   = FIBONACCI.includes(n);
    const isPr    = isPrime(n);
    const patternScore = 50 + (isFib ? 30 : 0) + (isPr ? 20 : 0);

    const lotoScore = Math.round(
      freqScore  * 0.35 +
      delayScore * 0.30 +
      quadrantScore * 0.20 +
      Math.min(patternScore, 100) * 0.15
    );

    scores[n] = {
      number: n,
      lotoScore,
      freqScore: +freqScore.toFixed(1),
      delayScore: +delayScore.toFixed(1),
      quadrantScore: +quadrantScore.toFixed(1),
      patternScore: Math.min(patternScore, 100),
      count: f.count,
      delay: d.delay,
      isHot: f.isHot,
      isCold: f.isCold,
      isFib,
      isPrime: isPr,
      quadrant: qi + 1
    };
  }

  return scores;
}

// ────────────────────────────────────────────────────────────
// GERADOR DE SUGESTÕES (4 estratégias × 3 jogos)
// ────────────────────────────────────────────────────────────
export function generateSuggestions(results, lotteryKey) {
  const cfg = LOTTERY_CONFIG[lotteryKey];
  const scores = computeLotoScores(results, lotteryKey);
  const scoreArr = Object.values(scores).sort((a, b) => b.lotoScore - a.lotoScore);

  const sumAnalysis   = analyzeSum(results);
  const evenOddAna    = analyzeEvenOdd(results, lotteryKey);
  const freqAnalysis  = analyzeFrequency(results, lotteryKey);
  const delayAnalysis = analyzeDelay(results, lotteryKey);
  const composition   = analyzeComposition(results, lotteryKey);

  // Mapa rápido de classificação por número
  const freqMap = {};
  for (const f of freqAnalysis) freqMap[f.number] = f;

  const bestEven = evenOddAna.best.evens;
  const bestOdd  = evenOddAna.best.odds;

  function validateAndFinalize(nums) {
    const unique = [...new Set(nums)].filter(n => n >= cfg.min && n <= cfg.max);
    while (unique.length < cfg.pick) {
      const rand = cfg.min + Math.floor(Math.random() * (cfg.max - cfg.min + 1));
      if (!unique.includes(rand)) unique.push(rand);
    }
    return unique.slice(0, cfg.pick).sort((a, b) => a - b);
  }

  function sumInRange(nums) {
    const s = nums.reduce((a, b) => a + b, 0);
    return s >= sumAnalysis.sweetMin && s <= sumAnalysis.sweetMax;
  }

  function applyBalance(nums, targetEven, targetOdd) {
    const evens = nums.filter(n => n % 2 === 0);
    const odds  = nums.filter(n => n % 2 !== 0);
    const result = [];
    const allEvens = Array.from({ length: cfg.max - cfg.min + 1 }, (_, i) => i + cfg.min).filter(n => n % 2 === 0);
    const allOdds  = Array.from({ length: cfg.max - cfg.min + 1 }, (_, i) => i + cfg.min).filter(n => n % 2 !== 0);

    // Fill evens
    result.push(...evens.slice(0, targetEven));
    while (result.filter(n => n % 2 === 0).length < targetEven) {
      const e = allEvens[Math.floor(Math.random() * allEvens.length)];
      if (!result.includes(e)) result.push(e);
    }
    // Fill odds
    result.push(...odds.slice(0, targetOdd));
    while (result.filter(n => n % 2 !== 0).length < targetOdd) {
      const o = allOdds[Math.floor(Math.random() * allOdds.length)];
      if (!result.includes(o)) result.push(o);
    }
    return result.slice(0, cfg.pick);
  }

  // ── ESTRATÉGIA 1: QUENTE (top frequência + balanceamento) ──
  const strategy1Games = [];
  for (let g = 0; g < 3; g++) {
    const hotNums = freqAnalysis.filter(f => f.isHot).map(f => f.number);
    const topNums = scoreArr.slice(g * 3, g * 3 + cfg.pick + 6).map(s => s.number);
    let pick = applyBalance([...hotNums, ...topNums], bestEven, bestOdd);
    strategy1Games.push(validateAndFinalize(pick));
  }

  // ── ESTRATÉGIA 2: EQUILIBRADA (hot + atrasados + soma) ──
  const strategy2Games = [];
  for (let g = 0; g < 3; g++) {
    const hotTop  = scoreArr.filter(s => s.isHot).slice(0, Math.ceil(cfg.pick / 2)).map(s => s.number);
    const delayed = delayAnalysis.filter(d => d.status === 'late' || d.status === 'urgent').slice(g, g + Math.floor(cfg.pick / 2)).map(d => d.number);
    let pick = applyBalance([...hotTop, ...delayed], bestEven, bestOdd);
    pick = validateAndFinalize(pick);
    // If sum out of range, try to adjust
    if (!sumInRange(pick)) {
      const sum = pick.reduce((a, b) => a + b, 0);
      const diff = sumAnalysis.sweetMin - sum;
      // swap largest for something closer to target
      if (diff > 0) pick[pick.length - 1] = Math.min(cfg.max, pick[pick.length - 1] + Math.min(diff, 5));
      else pick[0] = Math.max(cfg.min, pick[0] - Math.min(-diff, 5));
      pick = validateAndFinalize(pick);
    }
    strategy2Games.push(pick);
  }

  // ── ESTRATÉGIA 3: FIBONACCI + COMPLEMENTO ESTATÍSTICO ──
  const strategy3Games = [];
  const fibInRange = FIBONACCI.filter(n => n >= cfg.min && n <= cfg.max);
  for (let g = 0; g < 3; g++) {
    const fibSlice = fibInRange.slice(0, Math.min(fibInRange.length, Math.ceil(cfg.pick * 0.4)));
    const complement = scoreArr.filter(s => !fibSlice.includes(s.number)).slice(g * 2, g * 2 + cfg.pick).map(s => s.number);
    let pick = applyBalance([...fibSlice, ...complement], bestEven, bestOdd);
    strategy3Games.push(validateAndFinalize(pick));
  }

  // ── ESTRATÉGIA 4: COMPOSIÇÃO HISTÓRICA ─────────────────
  // Replica o perfil típico de um sorteio vencedor:
  // exatamente N quentes + M normais + K frios + R repetidos
  // ──────────────────────────────────────────────────────────
  const strategy4Games = [];
  const lastDraw    = results[0];
  const prevDraw    = results[1] || results[0];
  const lastDrawSet = new Set(lastDraw.dezenas);
  const prevDrawSet = new Set(prevDraw.dezenas);

  // Listas separadas por tipo
  const hotNums_s4    = scoreArr.filter(s => freqMap[s.number]?.isHot).map(s => s.number);
  const coldNums_s4   = scoreArr.filter(s => freqMap[s.number]?.isCold).map(s => s.number);
  const normalNums_s4 = scoreArr.filter(s => !freqMap[s.number]?.isHot && !freqMap[s.number]?.isCold).map(s => s.number);
  const repeatedNums  = [...lastDrawSet].sort((a, b) => (scores[b]?.lotoScore||0) - (scores[a]?.lotoScore||0));

  for (let g = 0; g < 3; g++) {
    const pick = new Set();

    // Escolhe perfil de composição baseado nos top padrões históricos
    const profile = composition.topProfiles[g] || composition.topProfiles[0];
    const wantHot    = profile?.parts?.hot      ?? composition.idealHot;
    const wantNormal = profile?.parts?.normal   ?? composition.idealNormal;
    const wantCold   = profile?.parts?.cold     ?? composition.idealCold;
    const wantRepeat = profile?.parts?.repeated ?? composition.idealRepeated;

    // 1. Repetidos do último sorteio (com offset g)
    if (wantRepeat > 0) {
      const repeatedSlice = repeatedNums.slice(g % Math.max(1, repeatedNums.length));
      for (const n of repeatedSlice) {
        if ([...pick].filter(x => lastDrawSet.has(x)).length >= wantRepeat) break;
        pick.add(n);
      }
    }

    // 2. Quentes (com offset g * 2)
    if (wantHot > 0) {
      const hotSlice = [...hotNums_s4.slice(g * 2), ...hotNums_s4.slice(0, g * 2)];
      for (const n of hotSlice) {
        if ([...pick].filter(x => freqMap[x]?.isHot).length >= wantHot) break;
        if (!pick.has(n)) pick.add(n);
      }
    }

    // 3. Frios (com offset g * 2)
    if (wantCold > 0) {
      const coldSlice = [...coldNums_s4.slice(g * 2), ...coldNums_s4.slice(0, g * 2)];
      for (const n of coldSlice) {
        if ([...pick].filter(x => freqMap[x]?.isCold).length >= wantCold) break;
        if (!pick.has(n)) pick.add(n);
      }
    }

    // 4. Normais (com offset g * 3)
    const normalSlice = [...normalNums_s4.slice(g * 3), ...normalNums_s4.slice(0, g * 3)];
    for (const n of normalSlice) {
      const currentNormal = [...pick].filter(x => !freqMap[x]?.isHot && !freqMap[x]?.isCold).length;
      if (currentNormal >= wantNormal) break;
      if (!pick.has(n)) pick.add(n);
    }

    // 5. Padding e balanceamento
    const pickArr = applyBalance([...pick], bestEven, bestOdd);
    strategy4Games.push(validateAndFinalize(pickArr));
  }

  // ── MONTAR RESULTADO ──
  function buildGameInfo(nums, strategyId) {
    const sum = nums.reduce((a, b) => a + b, 0);
    const evens = nums.filter(n => n % 2 === 0).length;
    const odds = nums.length - evens;
    const totalScore = nums.reduce((acc, n) => acc + (scores[n]?.lotoScore || 50), 0);
    const avgScore = Math.round(totalScore / nums.length);
    const fibCount = nums.filter(n => FIBONACCI.includes(n)).length;
    const primeCount = nums.filter(n => isPrime(n)).length;
    const inSweetZone = sum >= sumAnalysis.sweetMin && sum <= sumAnalysis.sweetMax;
    const quadrantCoverage = [...new Set(nums.map(n => {
      const range = LOTTERY_CONFIG[lotteryKey].max - LOTTERY_CONFIG[lotteryKey].min + 1;
      const qSize = Math.ceil(range / 4);
      return Math.min(3, Math.floor((n - LOTTERY_CONFIG[lotteryKey].min) / qSize)) + 1;
    }))].length;

    // Composição real do jogo gerado
    const hotInGame      = nums.filter(n => freqMap[n]?.isHot).length;
    const coldInGame     = nums.filter(n => freqMap[n]?.isCold).length;
    const normalInGame   = nums.filter(n => !freqMap[n]?.isHot && !freqMap[n]?.isCold).length;
    const repeatedInGame = nums.filter(n => lastDrawSet.has(n)).length;

    return {
      numbers: nums,
      sum,
      evens,
      odds,
      avgScore,
      fibCount,
      primeCount,
      inSweetZone,
      quadrantCoverage,
      hotInGame,
      coldInGame,
      normalInGame,
      repeatedInGame,
      strategyId,
      numberDetails: nums.map(n => scores[n] || { number: n, lotoScore: 50 })
    };
  }

  return {
    strategies: [
      {
        id: 'hot',
        name: '🔥 Estratégia Quente',
        description: 'Prioriza os números mais frequentes na história recente',
        games: strategy1Games.map(n => buildGameInfo(n, 'hot'))
      },
      {
        id: 'balanced',
        name: '⚖️ Estratégia Equilibrada',
        description: 'Combina números quentes + atrasados com equilíbrio par/ímpar e soma ideal',
        games: strategy2Games.map(n => buildGameInfo(n, 'balanced'))
      },
      {
        id: 'fibonacci',
        name: '🌀 Estratégia Fibonacci',
        description: 'Incorpora sequência de Fibonacci com complemento estatístico',
        games: strategy3Games.map(n => buildGameInfo(n, 'fibonacci'))
      },
      {
        id: 'composition',
        name: '🧬 Estratégia Composição Histórica',
        description: `Replica o padrão real dos sorteios: ~${composition.idealHot} quente(s) + ~${composition.idealNormal} normal(is) + ~${composition.idealCold} frio(s) + ~${composition.idealRepeated} repetido(s) do último concurso`,
        games: strategy4Games.map(n => buildGameInfo(n, 'composition'))
      }
    ],
    meta: {
      sweetZone: { min: sumAnalysis.sweetMin, max: sumAnalysis.sweetMax },
      bestBalance: `${bestEven}P / ${bestOdd}I`,
      avgRepetition: composition.avgRepeated,
      composition
    }
  };
}
