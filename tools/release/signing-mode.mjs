// SPDX-License-Identifier: Apache-2.0
// Escolhe a assinatura de plataforma possível para o alvo e grava a configuração extra do Tauri.
// Sem Developer ID o macOS recebe assinatura ad hoc, que basta para abrir no Apple Silicon.
// A notarização usa a chave da API do App Store Connect, sem Apple ID nem senha de app.
// Sem conta do Azure Trusted Signing o Windows sai sem Authenticode. Nenhum valor é impresso.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APPLE_DEVELOPER_ID = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY',
  'APPLE_API_PRIVATE_KEY',
];
const WINDOWS_TRUSTED_SIGNING = [
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'WINDOWS_SIGNING_ENDPOINT',
  'WINDOWS_SIGNING_ACCOUNT',
  'WINDOWS_SIGNING_PROFILE',
];

const present = (env, names) => names.every((name) => (env[name] ?? '').trim() !== '');

export function signingPlan(target, env) {
  if (target.endsWith('-apple-darwin')) {
    if (present(env, APPLE_DEVELOPER_ID)) {
      // O identificador da chave vira nome de arquivo no runner e o emissor segue o formato UUID da Apple.
      if (!/^[A-Z0-9]{10}$/.test(env.APPLE_API_KEY.trim())) throw new Error('APPLE_API_KEY has unexpected characters');
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(env.APPLE_API_ISSUER.trim())) {
        throw new Error('APPLE_API_ISSUER must be an App Store Connect issuer ID');
      }
      return { macos: 'developer-id', windows: 'none', config: {} };
    }
    return { macos: 'adhoc', windows: 'none', config: { bundle: { macOS: { signingIdentity: '-' } } } };
  }
  if (target.endsWith('-pc-windows-msvc')) {
    if (!present(env, WINDOWS_TRUSTED_SIGNING)) return { macos: 'none', windows: 'unsigned', config: {} };
    const endpoint = env.WINDOWS_SIGNING_ENDPOINT.trim();
    const account = env.WINDOWS_SIGNING_ACCOUNT.trim();
    const profile = env.WINDOWS_SIGNING_PROFILE.trim();
    if (!/^https:\/\/[a-z0-9.-]+\.codesigning\.azure\.net\/?$/.test(endpoint)) {
      throw new Error('WINDOWS_SIGNING_ENDPOINT must be an Azure code signing endpoint');
    }
    for (const [name, value] of [['WINDOWS_SIGNING_ACCOUNT', account], ['WINDOWS_SIGNING_PROFILE', profile]]) {
      if (!/^[A-Za-z0-9-]{3,64}$/.test(value)) throw new Error(`${name} has unexpected characters`);
    }
    const signCommand = `trusted-signing-cli -e ${endpoint} -a ${account} -c ${profile} -d Cialai %1`;
    return { macos: 'none', windows: 'trusted-signing', config: { bundle: { windows: { signCommand } } } };
  }
  if (target.endsWith('-linux-gnu')) return { macos: 'none', windows: 'none', config: {} };
  throw new Error(`Unknown release target ${target}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
    return args[index + 1];
  };
  const plan = signingPlan(option('--target'), process.env);
  writeFileSync(option('--config-out'), `${JSON.stringify(plan.config, null, 2)}\n`);
  console.log(`macos=${plan.macos}`);
  console.log(`windows=${plan.windows}`);
}
