CREATE TABLE `card_review_notes` (
  `card_id` CHAR(36) NOT NULL,
  `note_text` VARCHAR(2000) NOT NULL,
  `ink_json` JSON NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`card_id`),
  CONSTRAINT `fk_card_review_notes_card` FOREIGN KEY (`card_id`) REFERENCES `cards` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `question_review_notes`
  ADD COLUMN `ink_json` JSON NULL AFTER `note_text`;
