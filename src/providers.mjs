import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, ROUTES, caseText, decisionSchema, normalizeDecision, questions, requestJson, systemPrompt, validateCase } from './decision.mjs';
import { createLocalProvider } from './provider.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;
const env = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;
const unavailable = error => ({ available: false, error });
const httpsOrigin = (value, name) => {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid URL.`); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an https URL (http only for loopback) without credentials, query, or fragment.`);
  }
  return url.href.replace(/\/$/, '');
};

// TypeSafe Jev: a typed decision model. One request carries the state and all
// three questions; answers come back as choices with probabilities, not prose.
export function createJevProvider({
  apiKey = env('TYPESAFE_API_KEY'),
  baseUrl = env('TYPESAFE_BASE_URL', 'https://api.typesafe.ai'),
  model = env('JEV_MODEL', 'jev-latest'),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  baseUrl = httpsOrigin(baseUrl, 'TYPESAFE_BASE_URL');
  const answerOf = (body, name) => body?.answers?.[name] ?? body?.results?.[name] ?? body?.[name];
  function choice(answer, keys, name) {
    const picked = answer?.choice ?? answer?.answer ?? answer?.value;
    const probabilities = answer?.probabilities ?? answer?.distribution ?? null;
    if (!keys.includes(picked)) throw new Error(`Jev answer for ${name} is not one of the allowed options.`);
    const confidence = typeof answer?.confidence === 'number' ? answer.confidence : probabilities?.[picked];
    return { picked, confidence, probabilities };
  }
  return {
    name: 'jev',
    label: 'TypeSafe Jev',
    kind: 'api',
    model,
    baseUrl,
    configured: Boolean(apiKey),
    setup: 'Set TYPESAFE_API_KEY (and optionally JEV_MODEL, TYPESAFE_BASE_URL).',
    async health() {
      return apiKey ? { available: true, note: 'API key configured; verified on first decision.' } : unavailable('TYPESAFE_API_KEY is not set.');
    },
    async judge(input) {
      if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set.');
      const caseData = validateCase(input);
      const started = performance.now();
      const body = await requestJson(`${baseUrl}/v1/systemone`, {
        method: 'POST',
        label: 'Jev',
        timeoutMs,
        headers: { authorization: `Bearer ${apiKey}` },
        body: { model, state: caseText(caseData), questions },
      });
      const route = choice(answerOf(body, 'route'), Object.keys(ROUTES), 'route');
      const category = choice(answerOf(body, 'category'), Object.keys(CATEGORIES), 'category');
      const sensitiveAnswer = answerOf(body, 'sensitive');
      const sensitive = typeof sensitiveAnswer === 'number' ? sensitiveAnswer : sensitiveAnswer?.noul ?? sensitiveAnswer?.probability;
      const ranked = Object.entries(route.probabilities || {}).sort((a, b) => b[1] - a[1]);
      const reason = ranked.length > 1
        ? `Jev chose ${route.picked} (${Math.round(ranked[0][1] * 100)}%); runner-up ${ranked[1][0]} (${Math.round(ranked[1][1] * 100)}%). Category ${category.picked}.`
        : `Jev chose ${route.picked}; category ${category.picked}.`;
      return normalizeDecision({
        route: route.picked,
        confidence: route.confidence,
        probabilities: route.probabilities,
        category: category.picked,
        categoryConfidence: category.confidence,
        sensitive,
        reason,
      }, { provider: 'jev', model: body?.model || model, durationMs: performance.now() - started });
    },
  };
}

// Claude through the official SDK. Accepts an API key or an auth token.
export function createAnthropicProvider({
  apiKey = env('ANTHROPIC_API_KEY'),
  authToken = env('DAYBREAK_ANTHROPIC_AUTH_TOKEN'),
  baseUrl = env('DAYBREAK_ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
  model = env('ANTHROPIC_MODEL', 'claude-opus-5'),
  effort = env('ANTHROPIC_EFFORT', 'low'),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  baseUrl = httpsOrigin(baseUrl, 'DAYBREAK_ANTHROPIC_BASE_URL');
  const configured = Boolean(apiKey || authToken);
  // Explicit baseURL so an ambient ANTHROPIC_BASE_URL cannot redirect HR data.
  const client = configured ? new Anthropic({ apiKey: apiKey || null, authToken: authToken || null, baseURL: baseUrl, timeout: timeoutMs, maxRetries: 2 }) : null;
  return {
    name: 'anthropic',
    label: 'Claude (Anthropic API)',
    kind: 'api',
    model,
    baseUrl,
    configured,
    setup: 'Set ANTHROPIC_API_KEY (or DAYBREAK_ANTHROPIC_AUTH_TOKEN); optionally ANTHROPIC_MODEL and ANTHROPIC_EFFORT.',
    async health() {
      return configured ? { available: true, note: 'Credential configured; verified on first decision.' } : unavailable('ANTHROPIC_API_KEY is not set.');
    },
    async judge(input) {
      if (!client) throw new Error('ANTHROPIC_API_KEY is not set.');
      const caseData = validateCase(input);
      const started = performance.now();
      let response;
      try {
        response = await client.messages.create({
          model,
          max_tokens: 4000,
          system: systemPrompt,
          output_config: { effort, format: { type: 'json_schema', schema: decisionSchema } },
          messages: [{ role: 'user', content: `Classify the request in EXCEPTION. Report confidence as your probability (0 to 1) that the route is correct.\n${caseText(caseData)}` }],
        });
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the credential (401).');
        if (error instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached; retry later.');
        if (error instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${error.status ?? ''}: ${error.message}`.slice(0, 300));
        throw error;
      }
      if (response.stop_reason === 'refusal') throw new Error('Claude declined to classify this request.');
      const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error('Claude returned invalid decision JSON.'); }
      return normalizeDecision(parsed, { provider: 'anthropic', model: response.model || model, durationMs: performance.now() - started });
    },
  };
}

// Any OpenAI-compatible chat completions API: OpenAI, OpenRouter, Groq, vLLM, LM Studio.
export function createOpenAICompatibleProvider({
  apiKey = env('OPENAI_API_KEY'),
  baseUrl = env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  model = env('OPENAI_MODEL'),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  baseUrl = httpsOrigin(baseUrl, 'OPENAI_BASE_URL');
  const configured = Boolean(apiKey && model);
  return {
    name: 'openai',
    label: 'OpenAI-compatible API',
    kind: 'api',
    model: model || 'not set',
    baseUrl,
    configured,
    setup: 'Set OPENAI_API_KEY and OPENAI_MODEL; OPENAI_BASE_URL selects OpenRouter or another compatible host.',
    async health() {
      if (!apiKey) return unavailable('OPENAI_API_KEY is not set.');
      if (!model) return unavailable('OPENAI_MODEL is not set.');
      return { available: true, note: 'API key configured; verified on first decision.' };
    },
    async judge(input) {
      if (!configured) throw new Error('OPENAI_API_KEY and OPENAI_MODEL must be set.');
      const caseData = validateCase(input);
      const started = performance.now();
      const body = await requestJson(`${baseUrl}/chat/completions`, {
        method: 'POST',
        label: 'OpenAI-compatible API',
        timeoutMs,
        headers: { authorization: `Bearer ${apiKey}` },
        body: {
          model,
          temperature: 0,
          response_format: { type: 'json_schema', json_schema: { name: 'hr_decision', strict: true, schema: decisionSchema } },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Classify the request in EXCEPTION. Report confidence as your probability (0 to 1) that the route is correct.\n${caseText(caseData)}` },
          ],
        },
      });
      const text = body?.choices?.[0]?.message?.content;
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error('OpenAI-compatible API returned invalid decision JSON.'); }
      return normalizeDecision(parsed, { provider: 'openai', model: body?.model || model, durationMs: performance.now() - started });
    },
  };
}

