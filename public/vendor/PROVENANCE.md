# CAPTCHA assets

Unmodified upstream files, fetched 2026-11-05:

- `cap.min.js`: `https://unpkg.com/@cap.js/widget@0.1.57/cap.min.js`.
  SHA-384: `jRVyBEwWeNAitIjhGT4Es7NBrYJS0WspXxvwUaxOve885Bj6sLTieyvmS85d9WF0`.
  The page retains the existing SRI check.
- `cap_wasm_bg.wasm`: `https://cdn.jsdelivr.net/npm/@cap.js/wasm@0.0.7/browser/cap_wasm_bg.wasm`.
- `pako_inflate.min.js`: `https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako_inflate.min.js`.

`faucet.js` sets the widget's supported `CAP_CUSTOM_WASM_URL` and `CAP_PAKO_URL`
overrides to same-origin resources, and `CAP_DISABLE_WIDGET_REF` so the widget's
attribution link never carries the page URL (which can hold a voucher code). Turnstile remains the existing abuse control.
The widget and WASM package both declare Apache-2.0 (CAP-LICENSE.txt holds the
upstream notice and the full licence text).
Pako uses MIT AND Zlib (PAKO-LICENSE.txt holds both notices). `SHA256` pins all three files.
