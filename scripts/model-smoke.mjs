import { createLocalProvider } from '../src/provider.mjs';

const provider = createLocalProvider();
const caseData = {
  role: 'Product Designer',
  location: 'Portland, OR',
  workMode: 'remote',
  exception: 'My assigned laptop arrives after my start date. Can I use my personal laptop to access company design files for the first week?',
  policies: [
    { id: 'workspace', title: 'Workspace access', rule: 'IT provisions company devices and approved accounts before access to company files.' },
    { id: 'remote', title: 'Remote onboarding', rule: 'Remote hires receive a company laptop. Temporary access exceptions require human review.' },
    { id: 'exceptions', title: 'Exception routing', rule: 'Security reviews personal-device access to company data; IT reviews device delivery and setup.' },
  ],
};

async function main() {
  const health = await provider.health();
  if (!health.available) throw new Error(health.error || 'Ollama is unavailable.');
  console.log(`Running real local inference with ${provider.model} at ${provider.baseUrl}...`);
  const started = performance.now();
  const judgment = await provider.judge(caseData);
  console.log(JSON.stringify({ judgment, wallTimeMs: Math.round(performance.now() - started) }, null, 2));
}

main().catch((error) => {
  console.error(`Model smoke failed: ${error.message}`);
  process.exitCode = 1;
});