// Offline typed-decision baseline: multinomial naive Bayes over labeled HR
// requests. It returns full probability distributions like Jev, needs no key
// or network, and is the floor the hosted models should beat.
const STOP = new Set('a an and are as at be been but by can could do for from had has have hello hi i if in is it its me my of on or our please regards so that the their them then there this to us was we were will with would you your dear thank thanks best kind hr am'.split(' '));
export function tokenize(text) {
  const words = String(text).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(word => word.length > 1 && !STOP.has(word) && !/^\d+$/.test(word));
  const tokens = [...words];
  for (let i = 0; i < words.length - 1; i += 1) tokens.push(`${words[i]}_${words[i + 1]}`);
  return tokens;
}

export function trainNaiveBayes(examples, labelOf, { alpha = 0.5 } = {}) {
  const counts = new Map();
  const totals = new Map();
  const docs = new Map();
  const vocabulary = new Set();
  for (const example of examples) {
    const label = labelOf(example);
    docs.set(label, (docs.get(label) || 0) + 1);
    if (!counts.has(label)) { counts.set(label, new Map()); totals.set(label, 0); }
    const bag = counts.get(label);
    for (const token of tokenize(example.text)) {
      vocabulary.add(token);
      bag.set(token, (bag.get(token) || 0) + 1);
      totals.set(label, totals.get(label) + 1);
    }
  }
  const labels = [...docs.keys()];
  const size = vocabulary.size;
  return {
    labels,
    // Scores are divided by sqrt(token count) so long tickets do not produce 100% certainty.
    predict(text) {
      const tokens = tokenize(text).filter(token => vocabulary.has(token));
      const scale = 1 / Math.sqrt(Math.max(tokens.length, 1));
      const scores = {};
      const evidence = {};
      for (const label of labels) {
        let score = Math.log(docs.get(label) / examples.length);
        const bag = counts.get(label);
        const denominator = totals.get(label) + alpha * size;
        for (const token of tokens) score += Math.log(((bag.get(token) || 0) + alpha) / denominator) * scale;
        scores[label] = score;
      }
      const max = Math.max(...Object.values(scores));
      const exp = Object.fromEntries(labels.map(label => [label, Math.exp(scores[label] - max)]));
      const sum = Object.values(exp).reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(labels.map(label => [label, exp[label] / sum]));
      const top = labels.reduce((a, b) => probabilities[a] >= probabilities[b] ? a : b);
      for (const token of new Set(tokens)) {
        const lift = Math.log(((counts.get(top).get(token) || 0) + alpha) / (totals.get(top) + alpha * size)) -
          Math.log(labels.reduce((acc, label) => acc + ((counts.get(label).get(token) || 0) + alpha) / (totals.get(label) + alpha * size), 0) / labels.length);
        evidence[token] = lift;
      }
      const cues = Object.entries(evidence).filter(([, lift]) => lift > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([token]) => token.replace('_', ' '));
      return { label: top, probability: probabilities[top], probabilities, cues };
    },
  };
}

