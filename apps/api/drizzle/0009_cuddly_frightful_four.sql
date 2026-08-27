CREATE TABLE "multipart_upload" (
	"id" text PRIMARY KEY NOT NULL,
	"upload_file_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"part_count" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result_sha256" text,
	"result_byte_size" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "mu_part_count" CHECK (part_count >= 2 and part_count <= 10000),
	CONSTRAINT "mu_state" CHECK (state in ('pending', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "upload_file" ADD COLUMN "multipart_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "multipart_upload" ADD CONSTRAINT "multipart_upload_upload_file_id_upload_file_id_fk" FOREIGN KEY ("upload_file_id") REFERENCES "public"."upload_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_multipart_upload_file" ON "multipart_upload" USING btree ("upload_file_id");