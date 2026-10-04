CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"shop" text NOT NULL,
	"item" text NOT NULL,
	"discount" text NOT NULL,
	"category" text,
	"start_date" date,
	"end_date" date NOT NULL,
	"notes" text,
	"image_key" text,
	"redeemed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
