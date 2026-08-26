CREATE TABLE "human_operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "human_operation" ADD CONSTRAINT "human_operation_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;