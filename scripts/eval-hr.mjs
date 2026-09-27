// Scores decision providers on the SAP HR request survey set (259 human-written
// employee requests). The baseline is scored with stratified 5-fold
// cross-validation so it never sees a test ticket during training; hosted
// providers are scored zero-shot.
//
//   npm run eval                          # baseline + every configured hosted provider
//   npm run eval -- --providers anthropic --limit 60
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, ROUTES } from '../src/decision.mjs';
import { policies } from '../src/fixtures.mjs';
import { createBaselineProvider, createProviders, trainingPath } from '../src/providers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(part => { const [key, ...rest] = part.trim().split(/\s+/); return [key, rest.join(' ') || true]; }));
const limit = args.limit ? Number(args.limit) : Infinity;
const concurrency = Number(args.concurrency || 4);
const out = args.out || 'docs/eval';

const dataset = JSON.parse(await readFile(`${root}data/eval/sap-hr-survey.json`, 'utf8'));
const training = JSON.parse(await readFile(trainingPath, 'utf8')).examples;
const surveyIds = new Set(dataset.examples.map(example => example.id));
const background = training.filter(example => !surveyIds.has(example.id));
const casePolicies = policies.filter(policy => ['workspace', 'remote', 'payroll', 'exceptions'].includes(policy.id));
const caseFor = example => ({ role: 'Employee', location: 'Europe', workMode: 'office', exception: example.text.slice(0, 3000), policies: casePolicies });

// Stratified sample so --limit keeps every source category represented.
function sample(examples, n) {
  if (!(n < examples.length)) return examples;
  const groups = Map.groupBy(examples, example => `${example.sourceCategory}/${example.sourceSubcategory}`);
  const picked = [];
  for (let i = 0; picked.length < n; i += 1) for (const group of groups.values()) if (group[i] && picked.length < n) picked.push(group[i]);
  return picked;
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); }
  }));
  return results;
}

async function runBaselineCV(examples, folds = 5) {
  const order = [...Map.groupBy(examples, example => example.sourceSubcategory).values()].flat();
  const foldOf = new Map(order.map((example, index) => [example.id, index % folds]));
  const rows = [];
  for (let fold = 0; fold < folds; fold += 1) {
    const provider = createBaselineProvider({ examples: [...background, ...examples.filter(example => foldOf.get(example.id) !== fold)] });
    for (const example of examples.filter(item => foldOf.get(item.id) === fold)) {
      rows.push({ example, result: await provider.judge(caseFor(example)) });
    }
  }
  return rows;
}

async function runProvider(provider, examples) {
  let done = 0;
  return pool(examples, concurrency, async example => {
    let result, error;
    try { result = await provider.judge(caseFor(example)); }
    catch (caught) { error = caught.message; }
    done += 1;
    if (done % 20 === 0 || done === examples.length) process.stderr.write(`  ${provider.name}: ${done}/${examples.length}\n`);
    return { example, result, error };
  });
}

function score(rows) {
  const ok = rows.filter(row => row.result);
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const routeHit = row => row.result.route === row.example.route;
  const unflagged = ok.filter(row => !row.result.uncertain);
  const bins = Array.from({ length: 10 }, () => ({ n: 0, confidence: 0, correct: 0 }));
  for (const row of ok) {
    const bin = bins[Math.min(9, Math.floor(row.result.confidence * 10))];
    bin.n += 1; bin.confidence += row.result.confidence; bin.correct += Number(routeHit(row));
  }
  const ece = bins.reduce((sum, bin) => sum + (bin.n ? (bin.n / ok.length) * Math.abs(bin.confidence / bin.n - bin.correct / bin.n) : 0), 0);
  const labels = Object.keys(CATEGORIES);
  const matrix = labels.map(truth => labels.map(predicted => ok.filter(row => row.example.category === truth && row.result.category === predicted).length));
  const routeLabels = Object.keys(ROUTES);
  const routeMatrix = ['payroll', 'people_ops'].map(truth => routeLabels.map(predicted => ok.filter(row => row.example.route === truth && row.result.route === predicted).length));
  const bySource = Object.fromEntries([...Map.groupBy(ok, row => `${row.example.sourceCategory} / ${row.example.sourceSubcategory}`)].map(([key, group]) => [key, {
    n: group.length,
    route: mean(group.map(row => Number(routeHit(row)))),
    category: mean(group.map(row => Number(row.result.category === row.example.category))),
  }]));
  return {
    n: rows.length,
    errors: rows.length - ok.length,
    routeAccuracy: mean(ok.map(row => Number(routeHit(row)))),
    safeRouteRate: mean(ok.map(row => Number(routeHit(row) || row.result.route === 'uncertain'))),
    categoryAccuracy: mean(ok.map(row => Number(row.result.category === row.example.category))),
    sensitiveAccuracy: mean(ok.map(row => Number((row.result.sensitive >= 0.5) === row.example.sensitive))),
    flaggedRate: mean(ok.map(row => Number(row.result.uncertain))),
    accuracyWhenNotFlagged: mean(unflagged.map(row => Number(routeHit(row)))),
    meanConfidence: mean(ok.map(row => row.result.confidence)),
    ece,
    calibration: bins.map((bin, index) => ({ bin: `${index / 10}-${(index + 1) / 10}`, n: bin.n, meanConfidence: bin.n ? bin.confidence / bin.n : null, accuracy: bin.n ? bin.correct / bin.n : null })),
    meanLatencyMs: mean(ok.map(row => row.result.durationMs)) ?? 0,
    confusion: { labels, matrix },
    routeConfusion: { rows: ['payroll', 'people_ops'], columns: routeLabels, matrix: routeMatrix },
    bySource,
    sampleErrors: ok.filter(row => row.result.category !== row.example.category || !routeHit(row)).slice(0, 12).map(row => ({
      id: row.example.id, text: row.example.text.slice(0, 220), expected: { route: row.example.route, category: row.example.category }, predicted: { route: row.result.route, category: row.result.category, confidence: Math.round(row.result.confidence * 100) / 100 }, reason: row.result.reason,
    })),
    failures: rows.filter(row => row.error).slice(0, 5).map(row => ({ id: row.example.id, error: row.error })),
  };
}

