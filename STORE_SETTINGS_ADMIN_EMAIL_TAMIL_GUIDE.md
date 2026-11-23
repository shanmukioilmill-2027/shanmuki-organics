# Shanmuki Organics — Admin Store Information + Admin Login Email

**புதிய Website:** https://shop.shanmukiorg.workers.dev

## என்ன மாற்றப்பட்டுள்ளது?

1. Admin → Settings → Store Information: Store Name, Store Email, Phone, Address மாற்றி **Save Changes** அழுத்தினால் இனிமேல் Supabase `public.storefront_settings` என்ற shared record-ல் சேமிக்கப்படும்.
2. Website frontend-ல் Footer / Header / Contact / Store Locator / Shipping display / தொடர்புடைய static page தகவல்கள் reload செய்யும்போது shared data-வை எடுத்துக்கொள்ளும். Free Shipping Threshold cart-க்கும் பயன்படுத்தப்படும்.
3. Store data frontend-ல் வாசிப்பதற்கு Cloudflare Worker **GET `/api/store-settings`** route சேர்க்கப்பட்டது; public visitors-க்கு read-only. Update கோரிக்கைகளை `demo-payment-kit/admin-store-settings` Edge Function-ல் Supabase Auth + `ownpay_payment_admins` allowlist check செய்த பின்னரே அனுமதிக்கும்.
4. Admin Login page-ல் default-ஆக `shanmukioilmill@gmail.com` email காட்டப்படும். **Password மாற்றப்படவில்லை.**
5. Admin → Settings → General Settings-ன் கீழ் **Change Admin Login Email** என்ற button சேர்க்கப்பட்டுள்ளது. இது Supabase Auth-ல் *signed-in admin* email-ஐ verify செய்து மாற்ற உதவும். இது **Store Email**-இலிருந்து வேறுபட்டது.

## மிக முக்கியமான Deployment வரிசை

### 1. Supabase SQL — ஒரு முறை மட்டும்

- Supabase Dashboard → உங்கள் Project → **SQL Editor** → **New query**.
- கீழேயுள்ள file-ஐத் திறந்து முழு SQL-ஐ paste செய்து **Run**:
  `backend/supabase/migrations/20261123000000_storefront_settings.sql`
- இது தனியான shared data table-ஐ உருவாக்கும்; மற்ற Products/Orders/Customers-ஐ delete செய்யாது.
- முதல் data screenshot-ல் காட்டிய Store Information அடிப்படையில் seed செய்யப்பட்டுள்ளது. Table ஏற்கெனவே இருந்தால் existing row-ஐ overwrite செய்யாது.
- Public visitors-க்கு **SELECT மட்டும்**; UPDATE/INSERT/DELETE privilege இல்லை.

### 2. Supabase Edge Function — deploy தேவை

- `backend/supabase/functions/demo-payment-kit/index.ts` என்ற **முழு updated** file-ஐ, உங்களுடைய deployed `demo-payment-kit` Edge Function உடன் கவனமாக compare செய்து deploy செய்யுங்கள். ஏற்கெனவே production-ல் வேறு மாற்றங்கள் இருந்தால் blind overwrite செய்ய வேண்டாம்.
- புதிய action: `admin-store-settings`.
- Admin Auth + UUID allowlist-ஐ நீக்க வேண்டாம்.
- **Service role key**-ஐ GitHub, frontend, ChatGPT screenshot எதிலும் paste செய்ய வேண்டாம்.
- இந்த function Supabase-ல் deploy ஆகாவிட்டால் Admin Save Changes-ல் error வரும்.

### 3. GitHub / Cloudflare — updated source deploy

