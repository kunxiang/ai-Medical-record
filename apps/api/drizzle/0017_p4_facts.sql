CREATE TABLE "medication" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"encounter_id" uuid,
	"client_row_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name_raw" text NOT NULL,
	"generic_name" text,
	"dose_raw" text,
	"dose_value" numeric(30, 12),
	"dose_unit" text,
	"concentration_pct" numeric(12, 6),
	"solute_mass_g" numeric(30, 12),
	"frequency_raw" text,
	"route" text,
	"administration_group" text,
	"group_volume_ml" numeric(30, 12),
	"sequence" integer,
	"administered_at" timestamp with time zone,
	"started_on" date,
	"ended_on" date,
	"origin_capture_document_id" uuid,
	"origin_capture_order" integer,
	"object_sha256" text,
	"logical_page_index" integer,
	"source_bbox" jsonb,
	"current_document_id" uuid,
	"current_page_no" integer,
	"note" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "medication_kind" CHECK (kind in ('prescribed', 'administered')),
	CONSTRAINT "medication_source" CHECK (source in ('manual', 'imported', 'accepted_suggestion')),
	CONSTRAINT "medication_revision" CHECK (revision >= 1),
	CONSTRAINT "medication_required_time" CHECK ((
      kind = 'administered' and administered_at is not null
    ) or (kind = 'prescribed' and started_on is not null)),
	CONSTRAINT "medication_date_order" CHECK (ended_on is null or started_on is null or ended_on >= started_on),
	CONSTRAINT "medication_dose_complete" CHECK ((dose_value is null) = (dose_unit is null)),
	CONSTRAINT "medication_nonnegative" CHECK ((
      dose_value is null or dose_value >= 0
    ) and (concentration_pct is null or concentration_pct between 0 and 100)
      and (solute_mass_g is null or solute_mass_g >= 0)
      and (group_volume_ml is null or group_volume_ml >= 0)),
	CONSTRAINT "medication_sequence_group" CHECK (sequence is null or (sequence >= 1 and administration_group is not null)),
	CONSTRAINT "medication_origin_complete" CHECK ((
      origin_capture_document_id is null and origin_capture_order is null
      and object_sha256 is null and logical_page_index is null and source_bbox is null
      and current_document_id is null and current_page_no is null
    ) or (
      origin_capture_document_id is not null and origin_capture_order >= 1
      and object_sha256 ~ '^[0-9a-f]{64}$' and logical_page_index >= 1
    )),
	CONSTRAINT "medication_current_page" CHECK (current_page_no is null or current_page_no >= 1)
);
--> statement-breakpoint
CREATE TABLE "timeline_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"encounter_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"occurred_on" date,
	"occurred_at" timestamp with time zone,
	"time_precision" text NOT NULL,
	"note" text,
	"origin_capture_document_id" uuid,
	"origin_capture_order" integer,
	"object_sha256" text,
	"logical_page_index" integer,
	"source_bbox" jsonb,
	"current_document_id" uuid,
	"current_page_no" integer,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "timeline_event_kind" CHECK (kind in ('procedure', 'hospitalization', 'symptom', 'change', 'other')),
	CONSTRAINT "timeline_event_precision" CHECK (time_precision in ('date', 'minute', 'unknown')),
	CONSTRAINT "timeline_event_source" CHECK (source in ('manual', 'imported', 'accepted_suggestion')),
	CONSTRAINT "timeline_event_revision" CHECK (revision >= 1),
	CONSTRAINT "timeline_event_time" CHECK ((
      time_precision = 'minute' and occurred_on is not null and occurred_at is not null
    ) or (
      time_precision = 'date' and occurred_on is not null and occurred_at is null
    ) or (
      time_precision = 'unknown' and occurred_on is null and occurred_at is null
    )),
	CONSTRAINT "timeline_event_origin_complete" CHECK ((
      origin_capture_document_id is null and origin_capture_order is null
      and object_sha256 is null and logical_page_index is null and source_bbox is null
      and current_document_id is null and current_page_no is null
    ) or (
      origin_capture_document_id is not null and origin_capture_order >= 1
      and object_sha256 ~ '^[0-9a-f]{64}$' and logical_page_index >= 1
    )),
	CONSTRAINT "timeline_event_current_page" CHECK (current_page_no is null or current_page_no >= 1)
);
--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_current_document_id_document_id_fk" FOREIGN KEY ("current_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_updated_by_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_current_document_id_document_id_fk" FOREIGN KEY ("current_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_updated_by_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_medication_client_row" ON "medication" USING btree ("person_id","client_row_id");--> statement-breakpoint
CREATE INDEX "idx_medication_person_canonical" ON "medication" USING btree ("person_id",COALESCE(("administered_at" at time zone 'UTC')::date, "started_on") desc,"administered_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_medication_origin" ON "medication" USING btree ("origin_capture_document_id","origin_capture_order","logical_page_index");--> statement-breakpoint
CREATE INDEX "idx_timeline_event_person_time" ON "timeline_event" USING btree ("person_id","occurred_on" DESC NULLS LAST,"occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_timeline_event_origin" ON "timeline_event" USING btree ("origin_capture_document_id","origin_capture_order","logical_page_index");