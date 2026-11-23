import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
const root = new URL('../', import.meta.url).pathname;
const read = p => readFileSync(join(root, p), 'utf8');
const migration = read('backend/supabase/migrations/20261123000000_storefront_settings.sql');
assert.match(migration, /enable row level security/i);
assert.match(migration, /grant select on table public\.storefront_settings to anon, authenticated/i);
assert.doesNotMatch(migration, /grant\s+(?:all|insert|update|delete).*to\s+(?:anon|authenticated)/i);
const edge = read('backend/supabase/functions/demo-payment-kit/index.ts');
assert.match(edge, /admin-store-settings/);
assert.ok(edge.indexOf("if (!admin) return reply") < edge.indexOf("if (url.pathname.endsWith('/admin-store-settings'))"));
assert.match(edge, /body.action !== 'save'/);
const worker = await import(pathToFileURL(join(root, 'cloudflare-worker.js')).href);
const origFetch = globalThis.fetch;
const requests = [];
try {
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => [{
      store_name:'Changed Store', store_email:'new@example.com', store_phone:'+91 9876543210',
      address:'New Street, Chennai, Tamil Nadu', currency:'INR', tax_rate:5,
      free_ship_min:1250,enable_cod:true,enable_online:false
    }] };
  };
  const env = { SUPABASE_URL:'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY:'test-public-key', ASSETS:{fetch:()=>{throw Error('assets path should not run')}} };
  let response = await worker.default.fetch(new Request('https://shop.example.test/api/store-settings'), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settings.freeShipMin, 1250);
  assert.equal(requests.length,1);
  assert.match(requests[0].url,/storefront_settings/);
  assert.equal(requests[0].options.headers.apikey,'test-public-key');
  response = await worker.default.fetch(new Request('https://shop.example.test/api/store-settings',{method:'POST'}),env);
  assert.equal(response.status,405);
  assert.equal(requests.length,1);
} finally { globalThis.fetch=origFetch; }
const source = read('frontend/assets/js/store-settings.js');
const shop = { name:'Old', freeShipOver:999 };
const context = {
  window: { SITE:{shop} },
  document: { body:null, readyState:'loading', addEventListener:()=>{} },
  fetch: async () => ({ok:true,json:async()=>({settings:{
    storeName:'Updated Shop',storeEmail:'new@example.com',storePhone:'+91 9876543210',
    address:'123 Market Road, Chennai, Tamil Nadu',freeShipMin:1250,
    taxRate:5,currency:'INR',enableCod:true,enableOnline:false
  }})}),
  AbortController, setTimeout, clearTimeout, console
};
vm.runInNewContext(source,context);
await context.window.StorefrontSettings.ready;
assert.equal(shop.name,'Updated Shop');
assert.equal(shop.phoneHref,'+919876543210');
assert.equal(shop.freeShipOver,1250);
assert.equal(shop.enableOnline,false);
assert.match(read('frontend/admin.html'),/id="adminGateEmail"[^>]*value="shanmukioilmill@gmail\.com"/);
assert.match(read('frontend/assets/js/admin.js'),/auth\.updateUser\(\{ email: newEmail \}\)/);
assert.match(read('frontend/assets/js/admin.js'),/demoAdminRequest\('admin-store-settings', \{ action: 'save'/);
console.log('Shared store settings: public GET, write security, rendering and admin tests passed');
