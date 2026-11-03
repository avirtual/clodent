import { describe, it } from 'node:test';

function loadRows() {
  throw new Error('table fails to load');
}

describe('table-driven suite', () => {
  for (const row of loadRows()) it(row.name, () => {});
});
