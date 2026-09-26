import { spawn } from 'node:child_process';
import { createLocalProvider } from '../src/provider.mjs';

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 2)) {
    throw new Error(`Node 24.2 or newer is required (found ${process.versions.node}). Install a newer Node version and rerun setup.`);
  }
}

function pullModel(model, baseUrl) {
  return new Promise((resolve, reject) => {
    const address = new URL(baseUrl);
    const child = spawn('ollama', ['pull', model], {
      stdio: 'inherit',
      env: { ...process.env, OLLAMA_HOST: address.host },
    });
    child.on('error', (error) => {
      reject(new Error(error.code === 'ENOENT'
        ? 'The Ollama CLI is not installed. Install Ollama, start `ollama serve`, and rerun setup.'
        : `Could not run ollama pull: ${error.message}`));
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ollama pull ${model} exited with status ${code}. Check Ollama and rerun setup.`));
    });
  });
}

async function main() {
  checkNode();
  const provider = createLocalProvider();
  console.log(`Node ${process.versions.node} is ready.`);
  console.log(`Checking Ollama at ${provider.baseUrl} for ${provider.model}...`);
  const status = await provider.health();
  if (status.available) {
    console.log(`Ollama is ready; ${provider.model} has verified local weights and no cloud or remote metadata.`);
    console.log('For extra protection, start the Ollama daemon with OLLAMA_NO_CLOUD=1.');
    return;
  }
  if (!status.error?.startsWith(`Model ${provider.model} is not installed.`)) {
    const unavailable = /Cannot reach Ollama|timed out/i.test(status.error || '');
    throw new Error(`${status.error || 'Ollama is unavailable.'}${unavailable
      ? ' Start Ollama with `ollama serve` (or open the Ollama app), then rerun setup.'
      : ' Choose a model with local weights and rerun setup.'}`);
  }
  console.log(`Downloading ${provider.model} through the local Ollama daemon...`);
  await pullModel(provider.model, provider.baseUrl);
  const afterPull = await provider.health();
  if (!afterPull.available) {
    throw new Error(`Model download finished but setup could not verify it: ${afterPull.error}`);
  }
  console.log(`Ollama is ready; ${provider.model} has verified local weights and no cloud or remote metadata.`);
  console.log('For extra protection, start the Ollama daemon with OLLAMA_NO_CLOUD=1.');
}

main().catch((error) => {
  console.error(`Setup failed: ${error.message}`);
  process.exitCode = 1;
});
