// Monta a pasta www/ usada pelo app Android (Capacitor) a partir de public/.
// Uso: PERFIL_SERVER_URL=http://192.168.0.10:3000 node scripts/build-web.mjs
import { cpSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const out = 'www';
rmSync(out, { recursive: true, force: true });
cpSync('public', out, { recursive: true });
mkdirSync(join(out, 'vendor'), { recursive: true });
cpSync('node_modules/socket.io/client-dist/socket.io.min.js', join(out, 'vendor', 'socket.io.min.js'));

const server = (process.env.PERFIL_SERVER_URL || '').replace(/\/+$/, '');
writeFileSync(join(out, 'config.js'), `window.PERFIL_SERVER_URL = ${JSON.stringify(server)};\n`);

// Garantia de segurança: nenhuma chave de API pode ir para dentro do APK.
for (const f of readdirSync(out, { recursive: true })) {
  const path = join(out, String(f));
  if (!/\.(js|html|css|json)$/.test(path)) continue;
  if (/sk-ant-[\w-]{10,}/.test(readFileSync(path, 'utf8'))) {
    console.error(`ERRO: ${path} contém uma chave de API. Build cancelado.`);
    process.exit(1);
  }
}
console.log(`www/ pronto${server ? ` (servidor padrão: ${server})` : ' (sem servidor padrão: configure no app)'}`);
