-- Shanmuki Organics v17 — publish individually chosen product cards on home.
-- Requires v16 homepage_product_sections migration already applied.
-- Back up production database and verify current project before running.
-- Existing category-based selections stay live until Admin saves new picks.
BEGIN;
ALTER TABLE public.homepage_product_sections
  ADD COLUMN IF NOT EXISTS product_slugs text[] NULL;
-- v16 limited every section to 24 cards; keep Featured exactly four on
-- publication, but let Best Selling display as many checked items (max 200).
ALTER TABLE public.homepage_product_sections
  DROP CONSTRAINT IF EXISTS homepage_product_sections_product_limit_check;
ALTER TABLE public.homepage_product_sections
  ADD CONSTRAINT homepage_product_sections_product_limit_check
    CHECK (product_limit BETWEEN 1 AND 200);
ALTER TABLE public.homepage_product_sections
  DROP CONSTRAINT IF EXISTS homepage_product_sections_product_slugs_check;
ALTER TABLE public.homepage_product_sections
  ADD CONSTRAINT homepage_product_sections_product_slugs_check
    CHECK (product_slugs IS NULL OR
      (section_key = 'featured' AND cardinality(product_slugs) = 4) OR
      (section_key = 'bestseller' AND cardinality(product_slugs) BETWEEN 1 AND 200));
-- Do not add public UPDATE / INSERT policies. Approved admin writes only.
COMMIT;
NOTIFY pgrst, 'reload schema';
