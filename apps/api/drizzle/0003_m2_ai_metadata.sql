CREATE TABLE "ai_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid,
	"person_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" jsonb,
	"result_key" text,
	"dedup_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aj_kind" CHECK (kind in ('stage1', 'facility_normalize', 'encounter_suggest')),
	CONSTRAINT "aj_state" CHECK (state in ('pending', 'running', 'done', 'failed', 'needs_human', 'unsupported')),
	CONSTRAINT "aj_person" CHECK (kind <> 'stage1' or person_id is not null)
);
--> statement-breakpoint
CREATE TABLE "normalization_decision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"prompt_id" text,
	"prompt_version" integer,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nd_kind" CHECK (kind in ('facility', 'encounter')),
	CONSTRAINT "nd_state" CHECK (state in ('proposed', 'confirmed', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "department_raw" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "person_check" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "person_check_ack_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "s1_artifact_key" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "s1_prompt_version" integer;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "grouping_basis" text;--> statement-breakpoint
ALTER TABLE "ai_job" ADD CONSTRAINT "ai_job_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_job" ADD CONSTRAINT "ai_job_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalization_decision" ADD CONSTRAINT "normalization_decision_decided_by_account_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_job_dedup" ON "ai_job" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "idx_ai_job_ready" ON "ai_job" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_normalization_fingerprint" ON "normalization_decision" USING btree ("input_fingerprint");--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "doc_person_check" CHECK (person_check in ('match', 'mismatch', 'unknown'));--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "enc_grouping_basis" CHECK (grouping_basis is null or grouping_basis in ('event_time', 'capture_date_degraded'));