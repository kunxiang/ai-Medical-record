DROP INDEX "idx_document_person_captured";--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "token_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_document_person_captured" ON "document" USING btree ("person_id","captured_at" DESC NULLS LAST,"id" DESC NULLS LAST);