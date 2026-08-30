CREATE TABLE "context_answer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question_text" text NOT NULL,
	"question_snapshot" jsonb NOT NULL,
	"answer_type" text NOT NULL,
	"value" jsonb,
	"upload_id" uuid,
	"skipped" boolean DEFAULT false NOT NULL,
	"answered_at" timestamp with time zone,
	"event_on" date,
	"event_at" timestamp with time zone,
	"time_precision" text,
	"event_time_source" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ca_answer_type" CHECK (answer_type in ('choice', 'multi_choice', 'number', 'text', 'date', 'datetime', 'audio', 'photo')),
	CONSTRAINT "ca_time_precision" CHECK (time_precision is null or time_precision in ('date', 'minute', 'unknown')),
	CONSTRAINT "ca_event_time_source" CHECK (event_time_source is null or event_time_source in ('answer_value', 'document_sampled_on', 'session_started_at', 'none')),
	CONSTRAINT "ca_revision" CHECK (revision >= 1),
	CONSTRAINT "ca_value" CHECK ((skipped and value is null and upload_id is null) or not skipped)
);
--> statement-breakpoint
CREATE TABLE "context_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_key" text NOT NULL,
	"client_document_id" text,
	"document_id" uuid,
	"encounter_id" uuid,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"template_hash" text NOT NULL,
	"question_snapshot" jsonb NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "cs_scope_type" CHECK (scope_type in ('document', 'standalone')),
	CONSTRAINT "cs_stage" CHECK (stage in ('onsite', 'same_day', 'anytime')),
	CONSTRAINT "cs_status" CHECK (status in ('active', 'completed')),
	CONSTRAINT "cs_revision" CHECK (revision >= 1),
	CONSTRAINT "cs_scope_key_length" CHECK (char_length(scope_key) between 8 and 64),
	CONSTRAINT "cs_template_hash" CHECK (template_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cs_scope_document" CHECK ((
      scope_type = 'document' and client_document_id is not null and scope_key = client_document_id
    ) or (scope_type = 'standalone' and client_document_id is null))
);
--> statement-breakpoint
CREATE TABLE "context_upload" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"multipart_state" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "context_upload_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "cu_kind" CHECK (kind in ('audio', 'photo')),
	CONSTRAINT "cu_mime" CHECK (mime in ('audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/wav', 'image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "cu_state" CHECK (state in ('prepared', 'uploading', 'finalized', 'expired')),
	CONSTRAINT "cu_byte_size" CHECK (byte_size > 0),
	CONSTRAINT "cu_sha256" CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "context_answer" ADD CONSTRAINT "context_answer_session_id_context_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."context_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_answer" ADD CONSTRAINT "context_answer_upload_id_context_upload_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."context_upload"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_answer" ADD CONSTRAINT "context_answer_updated_by_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_session" ADD CONSTRAINT "context_session_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_session" ADD CONSTRAINT "context_session_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_session" ADD CONSTRAINT "context_session_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_session" ADD CONSTRAINT "context_session_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_session" ADD CONSTRAINT "context_session_updated_by_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_upload" ADD CONSTRAINT "context_upload_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_upload" ADD CONSTRAINT "context_upload_session_id_context_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."context_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_upload" ADD CONSTRAINT "context_upload_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_context_answer_question" ON "context_answer" USING btree ("session_id","question_key");--> statement-breakpoint
CREATE INDEX "idx_context_answer_upload" ON "context_answer" USING btree ("upload_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_context_session_scope" ON "context_session" USING btree ("person_id","scope_type","scope_key","template_id","template_version","stage");--> statement-breakpoint
CREATE INDEX "idx_context_session_pending" ON "context_session" USING btree ("person_id","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_context_session_document" ON "context_session" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_context_upload_session" ON "context_upload" USING btree ("session_id","question_key");