export const trainingPath = fileURLToPath(new URL('../data/training/hr-requests.json', import.meta.url));

export function createBaselineProvider({ examples } = {}) {
  let models;
  function load() {
    if (models) return models;
    const rows = examples || JSON.parse(readFileSync(trainingPath, 'utf8')).examples;
    models = {
      count: rows.length,
      route: trainNaiveBayes(rows, row => row.route),
      category: trainNaiveBayes(rows, row => row.category),
      sensitive: trainNaiveBayes(rows, row => row.sensitive ? 'yes' : 'no'),
    };
    return models;
  }
  return {
    name: 'baseline',
    label: 'Offline baseline (naive Bayes)',
    kind: 'offline',
    model: 'daybreak-nb-v1',
    baseUrl: 'in-process',
    configured: true,
    setup: 'Always available. Trained on data/training/hr-requests.json.',
    async health() {
      try { return { available: true, note: `Trained on ${load().count} labeled requests; no network.` }; }
      catch (error) { return unavailable(`Training data unavailable: ${error.message}`); }
    },
    async judge(input) {
      const caseData = validateCase(input);
      const started = performance.now();
      const { route, category, sensitive } = load();
      const r = route.predict(caseData.exception);
      const c = category.predict(caseData.exception);
      const s = sensitive.predict(caseData.exception);
      return normalizeDecision({
        route: r.label,
        confidence: r.probability,
        probabilities: r.probabilities,
        category: c.label,
        categoryConfidence: c.probability,
        sensitive: s.probabilities.yes ?? 0,
        reason: r.cues.length ? `Strongest cues for ${r.label}: ${r.cues.map(cue => `"${cue}"`).join(', ')}.` : `No strong cues; prior favors ${r.label}.`,
      }, { provider: 'baseline', model: 'daybreak-nb-v1', durationMs: performance.now() - started });
    },
  };
}

// Build every provider once; configuration errors become visible health errors.
export function createProviders() {
  const factories = { jev: createJevProvider, anthropic: createAnthropicProvider, openai: createOpenAICompatibleProvider, ollama: createLocalProvider, baseline: createBaselineProvider };
  const providers = {};
  for (const [name, factory] of Object.entries(factories)) {
    try { providers[name] = factory(); }
    catch (error) {
      providers[name] = { name, label: name, kind: 'api', model: 'invalid config', baseUrl: '', configured: false, setup: error.message,
        health: async () => unavailable(error.message), judge: async () => { throw error; } };
    }
  }
  return providers;
}

// DAYBREAK_PROVIDER picks one explicitly; auto prefers configured hosted providers.
export function defaultProviderName(providers, requested = env('DAYBREAK_PROVIDER', 'auto')) {
  if (requested !== 'auto') {
    if (!providers[requested]) throw new Error(`DAYBREAK_PROVIDER must be auto or one of: ${Object.keys(providers).join(', ')}.`);
    return requested;
  }
  const ollamaChosen = Boolean(env('OLLAMA_MODEL') || env('OLLAMA_BASE_URL'));
  return ['jev', 'anthropic', 'openai', 'ollama'].find(name => providers[name]?.configured && (name !== 'ollama' || ollamaChosen)) || 'baseline';
}

export const hasTrainingData = () => existsSync(trainingPath);
