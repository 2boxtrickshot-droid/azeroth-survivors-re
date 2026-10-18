// Only active for an explicitly selected local-data co-op session. Native-server and solo
// pages retain the browser's original XHR. The upstream Rust Chain needs only status/text.
if (new URLSearchParams(location.search).has('localData')) {
  const mountId = new URLSearchParams(location.search).get('localData');
  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) window.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/data/')) {
      url.searchParams.set('localData', mountId);
      return originalFetch(input instanceof Request ? new Request(url.href, input) : url.href, options);
    }
    return originalFetch(input, options);
  };
  const Original = window.XMLHttpRequest;
  const read = parent.__azeroth_local_read;
  if (typeof read !== 'function') throw new Error('Select your Data folder from the co-op menu first.');
  window.XMLHttpRequest = class extends Original {
    open(method, url, async = true, ...rest) {
      const target = new URL(url, location.href);
      this.local = !async && target.origin === location.origin && target.pathname.startsWith('/data/');
      if (!this.local) return super.open(method, url, async, ...rest);
      this.localMethod = method.toUpperCase();
      this.localName = decodeURIComponent(target.pathname.slice(6)).replaceAll('/', '\\');
      this.localResult = { status: 0, bytes: new Uint8Array() };
    }
    overrideMimeType(type) { if (!this.local) super.overrideMimeType(type); }
    send(body) {
      if (!this.local) return super.send(body);
      if (!['GET', 'HEAD'].includes(this.localMethod)) throw new Error('Local data is read-only');
      this.localResult = this.localName === '__index' ? { status: 404, bytes: new Uint8Array() } : read(this.localName, this.localMethod === 'HEAD');
    }
    get status() { return this.local ? this.localResult.status : super.status; }
    get responseText() {
      if (!this.local) return super.responseText;
      const bytes = this.localResult.bytes, chunks = [];
      for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
      return chunks.join('');
    }
  };
}
