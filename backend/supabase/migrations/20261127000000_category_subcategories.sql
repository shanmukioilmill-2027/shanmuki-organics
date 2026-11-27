-- Shanmuki Organics: one-level Main Category -> Subcategory hierarchy.
-- Run once in Supabase SQL Editor BEFORE deploying the updated admin/backend.
-- Adds metadata only. Existing categories and products remain unchanged.
-- Does not change RLS, public grants, authentication, payments, or cart.

BEGIN;
ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS parent_slug TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_parent_slug_fkey' AND conrelid = 'public.categories'::regclass) THEN
    ALTER TABLE public.categories
      ADD CONSTRAINT categories_parent_slug_fkey
      FOREIGN KEY (parent_slug) REFERENCES public.categories(slug)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_parent_not_self_chk' AND conrelid = 'public.categories'::regclass) THEN
    ALTER TABLE public.categories
      ADD CONSTRAINT categories_parent_not_self_chk CHECK (parent_slug IS NULL OR parent_slug <> slug);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_categories_parent_slug ON public.categories(parent_slug);

-- Database-level validation: no grandchildren / cycles, even if another caller writes data.
CREATE OR REPLACE FUNCTION public.enforce_one_level_category_hierarchy()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  parent_of_parent TEXT;
BEGIN
  IF NEW.parent_slug IS NOT NULL THEN
    IF NEW.parent_slug = NEW.slug THEN
      RAISE EXCEPTION 'A category cannot be its own parent' USING ERRCODE='23514';
    END IF;
    SELECT parent_slug INTO parent_of_parent FROM public.categories WHERE slug = NEW.parent_slug;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent category not found' USING ERRCODE='23503';
    END IF;
    IF parent_of_parent IS NOT NULL THEN
      RAISE EXCEPTION 'Only one Subcategory level is allowed' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.categories WHERE parent_slug = NEW.slug) THEN
      RAISE EXCEPTION 'A Main Category with children cannot become a Subcategory' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_categories_one_level_hierarchy ON public.categories;
CREATE TRIGGER trg_categories_one_level_hierarchy
BEFORE INSERT OR UPDATE OF parent_slug, slug ON public.categories
FOR EACH ROW EXECUTE FUNCTION public.enforce_one_level_category_hierarchy();
COMMIT;

-- Verify after migration (no changes):
SELECT slug, name, parent_slug FROM public.categories ORDER BY order_index, name;