const providers = createProviders();
const requested = args.providers ? String(args.providers).split(',') : ['baseline', ...['jev', 'anthropic', 'openai'].filter(name => providers[name].configured)];
const examples = sample(dataset.examples, limit);
const runs = [];
await mkdir(`${root}${out}`, { recursive: true });
for (const name of requested) {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown provider ${name}.`);
  const health = await provider.health();
  if (!health.available) { console.error(`Skipping ${name}: ${health.error}`); continue; }
  process.stderr.write(`Running ${name} on ${examples.length} requests…\n`);
  const started = Date.now();
  const rows = name === 'baseline' ? await runBaselineCV(examples) : await runProvider(provider, examples);
  const result = { provider: name, label: provider.label, model: provider.model, mode: name === 'baseline' ? '5-fold CV' : 'zero-shot', wallSeconds: Math.round((Date.now() - started) / 100) / 10, ...score(rows) };
  runs.push(result);
  printRun(result);
  if (name === 'baseline') {
    // Harder check: never train on survey tickets at all (SAP handwritten + NodFirst seeds only).
    const crossRows = await runProvider(createBaselineProvider({ examples: background }), examples);
    const cross = { provider: 'baseline-cross-source', label: 'Offline baseline, cross-source', model: provider.model, mode: 'trained on other sources', wallSeconds: 0, ...score(crossRows) };
    runs.push(cross);
    printRun(cross);
  }
  await writeFile(`${root}${out}/predictions-${name}.json`, JSON.stringify(rows.map(row => ({ id: row.example.id, expected: { route: row.example.route, category: row.example.category, sensitive: row.example.sensitive }, predicted: row.result && { route: row.result.route, confidence: row.result.confidence, probabilities: row.result.probabilities, category: row.result.category, sensitive: row.result.sensitive, uncertain: row.result.uncertain, reason: row.result.reason }, error: row.error })), null, 1));
}
function printRun(result) {
  console.log(`${result.provider.padEnd(22)} route ${(result.routeAccuracy * 100).toFixed(1)}%  category ${(result.categoryAccuracy * 100).toFixed(1)}%  sensitive ${(result.sensitiveAccuracy * 100).toFixed(1)}%  flagged ${(result.flaggedRate * 100).toFixed(1)}%  unflagged-acc ${result.accuracyWhenNotFlagged === null ? '—' : (result.accuracyWhenNotFlagged * 100).toFixed(1) + '%'}  ECE ${result.ece.toFixed(3)}  errors ${result.errors}`);
}
runs.sort((a, b) => (b.categoryAccuracy ?? 0) - (a.categoryAccuracy ?? 0));
const report = {
  generatedAt: new Date().toISOString(),
  dataset: { name: 'SAP HR request survey tickets', size: examples.length, source: 'https://github.com/SAP/hr-request-data-set', license: 'Apache-2.0' },
  note: 'Human-written HR requests by 29 SAP survey participants; NodFirst labels are mapped from SAP categories (docs/EVALUATION.md). Baseline scored with 5-fold cross-validation; hosted providers zero-shot.',
  runs,
};
await writeFile(`${root}${out}/latest.json`, JSON.stringify(report, null, 1));
console.log(`Wrote ${out}/latest.json`);
