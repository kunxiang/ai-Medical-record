ALTER TABLE "observation" DROP CONSTRAINT "obs_review_status";--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "obs_review_status" CHECK (review_status in ('confirmed','corrected','machine_verified'));--> statement-breakpoint
-- 机器验证的行没有人类审阅者:reviewed_by 必须为空,否则又是一句假话。
ALTER TABLE "observation" ADD CONSTRAINT "obs_machine_verified_has_no_reviewer" CHECK (review_status <> 'machine_verified' or reviewed_by is null);