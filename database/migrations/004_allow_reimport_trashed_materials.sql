ALTER TABLE `materials`
  DROP INDEX `uq_materials_source_sha256`,
  ADD KEY `idx_materials_source_sha256_deleted_at` (`source_sha256`, `deleted_at`);
