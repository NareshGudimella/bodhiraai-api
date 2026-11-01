ALTER TABLE "announcements" DROP CONSTRAINT "announcements_created_by_foreign";
--> statement-breakpoint
ALTER TABLE "assignment_submissions" DROP CONSTRAINT "assignment_submissions_graded_by_foreign";
--> statement-breakpoint
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_subject_id_foreign";
--> statement-breakpoint
ALTER TABLE "attendance" DROP CONSTRAINT "attendance_marked_by_foreign";
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_school_id_foreign";
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_user_id_foreign";
--> statement-breakpoint
ALTER TABLE "blog_posts" DROP CONSTRAINT "blog_posts_author_id_foreign";
--> statement-breakpoint
ALTER TABLE "blog_posts" DROP CONSTRAINT "blog_posts_blog_category_id_foreign";
--> statement-breakpoint
ALTER TABLE "class_subject" DROP CONSTRAINT "class_subject_teacher_id_foreign";
--> statement-breakpoint
ALTER TABLE "classes" DROP CONSTRAINT "classes_class_teacher_id_foreign";
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_payment_id_foreign";
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_school_id_foreign";
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_subscription_id_foreign";
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_user_id_foreign";
--> statement-breakpoint
ALTER TABLE "live_classes" DROP CONSTRAINT "live_classes_class_id_foreign";
--> statement-breakpoint
ALTER TABLE "live_classes" DROP CONSTRAINT "live_classes_school_id_foreign";
--> statement-breakpoint
ALTER TABLE "live_classes" DROP CONSTRAINT "live_classes_subject_id_foreign";
--> statement-breakpoint
ALTER TABLE "live_classes" DROP CONSTRAINT "live_classes_syllabus_id_foreign";
--> statement-breakpoint
ALTER TABLE "media" DROP CONSTRAINT "media_media_folder_id_foreign";
--> statement-breakpoint
ALTER TABLE "quizzes" DROP CONSTRAINT "quizzes_chapter_id_foreign";
--> statement-breakpoint
ALTER TABLE "quizzes" DROP CONSTRAINT "quizzes_created_by_foreign";
--> statement-breakpoint
ALTER TABLE "quizzes" DROP CONSTRAINT "quizzes_subject_id_foreign";
--> statement-breakpoint
ALTER TABLE "subjects" DROP CONSTRAINT "subjects_syllabus_id_foreign";
--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_source_payment_id_foreign";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "1";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_syllabus_id_foreign";
--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_foreign" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_graded_by_foreign" FOREIGN KEY ("graded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_subject_id_foreign" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_marked_by_foreign" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_school_id_foreign" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_author_id_foreign" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_blog_category_id_foreign" FOREIGN KEY ("blog_category_id") REFERENCES "public"."blog_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_subject" ADD CONSTRAINT "class_subject_teacher_id_foreign" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_class_teacher_id_foreign" FOREIGN KEY ("class_teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_id_foreign" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_school_id_foreign" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_foreign" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_classes" ADD CONSTRAINT "live_classes_class_id_foreign" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_classes" ADD CONSTRAINT "live_classes_school_id_foreign" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_classes" ADD CONSTRAINT "live_classes_subject_id_foreign" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_classes" ADD CONSTRAINT "live_classes_syllabus_id_foreign" FOREIGN KEY ("syllabus_id") REFERENCES "public"."syllabi"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_media_folder_id_foreign" FOREIGN KEY ("media_folder_id") REFERENCES "public"."media_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_chapter_id_foreign" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_created_by_foreign" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_subject_id_foreign" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_syllabus_id_foreign" FOREIGN KEY ("syllabus_id") REFERENCES "public"."syllabi"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_source_payment_id_foreign" FOREIGN KEY ("source_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "1" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_syllabus_id_foreign" FOREIGN KEY ("syllabus_id") REFERENCES "public"."syllabi"("id") ON DELETE set null ON UPDATE no action;