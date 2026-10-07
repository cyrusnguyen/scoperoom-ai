-- Data 03 "Reset and project lifecycle": current-project display counters never rewind or reuse ids, including across draft reset.
ALTER TABLE "app"."project"
  ADD COLUMN "requirement_display_sequence" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "project_requirement_display_sequence_range" CHECK ("requirement_display_sequence" BETWEEN 0 AND 999999999);
GRANT UPDATE ("requirement_display_sequence") ON "app"."project" TO app_web;
