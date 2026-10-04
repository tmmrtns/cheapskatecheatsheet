CREATE TABLE price_check_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  subtype TEXT,
  unit_price DOUBLE PRECISION NOT NULL CHECK (unit_price > 0),
  inputs JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX price_check_history_category_created_idx
  ON price_check_history (category, created_at DESC);
