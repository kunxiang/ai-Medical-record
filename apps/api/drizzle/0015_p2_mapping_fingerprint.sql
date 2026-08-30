DROP INDEX "idx_observation_mapping_inbox";--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "mapping_fingerprint" text NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_observation_mapping_inbox" ON "observation" USING btree ("person_id","mapping_fingerprint","id") WHERE "observation"."concept_code" is null and "observation"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "obs_mapping_fingerprint" CHECK (mapping_fingerprint ~ '^[0-9a-f]{64}$');