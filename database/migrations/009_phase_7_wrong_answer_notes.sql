CREATE TABLE `question_review_notes` (
  `question_id` CHAR(36) NOT NULL,
  `note_text` VARCHAR(2000) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`question_id`),
  CONSTRAINT `fk_question_review_notes_question` FOREIGN KEY (`question_id`) REFERENCES `questions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `practice_sessions`
  DROP CHECK `chk_practice_sessions_scope`,
  ADD CONSTRAINT `chk_practice_sessions_scope` CHECK (
    (`source` = 'favorite' AND `question_bank_id` IS NULL AND `subject_id` IS NOT NULL AND `question_chapter_id` IS NULL)
    OR (`source` = 'aggregate_wrong' AND `question_bank_id` IS NULL AND `subject_id` IS NOT NULL AND `question_chapter_id` IS NULL)
    OR (`source` <> 'favorite' AND `source` <> 'aggregate_wrong' AND `question_bank_id` IS NOT NULL AND `subject_id` IS NULL)
  );
