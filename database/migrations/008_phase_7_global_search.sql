ALTER TABLE `materials`
  ADD FULLTEXT KEY `ftx_materials_name_ngram` (`name`) WITH PARSER `ngram`;

ALTER TABLE `cards`
  ADD COLUMN `search_text` MEDIUMTEXT GENERATED ALWAYS AS (JSON_UNQUOTE(`content_json`)) STORED,
  ADD FULLTEXT KEY `ftx_cards_search_ngram` (`title`, `search_text`) WITH PARSER `ngram`;

ALTER TABLE `questions`
  ADD COLUMN `stem_search_text` MEDIUMTEXT GENERATED ALWAYS AS (JSON_UNQUOTE(`stem_json`)) STORED,
  ADD FULLTEXT KEY `ftx_questions_stem_search_ngram` (`stem_search_text`) WITH PARSER `ngram`;
