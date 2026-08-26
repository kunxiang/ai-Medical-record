ALTER TABLE "document" DROP CONSTRAINT "doc_page_count";--> statement-breakpoint
ALTER TABLE "document" DROP CONSTRAINT "doc_source";--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "doc_page_count" CHECK (page_count >= 0);--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "doc_source" CHECK (source in ('camera', 'album', 'pdf', 'screenshot', 'scan', 'import', 'split'));