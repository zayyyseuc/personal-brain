require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path = require('path');
const { searchMemories } = require('../src/retrieval');

const testset = require('./testset.json');

async function runEval() {
  const results = [];

  for (const item of testset) {
    const { query, expected_sources, top_k } = item;

    let hits;
    try {
      hits = await searchMemories(query, top_k);
    } catch (err) {
      console.error(`[ERROR] query="${query.slice(0, 30)}": ${err.message}`);
      results.push({ query, hitAtK: 0, recallAtK: 0, mrr: 0, error: true });
      continue;
    }

    const returnedSources = hits.map(h => h.source);
    const expectedSet     = new Set(expected_sources);

    // Hit@K: 1 if any expected source appears in results
    const hitAtK = returnedSources.some(s => expectedSet.has(s)) ? 1 : 0;

    // Recall@K: fraction of expected sources that appear in results
    const returnedSet  = new Set(returnedSources);
    const hitCount     = expected_sources.filter(s => returnedSet.has(s)).length;
    const recallAtK    = expected_sources.length > 0 ? hitCount / expected_sources.length : 0;

    // MRR: 1/rank of first expected source in results (1-indexed), 0 if none
    let mrr = 0;
    for (let i = 0; i < returnedSources.length; i++) {
      if (expectedSet.has(returnedSources[i])) {
        mrr = 1 / (i + 1);
        break;
      }
    }

    results.push({ query, hitAtK, recallAtK, mrr, returnedSources, expected_sources });
  }

  // ── per-query report ──────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log('EVAL RESULTS');
  console.log('═'.repeat(72));

  for (const r of results) {
    const label = r.query.length > 40 ? r.query.slice(0, 40) + '…' : r.query;
    console.log(`\nQuery : ${label}`);
    if (r.error) {
      console.log('  ❌  搜索出错，跳过');
      continue;
    }
    console.log(`  Hit@K    : ${r.hitAtK}`);
    console.log(`  Recall@K : ${r.recallAtK.toFixed(3)}`);
    console.log(`  MRR      : ${r.mrr.toFixed(3)}`);
    console.log('  返回来源 :');
    r.returnedSources.forEach((s, i) => {
      const mark = new Set(r.expected_sources).has(s) ? '✓' : '✗';
      console.log(`    ${i + 1}. [${mark}] ${s}`);
    });
  }

  // ── aggregate ─────────────────────────────────────────────────────────────
  const valid = results.filter(r => !r.error);
  if (valid.length === 0) {
    console.log('\n没有有效结果，无法计算汇总指标。');
    return;
  }

  const avgHit    = valid.reduce((s, r) => s + r.hitAtK,    0) / valid.length;
  const avgRecall = valid.reduce((s, r) => s + r.recallAtK, 0) / valid.length;
  const avgMRR    = valid.reduce((s, r) => s + r.mrr,       0) / valid.length;

  console.log('\n' + '─'.repeat(72));
  console.log(`总计 ${valid.length} 条查询（${results.length - valid.length} 条出错跳过）`);
  console.log(`平均 Hit@K    : ${avgHit.toFixed(3)}`);
  console.log(`平均 Recall@K : ${avgRecall.toFixed(3)}`);
  console.log(`平均 MRR      : ${avgMRR.toFixed(3)}`);
  console.log('─'.repeat(72) + '\n');
}

runEval().catch(err => {
  console.error('eval 运行失败:', err);
  process.exit(1);
});
