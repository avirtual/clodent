import { describe, it } from 'node:test';

describe.skip('skipped suite', () => {
  it('never runs', () => {});
});
