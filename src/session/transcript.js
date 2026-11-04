import { dirname } from 'node:path';

export const INTERRUPT_TEXT = '[Request interrupted by user]';
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export function createTranscript({ path, sessionId, cwd, version, parentUuid = null }, deps) {
  const { appendFileSync, mkdirSync, clock, uuid } = deps;
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  let last = parentUuid;

  function write(entry) {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
    last = entry.uuid ?? last;
    return entry;
  }

  return {
    path,
    lastUuid: () => last,
    append(record) {
      return write({
        parentUuid: last,
        isSidechain: false,
        ...record,
        uuid: uuid(),
        timestamp: clock().toISOString(),
        cwd,
        sessionId,
        version,
        entrypoint: 'clodent',
      });
    },
    copy(records) {
      for (const record of records) write({ ...record, sessionId });
    },
  };
}
