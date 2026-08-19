CREATE TABLE `question_banks` (
  `id` CHAR(36) NOT NULL,
  `subject_id` CHAR(36) NOT NULL,
  `kind` ENUM('chapter', 'official', 'mock') NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `sort_order` INT UNSIGNED NOT NULL,
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_question_banks_subject_kind_order` (`subject_id`, `kind`, `deleted_at`, `sort_order`),
  CONSTRAINT `fk_question_banks_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `question_chapters` (
  `id` CHAR(36) NOT NULL,
  `question_bank_id` CHAR(36) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `sort_order` INT UNSIGNED NOT NULL,
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_question_chapters_bank_order` (`question_bank_id`, `deleted_at`, `sort_order`),
  CONSTRAINT `fk_question_chapters_bank` FOREIGN KEY (`question_bank_id`) REFERENCES `question_banks` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `questions` (
  `id` CHAR(36) NOT NULL,
  `question_bank_id` CHAR(36) NOT NULL,
  `question_chapter_id` CHAR(36) NULL,
  `stem_json` JSON NOT NULL,
  `question_type` ENUM('single', 'multiple', 'true_false') NOT NULL,
  `options_json` JSON NOT NULL,
  `answer_json` JSON NOT NULL,
  `analysis_json` JSON NULL,
  `knowledge_points_json` JSON NOT NULL,
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `sort_order` INT UNSIGNED NOT NULL,
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_questions_bank_order` (`question_bank_id`, `deleted_at`, `sort_order`),
  KEY `idx_questions_chapter_order` (`question_chapter_id`, `deleted_at`, `sort_order`),
  CONSTRAINT `fk_questions_bank` FOREIGN KEY (`question_bank_id`) REFERENCES `question_banks` (`id`),
  CONSTRAINT `fk_questions_chapter` FOREIGN KEY (`question_chapter_id`) REFERENCES `question_chapters` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `question_ai_explanations` (
  `id` CHAR(36) NOT NULL,
  `question_id` CHAR(36) NOT NULL,
  `question_version` INT UNSIGNED NOT NULL,
  `provider_profile_id` CHAR(36) NULL,
  `provider` VARCHAR(100) NOT NULL,
  `model` VARCHAR(255) NOT NULL,
  `prompt_text` TEXT NOT NULL,
  `content_json` JSON NOT NULL,
  `generated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_question_ai_explanations_question_version` (`question_id`, `question_version`, `generated_at`),
  KEY `idx_question_ai_explanations_provider` (`provider_profile_id`),
  CONSTRAINT `fk_question_ai_explanations_question` FOREIGN KEY (`question_id`) REFERENCES `questions` (`id`),
  CONSTRAINT `fk_question_ai_explanations_provider` FOREIGN KEY (`provider_profile_id`) REFERENCES `ai_provider_profiles` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `practice_sessions` (
  `id` CHAR(36) NOT NULL,
  `question_bank_id` CHAR(36) NOT NULL,
  `question_chapter_id` CHAR(36) NULL,
  `mode` ENUM('cram', 'test') NOT NULL,
  `source` ENUM('full', 'current_wrong', 'aggregate_wrong') NOT NULL DEFAULT 'full',
  `scope_json` JSON NOT NULL,
  `status` ENUM('in_progress', 'completed', 'abandoned') NOT NULL DEFAULT 'in_progress',
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_practice_sessions_bank_status` (`question_bank_id`, `status`, `started_at`),
  CONSTRAINT `fk_practice_sessions_bank` FOREIGN KEY (`question_bank_id`) REFERENCES `question_banks` (`id`),
  CONSTRAINT `fk_practice_sessions_chapter` FOREIGN KEY (`question_chapter_id`) REFERENCES `question_chapters` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `practice_attempts` (
  `id` CHAR(36) NOT NULL,
  `practice_session_id` CHAR(36) NOT NULL,
  `question_id` CHAR(36) NOT NULL,
  `question_version` INT UNSIGNED NOT NULL,
  `sort_order` INT UNSIGNED NOT NULL,
  `snapshot_json` JSON NOT NULL,
  `answer_json` JSON NULL,
  `result` ENUM('unanswered', 'correct', 'incorrect') NOT NULL DEFAULT 'unanswered',
  `answered_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_practice_attempts_session_question` (`practice_session_id`, `question_id`),
  KEY `idx_practice_attempts_question_result` (`question_id`, `result`, `answered_at`),
  CONSTRAINT `fk_practice_attempts_session` FOREIGN KEY (`practice_session_id`) REFERENCES `practice_sessions` (`id`),
  CONSTRAINT `fk_practice_attempts_question` FOREIGN KEY (`question_id`) REFERENCES `questions` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
