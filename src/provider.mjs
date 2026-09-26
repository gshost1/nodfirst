import { caseText, decisionSchema, normalizeDecision, systemPrompt, validateCase } from './decision.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5:3b';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SHOW_BYTES = 1024 * 1024;

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OLLAMA_BASE_URL must be a valid loopback HTTP URL.');
  }
  const host = url.hostname.toLowerCase();
  const loopbackV4 = /^127(?:\.\d{1,3}){3}$/.test(host) &&
    host.split('.').every((part) => Number(part) <= 255);
  if (url.protocol !== 'http:' || !(host === 'localhost' || host === '[::1]' || loopbackV4) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OLLAMA_BASE_URL must be a loopback HTTP origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

function describeFailure(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return 'Ollama request timed out.';
  }
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    return 'Cannot reach Ollama. Start it with `ollama serve` and try again.';
  }
  return error instanceof Error ? error.message : String(error);
}

async function requestJson(baseUrl, path, { method = 'GET', body, timeoutMs, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  let response;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    throw new Error(describeFailure(error), { cause: error });
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error('Ollama endpoint returned a redirect; redirects are not allowed.');
  }
  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}.`);
  }
  let bytes;
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new Error('Ollama response is too large.');
      }
      chunks.push(chunk);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } catch (error) {
    throw new Error(describeFailure(error), { cause: error });
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Ollama returned invalid JSON.');
  }
}

function remainingMs(deadline) {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw new Error('Ollama request timed out.');
  return remaining;
}

function hasCloudCapability(capabilities) {
  return !Array.isArray(capabilities) || capabilities.some((item) =>
    typeof item !== 'string' || /cloud|remote/i.test(item));
}

async function verifyLocalModel(baseUrl, model, deadline) {
  const tags = await requestJson(baseUrl, '/api/tags', { timeoutMs: remainingMs(deadline) });
  if (!Array.isArray(tags?.models)) {
    throw new Error('Ollama returned an invalid model list.');
  }
  const entry = tags.models.find((item) => item?.name === model || item?.model === model);
  if (!entry) {
    throw new Error(`Model ${model} is not installed. Run \`ollama pull ${model}\`.`);
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 1_000_000 ||
      hasCloudCapability(entry.capabilities)) {
    throw new Error(`Model ${model} has no verifiable local weights or advertises cloud capability.`);
  }
  const show = await requestJson(baseUrl, '/api/show', {
    method: 'POST',
    body: { model },
    timeoutMs: remainingMs(deadline),
    maxBytes: MAX_SHOW_BYTES,
  });
  if (!show || typeof show !== 'object' || Array.isArray(show) ||
      Object.hasOwn(show, 'remote_model') || Object.hasOwn(show, 'remote_host') ||
      hasCloudCapability(show.capabilities) ||
      typeof show.details?.format !== 'string' || !show.details.format ||
      !Array.isArray(show.tensors) || show.tensors.length === 0) {
    throw new Error(`Model ${model} is not verified as local-only by Ollama metadata (remote or missing weights).`);
  }
}

export function createLocalProvider({
  baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL,
  model = process.env.OLLAMA_MODEL || DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  baseUrl = validateBaseUrl(baseUrl);
  if (typeof model !== 'string' || !/^[\w.][\w.:/-]{0,120}$/.test(model)) {
    throw new Error('OLLAMA_MODEL must be a valid model name.');
  }
  if (/(^|[:/._-])cloud($|[:/._-])/i.test(model)) {
    throw new Error('Cloud Ollama models are disabled for this local-only demo. Choose an installed local model.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
    throw new Error('timeoutMs must be an integer from 1 to 600000.');
  }

  return {
    name: 'ollama',
    label: 'Ollama (local)',
    kind: 'local',
    model,
    baseUrl,
    async health() {
      try {
        await verifyLocalModel(baseUrl, model, performance.now() + Math.min(timeoutMs, 5000));
        return { available: true };
      } catch (error) {
        return { available: false, error: describeFailure(error) };
      }
    },
    async judge(input) {
      const caseData = validateCase(input);
      const started = performance.now();
      const deadline = started + timeoutMs;
      await verifyLocalModel(baseUrl, model, deadline);
      const result = await requestJson(baseUrl, '/api/generate', {
        method: 'POST',
        timeoutMs: remainingMs(deadline),
        body: {
          model,
          stream: false,
          format: decisionSchema,
          options: { temperature: 0, num_predict: 260, num_ctx: 2048 },
          system: `${systemPrompt} Return JSON with route, confidence (0 to 1), category, sensitive (0 to 1), and a short reason.`,
          prompt: `Classify the request in EXCEPTION.\n${caseText(caseData)}`,
        },
      });
      if (result?.done !== true || typeof result.response !== 'string') {
        throw new Error('Ollama returned an incomplete generation.');
      }
      let parsed;
      try {
        parsed = JSON.parse(result.response);
      } catch {
        throw new Error('Ollama returned invalid judgment JSON.');
      }
      if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).sort().join(',') !== 'category,confidence,reason,route,sensitive') {
        throw new Error('Ollama returned a judgment that does not match the required schema.');
      }
      return normalizeDecision(parsed, { provider: 'ollama', model, durationMs: performance.now() - started });
    },
  };
}
