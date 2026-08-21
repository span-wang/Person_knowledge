ALTER TABLE `questions`
  ADD COLUMN `is_favorite` TINYINT(1) NOT NULL DEFAULT 0 AFTER `knowledge_points_json`,
  ADD KEY `idx_questions_favorite` (`is_favorite`, `deleted_at`, `question_bank_id`, `sort_order`);

ALTER TABLE `practice_sessions`
  MODIFY COLUMN `question_bank_id` CHAR(36) NULL,
  ADD COLUMN `subject_id` CHAR(36) NULL AFTER `question_bank_id`,
  MODIFY COLUMN `source` ENUM('full', 'current_wrong', 'aggregate_wrong', 'favorite') NOT NULL DEFAULT 'full',
  ADD KEY `idx_practice_sessions_subject_status` (`subject_id`, `status`, `started_at`),
  ADD CONSTRAINT `fk_practice_sessions_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`id`),
  ADD CONSTRAINT `chk_practice_sessions_scope` CHECK (
    (`source` = 'favorite' AND `question_bank_id` IS NULL AND `subject_id` IS NOT NULL AND `question_chapter_id` IS NULL)
    OR (`source` <> 'favorite' AND `question_bank_id` IS NOT NULL AND `subject_id` IS NULL)
  );
