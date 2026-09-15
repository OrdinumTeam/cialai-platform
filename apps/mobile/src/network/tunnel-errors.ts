type CodedError = {
  code?: unknown;
  message?: unknown;
};

const CODE_PATTERN = /^[a-z]+(?:_[a-z]+)*$/;

// O Android rejeita com o código estável em `code`; o iOS repassa a mensagem do Go,
// que começa por `codigo: mensagem`, às vezes depois do prefixo do Expo. Só códigos
// conhecidos são aceitos, para nunca mostrar a mensagem crua do núcleo.
export function tunnelErrorCode(caught: unknown, known: ReadonlySet<string>): string | null {
  if (typeof caught !== 'object' || caught === null) return null;
  const error = caught as CodedError;
  if (typeof error.code === 'string' && CODE_PATTERN.test(error.code) && known.has(error.code)) return error.code;
  if (typeof error.message !== 'string') return null;
  for (const match of error.message.matchAll(/(?:^|[\s>:→])([a-z]+(?:_[a-z]+)*)(?=:|$)/gm)) {
    const code = match[1];
    if (code && known.has(code)) return code;
  }
  return null;
}
