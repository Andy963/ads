## 2026-02-16 - [Implementing Custom Gzip Compression]
**Learning:** Node.js native `zlib` and `stream.pipeline` can be used to implement robust HTTP compression without external dependencies like `compression` middleware. This is useful when adding dependencies is restricted.
**Action:** When working with raw `http.createServer`, use `stream.pipeline` to pipe file streams through `zlib.createGzip()` to the response, handling errors correctly. Remember to set `Content-Encoding: gzip` and `Vary: Accept-Encoding`.
