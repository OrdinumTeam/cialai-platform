// SPDX-License-Identifier: Apache-2.0
// Anuncia uma release no Discord, com o resumo e os destaques de
// `docs/releases/<versao>.md`. A página é a fonte única: o que está escrito lá
// é o que chega ao canal, sem um segundo texto para manter em dia.
//
// Uso: DISCORD_WEBHOOK=... node tools/release/discord-notify.mjs v0.2.5
//      --dry-run imprime o payload e não envia.
//
// O endereço do webhook nunca entra no repositório: vem do segredo
// `DISCORD_WEBHOOK` do repositório público, lido pelo workflow.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const TAG = /^v(\d+\.\d+\.\d+)$/;
const COLOR = 0xe9497f;
const AVATAR = 'https://cialai.com.br/assets/img/brand/cialai-mark.png';
const DOWNLOADS = 'https://cialai.com.br/downloads/';

/** Versão a partir da tag, recusando qualquer coisa fora de `vX.Y.Z`. */
export function versionOf(tag) {
  const match = TAG.exec(String(tag).trim());
  if (!match) throw new Error(`Tag inválida ${tag}, esperado v<major>.<minor>.<patch>`);
  return match[1];
}

/** Corpo de uma seção `## Título`, até a próxima seção do mesmo nível. */
export function section(markdown, title) {
  const pattern = new RegExp(`^## ${title}\\s*$([\\s\\S]*?)(?=^## |\\s*$(?![\\s\\S]))`, 'm');
  return (pattern.exec(markdown)?.[1] ?? '').trim();
}

/** Itens de lista de uma seção, já sem o marcador. */
export function bullets(body) {
  return body
    .split('\n')
    .filter((line) => line.startsWith('* '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

/** Uma linha só por item, para o canal não virar parede de texto. */
function condense(text) {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * Separa o rótulo em negrito do corpo do destaque.
 *
 * A página escreve `**🖥️ Diálogos do computador.** texto`, então o emoji e o
 * título curto vêm de lá, junto com o texto. Assim o anúncio continua tendo
 * uma fonte só, e quem escreve a página decide como o canal vai ler.
 */
export function splitHighlight(item) {
  const match = /^\*\*\s*(.+?)\s*\.?\*\*\s*([\s\S]*)$/.exec(item);
  if (!match) return { label: '', body: condense(item) };
  return { label: condense(match[1]), body: condense(match[2]) };
}

export function buildPayload(version, page, { downloads = DOWNLOADS, release } = {}) {
  const summary = condense(section(page, 'Resumo'));
  const highlights = bullets(section(page, 'Destaques'));
  if (!summary) throw new Error(`docs/releases/${version}.md não tem seção Resumo`);
  if (!highlights.length) throw new Error(`docs/releases/${version}.md não tem seção Destaques`);
  // Um bloco por destaque: rótulo em negrito e o texto citado abaixo. A citação
  // separa os assuntos sem transformar o anúncio numa parede de texto.
  const blocks = highlights.map((item) => {
    const { label, body } = splitHighlight(item);
    return label ? `**${label}:**\n> ${body}` : `> ${body}`;
  });
  const description = [summary, ...blocks, `**📥 Baixar:**\n> ${downloads}`].join('\n\n');
  return {
    username: 'Cialai',
    avatar_url: AVATAR,
    embeds: [
      {
        title: `Cialai ${version} 🚀`,
        url: release,
        color: COLOR,
        description,
        footer: { text: 'Prévia pública' },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function send(webhook, payload) {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    // O corpo pode repetir o endereço assinado; só o status vai ao log.
    throw new Error(`Discord recusou o anúncio com status ${response.status}`);
  }
}

async function main() {
  const [tag, ...flags] = process.argv.slice(2);
  const version = versionOf(tag);
  const page = readFileSync(new URL(`docs/releases/${version}.md`, ROOT), 'utf8');
  const repo = process.env.GH_REPO || 'OrdinumTeam/cialai-platform';
  const payload = buildPayload(version, page, {
    release: `https://github.com/${repo}/releases/tag/${tag}`,
  });
  if (flags.includes('--dry-run')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const webhook = process.env.DISCORD_WEBHOOK;
  if (!webhook) throw new Error('Defina DISCORD_WEBHOOK no ambiente');
  await send(webhook, payload);
  console.log(`Anúncio de ${tag} enviado ao Discord`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
