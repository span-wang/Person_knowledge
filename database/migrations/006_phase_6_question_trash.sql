ALTER TABLE `trash_items`
  MODIFY COLUMN `entity_type` ENUM('material', 'chapter', 'section', 'card', 'question_bank', 'question_chapter', 'question') NOT NULL;
