CREATE TABLE "concept_alias_decision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"input_fingerprint" text NOT NULL,
	"local_name" text NOT NULL,
	"context" jsonb DEFAULT '{"specimen":null,"method":null}'::jsonb NOT NULL,
	"concept_code" text NOT NULL,
	"display_name" text NOT NULL,
	"catalog_version" text NOT NULL,
	"state" text DEFAULT 'confirmed' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cad_fingerprint" CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cad_state" CHECK (state in ('confirmed', 'superseded')),
	CONSTRAINT "cad_revision" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "observation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"document_id" uuid,
	"encounter_id" uuid,
	"client_row_id" uuid,
	"observed_on" date NOT NULL,
	"observed_at" timestamp with time zone,
	"time_precision" text NOT NULL,
	"date_source" text NOT NULL,
	"local_name" text NOT NULL,
	"concept_code" text,
	"concept_catalog_version" text,
	"loinc_code" text,
	"qualifier" text,
	"body_site" text,
	"extra_dims" jsonb,
	"series_key" text,
	"value_raw" text NOT NULL,
	"value_num" numeric(30, 12),
	"comparator" text,
	"value_text" text,
	"value_dimensions" jsonb,
	"unit_raw" text,
	"unit_ucum" text,
	"value_si" numeric(30, 12),
	"unit_si" text,
	"conversion_version" text,
	"ref_low" numeric(30, 12),
	"ref_high" numeric(30, 12),
	"ref_text" text,
	"ref_unit" text,
	"abnormal_flag_raw" text,
	"abnormal_flag" text,
	"specimen" text,
	"specimen_label" text,
	"method" text,
	"device" text,
	"measurement_setting" text,
	"result_kind" text DEFAULT 'measured' NOT NULL,
	"collected_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"lab_facility_id" uuid,
	"origin_capture_document_id" uuid,
	"origin_capture_order" integer,
	"object_sha256" text,
	"logical_page_index" integer,
	"source_bbox" jsonb,
	"current_document_id" uuid,
	"current_page_no" integer,
	"source" text NOT NULL,
	"source_ref" jsonb,
	"review_status" text NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"consistency_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_derived" boolean DEFAULT false NOT NULL,
	"derived_formula" text,
	"calculation_version" text,
	"derivation_key" text,
	"input_observation_ids" uuid[],
	"input_revision_hash" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "obs_time_precision" CHECK (time_precision in ('date', 'minute', 'unknown')),
	CONSTRAINT "obs_date_source" CHECK (date_source in ('manual', 'document_sampled', 'document_reported')),
	CONSTRAINT "obs_time_consistency" CHECK ((
      time_precision = 'minute' and observed_at is not null
    ) or (time_precision <> 'minute' and observed_at is null)),
	CONSTRAINT "obs_comparator" CHECK (comparator is null or comparator in ('<', '<=', '=', '>=', '>')),
	CONSTRAINT "obs_result_kind" CHECK (result_kind in ('measured', 'calculated', 'input_parameter')),
	CONSTRAINT "obs_source" CHECK (source in ('manual', 'imported', 'accepted_suggestion', 'derived')),
	CONSTRAINT "obs_review_status" CHECK (review_status in ('confirmed', 'corrected')),
	CONSTRAINT "obs_abnormal_flag" CHECK (abnormal_flag is null or abnormal_flag in ('low', 'high', 'critical_low', 'critical_high', 'abnormal', 'normal', 'unknown')),
	CONSTRAINT "obs_revision" CHECK (revision >= 1),
	CONSTRAINT "obs_value_present" CHECK (value_num is not null or value_text is not null or value_dimensions is not null),
	CONSTRAINT "obs_comparator_numeric" CHECK (comparator is null or value_num is not null),
	CONSTRAINT "obs_concept_series" CHECK ((
      concept_code is null and concept_catalog_version is null and loinc_code is null and series_key is null
    ) or (concept_code is not null and concept_catalog_version is not null and series_key is not null)),
	CONSTRAINT "obs_series_key" CHECK (series_key is null or series_key ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "obs_conversion_complete" CHECK ((
      value_si is null and unit_si is null and conversion_version is null
    ) or (value_si is not null and unit_si is not null and conversion_version is not null)),
	CONSTRAINT "obs_origin_complete" CHECK ((
      origin_capture_document_id is null and origin_capture_order is null
      and object_sha256 is null and logical_page_index is null and source_bbox is null
      and current_document_id is null and current_page_no is null
    ) or (
      origin_capture_document_id is not null and origin_capture_order >= 1
      and object_sha256 ~ '^[0-9a-f]{64}$' and logical_page_index >= 1
    )),
	CONSTRAINT "obs_current_page" CHECK (current_page_no is null or current_page_no >= 1),
	CONSTRAINT "obs_derived_fields" CHECK ((
      not is_derived
    ) or (
      source = 'derived' and derived_formula is not null and calculation_version is not null
      and derivation_key ~ '^[0-9a-f]{64}$' and input_observation_ids is not null
      and cardinality(input_observation_ids) > 0 and input_revision_hash ~ '^[0-9a-f]{64}$'
    ))
);
--> statement-breakpoint
ALTER TABLE "concept_alias_decision" ADD CONSTRAINT "concept_alias_decision_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_alias_decision" ADD CONSTRAINT "concept_alias_decision_decided_by_account_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_lab_facility_id_facility_id_fk" FOREIGN KEY ("lab_facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_current_document_id_document_id_fk" FOREIGN KEY ("current_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_reviewed_by_account_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_updated_by_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_concept_alias_active" ON "concept_alias_decision" USING btree ("person_id","input_fingerprint") WHERE "concept_alias_decision"."state" = 'confirmed';--> statement-breakpoint
CREATE INDEX "idx_concept_alias_person" ON "concept_alias_decision" USING btree ("person_id","local_name","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_observation_client_row" ON "observation" USING btree ("person_id","client_row_id") WHERE "observation"."client_row_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_observation_person_concept_time" ON "observation" USING btree ("person_id","concept_code","observed_on" DESC NULLS LAST,"observed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_observation_person_review" ON "observation" USING btree ("person_id","archived_at","review_status","id");--> statement-breakpoint
CREATE INDEX "idx_observation_series_time" ON "observation" USING btree ("person_id","concept_code","series_key","observed_on" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_observation_origin" ON "observation" USING btree ("origin_capture_document_id","origin_capture_order","logical_page_index");--> statement-breakpoint
CREATE INDEX "idx_observation_mapping_inbox" ON "observation" USING btree ("person_id","local_name","id") WHERE "observation"."concept_code" is null and "observation"."archived_at" is null;