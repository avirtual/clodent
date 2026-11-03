export const DIR = Symbol('dir');

function enoent(path) {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
}

export function fakeFs(entries) {
  const map = new Map(Object.entries(entries));
  const reads = [];
  return {
    reads,
    readFile(path) {
      reads.push(path);
      const entry = map.get(path);
      if (entry === undefined || entry === DIR) throw enoent(path);
      return entry;
    },
    stat(path) {
      const entry = map.get(path);
      if (entry === undefined) throw enoent(path);
      return { isFile: () => entry !== DIR, isDirectory: () => entry === DIR };
    },
  };
}
