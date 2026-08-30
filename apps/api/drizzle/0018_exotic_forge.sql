CREATE TABLE "export_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text DEFAULT 'visit_summary' NOT NULL,
	"client_operation_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"source_revision_hash" text NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"input_manifest" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"lease_expires_at" timestamp with time zone,
	"progress" integer DEFAULT 0 NOT NULL,
	"last_error" jsonb,
	"renderer_id" text NOT NULL,
	"renderer_version" text NOT NULL,
	"font_manifest_hash" text NOT NULL,
	"result_key" text,
	"result_sha256" text,
	"result_byte_size" bigint,
	"result_content_hash" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "export_job_kind" CHECK (kind = 'visit_summary'),
	CONSTRAINT "export_job_state" CHECK (state in ('pending','running','done','failed')),
	CONSTRAINT "export_job_attempts" CHECK (attempt >= 0 and max_attempts >= 1),
	CONSTRAINT "export_job_progress" CHECK (progress between 0 and 100),
	CONSTRAINT "export_job_hashes" CHECK (
      request_hash ~ '^[0-9a-f]{64}$'
      and source_revision_hash ~ '^[0-9a-f]{64}$'
      and font_manifest_hash ~ '^[0-9a-f]{64}$'
      and (result_sha256 is null or result_sha256 ~ '^[0-9a-f]{64}$')
      and (result_content_hash is null or result_content_hash ~ '^[0-9a-f]{64}$')
    ),
	CONSTRAINT "export_job_result" CHECK ((
      state <> 'done'
    ) or (
      result_key is not null and result_sha256 is not null
      and result_byte_size is not null and result_content_hash is not null
    ))
);
--> statement-breakpoint
CREATE TABLE "export_share" (
	"id" uuid PRIMARY KEY NOT NULL,
	"export_job_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"client_operation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "export_share_token_hash" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "export_share_request_hash" CHECK (request_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "export_share_access_count" CHECK (access_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_share" ADD CONSTRAINT "export_share_export_job_id_export_job_id_fk" FOREIGN KEY ("export_job_id") REFERENCES "public"."export_job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_share" ADD CONSTRAINT "export_share_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_export_job_operation" ON "export_job" USING btree ("created_by","client_operation_id");--> statement-breakpoint
CREATE INDEX "idx_export_job_ready" ON "export_job" USING btree ("state","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "idx_export_job_person" ON "export_job" USING btree ("person_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_export_share_token" ON "export_share" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_export_share_operation" ON "export_share" USING btree ("created_by","client_operation_id");--> statement-breakpoint
CREATE INDEX "idx_export_share_job" ON "export_share" USING btree ("export_job_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_export_share_expiry" ON "export_share" USING btree ("expires_at");