import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE, orderArchives } from '../../web/coop/data-order.js';
test('local mount order preserves patch precedence and rejects incomplete/ambiguous folders', () => {
  const files = [...BASE, 'patch-b.mpq', 'patch-2.mpq', 'patch.mpq', 'speech2.mpq', 'patch-10.mpq'].reverse().map(name => ({ name }));
  assert.deepEqual(orderArchives(files).map(f => f.name), [...BASE, 'patch.mpq', 'patch-2.mpq', 'patch-b.mpq', 'speech2.mpq']);
  assert.throws(() => orderArchives([]), /Missing/);
  assert.throws(() => orderArchives([...files, { name: 'DBC.MPQ' }]), /Duplicate/);
});
