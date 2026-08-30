ALTER TABLE "document_page" ADD COLUMN "origin_capture_document_id" uuid;--> statement-breakpoint
ALTER TABLE "document_page" ADD COLUMN "origin_capture_order" integer;--> statement-breakpoint
ALTER TABLE "document_page" ADD COLUMN "origin_object_sha256" text;--> statement-breakpoint
UPDATE "document_page"
SET "origin_capture_document_id" = "document_id",
    "origin_capture_order" = "capture_order",
    "origin_object_sha256" = "content_sha256";--> statement-breakpoint
ALTER TABLE "document_page" ALTER COLUMN "origin_capture_document_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_page" ALTER COLUMN "origin_capture_order" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_page" ALTER COLUMN "origin_object_sha256" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_document_page_origin" ON "document_page" USING btree ("origin_capture_document_id","origin_capture_order","origin_object_sha256");--> statement-breakpoint
ALTER TABLE "document_page" ADD CONSTRAINT "dp_origin_capture_order" CHECK (origin_capture_order >= 1);--> statement-breakpoint
ALTER TABLE "document_page" ADD CONSTRAINT "dp_origin_object_sha" CHECK (origin_object_sha256 ~ '^[0-9a-f]{64}$');
