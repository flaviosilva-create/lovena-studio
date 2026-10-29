ALTER TABLE public.lovena_orders
  ADD COLUMN IF NOT EXISTS purchase_type text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'lovena_orders_purchase_type_check'
      AND conrelid = 'public.lovena_orders'::regclass
  ) THEN
    ALTER TABLE public.lovena_orders
      ADD CONSTRAINT lovena_orders_purchase_type_check
      CHECK (purchase_type IS NULL OR purchase_type IN ('online', 'online_with_html', 'html_download'));
  END IF;
END $$;
