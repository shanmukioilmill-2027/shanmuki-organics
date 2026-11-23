# Shanmuki Organics — Cloudflare Admin Login CORS Fix

## பிரச்சினை

புதிய website URL: `https://shop.shanmukiorg.workers.dev`

Admin Login நேரடியாக Supabase Edge Function-க்கு request அனுப்புகிறது:
`/functions/v1/demo-payment-kit/admin-check`.

இந்த function-ல் அனுமதிக்கப்பட்ட web origins பட்டியலில் பழைய Netlify/GitHub origins மட்டுமே இருந்தன. அதனால் புதிய Cloudflare domain-இலிருந்து browser அனுப்பும் **OPTIONS (CORS preflight)** request தடுக்கப்படலாம். Browser அதை network failure போல காட்டி `Cannot reach the admin backend` என்று தெரிவிக்கிறது.

**எச்சரிக்கை:** இதுவே live error-க்கான ஒரே காரணம் என்று browser Network tab / Edge Function logs இல்லாமல் உறுதிப்படுத்த முடியாது. Function deploy ஆகாமல் இருந்தாலும் இதே error வரலாம்.

## உடனடி வழி: Supabase-ல் Allowed Origin சேர்த்தல்

1. Supabase Dashboard > உங்கள் project > **Edge Functions** > **Secrets** (அல்லது **Edge Function Secrets**) திறக்கவும்.
2. `ADMIN_ALLOWED_ORIGINS` என்ற key ஏற்கெனவே இருந்தால், அதன் value-ல் உள்ள மற்ற domains-ஐ அழிக்காமல் comma `,` மூலம் கீழே உள்ள exact origin-ஐச் சேர்க்கவும். இல்லையென்றால் புதிய key/value சேர்க்கவும்.

   Key: `ADMIN_ALLOWED_ORIGINS`
   Value: `https://shop.shanmukiorg.workers.dev`

   `https://` அவசியம்; இறுதியில் `/` சேர்க்க வேண்டாம்.
3. **Save** செய்யவும். ஏற்கெனவே deploy செய்யப்பட்ட function இந்த environment variable-ஐப் படிக்கிறதென்றால், **Cloudflare redeploy தேவையில்லை**.
4. Admin Login page reload செய்து, சரியான account மூலம் Sign In செய்யவும். Admin permission இல்லாத user-க்கு அனுமதி கிடைக்காது.

## Source-code fix (இந்த ZIP-ல் சேர்க்கப்பட்டுள்ளது)

`backend/supabase/functions/demo-payment-kit/index.ts`-ல் `defaultOrigins` பட்டியலில் இந்த domain-ஐயும் சேர்த்துள்ளோம்:

```ts
'https://shop.shanmukiorg.workers.dev',
```

இந்த file-ஐ GitHub-ல் commit செய்வது மட்டும் **Supabase Edge Function-ஐ deploy செய்யாது**.
Source code fix-ஐ live-ல் பயன்படுத்த, Supabase Dashboard > Edge Functions > `demo-payment-kit` > Code > Deploy updates, **அல்லது** Supabase CLI மூலம் `demo-payment-kit` function-ஐத் தனியாக deploy செய்ய வேண்டும். Cloudflare deployment மாற்ற வேண்டாம்.

இந்த source patch `ADMIN_ALLOWED_ORIGINS` முறையுடன் இணைந்து இயங்கும்; எல்லா domains-க்கும் `*` அனுமதி தரப்படவில்லை.

## இதற்குப் பிறகும் error வந்தால்

- Supabase > **Edge Functions**-ல் `demo-payment-kit` function உண்மையாக deploy செய்யப்பட்டிருக்கிறதா பார்க்கவும். இல்லையென்றால் original Edge Function source-ஐ deploy செய்ய வேண்டும்.
- Function > **Invocations / Logs**-ல் request/error பார்க்கவும்.
- Browser > DevTools > Network-ல் `demo-payment-kit/admin-check` request-ஐ பார்க்கவும்:
  - `403` / CORS: Allowed origin அல்லது function permissions சரிபார்க்கவும்.
  - `404`: Edge Function deployment / URL சரிபார்க்கவும்.
  - `401`: Supabase Auth session சரிபார்க்கவும்.
  - `503`: Supabase Function runtime configuration சரிபார்க்கவும்.
- Login succeeds but `Approved admin access required` என்றால் Supabase table `ownpay_payment_admins`-ல் அந்த authenticated user's ID approved admin-ஆக உள்ளதா, **authorized admin மூலம் மட்டும்** verify செய்யவும்.

## Security

- Browser / GitHub / Cloudflare Build Variables-ல் **service-role key** போட வேண்டாம்.
- CORS மட்டும் security அல்ல. Backend `getUser()` + `ownpay_payment_admins` check-ஐ மாற்றவில்லை.
- `ADMIN_ALLOWED_ORIGINS` value என்பது website URL (public); password/API secret அல்ல.
- Password, OTP, tokens, service-role key உள்ள screenshots பகிர வேண்டாம்.

## Testing

`node --experimental-strip-types tools/admin-edge-cors.test.mjs`

இந்த test புதிய domain preflight-ஐ ஏற்கிறதா, unknown origins-ஐ மறுக்கிறதா, unauthenticated admin access அனுமதிக்கப்படவில்லையா என்று source handler-ஐ mock செய்து சோதிக்கிறது. **Live Supabase deployment சோதனை செய்யப்படவில்லை.**
