// Configura a chave da Claude API no servidor (arquivo .env), sem mostrá-la na tela.
// Uso: npm run setup          → pede a chave, testa e salva
//      npm run setup -- --check → só testa a chave que já está no .env
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import Anthropic from '@anthropic-ai/sdk';

const ENV_FILE = '.env';

function readEnv() {
  if (!existsSync(ENV_FILE)) return existsSync('.env.example') ? readFileSync('.env.example', 'utf8') : '';
  return readFileSync(ENV_FILE, 'utf8');
}

function getVar(text, name) {
  const m = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

function setVar(text, name, value) {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}

// Lê uma linha sem ecoar o que é digitado.
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) process.stdout.write(s);
      else process.stdout.write(s.includes('\n') ? '\n' : '•');
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function check(apiKey) {
  try {
    // Listar modelos não gasta tokens: só confirma que a chave é aceita.
    await new Anthropic({ apiKey }).models.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, reason: 'chave inválida ou revogada' };
    if (err instanceof Anthropic.PermissionDeniedError) return { ok: false, reason: 'a chave não tem permissão' };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, reason: 'sem conexão com api.anthropic.com' };
    return { ok: false, reason: err.message };
  }
}

const mask = (k) => (k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-4)}` : '••••');

let env = readEnv();

if (process.argv.includes('--check')) {
  const key = getVar(env, 'ANTHROPIC_API_KEY');
  if (!key) {
    console.log('Nenhuma ANTHROPIC_API_KEY no .env. Rode: npm run setup');
    process.exit(1);
  }
  const r = await check(key);
  console.log(r.ok ? `✔ Chave ${mask(key)} funcionando.` : `✘ Chave ${mask(key)} não funcionou: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}

console.log('Configuração da IA do Perfil IA');
console.log('Crie uma chave em https://console.anthropic.com/settings/keys e cole abaixo.');
console.log('Ela fica só neste servidor (arquivo .env) e nunca vai para o navegador nem para o APK.\n');

const key = await askHidden('Chave da API (começa com sk-ant-): ');
if (!key.startsWith('sk-ant-')) {
  console.log('Isso não parece uma chave da Anthropic (deveria começar com "sk-ant-"). Nada foi salvo.');
  process.exit(1);
}
process.stdout.write('Testando a chave… ');
const r = await check(key);
if (!r.ok) {
  console.log(`não funcionou (${r.reason}). Nada foi salvo.`);
  process.exit(1);
}
console.log('ok!');

env = setVar(env, 'ANTHROPIC_API_KEY', key);
if (!getVar(env, 'ADMIN_TOKEN')) env = setVar(env, 'ADMIN_TOKEN', randomBytes(18).toString('base64url'));
writeFileSync(ENV_FILE, env);
try {
  chmodSync(ENV_FILE, 0o600); // só o dono do arquivo consegue ler
} catch {
  /* Windows não usa permissões Unix */
}
console.log(`\n✔ Chave ${mask(key)} salva em .env.`);
console.log(`✔ ADMIN_TOKEN para ver o consumo: ${getVar(env, 'ADMIN_TOKEN')}`);
console.log('Agora rode: npm start');
