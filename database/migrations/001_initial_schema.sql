CREATE TABLE `materials` (
  `id` CHAR(36) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `source_filename` VARCHAR(255) NOT NULL,
  `source_sha256` CHAR(64) NOT NULL,
  `imported_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_materials_source_sha256` (`source_sha256`),
  KEY `idx_materials_deleted_at` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `chapters` (
  `id` CHAR(36) NOT NULL,
  `material_id` CHAR(36) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `sort_order` INT UNSIGNED NOT NULL,
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_chapters_material_order` (`material_id`, `sort_order`),
  CONSTRAINT `fk_chapters_material` FOREIGN KEY (`material_id`) REFERENCES `materials` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `sections` (
  `id` CHAR(36) NOT NULL,
  `chapter_id` CHAR(36) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `sort_order` INT UNSIGNED NOT NULL,
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_sections_chapter_order` (`chapter_id`, `sort_order`),
  CONSTRAINT `fk_sections_chapter` FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cards` (
  `id` CHAR(36) NOT NULL,
  `section_id` CHAR(36) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `content_json` JSON NOT NULL,
  `mastery_status` ENUM('unassessed', 'mastered', 'familiar', 'effort') NOT NULL DEFAULT 'unassessed',
  `sort_order` INT UNSIGNED NOT NULL,
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_cards_section_order` (`section_id`, `sort_order`),
  KEY `idx_cards_mastery_status` (`mastery_status`),
  CONSTRAINT `fk_cards_section` FOREIGN KEY (`section_id`) REFERENCES `sections` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `resources` (
  `id` CHAR(36) NOT NULL,
  `relative_path` VARCHAR(512) NOT NULL,
  `mime_type` VARCHAR(100) NOT NULL,
  `width` INT UNSIGNED NULL,
  `height` INT UNSIGNED NULL,
  `sha256` CHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deleted_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_resources_relative_path` (`relative_path`),
  KEY `idx_resources_sha256` (`sha256`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `highlights` (
  `id` CHAR(36) NOT NULL,
  `card_id` CHAR(36) NOT NULL,
  `kind` ENUM('text', 'formula') NOT NULL,
  `anchor_json` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_highlights_card` (`card_id`),
  CONSTRAINT `fk_highlights_card` FOREIGN KEY (`card_id`) REFERENCES `cards` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `review_records` (
  `card_id` CHAR(36) NOT NULL,
  `first_viewed_at` DATETIME(3) NULL,
  `last_viewed_at` DATETIME(3) NULL,
  `status_changed_at` DATETIME(3) NULL,
  `view_count` INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`card_id`),
  CONSTRAINT `fk_review_records_card` FOREIGN KEY (`card_id`) REFERENCES `cards` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `ai_provider_profiles` (
  `id` CHAR(36) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `provider` VARCHAR(100) NOT NULL,
  `base_url` VARCHAR(1024) NOT NULL,
  `model` VARCHAR(255) NOT NULL,
  `api_key_ciphertext` VARBINARY(4096) NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT FALSE,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_ai_provider_profiles_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `ai_explanations` (
  `card_id` CHAR(36) NOT NULL,
  `provider_profile_id` CHAR(36) NULL,
  `provider` VARCHAR(100) NOT NULL,
  `model` VARCHAR(255) NOT NULL,
  `prompt_text` TEXT NOT NULL,
  `content_json` JSON NOT NULL,
  `generated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`card_id`),
  KEY `idx_ai_explanations_provider` (`provider_profile_id`),
  CONSTRAINT `fk_ai_explanations_card` FOREIGN KEY (`card_id`) REFERENCES `cards` (`id`),
  CONSTRAINT `fk_ai_explanations_provider` FOREIGN KEY (`provider_profile_id`) REFERENCES `ai_provider_profiles` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `sync_locks` (
  `card_id` CHAR(36) NOT NULL,
  `lock_token` CHAR(36) NOT NULL,
  `device_id` VARCHAR(255) NOT NULL,
  `acquired_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`card_id`),
  UNIQUE KEY `uq_sync_locks_token` (`lock_token`),
  CONSTRAINT `fk_sync_locks_card` FOREIGN KEY (`card_id`) REFERENCES `cards` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `backup_records` (
  `id` CHAR(36) NOT NULL,
  `started_at` DATETIME(3) NOT NULL,
  `finished_at` DATETIME(3) NULL,
  `directory` VARCHAR(1024) NOT NULL,
  `file_manifest` JSON NULL,
  `status` ENUM('running', 'succeeded', 'failed') NOT NULL,
  `error_message` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_backup_records_started_at` (`started_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `trash_items` (
  `id` CHAR(36) NOT NULL,
  `entity_type` ENUM('material', 'chapter', 'section', 'card') NOT NULL,
  `entity_id` CHAR(36) NOT NULL,
  `payload_json` JSON NOT NULL,
  `deleted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` DATETIME(3) NULL,
  `restored_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_trash_items_entity` (`entity_type`, `entity_id`),
  KEY `idx_trash_items_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `app_settings` (
  `setting_key` VARCHAR(100) NOT NULL,
  `setting_value` JSON NOT NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
