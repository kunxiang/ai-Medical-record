CREATE TABLE "metric_group" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"preset_origin" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "metric_group_preset_origin" CHECK (preset_origin is null or preset_origin in ('three_high_plus')),
	CONSTRAINT "metric_group_revision" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "metric_group_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"metric_group_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"item_type" text DEFAULT 'series' NOT NULL,
	"concept_code" text NOT NULL,
	"qualifier" text,
	"body_site" text,
	"specimen" text,
	"method" text,
	"device" text,
	"measurement_setting" text,
	"extra_dims" jsonb,
	"result_kind" text NOT NULL,
	"series_selector_hash" text NOT NULL,
	CONSTRAINT "metric_group_item_position" CHECK (position >= 0),
	CONSTRAINT "metric_group_item_type" CHECK (item_type = 'series'),
	CONSTRAINT "metric_group_item_result_kind" CHECK (result_kind in ('measured', 'calculated', 'input_parameter')),
	CONSTRAINT "metric_group_item_selector_hash" CHECK (series_selector_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "metric_group" ADD CONSTRAINT "metric_group_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_group" ADD CONSTRAINT "metric_group_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_group" ADD CONSTRAINT "metric_group_updated_by_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_group_item" ADD CONSTRAINT "metric_group_item_metric_group_id_metric_group_id_fk" FOREIGN KEY ("metric_group_id") REFERENCES "public"."metric_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_metric_group_person_updated" ON "metric_group" USING btree ("person_id","archived_at","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_metric_group_item_position" ON "metric_group_item" USING btree ("metric_group_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_metric_group_item_selector" ON "metric_group_item" USING btree ("metric_group_id","series_selector_hash");