CREATE TABLE `courses` (
  `id` CHAR(36) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `sort_order` INT UNSIGNED NOT NULL,
  `is_system` BOOLEAN NOT NULL DEFAULT FALSE,
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_courses_active_order` (`deleted_at`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `subjects` (
  `id` CHAR(36) NOT NULL,
  `course_id` CHAR(36) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `sort_order` INT UNSIGNED NOT NULL,
  `is_system` BOOLEAN NOT NULL DEFAULT FALSE,
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_subjects_course_order` (`course_id`, `deleted_at`, `sort_order`),
  CONSTRAINT `fk_subjects_course` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

SET @default_course_id = UUID();
INSERT INTO `courses` (`id`, `name`, `sort_order`, `is_system`)
VALUES (@default_course_id, '待整理', 0, TRUE);

SET @default_subject_id = UUID();
INSERT INTO `subjects` (`id`, `course_id`, `name`, `sort_order`, `is_system`)
VALUES (@default_subject_id, @default_course_id, '待整理', 0, TRUE);

ALTER TABLE `materials`
  ADD COLUMN `subject_id` CHAR(36) NULL AFTER `source_sha256`;

UPDATE `materials`
SET `subject_id` = @default_subject_id
WHERE `subject_id` IS NULL;

ALTER TABLE `materials`
  MODIFY COLUMN `subject_id` CHAR(36) NOT NULL,
  ADD KEY `idx_materials_subject_deleted` (`subject_id`, `deleted_at`),
  ADD CONSTRAINT `fk_materials_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`id`);

CREATE TABLE `material_covers` (
  `id` CHAR(36) NOT NULL,
  `material_id` CHAR(36) NOT NULL,
  `original_resource_id` CHAR(36) NOT NULL,
  `thumbnail_resource_id` CHAR(36) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_material_covers_material` (`material_id`),
  UNIQUE KEY `uq_material_covers_original_resource` (`original_resource_id`),
  UNIQUE KEY `uq_material_covers_thumbnail_resource` (`thumbnail_resource_id`),
  CONSTRAINT `fk_material_covers_material` FOREIGN KEY (`material_id`) REFERENCES `materials` (`id`),
  CONSTRAINT `fk_material_covers_original_resource` FOREIGN KEY (`original_resource_id`) REFERENCES `resources` (`id`),
  CONSTRAINT `fk_material_covers_thumbnail_resource` FOREIGN KEY (`thumbnail_resource_id`) REFERENCES `resources` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `review_status_history` (
  `id` CHAR(36) NOT NULL,
  `card_id` CHAR(36) NOT NULL,
  `from_status` ENUM('unassessed', 'mastered', 'familiar', 'effort') NULL,
  `to_status` ENUM('unassessed', 'mastered', 'familiar', 'effort') NOT NULL,
  `changed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `source` ENUM('import', 'review', 'migration', 'restore') NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_review_status_history_card_changed` (`card_id`, `changed_at`),
  KEY `idx_review_status_history_changed` (`changed_at`),
  CONSTRAINT `fk_review_status_history_card` FOREIGN KEY (`card_id`) REFERENCES `cards` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO `review_status_history` (`id`, `card_id`, `from_status`, `to_status`, `changed_at`, `source`)
SELECT UUID(), `id`, NULL, `mastery_status`, CURRENT_TIMESTAMP(3), 'migration'
FROM `cards`;
