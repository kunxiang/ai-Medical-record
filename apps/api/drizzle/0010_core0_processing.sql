CREATE TABLE "operation_ledger" (
	"account_id" uuid NOT NULL,
	"client_operation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"person_id" uuid,
	"request_hash" text NOT NULL,
	"request" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operation_ledger_account_id_client_operation_id_pk" PRIMARY KEY("account_id","client_operation_id")
);
--> statement-breakpoint
CREATE TABLE "processing_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"capability" text NOT NULL,
	"target_plugin_id" text NOT NULL,
	"target_plugin_version" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"person_id" uuid,
	"input_revision" integer DEFAULT 0 NOT NULL,
	"input_sha256" text NOT NULL,
	"run_generation" integer DEFAULT 0 NOT NULL,
	"dedup_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"lease_expires_at" timestamp with time zone,
	"result_key" text,
	"result_sha256" text,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pj_capability" CHECK (capability in ('document_metadata_suggest', 'facility_suggest', 'encounter_suggest', 'transcribe_audio', 'observation_suggest', 'semantic_embed')),
	CONSTRAINT "pj_subject_type" CHECK (subject_type in ('document', 'context_answer', 'person', 'family')),
	CONSTRAINT "pj_state" CHECK (state in ('pending', 'running', 'done', 'failed', 'needs_human', 'unsupported')),
	CONSTRAINT "pj_attempts" CHECK (attempt >= 0 and max_attempts >= 1),
	CONSTRAINT "pj_generation" CHECK (input_revision >= 0 and run_generation >= 0),
	CONSTRAINT "pj_person_scope" CHECK ((subject_type = 'family' and person_id is null) or (subject_type <> 'family' and person_id is not null))
);
--> statement-breakpoint
CREATE TABLE "processing_plugin" (
	"plugin_id" text PRIMARY KEY NOT NULL,
	"plugin_version" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_suggestion" (
	"id" uuid PRIMARY KEY NOT NULL,
	"capability" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"person_id" uuid,
	"input_revision" integer NOT NULL,
	"input_sha256" text NOT NULL,
	"payload" jsonb NOT NULL,
	"plugin_id" text NOT NULL,
	"plugin_version" text NOT NULL,
	"provider" text,
	"model" text,
	"prompt_id" text,
	"prompt_version" text,
	"artifact_key" text,
	"artifact_sha256" text,
	"state" text DEFAULT 'proposed' NOT NULL,
	"accepted_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ps_capability" CHECK (capability in ('document_metadata_suggest', 'facility_suggest', 'encounter_suggest', 'transcribe_audio', 'observation_suggest', 'semantic_embed')),
	CONSTRAINT "ps_subject_type" CHECK (subject_type in ('document', 'context_answer', 'person', 'family')),
	CONSTRAINT "ps_state" CHECK (state in ('proposed', 'partially_accepted', 'accepted', 'rejected', 'superseded')),
	CONSTRAINT "ps_revision" CHECK (input_revision >= 0),
	CONSTRAINT "ps_person_scope" CHECK ((subject_type = 'family' and person_id is null) or (subject_type <> 'family' and person_id is not null))
);
--> statement-breakpoint
ALTER TABLE "operation_ledger" ADD CONSTRAINT "operation_ledger_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_ledger" ADD CONSTRAINT "operation_ledger_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_suggestion" ADD CONSTRAINT "processing_suggestion_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_operation_ledger_subject" ON "operation_ledger" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "idx_operation_ledger_person" ON "operation_ledger" USING btree ("person_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_processing_job_dedup" ON "processing_job" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "idx_processing_job_ready" ON "processing_job" USING btree ("state","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "idx_processing_job_target" ON "processing_job" USING btree ("target_plugin_id","target_plugin_version","state");--> statement-breakpoint
CREATE INDEX "idx_processing_job_person" ON "processing_job" USING btree ("person_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_processing_plugin_heartbeat" ON "processing_plugin" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_processing_suggestion_input" ON "processing_suggestion" USING btree ("capability","subject_type","subject_id","plugin_id","plugin_version","input_sha256");--> statement-breakpoint
CREATE INDEX "idx_processing_suggestion_person" ON "processing_suggestion" USING btree ("person_id","state","created_at" DESC NULLS LAST);