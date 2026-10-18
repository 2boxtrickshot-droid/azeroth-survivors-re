import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../web/local-data-xhr.js', import.meta.url), 'utf8');
test('local XHR adapter preserves all binary bytes, HEAD/missing status and native async paths', () => {
  class Original {
    open() { this.nativeOpen = true; }
    send() { this.nativeSend = true; }
    get status() { return 201; }
    get responseText() { return 'native'; }
  }
  const bytes = Uint8Array.from({ length: 20000 }, (_, i) => i % 256);
  const context = { window: { XMLHttpRequest: Original }, URL, URLSearchParams, Uint8Array,
    location: { href: 'https://party.example/index.html?localData=test', origin: 'https://party.example', search: '?localData=test' },
    parent: { __azeroth_local_read: (name, head) => ({ status: name === 'missing' ? 404 : 200, bytes: head ? new Uint8Array() : bytes }) },
  };
  vm.runInNewContext(source, context);
  const x = new context.window.XMLHttpRequest();
  x.open('GET', '/data/test', false); x.send(); assert.equal(x.status, 200);
  assert.deepEqual(Uint8Array.from(x.responseText, ch => ch.charCodeAt(0)), bytes);
  x.open('HEAD', '/data/test', false); x.send(); assert.equal(x.status, 200); assert.equal(x.responseText, '');
  x.open('GET', '/data/missing', false); x.send(); assert.equal(x.status, 404);
  x.open('GET', '/data/test', true); x.send(); assert.equal(x.status, 201); assert.equal(x.responseText, 'native');
  assert.ok(x.nativeOpen && x.nativeSend);
  const native = { ...context, window: { XMLHttpRequest: Original }, location: { search: '' } };
  vm.runInNewContext(source, native); assert.equal(native.window.XMLHttpRequest, Original);
});
