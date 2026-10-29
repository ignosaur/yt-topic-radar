// Must be imported before lib/youtube.ts evaluates: youtubei.js's web platform
// captures `globalThis.fetch` unbound, which Chrome rejects with
// "Illegal invocation" when called as a bare function.
const nativeFetch = globalThis.fetch;
if (nativeFetch && typeof nativeFetch.bind === "function") {
  globalThis.fetch = nativeFetch.bind(globalThis);
}