- Updated ZIP-ன் source files-ஐ உங்கள் existing GitHub repo-வின் அதே folder paths-ல் copy/overwrite செய்து commit செய்யுங்கள்.
- ZIP-ஐ ஒரே `.zip` file-ஆக repo-வில் upload செய்ய வேண்டாம்.
- `wrangler.jsonc`-ல் Worker name **`shop`** என்பதைக் மாற்ற வேண்டாம்.
- Cloudflare → Workers & Pages → **shop** → Deployments → latest deployment `Ready` என சரிபார்க்கவும்.
- Runtime Variable `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` இரண்டும் முந்தையபடி இருக்கட்டும். Password / OTP settings-ஐ மாற்ற வேண்டாம்.
- Public endpoint test: `https://shop.shanmukiorg.workers.dev/api/store-settings` — ஒரு JSON `settings` object வர வேண்டும்; `503` வந்தால் SQL அல்லது Cloudflare deployment இன்னும் complete ஆகவில்லை.

### 4. Admin Store Information சேமிக்க

- Admin page → Settings → Store Information-ல் சரியான Name, Email, Phone, Address சரிபார்க்கவும்.
- **Save Changes** click செய்து **Saved in Supabase** success message வருவதை உறுதி செய்யவும்.
- வேறு browser / private window-ல் Website-ஐ refresh செய்து Contact, Footer, Store Locator, Shipping பகுதிகளை verify செய்யவும்.
- Offline / DB error ஏற்பட்டால் browser safe fallback காட்டும்; ஆனால் Save success என்று பொய்யாக சொல்லாது.

### 5. Admin உண்மையான Login Email-ஐ மாற்றுவது

- **முக்கியம்:** Admin Login form-ல் புதிய email default காட்டுவது, Supabase Auth account email-ஐ தானாக மாற்றாது. Login screen-ல் new email கொடுத்து பழைய password பயன்படுத்துவதற்கு முன் Supabase account email உண்மையாக மாற்றப்பட வேண்டும்.
- முன்பே login செய்த admin session இருந்தால் Admin → **Settings → General Settings → Admin Login Email** பகுதியில் `shanmukioilmill@gmail.com` இருக்கட்டும்.
- **Change Admin Login Email** click செய்து confirmation அளிக்கவும்.
- Supabase அனுப்பும் email verification link(s)-ஐ முடிக்கவும். Supabase-ல் identity update confirmed ஆனபின்தான் புதிய email மூலம் login செய்யவும்.
- புதிய email மூலம் login ஆகும் வரை தேவைப்பட்டால் பழைய **authorized** admin email-ஐ login form-ல் கைமுறையாக உள்ளிடவும். **Password பழையபடியே இருக்கும்**.
- பழைய user-ஐ delete செய்யவோ `ownpay_payment_admins` allowlist-ஐ மாற்றவோ வேண்டாம். அந்த allowlist user UUID மூலம் தொடர்கிறது.
- New email already another Supabase Auth account என்றால் error வரும்; பயன்படுத்தும் account-க்கு மாற்றாக புதிய unrelated account உருவாக்க வேண்டாம்.

## பாதுகாப்பு / Test குறிப்புகள்

- Browser-ல் Store Settings-ஐ மாற்றும் public endpoint உருவாக்கப்படவில்லை; admin update மட்டுமே செய்கிறது.
- Admin Password code-யில் store செய்யப்படவில்லை, மாற்றப்படவில்லை.
- Maintenance Mode பழைய project-ல் browser-local அமைப்பாகவே உள்ளது; இந்த correction Store Information மற்றும் Payment/Shipping shared record-க்கு மட்டும் பொருந்தும். Payment gateway, tax collection rules இவற்றைத் தானாக மாற்றவில்லை.
- Passed: Storefront Settings unit checks, Cloudflare OTP regression, 32 frontend pages/410 links layout, Wishlist isolation, `npm run build`.
- Existing `npm test` payment UI test `id="syncSupabaseBtn" disabled` என்ற பழைய assertion காரணமாக fail ஆகிறது; இந்த correction-க்கு சம்பந்தமில்லாத issue. Live Supabase integration test செய்யப்படவில்லை.
