import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (key: string) => Deno.env.get(key) || '';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (value: object, status = 200, origin = '') => new Response(JSON.stringify(value), { status, headers: { ...headers, ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) } });
const safe = (v: unknown, limit: number) => typeof v === 'string' ? v.trim().slice(0, limit) : '';

Deno.serve(async req => {
  const origin = req.headers.get('origin') || '';
  // Production admin operations are allowed only from explicitly approved origins.
  // This is CORS hygiene, NOT the security boundary: auth + DB allowlist below are mandatory.
  const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const defaultOrigins = [
    'https://shanmugaorganics.netlify.app',
    'https://karthickpoorvika2023-arch.github.io',
    // Current Cloudflare production storefront (exact origin; no wildcard).
    'https://shop.shanmukiorg.workers.dev',
  ];
  const extraOrigins = env('ADMIN_ALLOWED_ORIGINS').split(',').map(s => s.trim()).filter(Boolean);
  const allowedOrigin = !origin || localOrigin || [...defaultOrigins, ...extraOrigins].includes(origin);
  const url = new URL(req.url);
  const isAdminAction = /^\/admin-(check|payments|orders|customers|categories|category-upsert|category-delete|products|product-upsert|product-delete|image-upload|store-settings|site-content|banners|homepage-sections)$/.test(
    url.pathname.replace(/^.*\/demo-payment-kit/, '')
  );
  // Never expose demo checkout to hosted origins.
  if (!allowedOrigin || (!isAdminAction && !localOrigin))
    return reply({ error: 'Origin not allowed' }, 403);
  if (req.method === 'OPTIONS') return reply({}, 200, origin);
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405, origin);
  const cors = origin;
  try {
    if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_ROLE_KEY')) return reply({ error: 'Demo backend not configured' }, 503, cors);
    const token = req.headers.get('authorization') || '';
    if (!token.startsWith('Bearer ')) return reply({ error: 'Sign in as an approved admin' }, 401, cors);
    const client = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    const { data: auth, error: authError } = await client.auth.getUser(token.slice(7));
    if (authError || !auth.user) return reply({ error: 'Sign in as an approved admin' }, 401, cors);
    const { data: admin, error: adminError } = await client.from('ownpay_payment_admins').select('user_id').eq('user_id', auth.user.id).maybeSingle();
    if (adminError) throw adminError;
    if (!admin) return reply({ error: 'Approved admin access required' }, 403, cors);

    if (url.pathname.endsWith('/admin-check')) return reply({ admin: true, mode: 'demo' }, 200, cors);
    // Curated homepage category collections. The existing approved-admin UID
    // check above is mandatory; public clients have SELECT ONLY through RLS.
    if (url.pathname.endsWith('/admin-homepage-sections')) {
      const raw = await req.text();
      if (raw.length > 6000) return reply({ error: 'Homepage request too large' }, 413, cors);
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw || '{}'); } catch { return reply({ error: 'Invalid JSON' }, 400, cors); }
      if (body.action === 'list') {
        const { data, error } = await client.from('homepage_product_sections')
          .select('section_key,category_slugs,product_limit,updated_at').order('section_key');
        if (error) { console.error('[homepage-sections] read', error.code); return reply({ error: 'Homepage settings unavailable (' + error.code + '). Run the homepage SQL migration.' }, 503, cors); }
        return reply({ sections: data || [] }, 200, cors);
      }
      if (body.action !== 'save') return reply({ error: 'Unknown homepage action' }, 400, cors);
      if (!['featured','bestseller'].includes(String(body.section_key)))
        return reply({ error: 'Invalid homepage section' }, 400, cors);
      if (!Array.isArray(body.category_slugs) || body.category_slugs.length < 1 || body.category_slugs.length > 30 ||
          body.category_slugs.some(s => typeof s !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(s)) ||
          new Set(body.category_slugs).size !== body.category_slugs.length)
        return reply({ error: 'Choose 1 to 30 valid categories' }, 400, cors);
      const limit = Number(body.product_limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 24)
        return reply({ error: 'Product limit must be between 1 and 24' }, 400, cors);
      // Validate all slugs against the current database, not client-side labels.
      const { data: categories, error: categoriesError } = await client.from('categories')
        .select('slug').in('slug', body.category_slugs as string[]);
      if (categoriesError) return reply({ error: 'Could not verify categories' }, 503, cors);
      if (!Array.isArray(categories) || categories.length !== body.category_slugs.length)
        return reply({ error: 'One or more selected categories no longer exist. Refresh the page.' }, 409, cors);
      const record = { section_key: body.section_key, category_slugs: body.category_slugs,
        product_limit: limit, updated_at: new Date().toISOString() };
      const { data, error } = await client.from('homepage_product_sections')
        .upsert(record, { onConflict: 'section_key' })
        .select('section_key,category_slugs,product_limit,updated_at').single();
      if (error) { console.error('[homepage-sections] save', error.code); return reply({ error: 'Homepage settings save failed (' + error.code + ')' }, 500, cors); }
      return reply({ saved: true, section: data }, 200, cors);
    }

    // Approved-admin banner CRUD. All writes are made with the server-only service role.
    // The storefront reads active rows through the separate read-only RLS policy.
    if (url.pathname.endsWith('/admin-banners')) {
      const raw = await req.text();
      if (raw.length > 180000) return reply({ error: 'Banner request too large' }, 413, cors);
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw || '{}'); } catch { return reply({ error: 'Invalid JSON' }, 400, cors); }
      const list = async () => {
        const { data, error } = await client.from('banners').select('slug,title,link,image,position,"order",active')
          .order('order', { ascending: true }).order('slug', { ascending: true });
        if (error) { console.error('[admin-banners] list', error.code); return reply({ error: 'Banners table is not ready. Apply the secure banners SQL migration.' }, 503, cors); }
        return reply({ banners: data || [] }, 200, cors);
      };
      if (body.action === 'list') return await list();
      const validSlug = (v: unknown) => typeof v === 'string' && /^b[a-z0-9-]{1,48}$/i.test(v);
      const validLink = (v: unknown) => typeof v === 'string' && v.length <= 512 &&
        (v === '' || /^(?:[a-z0-9_-]+\.html(?:\?[a-z0-9_=&%-]+)?|https:\/\/[^\s"'<>]+)$/i.test(v));
      const validImage = (v: unknown) => typeof v === 'string' && v.length <= 1600 &&
        (/^assets\/img\/[a-z0-9_./-]+\.(?:png|jpg|jpeg|webp|svg)$/i.test(v) || /^https:\/\/[^\s"'<>]+$/i.test(v));
      const clean = (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const b = value as Record<string, unknown>;
        const slug = String(b.slug || '').toLowerCase();
        const title = safe(b.title, 120);
        const position = String(b.position || '');
        const order = Number(b.order);
        if (!validSlug(slug) || !title || title.length > 120 || /[<>]/.test(title) ||
            !validImage(b.image) || !validLink(b.link) || !['hero', 'promo', 'sidebar'].includes(position) ||
            !Number.isInteger(order) || order < 1 || order > 100 || typeof b.active !== 'boolean') return null;
        return { slug, title, link: b.link || '', image: b.image, position, order, active: b.active,
          updated_at: new Date().toISOString() };
      };
      if (body.action === 'upsert') {
        const item = clean(body.banner);
        if (!item) return reply({ error: 'Invalid banner. Upload the image before saving.' }, 400, cors);
        const { error } = await client.from('banners').upsert(item, { onConflict: 'slug' });
        if (error) { console.error('[admin-banners] upsert', error.code); return reply({ error: 'Could not save banner' }, 500, cors); }
        return reply({ saved: true }, 200, cors);
      }
      if (body.action === 'toggle') {
        if (!validSlug(body.slug) || typeof body.active !== 'boolean') return reply({ error: 'Invalid banner status' }, 400, cors);
        const { data, error } = await client.from('banners').update({ active: body.active, updated_at: new Date().toISOString() })
          .eq('slug', String(body.slug).toLowerCase()).select('slug').maybeSingle();
        if (error || !data) return reply({ error: 'Could not update banner status' }, error ? 500 : 404, cors);
        return reply({ saved: true }, 200, cors);
      }
      if (body.action === 'delete') {
        if (!validSlug(body.slug)) return reply({ error: 'Invalid banner ID' }, 400, cors);
        const { error } = await client.from('banners').delete().eq('slug', String(body.slug).toLowerCase());
        if (error) return reply({ error: 'Could not delete banner' }, 500, cors);
        return reply({ deleted: true }, 200, cors);
      }
      if (body.action === 'import') {
        // Explicit one-time migration from this browser's existing paused/active state.
        if (!Array.isArray(body.banners) || body.banners.length > 50) return reply({ error: 'Invalid import list' }, 400, cors);
        const records = body.banners.map(clean);
        if (records.some(x => !x) || !records.length || new Set(records.map(x => x!.slug)).size !== records.length)
          return reply({ error: 'Invalid import banners or duplicate IDs' }, 400, cors);
        const { error } = await client.from('banners').upsert(records, { onConflict: 'slug' });
        if (error) return reply({ error: 'Could not import banners' }, 500, cors);
        return reply({ imported: records.length }, 200, cors);
      }
      return reply({ error: 'Unknown banners action' }, 400, cors);
    }


    // Existing Auth session + ownpay_payment_admins UID was verified above.
    // A customer with a valid login may NOT publish website changes.
    if (url.pathname.endsWith('/admin-site-content')) {
      const raw = await req.text();
      if (raw.length > 1600000) return reply({ error: 'Website content exceeds 1.6 MB.' }, 413, cors);
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw || '{}'); } catch { return reply({ error: 'Invalid JSON' }, 400, cors); }
      if (body.action === 'read') {
        const { data, error } = await client.from('site_content').select('payload').eq('id', 'global').maybeSingle();
        if (error) return reply({ error: 'Website content table missing. Apply the editor SQL migration.' }, 503, cors);
        return reply({ content: data?.payload ?? null }, 200, cors);
      }
      if (body.action !== 'publish') return reply({ error: 'Unknown website content action' }, 400, cors);
      const payload = body.content;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply({ error: 'Invalid website content' }, 400, cors);
      const value = payload as Record<string, unknown>;
      if (!value.nodes || typeof value.nodes !== 'object' || Array.isArray(value.nodes) ||
          !value.inserts || typeof value.inserts !== 'object' || Array.isArray(value.inserts))
        return reply({ error: 'Invalid document structure' }, 400, cors);
      if (Object.keys(value.nodes as object).length > 1000 || Object.keys(value.inserts as object).length > 75)
        return reply({ error: 'Too many website elements' }, 400, cors);
      const permittedUrl = (v: unknown) => typeof v === 'string' && v.length <= 350000 &&
        (/^https:\/\/[^\s"'<>]+$/.test(v) || /^(?:assets\/img\/|[a-z0-9._/-]+\.html|#|\/)[^\s"'<>]*$/i.test(v) ||
          /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(v));
      for (const [key, record] of Object.entries(value.nodes as Record<string, unknown>)) {
        if (key.length > 1024 || !record || typeof record !== 'object' || Array.isArray(record))
          return reply({ error: 'Invalid content element' }, 400, cors);
        const r = record as Record<string, unknown>;
        if (typeof r.text === 'string' && r.text.length > 4000) return reply({ error: 'Text too long' }, 400, cors);
        for (const field of ['src', 'bg', 'href']) {
          if (r[field] !== undefined && r[field] !== '' && !permittedUrl(r[field]))
            return reply({ error: 'Unsafe image or link' }, 400, cors);
        }
        for (const field of ['bgColor', 'textColor']) {
          if (r[field] !== undefined && r[field] !== '' &&
              (typeof r[field] !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(r[field] as string)))
            return reply({ error: 'Invalid color' }, 400, cors);
        }
      }
      for (const [scope, entries] of Object.entries(value.inserts as Record<string, unknown>)) {
        if (scope.length > 80 || !Array.isArray(entries) || entries.length > 40)
          return reply({ error: 'Too many added elements' }, 400, cors);
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return reply({ error: 'Invalid added element' }, 400, cors);
          const e = entry as Record<string, unknown>;
          if (!['heading', 'text', 'button', 'icon', 'image', 'spacer'].includes(String(e.type)) ||
              (typeof e.text === 'string' && e.text.length > 4000) ||
              (typeof e.src === 'string' && !permittedUrl(e.src)) ||
              (typeof e.href === 'string' && !permittedUrl(e.href)))
            return reply({ error: 'Invalid added element content' }, 400, cors);
        }
      }
      const layout = value.layout;
      if (layout !== undefined) {
        if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return reply({ error: 'Invalid layout' }, 400, cors);
        const l = layout as Record<string, unknown>;
        const ids = ['hero','categories','featured','promos','story','reviews','bestsellers'];
        if (l.homeOrder !== undefined && (!Array.isArray(l.homeOrder) || l.homeOrder.length !== 7 ||
            new Set(l.homeOrder).size !== 7 || l.homeOrder.some(id => !ids.includes(String(id)))))
          return reply({ error: 'Invalid homepage section order' }, 400, cors);
        if (l.promoColumns !== undefined && ![1,2,3].includes(Number(l.promoColumns)))
          return reply({ error: 'Invalid promo layout' }, 400, cors);
        if (l.storyColumns !== undefined && ![1,2,3].includes(Number(l.storyColumns)))
          return reply({ error: 'Invalid story layout' }, 400, cors);
      }
      const stored = { ...value, v: 1, updatedAt: Date.now() };
      const { error } = await client.from('site_content').upsert({ id: 'global', payload: stored, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) return reply({ error: 'Website content could not be published. Apply the editor SQL migration.' }, 503, cors);
      return reply({ published: true, updatedAt: stored.updatedAt }, 200, cors);
    }

    // Central store settings: server-side allowlisted admin only. Public read
    // happens through Supabase RLS; the storefront never receives write access.
    if (url.pathname.endsWith('/admin-store-settings')) {
      const raw = await req.text();
      if (raw.length > 4000) return reply({ error: 'Settings request too large' }, 413, cors);
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw || '{}'); } catch { return reply({ error: 'Invalid JSON' }, 400, cors); }
      if (body.action === 'read') {
        const { data, error } = await client.from('storefront_settings').select('*').eq('id', 1).maybeSingle();
        if (error) return reply({ error: 'Store settings table unavailable. Apply the SQL migration.' }, 503, cors);
        return reply({ settings: data }, 200, cors);
      }
      if (body.action !== 'save' || !body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings))
        return reply({ error: 'Invalid settings action' }, 400, cors);
      const input = body.settings as Record<string, unknown>;
      const name = safe(input.storeName, 121);
      const email = safe(input.storeEmail, 255);
      const phone = safe(input.storePhone, 33);
      const address = safe(input.address, 501);
      const currency = input.currency;
      const taxRate = Number(input.taxRate);
      const min = Number(input.freeShipMin);
      if (!name || name.length > 120 || /[<>]/.test(name + address) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
          !/^[+0-9 ()-]{6,32}$/.test(phone) || !address || address.length > 500 ||
          !['INR', 'USD'].includes(String(currency)) || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100 ||
          !Number.isInteger(min) || min < 0 || min > 10000000 ||
          typeof input.enableCod !== 'boolean' || typeof input.enableOnline !== 'boolean')
        return reply({ error: 'Check store information and shipping settings' }, 400, cors);
      const payload = { id: 1, store_name: name, store_email: email, store_phone: phone,
        address, currency, tax_rate: taxRate, free_ship_min: min,
        enable_cod: input.enableCod, enable_online: input.enableOnline, updated_at: new Date().toISOString() };
      const { data, error } = await client.from('storefront_settings').upsert(payload, { onConflict: 'id' }).select('*').single();
      if (error) { console.error('[admin-store-settings] save', error.code); return reply({ error: 'Could not save store settings' }, 500, cors); }
      return reply({ saved: true, settings: data }, 200, cors);
    }

    // Authenticated and allowlisted admin-only image upload. The browser NEVER
    // receives the service-role key or direct Storage write access.
    if (url.pathname.endsWith('/admin-image-upload')) {
      const raw = await req.text();
      if (raw.length > 7500000) return reply({ error: 'Photo exceeds the 5 MB upload limit.' }, 413, cors);
      let payload: { image?: string };
      try { payload = JSON.parse(raw); } catch { return reply({ error: 'Invalid upload request' }, 400, cors); }
      const match = typeof payload.image === 'string' ?
        /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(payload.image) : null;
      if (!match) return reply({ error: 'Upload a PNG, JPEG or WebP photo' }, 400, cors);
      const mime = `image/${match[1]}`;
      let bytes: Uint8Array;
      try {
        // 5 MiB binary can expand to ~6.99M base64 characters.
        if (match[2].length > Math.ceil(5 * 1024 * 1024 / 3) * 4) {
          return reply({ error: 'Image must be 5 MB or smaller' }, 413, cors);
        }
        const binary = atob(match[2]);
        if (binary.length < 20 || binary.length > 5 * 1024 * 1024) return reply({ error: 'Image must be 5 MB or smaller' }, 413, cors);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      } catch { return reply({ error: 'Invalid image bytes' }, 400, cors); }
      const isPNG = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isJPEG = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const isWebP = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
      if (!((mime === 'image/png' && isPNG) || (mime === 'image/jpeg' && isJPEG) ||
            (mime === 'image/webp' && isWebP))) return reply({ error: 'File is not a valid image' }, 400, cors);
      const extension = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp';
      const path = `${auth.user.id}/${crypto.randomUUID()}.${extension}`;
      const bucket = 'shanmuga-variant-photos';
      const { error: uploadError } = await client.storage.from(bucket).upload(path, bytes, {
        contentType: mime, upsert: false, cacheControl: '31536000'
      });
      if (uploadError) {
        console.error('[admin-image-upload] upload', uploadError);
        return reply({ error: 'Photo upload failed. Ensure the shanmuga-variant-photos bucket exists and is public.' }, 500, cors);
      }
      const { data: publicData } = client.storage.from(bucket).getPublicUrl(path);
      return reply({ url: publicData.publicUrl }, 201, cors);
    }
    // ADMIN PRODUCTS: every request runs AFTER getUser() + ownpay_payment_admins check.
    if (url.pathname.endsWith('/admin-products')) {
      const { data, error } = await client.from('products')
        .select('id,slug,name,category_slug,price,unit,in_stock,image_url,description,mrp,admin_details')
        .order('name', { ascending: true }).limit(500);
      if (error) { console.error('[admin-products] list', error); return reply({ error: 'Could not load products (' + error.code + ')' }, 500, cors); }
      return reply({ products: data || [] }, 200, cors);
    }
    if (url.pathname.endsWith('/admin-product-upsert')) {
      const raw = await req.text();
      if (raw.length > 2600000) return reply({ error: 'Product images are too large. Use at most 5 compressed images.' }, 413, cors);
      let body: { product?: Record<string, unknown>; originalSlug?: string | null };
      try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid product JSON' }, 400, cors); }
      const p = body?.product;
      if (!p || typeof p !== 'object') return reply({ error: 'Missing product' }, 400, cors);
      const name = safe(p.name, 150);
      const slug = safe(p.slug, 90);
      const category_slug = safe(p.cat, 90);
      const unit = safe(p.unit, 60);
      if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category_slug) || !unit)
        return reply({ error: 'Product name, slug, category, and size are required' }, 400, cors);
      const price = Number(p.price);
      const mrp = Number(p.mrp ?? p.price);
      if (!Number.isFinite(price) || price <= 0 || price > 10000000 ||
          !Number.isFinite(mrp) || mrp < 0 || mrp > 10000000)
        return reply({ error: 'Invalid price or MRP' }, 400, cors);
      if (!Array.isArray(p.sizes) || !p.sizes.length || p.sizes.length > 20)
        return reply({ error: 'Provide 1 to 20 size variants' }, 400, cors);
      const sizes: [string, number, number][] = [];
      for (const s of p.sizes) {
        if (!Array.isArray(s) || s.length < 3) return reply({ error: 'Invalid size row' }, 400, cors);
        const label = safe(s[0], 60), cost = Number(s[1]), max = Number(s[2]);
        if (!label || !Number.isFinite(cost) || cost <= 0 || cost > 10000000 ||
            !Number.isFinite(max) || max < 0 || max > 10000000)
          return reply({ error: 'Invalid size price' }, 400, cors);
        sizes.push([label, cost, max]);
      }
      if (sizes[0][0] !== unit || sizes[0][1] !== price || sizes[0][2] !== mrp)
        return reply({ error: 'First size must match primary unit, price and MRP' }, 400, cors);
      const { data: category, error: categoryError } = await client.from('categories')
        .select('id').eq('slug', category_slug).maybeSingle();
      if (categoryError || !category) return reply({ error: 'Category not found in Supabase' }, 400, cors);
      const validImage = (value: unknown) => typeof value === 'string' &&
        value.length <= 420000 &&
        /^(?:data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s]+|assets\/img\/[A-Za-z0-9_./-]+)$/.test(value);
      if (!Array.isArray(p.images) || p.images.length > 5 ||
          p.images.some(item => !validImage(item)) ||
          p.images.reduce((sum: number, item: string) => sum + item.length, 0) > 1900000)
        return reply({ error: 'Please use up to five compressed product images' }, 400, cors);
      const img = typeof p.img === 'string' ? p.img : '';
      if (img && !validImage(img)) return reply({ error: 'Invalid main product image' }, 400, cors);
      const hl = Array.isArray(p.highlights) ? p.highlights : [];
      if (hl.length > 10 || hl.some(item => typeof item !== 'string' || item.length > 200))
        return reply({ error: 'Invalid highlights' }, 400, cors);
      // Tamil text is optional, separately validated, and stored in admin_details JSONB.
      const hlTa = Array.isArray(p.highlights_ta) ? p.highlights_ta : [];
      if (hlTa.length > 10 || hlTa.some(item => typeof item !== 'string' || item.length > 200))
        return reply({ error: 'Invalid Tamil highlights' }, 400, cors);
      // Galleries are stored as URLs in admin_details JSONB rather than
      // base64 blobs. The 5-image legacy gallery limit is not applied here.
      const variantInput = p.variant_images === undefined ? {} : p.variant_images;
      if (!variantInput || typeof variantInput !== 'object' || Array.isArray(variantInput))
        return reply({ error: 'Invalid size galleries' }, 400, cors);
      const variant_images: Record<string, string[]> = {};
      const storagePrefix = env('SUPABASE_URL') + '/storage/v1/object/public/shanmuga-variant-photos/';
      let totalVariantPhotos = 0;
      const allowedSizes = new Set(sizes.map(item => item[0]));
      for (const [label, photos] of Object.entries(variantInput)) {
        if (!allowedSizes.has(label) || !Array.isArray(photos))
          return reply({ error: 'Image gallery belongs to an unknown size' }, 400, cors);
        const urls: string[] = [];
        for (const rawUrl of photos) {
          if (typeof rawUrl !== 'string' || rawUrl.length > 2048 || !rawUrl.startsWith(storagePrefix) ||
              !/^https:\/\/[^\s"'<>]+$/.test(rawUrl))
            return reply({ error: 'Size gallery images must be uploaded through the admin uploader' }, 400, cors);
          if (!urls.includes(rawUrl)) urls.push(rawUrl);
          totalVariantPhotos++;
          if (totalVariantPhotos > 200) return reply({ error: 'Maximum 200 variant photos per product; contact support for bulk galleries' }, 400, cors);
        }
        if (urls.length) variant_images[label] = urls;
      }
      // Per-photo display scale is optional, stored in admin_details only.
      // Require the same number of scales as image URLs for every size.
      const scaleInput = p.variant_image_scales === undefined ? {} : p.variant_image_scales;
      if (!scaleInput || typeof scaleInput !== 'object' || Array.isArray(scaleInput))
        return reply({ error: 'Invalid image size settings' }, 400, cors);
      const variant_image_scales: Record<string, number[]> = {};
      for (const [label, rawScales] of Object.entries(scaleInput)) {
        const photos = variant_images[label] || [];
        if (!allowedSizes.has(label) || !Array.isArray(rawScales) || rawScales.length !== photos.length)
          return reply({ error: 'Image sizes must match uploaded photos for each variant' }, 400, cors);
        const scales = rawScales.map((value: unknown) => Number(value));
        if (scales.some((n: number) => !Number.isInteger(n) || n < 50 || n > 160 || n % 5 !== 0))
          return reply({ error: 'Image size must be 50–160% in 5% steps' }, 400, cors);
        variant_image_scales[label] = scales;
      }
      // Per-size per-photo alignment, not an image upload/transformation.
      // Backwards-compatible defaults for records saved before this feature.
      const positionsInput = p.variant_image_positions === undefined ? {} : p.variant_image_positions;
      if (!positionsInput || typeof positionsInput !== 'object' || Array.isArray(positionsInput))
        return reply({ error: 'Invalid image alignment settings' }, 400, cors);
      const variant_image_positions: Record<string, { x: number; y: number }[]> = {};
      for (const [label, rawPositions] of Object.entries(positionsInput)) {
        const photos = variant_images[label] || [];
        if (!allowedSizes.has(label) || !Array.isArray(rawPositions) || rawPositions.length !== photos.length)
          return reply({ error: 'Image positions must match uploaded photos for each variant' }, 400, cors);
        const positions: { x: number; y: number }[] = [];
        for (const position of rawPositions) {
          if (!position || typeof position !== 'object' || Array.isArray(position) ||
              !Number.isInteger((position as any).x) || !Number.isInteger((position as any).y) ||
              Math.abs((position as any).x) > 50 || Math.abs((position as any).y) > 50)
            return reply({ error: 'Image alignment must be between -50% and 50%' }, 400, cors);
          positions.push({ x: (position as any).x, y: (position as any).y });
        }
        variant_image_positions[label] = positions;
      }
      const rating = Number(p.rating);
      const details = {
        ta: safe(p.ta, 150), badge: safe(p.badge, 80),
        desc_ta: safe(p.desc_ta, 10000), highlights_ta: hlTa.map(item => item.trim()).filter(Boolean),
        images: p.images, img, sizes, variant_images, variant_image_scales, variant_image_positions,
        highlights: hl, rating: Number.isFinite(rating) ? Math.max(1, Math.min(5, rating)) : 4.5,
        reviews: Math.max(0, Math.min(1000000, Number(p.reviews) || 0)),
        custom: p.custom === true
      };
      const payload = { name, slug, category_slug, price, mrp, unit,
        in_stock: p.stock !== false, image_url: img || null,
        description: safe(p.desc, 10000), admin_details: details };
      const columns = 'id,slug,name,category_slug,price,unit,in_stock,image_url,description,mrp,admin_details';
      const originalSlug = safe(body?.originalSlug, 90);
      if (originalSlug) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(originalSlug) || originalSlug !== slug)
          return reply({ error: 'Changing product slugs is not supported' }, 400, cors);
        const { data, error } = await client.from('products').update(payload)
          .eq('slug', originalSlug).select(columns).maybeSingle();
        if (error) { console.error('[admin-products] update', error); return reply({ error: 'Product update failed (' + error.code + ')' }, 500, cors); }
        if (!data) return reply({ error: 'Product not found; refresh the page' }, 404, cors);
        return reply({ product: data }, 200, cors);
      }
      const { data, error } = await client.from('products').insert(payload).select(columns).single();
      if (error) { console.error('[admin-products] insert', error);
        return reply({ error: error.code === '23505' ? 'Product slug already exists' : 'Product insert failed (' + error.code + ')' }, error.code === '23505' ? 409 : 500, cors); }
      return reply({ product: data }, 201, cors);
    }
    if (url.pathname.endsWith('/admin-product-delete')) {
      const raw = await req.text();
      if (raw.length > 1000) return reply({ error: 'Request too large' }, 413, cors);
      let body: { slug?: string };
      try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid JSON' }, 400, cors); }
      const slug = safe(body?.slug, 90);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return reply({ error: 'Invalid product slug' }, 400, cors);
      // Foreign-key constraints protect sold products. Do not cascade-delete order history.
      const { data, error } = await client.from('products').delete().eq('slug', slug).select('id').maybeSingle();
      if (error) { console.error('[admin-products] delete', error);
        return reply({ error: error.code === '23503' ? 'Product has related records and cannot be deleted.' : 'Product delete failed (' + error.code + ')' }, error.code === '23503' ? 409 : 500, cors); }
      if (!data) return reply({ error: 'Product not found; refresh the page' }, 404, cors);
      return reply({ deleted: true, slug }, 200, cors);
    }

    // All category endpoints run after getUser() + ownpay_payment_admins verification.
    // No PUBLIC/anon/authenticated write grant is required on public.categories.
    if (url.pathname.endsWith('/admin-categories')) {
      const { data, error } = await client.from('categories')
        .select('id, name, name_tamil, slug, parent_slug, description, icon, image_url, image_alignment, order_index')
        .order('order_index', { ascending: true }).order('name', { ascending: true }).limit(500);
      if (error) { console.error('[admin-categories] list', error); return reply({ error: 'Could not load categories (' + error.code + ')' }, 500, cors); }
      return reply({ categories: data || [] }, 200, cors);
    }
    if (url.pathname.endsWith('/admin-category-upsert')) {
      const raw = await req.text();
      if (raw.length > 320000) return reply({ error: 'Category image is too large (max 200 KB compressed).' }, 413, cors);
      let body: { category?: Record<string, unknown>; originalSlug?: string | null };
      try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid JSON' }, 400, cors); }
      const incoming = body?.category;
      if (!incoming || typeof incoming !== 'object') return reply({ error: 'Category missing' }, 400, cors);
      const name = safe(incoming.name, 120);
      const slug = safe(incoming.slug, 90);
      const name_tamil = safe(incoming.ta, 150);
      const description = safe(incoming.blurb, 2000);
      // Any saved category may be a parent; database rejects self-links and cycles.
      const parent_slug = incoming.parent_slug == null || incoming.parent_slug === '' ? null : safe(incoming.parent_slug, 90);
      const image_url = typeof incoming.img === 'string' ? incoming.img.trim() : '';
      if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
        return reply({ error: 'Invalid name or slug' }, 400, cors);
      if (parent_slug && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parent_slug) || parent_slug === slug))
        return reply({ error: 'Invalid Parent Category' }, 400, cors);
      if (parent_slug) {
        const { data: parent, error: parentError } = await client.from('categories')
          .select('slug, parent_slug').eq('slug', parent_slug).maybeSingle();
        if (parentError) return reply({ error: 'Could not validate Parent Category' }, 500, cors);
        if (!parent) return reply({ error: 'Selected Parent Category no longer exists' }, 400, cors);
      }
      if (image_url.length > 280000 ||
          (image_url && !/^(data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s]+|assets\/img\/[A-Za-z0-9_./-]+)$/.test(image_url)))
        return reply({ error: 'Invalid or oversized category image' }, 400, cors);
      const inputAlignment = incoming.image_alignment;
      if (inputAlignment !== undefined && (typeof inputAlignment !== 'object' || inputAlignment === null || Array.isArray(inputAlignment)))
        return reply({ error: 'Invalid category image alignment' }, 400, cors);
      const align = inputAlignment as Record<string, unknown> | undefined;
      function alignValue(v: unknown, min: number, max: number, fallback: number): number | null {
        if (v === undefined || v === null || v === '') return fallback;
        if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max) return null;
        return v;
      }
      const scale = alignValue(align?.scale, 50, 160, 100);
      const x = alignValue(align?.x, -50, 50, 0);
      const y = alignValue(align?.y, -50, 50, 0);
      if (scale === null || x === null || y === null) return reply({ error: 'Category image alignment out of range' }, 400, cors);
      const image_alignment = { scale, x, y };
      const payload = { name, name_tamil, description, image_url: image_url || null, image_alignment, parent_slug };
      const originalSlug = safe(body.originalSlug, 90);
      if (originalSlug) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(originalSlug) || slug !== originalSlug)
          return reply({ error: 'Changing existing category slugs is not supported' }, 400, cors);
        const { data, error } = await client.from('categories').update(payload)
          .eq('slug', originalSlug).select('id, name, name_tamil, slug, parent_slug, description, icon, image_url, image_alignment, order_index').maybeSingle();
        if (error) { console.error('[admin-categories] update', error); return reply({ error: error.code === '23514' ? 'Invalid category hierarchy: cannot assign a category under itself or its descendant.' : 'Category update failed (' + error.code + ')' }, error.code === '23514' ? 409 : 500, cors); }
        if (!data) return reply({ error: 'Category not found. Reload and try again.' }, 404, cors);
        return reply({ category: data }, 200, cors);
      }
      const { data: last, error: orderError } = await client.from('categories')
        .select('order_index').order('order_index', { ascending: false }).limit(1);
      if (orderError) { console.error('[admin-categories] order', orderError); return reply({ error: 'Could not determine category order' }, 500, cors); }
      const order_index = (Number(last?.[0]?.order_index) || 0) + 1;
      const { data, error } = await client.from('categories')
        .insert({ ...payload, slug, order_index }).select('id, name, name_tamil, slug, parent_slug, description, icon, image_url, image_alignment, order_index').single();
      if (error) {
        console.error('[admin-categories] insert', error);
        return reply({ error: error.code === '23505' ? 'Category slug already exists' : error.code === '23514' ? 'Invalid category hierarchy (cycle).' : 'Category insert failed (' + error.code + ')' }, error.code === '23505' || error.code === '23514' ? 409 : 500, cors);
      }
      return reply({ category: data }, 201, cors);
    }
    if (url.pathname.endsWith('/admin-category-delete')) {
      const raw = await req.text();
      if (raw.length > 1000) return reply({ error: 'Request too large' }, 413, cors);
      let body: { slug?: string };
      try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid JSON' }, 400, cors); }
      const slug = safe(body?.slug, 90);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return reply({ error: 'Invalid slug' }, 400, cors);
      // Protect categories used in real DB products (not only local browser catalog).
      const { count, error: referenceError } = await client.from('products')
        .select('id', { count: 'exact', head: true }).eq('category_slug', slug);
      if (referenceError) { console.error('[admin-categories] references', referenceError); return reply({ error: 'Could not verify product references' }, 500, cors); }
      if (count && count > 0) return reply({ error: 'This category has ' + count + ' products; move them before deleting.' }, 409, cors);
      const { count: childCount, error: childError } = await client.from('categories')
        .select('id', { count: 'exact', head: true }).eq('parent_slug', slug);
      if (childError) return reply({ error: 'Could not verify Subcategory references' }, 500, cors);
      if (childCount && childCount > 0) return reply({ error: 'This Category has Subcategories. Move or delete them first.' }, 409, cors);
      const { data, error } = await client.from('categories').delete().eq('slug', slug).select('id').maybeSingle();
      if (error) { console.error('[admin-categories] delete', error); return reply({ error: 'Category delete failed (' + error.code + ')' }, 500, cors); }
      if (!data) return reply({ error: 'Category not found. Reload and try again.' }, 404, cors);
      return reply({ deleted: true, slug }, 200, cors);
    }
    if (url.pathname.endsWith('/admin-payments')) {
      const body = await req.text();
      if (body.length > 2000) return reply({ error: 'Request too large' }, 413, cors);
      const page = JSON.parse(body || '{}').page ?? 0;
      if (!Number.isInteger(page) || page < 0 || page > 10000) return reply({ error: 'Invalid page' }, 400, cors);
      const { data, error, count } = await client.from('demo_payment_attempts')
        .select('reference, total, currency, status, snapshot, created_at', { count: 'exact' })
        .order('created_at', { ascending: false }).range(page * 50, page * 50 + 49);
      if (error) throw error;
      return reply({ total: count || 0, payments: (data || []).map(r => ({ reference: r.reference, amount: r.total, currency: r.currency,
        status: 'demo', createdAt: r.created_at, customer: r.snapshot.address, items: r.snapshot.lines })) }, 200, cors);
    }
    if (url.pathname.endsWith('/admin-orders')) {
      const { data, error } = await client.from('orders').select('id, order_number, customer_name, customer_email, customer_phone, user_id, created_at, total, status, payment_method, payment_status, shipping_address, shipping_city, shipping_state, shipping_pincode, order_items(product_name, quantity, price, subtotal)')
        .order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return reply({ orders: data || [] }, 200, cors);
    }
    if (url.pathname.endsWith('/admin-customers')) {
      const { data, error } = await client.from('user_profiles').select('id, full_name, email, phone, default_shipping_address, default_shipping_city, default_shipping_state, default_shipping_pincode, created_at').order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return reply({ customers: data || [] }, 200, cors);
    }
    if (url.pathname.endsWith('/create')) {
      const raw = await req.text();
      if (raw.length > 12000) return reply({ error: 'Request too large' }, 413, cors);
      const input = JSON.parse(raw);
      if (!input || typeof input !== 'object') return reply({ error: 'Invalid demo request' }, 400, cors);
      const address = input.address;
      // Never store real contact details by mistake: require reserved examples.
      // 0000000000 is intentionally unreachable by phone/SMS.
      const demoEmail = safe(address?.email, 200).toLowerCase();
      const demoPhone = safe(address?.phone, 20);
      if (!address || !safe(address.name, 150) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safe(address.email, 200)) ||
        !demoEmail.endsWith('@example.com') || demoPhone !== '0000000000' ||
        !safe(address.state, 100))
        return reply({ error: 'Use an @example.com email and 0000000000 for demo testing only' }, 400, cors);
      if (!['standard', 'express', 'pickup'].includes(input.ship) || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50)
        return reply({ error: 'Invalid demo cart' }, 400, cors);
      if (input.coupon) return reply({ error: 'Discounts are not supported in the demo' }, 400, cors);
      const slugs = input.items.map((i: any) => i?.slug);
      if (slugs.some((s: unknown) => typeof s !== 'string' || !/^[a-z0-9-]{1,90}$/.test(s))) return reply({ error: 'Invalid item' }, 400, cors);
      const { data: products, error: productError } = await client.from('products').select('slug,name,price,unit,in_stock').in('slug', slugs);
      if (productError) throw productError;
      const lines = input.items.map((i: any) => {
        const product = (products || []).find(p => p.slug === i.slug && p.in_stock);
        const price = Number(product?.price);
        if (!product || i.size !== product.unit || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 99 ||
          !Number.isSafeInteger(price) || price <= 0) return null;
        return { slug: product.slug, name: product.name, size: product.unit, price, qty: i.qty, total: price * i.qty };
      });
      if (lines.some((line: unknown) => !line)) return reply({ error: 'Product or size unavailable for demo' }, 400, cors);
      if (new Set(slugs).size !== slugs.length) return reply({ error: 'Duplicate demo item' }, 400, cors);
      const sub = lines.reduce((sum: number, item: any) => sum + item.total, 0);
      const shipping = input.ship === 'pickup' ? 0 : (sub < 999 ? (address.state === 'Tamil Nadu' ? 60 : 90) : 0) + (input.ship === 'express' ? 90 : 0);
      const total = sub + shipping;
      if (!Number.isSafeInteger(total) || total <= 0 || total > 10000000) return reply({ error: 'Invalid demo total' }, 400, cors);
      const reference = 'DEMO-' + crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
      const { error } = await client.from('demo_payment_attempts').insert({ user_id: auth.user.id, reference, total,
        snapshot: { address: { name: safe(address.name, 150), email: safe(address.email, 200), phone: safe(address.phone, 20) },
          lines, ship: input.ship, sub, shipping } });
      if (error) throw error;
      return reply({ status: 'demo', reference, total, message: 'Demo saved. No payment was collected and no real order was created.' }, 200, cors);
    }
    return reply({ error: 'Not found' }, 404, cors);
  } catch (error) {
    console.error('[demo-payment-kit]', error);
    return reply({ error: 'Demo backend unavailable; nothing has been confirmed. Try again later.' }, 503, cors);
  }
});
