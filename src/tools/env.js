const HIDDEN_ENV = Object.freeze(['ANTHROPIC_API_KEY']);

export function toolEnv(env, names = []) {
  const kept = { ...(env ?? process.env) };
  for (const name of [...HIDDEN_ENV, ...names]) delete kept[name];
  return kept;
}
