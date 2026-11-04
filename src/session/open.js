import { findTranscript, transcriptPath } from './paths.js';
import { loadTranscript } from './load.js';
import { createTranscript } from './transcript.js';

function fail(error) {
  return { ok: false, error };
}

function fresh(id, { home, cwd, version }, deps) {
  const path = transcriptPath(home, cwd, id);
  return { path, transcript: createTranscript({ path, sessionId: id, cwd, version }, deps) };
}

export function openSession({ sessionId, resume, forkSession, home, cwd, version }, deps) {
  const where = { home, cwd, version };
  if (resume === undefined) {
    const id = sessionId ?? deps.uuid();
    if (sessionId !== undefined && deps.existsSync(transcriptPath(home, cwd, id))) {
      return fail(`session ${id} already exists; use --resume`);
    }
    const { path, transcript } = fresh(id, where, deps);
    return { ok: true, sessionId: id, transcriptPath: path, transcript, history: [], interrupted: false, warnings: [] };
  }
  const source = findTranscript(home, cwd, resume, deps);
  if (source === null) return fail(`no session ${resume}`);
  let loaded;
  try {
    loaded = loadTranscript(source, deps);
  } catch (err) {
    return fail(err.message);
  }
  const base = { ok: true, history: loaded.history, interrupted: loaded.interruptedLast, warnings: loaded.warnings };
  if (forkSession) {
    const id = sessionId ?? deps.uuid();
    if (sessionId !== undefined && (id === resume || deps.existsSync(transcriptPath(home, cwd, id)))) {
      return fail(`session ${id} already exists; use --resume`);
    }
    const { path, transcript } = fresh(id, where, deps);
    transcript.copy(loaded.records);
    return { ...base, sessionId: id, transcriptPath: path, transcript };
  }
  if (loaded.truncated) deps.truncateSync(source, loaded.validBytes);
  const transcript = createTranscript({ path: source, sessionId: resume, cwd, version, parentUuid: loaded.lastUuid }, deps);
  return { ...base, sessionId: resume, transcriptPath: source, transcript };
}
