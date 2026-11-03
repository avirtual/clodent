import { describe, test } from 'node:test';
import { cases, subtests } from './cases.js';

describe('suite via helper', () => cases());
test('parent via helper', (t) => subtests(t));
