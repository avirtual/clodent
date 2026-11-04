import { join } from 'node:path';

const SESSION_ID = /^[\w-]+$/;

export function clodentHome(env, homedir) {
  return env.CLODENT_HOME ? env.CLODENT_HOME : join(homedir, '.clodent');
}

export function projectSlug(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

export function transcriptPath(home, cwd, sessionId) {
  return join(home, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

export function findTranscript(home, cwd, sessionId, { existsSync, readdirSync }) {
  if (!SESSION_ID.test(sessionId)) return null;
  const own = transcriptPath(home, cwd, sessionId);
  if (existsSync(own)) return own;
  const projects = join(home, 'projects');
  if (!existsSync(projects)) return null;
  for (const slug of readdirSync(projects).sort()) {
    const path = join(projects, slug, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}
