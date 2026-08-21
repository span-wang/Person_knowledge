ALTER TABLE `ai_provider_profiles`
  ADD COLUMN `priority` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `is_active`;

UPDATE `ai_provider_profiles`
SET `priority` = CASE WHEN `is_active` THEN 1 ELSE 0 END;

ALTER TABLE `ai_provider_profiles`
  ADD KEY `idx_ai_provider_profiles_failover` (`is_active`, `priority`);
