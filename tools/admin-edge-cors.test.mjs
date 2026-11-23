/** Regression test for the Supabase admin Edge Function's exact-origin CORS gate.
 * No network, secrets, or real Supabase access required.
 * Node 22+ can strip the source's TypeScript types during import.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = await readFile(new URL('../backend/supabase/functions/demo-payment-kit/index.ts', import.meta.url), 'utf8');
assert.match(source, /client\.auth\.getUser\(token\.slice\(7\)\)/, 'Token must be verified server-side');
assert.match(source, /\.from\('ownpay_payment_admins'\)/, 'Admin must still be in database allowlist');
assert.doesNotMatch(source, /'Access-Control-Allow-Origin':\s*'\*'/, 'Do not allow wildcard origin');

// Mock the Deno platform and import dependency, but use the actual request handler.
let handler;
globalThis.Deno = {
  env: { get: (key) => key === 'SUPABASE_URL' ? 'https://project.example' : key === 'SUPABASE_SERVICE_ROLE_KEY' ? 'not-a-real-key' : '' },
  serve: (fn) => { handler = fn; }
};
const path = await mkdtemp(join(tmpdir(), 'shanmuki-admin-cors-'));
try {
  const testedSource = source.replace(
    "import { createClient } from 'npm:@supabase/supabase-js@2';",
    "const createClient = () => { throw new Error('Test must not reach Supabase'); };"
  );
  assert.notEqual(testedSource, source, 'Expected dependency import to be replaced');
  const testFile = join(path, 'admin-edge.ts');
  await writeFile(testFile, testedSource);
  await import(pathToFileURL(testFile).href);
  assert.equal(typeof handler, 'function');
  const endpoint = 'https://project.example/functions/v1/demo-payment-kit/admin-check';
  for (const origin of [
    'https://shop.shanmukiorg.workers.dev',
    'https://shanmugaorganics.netlify.app',
    'https://karthickpoorvika2023-arch.github.io'
  ]) {
    const preflight = await handler(new Request(endpoint, { method: 'OPTIONS', headers: { Origin: origin } }));
    assert.equal(preflight.status, 200, `Allowed origin ${origin}`);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    const unauthenticated = await handler(new Request(endpoint, { method: 'POST', headers: { Origin: origin } }));
    assert.equal(unauthenticated.status, 401, 'Allowed origin must still require authentication');
  }
  for (const origin of ['https://evil.example', 'https://shop.shanmukiorg.workers.dev.evil.example']) {
    const res = await handler(new Request(endpoint, { method: 'OPTIONS', headers: { Origin: origin } }));
    assert.equal(res.status, 403, 'Unknown origins are blocked');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
  console.log('PASS: admin CORS permits exact Cloudflare origin; rejects untrusted origins; preserves admin security gate');
} finally {
  await rm(path, { recursive: true, force: true });
  delete globalThis.Deno;
}
