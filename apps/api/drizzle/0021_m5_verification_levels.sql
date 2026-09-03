ALTER TABLE "observation" DROP CONSTRAINT "obs_review_status";--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "obs_review_status" CHECK (review_status in ('confirmed','corrected','machine_verified','unverified','check_failed'));--> statement-breakpoint
-- 机器产生的三种状态都不能挂人类审阅者,否则又是替用户签字。
ALTER TABLE "observation" DROP CONSTRAINT "obs_machine_verified_has_no_reviewer";--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "obs_machine_status_has_no_reviewer" CHECK (review_status not in ('machine_verified','unverified','check_failed') or reviewed_by is null);