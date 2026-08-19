SET @legacy_course_id = (
  SELECT `id`
  FROM `courses`
  WHERE `is_system` = TRUE
  ORDER BY `created_at`, `id`
  LIMIT 1
);
SET @legacy_subject_id = (
  SELECT `id`
  FROM `subjects`
  WHERE `is_system` = TRUE
  ORDER BY `created_at`, `id`
  LIMIT 1
);
SET @default_course_id = '00000000-0000-4000-8000-000000000001';
SET @default_subject_id = '00000000-0000-4000-8000-000000000002';

ALTER TABLE `materials`
  DROP FOREIGN KEY `fk_materials_subject`;
ALTER TABLE `subjects`
  DROP FOREIGN KEY `fk_subjects_course`;

UPDATE `courses`
SET `id` = @default_course_id
WHERE `id` = @legacy_course_id;

UPDATE `subjects`
SET `id` = @default_subject_id,
    `course_id` = @default_course_id
WHERE `id` = @legacy_subject_id;

UPDATE `materials`
SET `subject_id` = @default_subject_id
WHERE `subject_id` = @legacy_subject_id;

ALTER TABLE `subjects`
  ADD CONSTRAINT `fk_subjects_course` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`);
ALTER TABLE `materials`
  ADD CONSTRAINT `fk_materials_subject` FOREIGN KEY (`subject_id`) REFERENCES `subjects` (`id`),
  MODIFY COLUMN `subject_id` CHAR(36) NOT NULL DEFAULT '00000000-0000-4000-8000-000000000002';
