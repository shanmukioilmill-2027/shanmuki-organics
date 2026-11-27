-- Shanmuki Organics: Homepage Featured Products / Best Selling This Month picks.
-- Run ONCE in the correct Supabase project, before deploying the Edge Function/frontend.
-- This creates only a new table; no existing products/categories are modified.
BEGIN;
CREATE TABLE IF NOT EXISTS public.homepage_product_sections (
    section_key text PRIMARY KEY CHECK (section_key IN ('featured','bestseller')),
    -- NULL = unconfigured: preserve the legacy frontend collection until first publish.
    -- Once published, the exact selected categories are stored here.
    category_slugs text[] NULL,
    product_limit integer NOT NULL DEFAULT 4 CHECK (product_limit BETWEEN 1 AND 24),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.homepage_product_sections(section_key, category_slugs, product_limit)
VALUES ('featured', NULL, 4), ('bestseller', NULL, 4)
ON CONFLICT (section_key) DO NOTHING;
-- Anonymous visitors can READ the two public homepage preferences, but cannot write.
ALTER TABLE public.homepage_product_sections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.homepage_product_sections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.homepage_product_sections TO anon, authenticated;
DROP POLICY IF EXISTS homepage_product_sections_public_read ON public.homepage_product_sections;
CREATE POLICY homepage_product_sections_public_read
  ON public.homepage_product_sections FOR SELECT TO anon, authenticated USING (true);
-- All writes must pass the existing approved-admin Supabase Edge Function.
COMMIT;
NOTIFY pgrst, 'reload schema';
