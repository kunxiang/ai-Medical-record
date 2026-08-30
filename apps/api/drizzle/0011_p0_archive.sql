CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "document_manual_metadata" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"doc_type" text,
	"sampled_on" date,
	"reported_on" date,
	"facility_id" uuid,
	"facility_name_raw" text,
	"department" text,
	"title" text,
	"note" text,
	"field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dmm_doc_type" CHECK (doc_type is null or doc_type in ('lab_report', 'imaging_report', 'prescription', 'discharge_summary', 'pathology', 'outpatient_note', 'checkup_report', 'ecg', 'vaccination', 'infusion_order', 'other', 'unknown')),
	CONSTRAINT "dmm_revision" CHECK (revision >= 1),
	CONSTRAINT "dmm_facility_name_length" CHECK (facility_name_raw is null or char_length(facility_name_raw) <= 300),
	CONSTRAINT "dmm_department_length" CHECK (department is null or char_length(department) <= 200),
	CONSTRAINT "dmm_title_length" CHECK (title is null or char_length(title) <= 300),
	CONSTRAINT "dmm_note_length" CHECK (note is null or char_length(note) <= 4000)
);
--> statement-breakpoint
CREATE TABLE "search_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"document_id" uuid,
	"occurred_on" date,
	"sort_at" timestamp with time zone,
	"title" text NOT NULL,
	"core_body" text DEFAULT '' NOT NULL,
	"assist_body" text,
	"source_revision_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_entity_type" CHECK (entity_type in ('document', 'encounter', 'context_answer', 'observation', 'medication', 'timeline_event'))
);
--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_manual_metadata" ADD CONSTRAINT "document_manual_metadata_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_manual_metadata" ADD CONSTRAINT "document_manual_metadata_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_manual_metadata" ADD CONSTRAINT "document_manual_metadata_updated_by_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_entry" ADD CONSTRAINT "search_entry_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_entry" ADD CONSTRAINT "search_entry_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_dmm_sampled" ON "document_manual_metadata" USING btree ("sampled_on","document_id");--> statement-breakpoint
CREATE INDEX "idx_dmm_reported" ON "document_manual_metadata" USING btree ("reported_on","document_id");--> statement-breakpoint
CREATE INDEX "idx_dmm_facility" ON "document_manual_metadata" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_search_entry_entity" ON "search_entry" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_search_entry_person_sort" ON "search_entry" USING btree ("person_id","sort_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_search_entry_person_type_sort" ON "search_entry" USING btree ("person_id","entity_type","sort_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_search_entry_title_trgm" ON "search_entry" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_search_entry_core_trgm" ON "search_entry" USING gin ("core_body" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_updated_by_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_document_person_capture_date" ON "document" USING btree ("person_id","capture_date" DESC NULLS LAST,"captured_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_document_person_sampled" ON "document" USING btree ("person_id","sampled_on" DESC NULLS LAST,"captured_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_document_person_reported" ON "document" USING btree ("person_id","reported_on" DESC NULLS LAST,"captured_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_document_encounter" ON "document" USING btree ("encounter_id","captured_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_encounter_person_occurred" ON "encounter" USING btree ("person_id","occurred_on" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "enc_revision" CHECK (revision >= 1);
