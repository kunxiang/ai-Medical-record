CREATE TABLE "account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY NOT NULL,
	"short_id" text NOT NULL,
	"person_id" uuid NOT NULL,
	"encounter_id" uuid,
	"doc_type" text DEFAULT 'unknown' NOT NULL,
	"doc_type_confidence" numeric,
	"page_count" integer NOT NULL,
	"source" text NOT NULL,
	"original_filename" text,
	"captured_at" timestamp with time zone NOT NULL,
	"capture_date" date NOT NULL,
	"sampled_on" date,
	"reported_on" date,
	"collected_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"tested_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"event_time" timestamp with time zone,
	"event_time_source" text,
	"exam_items" jsonb,
	"facility_id" uuid,
	"report_no" text,
	"accession_no" text,
	"visit_no" text,
	"specimen" text,
	"specimen_label" text,
	"panel_name" text,
	"ordering_doctor" text,
	"clinical_diagnosis" text,
	"performed_by" text,
	"verified_by_name" text,
	"report_notes" text,
	"report_notes_source" text DEFAULT 'report_original' NOT NULL,
	"column_set" jsonb,
	"uploaded_by" uuid NOT NULL,
	"status" text NOT NULL,
	"client_document_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_short_id_unique" UNIQUE("short_id"),
	CONSTRAINT "doc_page_count" CHECK (page_count >= 1),
	CONSTRAINT "doc_source" CHECK (source in ('camera', 'album', 'pdf', 'screenshot', 'scan', 'import')),
	CONSTRAINT "doc_status" CHECK (status in ('uploading', 'uploaded', 'needs_person_confirm', 'ready', 'failed')),
	CONSTRAINT "doc_type_enum" CHECK (doc_type in ('lab_report', 'imaging_report', 'prescription', 'discharge_summary', 'pathology', 'outpatient_note', 'checkup_report', 'ecg', 'vaccination', 'infusion_order', 'other', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "document_page" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"page_no" integer NOT NULL,
	"storage_key" text NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"thumb_key" text,
	"page_label" text,
	"capture_order" integer NOT NULL,
	CONSTRAINT "document_page_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "dp_page_no" CHECK (page_no >= 1)
);
--> statement-breakpoint
CREATE TABLE "encounter" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"encounter_type" text NOT NULL,
	"facility_id" uuid,
	"department" text,
	"occurred_on" date NOT NULL,
	"ended_on" date,
	"occurred_at" timestamp with time zone,
	"chief_complaint" text DEFAULT '' NOT NULL,
	"diagnosis_text" text DEFAULT '' NOT NULL,
	"doctor_advice" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enc_type" CHECK (encounter_type in ('outpatient', 'inpatient', 'emergency', 'checkup', 'other'))
);
--> statement-breakpoint
CREATE TABLE "facility" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"slug" text NOT NULL,
	"city" text,
	"level" text
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"name_pinyin" text,
	"birth_date" date NOT NULL,
	"sex_at_birth" text NOT NULL,
	"gender" text,
	"relation_to_owner" text NOT NULL,
	"blood_type" text,
	"allergies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chronic_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "person_slug_unique" UNIQUE("slug"),
	CONSTRAINT "person_sex_at_birth" CHECK (sex_at_birth in ('male', 'female', 'unknown')),
	CONSTRAINT "person_relation" CHECK (relation_to_owner in ('self', 'spouse', 'parent', 'child', 'sibling', 'other'))
);
--> statement-breakpoint
CREATE TABLE "person_access" (
	"account_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_access_account_id_person_id_pk" PRIMARY KEY("account_id","person_id"),
	CONSTRAINT "pa_role" CHECK (role in ('owner', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "person_identifier" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"facility_id" uuid,
	"identifier_type" text NOT NULL,
	"identifier_value" text NOT NULL,
	"scope" text NOT NULL,
	CONSTRAINT "pi_type" CHECK (identifier_type in ('patient_id', 'card_no', 'medical_record_no', 'other')),
	CONSTRAINT "pi_scope" CHECK (scope in ('long_term', 'single_visit'))
);
--> statement-breakpoint
CREATE TABLE "upload_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"doc_short_id" text NOT NULL,
	"person_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"consumed_by_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "upload_batch_doc_short_id_unique" UNIQUE("doc_short_id")
);
--> statement-breakpoint
CREATE TABLE "upload_file" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"incoming_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_file_incoming_key_unique" UNIQUE("incoming_key")
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_uploaded_by_account_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_page" ADD CONSTRAINT "document_page_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_access" ADD CONSTRAINT "person_access_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_access" ADD CONSTRAINT "person_access_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_identifier" ADD CONSTRAINT "person_identifier_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_identifier" ADD CONSTRAINT "person_identifier_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_batch" ADD CONSTRAINT "upload_batch_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_batch" ADD CONSTRAINT "upload_batch_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_batch" ADD CONSTRAINT "upload_batch_consumed_by_document_id_document_id_fk" FOREIGN KEY ("consumed_by_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_file" ADD CONSTRAINT "upload_file_batch_id_upload_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."upload_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_document_idempotency" ON "document" USING btree ("uploaded_by","client_document_id");--> statement-breakpoint
CREATE INDEX "idx_document_person_captured" ON "document" USING btree ("person_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_document_page" ON "document_page" USING btree ("document_id","page_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_person_identifier" ON "person_identifier" USING btree (COALESCE("facility_id", '00000000-0000-0000-0000-000000000000'::uuid),"identifier_type","identifier_value");