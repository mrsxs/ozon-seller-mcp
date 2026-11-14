// Preloaded (--import) into the real entry point by tests/features.test.js: registers an ad token
// the way the Performance transport does, then lets errors carrying it and a configured key
// escape to the process-level handlers of bin/ozon-seller-mcp.js.
import { rememberToken } from '../../src/privacy.js';

const token = process.env.TEST_LEAK_TOKEN;
rememberToken(token, Date.now() + 60_000);
setTimeout(() => {
  throw new Error(`boom Authorization: Bearer ${token} Api-Key ${process.env.OZON_API_KEY}`);
}, 100);
setTimeout(() => {
  Promise.reject(new Error(`rejected ${token}`));
}, 150);
