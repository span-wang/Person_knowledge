import type {
  PracticeMode,
  PracticeSource,
  ReviewWorkspaceContext,
  ReviewWorkspaceContextUpdateRequest,
  ReviewWorkspaceContinue,
  ReviewWorkspaceCourseSummary,
  ReviewWorkspaceMaterialSummary,
  ReviewWorkspaceQuestionBankSummary,
  ReviewWorkspaceFavoritePracticeSummary,
  ReviewWorkspaceResponse,
  ReviewWorkspaceSubjectSummary,
  ReviewWorkspaceMode,
} from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';
import { ReviewApiError } from './review-service.js';

const workspaceSettingKey = 'review.workspaceContext';

type Row = Record<string, unknown>;

export interface ReviewWorkspaceSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowsFrom(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return value instanceof Date ? value.toISOString() : textValue(value);
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new ReviewApiError(400, `${label}无效。`);
  }
  return value.trim();
}

function readMode(value: unknown): ReviewWorkspaceMode {
  if (value !== 'flashcards' && value !== 'questions') {
    throw new ReviewApiError(400, '复习分段无效。');
  }
  return value;
}

type StoredContext = {
  courseId?: string | null;
  subjectsByCourse?: Record<string, string | null>;
  modesByCourse?: Record<string, ReviewWorkspaceMode>;
  expandedMaterialsByCourse?: Record<string, string | null>;
};

function stringMap(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === null ? null : textValue(item)]));
}

function modeMap(value: unknown): Record<string, ReviewWorkspaceMode> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item === 'flashcards' || item === 'questions')) as Record<string, ReviewWorkspaceMode>;
}

function parseStoredContext(value: unknown): StoredContext {
  if (typeof value !== 'string') {
    if (!isRecord(value)) return {};
    return { courseId: value.courseId === null ? null : textValue(value.courseId), subjectsByCourse: stringMap(value.subjectsByCourse), modesByCourse: modeMap(value.modesByCourse), expandedMaterialsByCourse: stringMap(value.expandedMaterialsByCourse) };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parseStoredContext(parsed);
  } catch {
    return {};
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function materialSummary(row: Row, cover: ReviewWorkspaceMaterialSummary['cover']): ReviewWorkspaceMaterialSummary {
  return {
    id: textValue(row.material_id),
    subjectId: textValue(row.subject_id),
    name: textValue(row.material_name),
    cardCount: numberValue(row.card_count),
    masteredCount: numberValue(row.mastered_count),
    familiarCount: numberValue(row.familiar_count),
    effortCount: numberValue(row.effort_count),
    unassessedCount: numberValue(row.unassessed_count),
    lastCardId: row.last_card_id === null || row.last_card_id === undefined ? null : textValue(row.last_card_id),
    lastCardTitle: row.last_card_title === null || row.last_card_title === undefined ? null : textValue(row.last_card_title),
    lastViewedAt: dateValue(row.last_viewed_at),
    cover,
  };
}

export interface ReviewWorkspaceService {
  getWorkspace(options?: { courseId?: string; subjectId?: string | null }): Promise<ReviewWorkspaceResponse>;
  updateContext(request: ReviewWorkspaceContextUpdateRequest): Promise<ReviewWorkspaceResponse>;
}

export function createReviewWorkspaceService(options: { database?: ReviewWorkspaceSqlExecutor } = {}): ReviewWorkspaceService {
  const database = options.database ?? createDatabasePool() as unknown as ReviewWorkspaceSqlExecutor;

  async function readSetting(): Promise<StoredContext> {
    const [rows] = await database.execute('SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1', [workspaceSettingKey]);
    return parseStoredContext(rowsFrom(rows)[0]?.setting_value);
  }

  async function writeSetting(value: StoredContext): Promise<void> {
    await database.execute(
      'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [workspaceSettingKey, JSON.stringify(value)],
    );
  }

  async function activeCourse(courseId: string): Promise<Row> {
    const [rows] = await database.execute(
      'SELECT id, name, is_system FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [courseId],
    );
    const row = rowsFrom(rows)[0];
    if (!row) throw new ReviewApiError(404, '课程不存在或已删除。');
    return row;
  }

  async function activeSubject(subjectId: string, courseId: string): Promise<Row> {
    const [rows] = await database.execute(
      'SELECT id, course_id, name, is_system FROM subjects WHERE id = ? AND course_id = ? AND deleted_at IS NULL LIMIT 1',
      [subjectId, courseId],
    );
    const row = rowsFrom(rows)[0];
    if (!row) throw new ReviewApiError(404, '科目不存在或不属于当前课程。');
    return row;
  }

  async function resolveCourse(stored: StoredContext, requestedCourseId?: string): Promise<Row> {
    if (requestedCourseId) return activeCourse(requestedCourseId);
    if (stored.courseId) {
      const [rows] = await database.execute('SELECT id, name, is_system FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1', [stored.courseId]);
      const row = rowsFrom(rows)[0];
      if (row) return row;
    }
    const [rows] = await database.execute('SELECT id, name, is_system FROM courses WHERE deleted_at IS NULL ORDER BY is_system, sort_order, created_at, id LIMIT 1');
    const row = rowsFrom(rows)[0];
    if (!row) throw new ReviewApiError(404, '暂无可用课程，请先在资料页新增课程。');
    return row;
  }

  async function courseSummaries(): Promise<ReviewWorkspaceCourseSummary[]> {
    const [courseRows, materialRows, questionRows, sessionRows] = await Promise.all([
      database.execute(`
        SELECT c.id, c.name, c.is_system, COUNT(DISTINCT s.id) AS subject_count,
          COUNT(DISTINCT m.id) AS material_count
        FROM courses AS c
        LEFT JOIN subjects AS s ON s.course_id = c.id AND s.deleted_at IS NULL
        LEFT JOIN materials AS m ON m.subject_id = s.id AND m.deleted_at IS NULL
        WHERE c.deleted_at IS NULL
        GROUP BY c.id, c.name, c.is_system, c.sort_order, c.created_at
        ORDER BY c.is_system, c.sort_order, c.created_at, c.id
      `),
      database.execute(`
        SELECT s.course_id, COUNT(c.id) AS flashcard_count
        FROM subjects AS s
        INNER JOIN materials AS m ON m.subject_id = s.id AND m.deleted_at IS NULL
        INNER JOIN chapters AS ch ON ch.material_id = m.id AND ch.deleted_at IS NULL
        INNER JOIN sections AS se ON se.chapter_id = ch.id AND se.deleted_at IS NULL
        INNER JOIN cards AS c ON c.section_id = se.id AND c.deleted_at IS NULL
        GROUP BY s.course_id
      `),
      database.execute(`
        SELECT s.course_id, COUNT(DISTINCT b.id) AS question_bank_count, COUNT(q.id) AS question_count
        FROM subjects AS s
        LEFT JOIN question_banks AS b ON b.subject_id = s.id AND b.deleted_at IS NULL
        LEFT JOIN questions AS q ON q.question_bank_id = b.id AND q.deleted_at IS NULL
        GROUP BY s.course_id
      `),
      database.execute(`
        SELECT s.course_id, COUNT(*) AS in_progress_count
        FROM practice_sessions AS ps
        INNER JOIN question_banks AS b ON b.id = ps.question_bank_id AND b.deleted_at IS NULL
        INNER JOIN subjects AS s ON s.id = b.subject_id AND s.deleted_at IS NULL
        INNER JOIN courses AS c ON c.id = s.course_id AND c.deleted_at IS NULL
        WHERE ps.status = 'in_progress'
        GROUP BY s.course_id
      `),
    ]);
    const flashcards = new Map(rowsFrom(materialRows[0]).map((row) => [textValue(row.course_id), numberValue(row.flashcard_count)]));
    const questions = new Map(rowsFrom(questionRows[0]).map((row) => [textValue(row.course_id), { bankCount: numberValue(row.question_bank_count), questionCount: numberValue(row.question_count) }]));
    const sessions = new Map(rowsFrom(sessionRows[0]).map((row) => [textValue(row.course_id), numberValue(row.in_progress_count)]));
    const lastCards = await readLastCards();
    const lastCardIds = Object.values(lastCards).filter(Boolean);
    const flashcardContinueCourses = new Set<string>();
    if (lastCardIds.length) {
      const [lastCardRows] = await database.execute(`
        SELECT DISTINCT s.course_id
        FROM cards AS c
        INNER JOIN sections AS se ON se.id = c.section_id AND se.deleted_at IS NULL
        INNER JOIN chapters AS ch ON ch.id = se.chapter_id AND ch.deleted_at IS NULL
        INNER JOIN materials AS m ON m.id = ch.material_id AND m.deleted_at IS NULL
        INNER JOIN subjects AS s ON s.id = m.subject_id AND s.deleted_at IS NULL
        INNER JOIN courses AS co ON co.id = s.course_id AND co.deleted_at IS NULL
        WHERE c.id IN (${placeholders(lastCardIds.length)})
      `, lastCardIds);
      for (const row of rowsFrom(lastCardRows)) flashcardContinueCourses.add(textValue(row.course_id));
    }
    return rowsFrom(courseRows[0]).map((row) => {
      const id = textValue(row.id);
      const question = questions.get(id) ?? { bankCount: 0, questionCount: 0 };
      return {
        id,
        name: textValue(row.name),
        isSystem: Boolean(row.is_system),
        subjectCount: numberValue(row.subject_count),
        materialCount: numberValue(row.material_count),
        flashcardCount: flashcards.get(id) ?? 0,
        questionBankCount: question.bankCount,
        questionCount: question.questionCount,
        hasContinue: (sessions.get(id) ?? 0) > 0 || flashcardContinueCourses.has(id),
      };
    });
  }

  async function subjectSummaries(courseId: string): Promise<ReviewWorkspaceSubjectSummary[]> {
    const [rows] = await database.execute(`
      SELECT s.id, s.course_id, s.name, s.is_system,
        COUNT(DISTINCT m.id) AS material_count,
        COUNT(DISTINCT c.id) AS flashcard_count,
        COUNT(DISTINCT b.id) AS question_bank_count,
        COUNT(DISTINCT q.id) AS question_count
      FROM subjects AS s
      LEFT JOIN materials AS m ON m.subject_id = s.id AND m.deleted_at IS NULL
      LEFT JOIN chapters AS ch ON ch.material_id = m.id AND ch.deleted_at IS NULL
      LEFT JOIN sections AS se ON se.chapter_id = ch.id AND se.deleted_at IS NULL
      LEFT JOIN cards AS c ON c.section_id = se.id AND c.deleted_at IS NULL
      LEFT JOIN question_banks AS b ON b.subject_id = s.id AND b.deleted_at IS NULL
      LEFT JOIN questions AS q ON q.question_bank_id = b.id AND q.deleted_at IS NULL
      WHERE s.course_id = ? AND s.deleted_at IS NULL
      GROUP BY s.id, s.course_id, s.name, s.is_system, s.sort_order, s.created_at
      ORDER BY s.is_system, s.sort_order, s.created_at, s.id
    `, [courseId]);
    return rowsFrom(rows).map((row) => ({
      id: textValue(row.id), courseId: textValue(row.course_id), name: textValue(row.name), isSystem: Boolean(row.is_system),
      materialCount: numberValue(row.material_count), flashcardCount: numberValue(row.flashcard_count),
      questionBankCount: numberValue(row.question_bank_count), questionCount: numberValue(row.question_count),
    }));
  }

  async function coversFor(materialIds: string[]): Promise<Map<string, ReviewWorkspaceMaterialSummary['cover']>> {
    if (!materialIds.length) return new Map();
    const [rows] = await database.execute(`
      SELECT mc.material_id, o.id AS original_id, o.relative_path AS original_path, o.mime_type AS original_mime,
        o.width AS original_width, o.height AS original_height, o.sha256 AS original_sha,
        t.id AS thumbnail_id, t.relative_path AS thumbnail_path, t.mime_type AS thumbnail_mime,
        t.width AS thumbnail_width, t.height AS thumbnail_height, t.sha256 AS thumbnail_sha
      FROM material_covers AS mc
      INNER JOIN resources AS o ON o.id = mc.original_resource_id
      INNER JOIN resources AS t ON t.id = mc.thumbnail_resource_id
      WHERE mc.material_id IN (${placeholders(materialIds.length)})
    `, materialIds);
    return new Map(rowsFrom(rows).map((row) => [textValue(row.material_id), {
      id: `${textValue(row.material_id)}-cover`,
      original: { id: textValue(row.original_id), mimeType: textValue(row.original_mime) as never, width: row.original_width === null ? null : numberValue(row.original_width), height: row.original_height === null ? null : numberValue(row.original_height), sha256: textValue(row.original_sha) },
      thumbnail: { id: textValue(row.thumbnail_id), mimeType: textValue(row.thumbnail_mime) as never, width: row.thumbnail_width === null ? null : numberValue(row.thumbnail_width), height: row.thumbnail_height === null ? null : numberValue(row.thumbnail_height), sha256: textValue(row.thumbnail_sha) },
    }]));
  }

  async function materialsFor(courseId: string, subjectId: string | null): Promise<ReviewWorkspaceMaterialSummary[]> {
    const lastCards = await readLastCards();
    const values: unknown[] = [courseId];
    const subjectClause = subjectId ? ' AND m.subject_id = ?' : '';
    if (subjectId) values.push(subjectId);
    const [rows] = await database.execute(`
      SELECT m.id AS material_id, m.subject_id, m.name AS material_name,
        COUNT(c.id) AS card_count,
        COALESCE(SUM(c.mastery_status = 'mastered'), 0) AS mastered_count,
        COALESCE(SUM(c.mastery_status = 'familiar'), 0) AS familiar_count,
        COALESCE(SUM(c.mastery_status = 'effort'), 0) AS effort_count,
        COALESCE(SUM(c.mastery_status = 'unassessed'), 0) AS unassessed_count,
        MAX(CASE WHEN c.id = JSON_UNQUOTE(JSON_EXTRACT(?, CONCAT('$."', m.id, '"'))) THEN c.id END) AS last_card_id,
        MAX(CASE WHEN c.id = JSON_UNQUOTE(JSON_EXTRACT(?, CONCAT('$."', m.id, '"'))) THEN c.title END) AS last_card_title,
        MAX(CASE WHEN c.id = JSON_UNQUOTE(JSON_EXTRACT(?, CONCAT('$."', m.id, '"'))) THEN rr.last_viewed_at END) AS last_viewed_at
      FROM materials AS m
      LEFT JOIN chapters AS ch ON ch.material_id = m.id AND ch.deleted_at IS NULL
      LEFT JOIN sections AS se ON se.chapter_id = ch.id AND se.deleted_at IS NULL
      LEFT JOIN cards AS c ON c.section_id = se.id AND c.deleted_at IS NULL
      LEFT JOIN review_records AS rr ON rr.card_id = c.id
      INNER JOIN subjects AS s ON s.id = m.subject_id AND s.course_id = ? AND s.deleted_at IS NULL
      WHERE m.deleted_at IS NULL${subjectClause}
      GROUP BY m.id, m.subject_id, m.name, m.created_at
      ORDER BY s.sort_order, s.id, m.created_at DESC, m.id
    `, [JSON.stringify(lastCards), JSON.stringify(lastCards), JSON.stringify(lastCards), ...values]);
    const ids = rowsFrom(rows).map((row) => textValue(row.material_id));
    const covers = await coversFor(ids);
    return rowsFrom(rows).map((row) => materialSummary(row, covers.get(textValue(row.material_id)) ?? null));
  }

  async function readLastCards(): Promise<Record<string, string>> {
    const [rows] = await database.execute("SELECT setting_value FROM app_settings WHERE setting_key = 'review.lastCards' LIMIT 1");
    const raw = rowsFrom(rows)[0]?.setting_value;
    let value: unknown = raw;
    if (typeof raw === 'string') {
      try { value = JSON.parse(raw) as unknown; } catch { return {}; }
    }
    if (!isRecord(value)) return {};
    const cardIdsByMaterial = isRecord(value.cardIdsByMaterial) ? value.cardIdsByMaterial : value;
    return Object.fromEntries(Object.entries(cardIdsByMaterial).filter(([, cardId]) => typeof cardId === 'string')) as Record<string, string>;
  }

  async function bankSummaries(courseId: string, subjectId: string | null): Promise<{ banks: ReviewWorkspaceQuestionBankSummary[]; favorites: ReviewWorkspaceFavoritePracticeSummary[]; inProgress: number; wrong: number }> {
    const values: unknown[] = [courseId];
    const subjectClause = subjectId ? ' AND b.subject_id = ?' : '';
    if (subjectId) values.push(subjectId);
    const [bankRows, chapterRows, sessionRows, wrongRows, favoriteRows] = await Promise.all([
      database.execute(`
        SELECT b.id AS bank_id, b.subject_id, b.kind, b.name,
          COUNT(DISTINCT q.id) AS question_count, COUNT(DISTINCT ch.id) AS chapter_count
        FROM question_banks AS b
        INNER JOIN subjects AS s ON s.id = b.subject_id AND s.course_id = ? AND s.deleted_at IS NULL
        LEFT JOIN question_chapters AS ch ON ch.question_bank_id = b.id AND ch.deleted_at IS NULL
        LEFT JOIN questions AS q ON q.question_bank_id = b.id AND q.deleted_at IS NULL
        WHERE b.deleted_at IS NULL${subjectClause}
        GROUP BY b.id, b.subject_id, b.kind, b.name, b.sort_order, b.created_at
        ORDER BY s.sort_order, s.id, b.kind, b.sort_order, b.created_at, b.id
      `, values),
      database.execute(`
        SELECT ch.id AS chapter_id, ch.question_bank_id, ch.title,
          COUNT(q.id) AS question_count
        FROM question_chapters AS ch
        INNER JOIN question_banks AS b ON b.id = ch.question_bank_id AND b.deleted_at IS NULL
        INNER JOIN subjects AS s ON s.id = b.subject_id AND s.course_id = ? AND s.deleted_at IS NULL
        LEFT JOIN questions AS q ON q.question_chapter_id = ch.id AND q.deleted_at IS NULL
        WHERE ch.deleted_at IS NULL${subjectClause}
        GROUP BY ch.id, ch.question_bank_id, ch.title, ch.sort_order, ch.created_at
        HAVING COUNT(q.id) > 0
        ORDER BY s.sort_order, s.id, b.kind, b.sort_order, b.created_at, b.id, ch.sort_order, ch.created_at, ch.id
      `, values),
      database.execute(`
        SELECT ps.id AS session_id, ps.question_bank_id, ps.mode, ps.source, ps.updated_at
        FROM practice_sessions AS ps
        INNER JOIN question_banks AS b ON b.id = ps.question_bank_id AND b.deleted_at IS NULL
        INNER JOIN subjects AS s ON s.id = b.subject_id AND s.course_id = ? AND s.deleted_at IS NULL
        WHERE ps.status = 'in_progress'${subjectId ? ' AND b.subject_id = ?' : ''}
        ORDER BY ps.updated_at DESC, ps.id DESC
      `, values),
      database.execute(`
        SELECT COUNT(DISTINCT q.id) AS wrong_count
        FROM questions AS q
        INNER JOIN question_banks AS b ON b.id = q.question_bank_id AND b.deleted_at IS NULL
        INNER JOIN subjects AS s ON s.id = b.subject_id AND s.course_id = ? AND s.deleted_at IS NULL
        INNER JOIN practice_attempts AS a ON a.question_id = q.id AND a.result = 'incorrect'
        INNER JOIN practice_sessions AS ps ON ps.id = a.practice_session_id AND ps.status = 'completed' AND ps.question_bank_id = q.question_bank_id
        WHERE q.deleted_at IS NULL${subjectId ? ' AND b.subject_id = ?' : ''}
          AND NOT EXISTS (
            SELECT 1 FROM practice_attempts AS newer_a
            INNER JOIN practice_sessions AS newer_ps ON newer_ps.id = newer_a.practice_session_id AND newer_ps.status = 'completed'
            WHERE newer_a.question_id = a.question_id AND (newer_a.answered_at > a.answered_at OR (newer_a.answered_at = a.answered_at AND newer_a.id > a.id))
          )
      `, values),
      database.execute(`
        SELECT b.subject_id, COUNT(DISTINCT q.id) AS favorite_count,
          COUNT(DISTINCT CASE WHEN ps.status = 'in_progress' THEN ps.id END) AS in_progress_count,
          SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN ps.status = 'in_progress' THEN ps.id END ORDER BY ps.updated_at DESC, ps.id DESC), ',', 1) AS latest_session_id,
          SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN ps.status = 'in_progress' THEN ps.mode END ORDER BY ps.updated_at DESC, ps.id DESC), ',', 1) AS latest_session_mode,
          MAX(CASE WHEN ps.status = 'in_progress' THEN ps.updated_at END) AS latest_session_updated_at
        FROM question_banks AS b
        INNER JOIN subjects AS s ON s.id = b.subject_id AND s.course_id = ? AND s.deleted_at IS NULL
        INNER JOIN questions AS q ON q.question_bank_id = b.id AND q.is_favorite = 1 AND q.deleted_at IS NULL
        LEFT JOIN practice_sessions AS ps ON ps.subject_id = b.subject_id AND ps.source = 'favorite'
        WHERE b.deleted_at IS NULL${subjectClause}
        GROUP BY b.subject_id
      `, values),
    ]);
    const chaptersByBank = new Map<string, Array<{ id: string; title: string; questionCount: number }>>();
    for (const row of rowsFrom(chapterRows[0])) {
      const bankId = textValue(row.question_bank_id);
      const chapters = chaptersByBank.get(bankId) ?? [];
      chapters.push({ id: textValue(row.chapter_id), title: textValue(row.title), questionCount: numberValue(row.question_count) });
      chaptersByBank.set(bankId, chapters);
    }
    const sessionsByBank = new Map<string, Row[]>();
    for (const row of rowsFrom(sessionRows[0])) {
      const bankId = textValue(row.question_bank_id);
      const list = sessionsByBank.get(bankId) ?? [];
      list.push(row);
      sessionsByBank.set(bankId, list);
    }
    const banks = rowsFrom(bankRows[0]).map((row) => {
      const sessions = sessionsByBank.get(textValue(row.bank_id)) ?? [];
      const latest = sessions[0];
      return {
        id: textValue(row.bank_id), subjectId: textValue(row.subject_id), kind: textValue(row.kind) as never,
        name: textValue(row.name), questionCount: numberValue(row.question_count), chapterCount: numberValue(row.chapter_count),
        chapters: chaptersByBank.get(textValue(row.bank_id)) ?? [],
        inProgressCount: sessions.length, latestSessionId: latest ? textValue(latest.session_id) : null,
        latestSessionMode: latest ? textValue(latest.mode) as PracticeMode : null,
        latestSessionUpdatedAt: latest ? dateValue(latest.updated_at) : null,
      } satisfies ReviewWorkspaceQuestionBankSummary;
    });
    const favorites = rowsFrom(favoriteRows[0]).map((row) => ({ subjectId: textValue(row.subject_id), questionCount: numberValue(row.favorite_count), inProgressCount: numberValue(row.in_progress_count), latestSessionId: row.latest_session_id ? textValue(row.latest_session_id) : null, latestSessionMode: row.latest_session_mode ? textValue(row.latest_session_mode) as PracticeMode : null, latestSessionUpdatedAt: dateValue(row.latest_session_updated_at) }));
    return { banks, favorites, inProgress: rowsFrom(sessionRows[0]).length + favorites.reduce((count, item) => count + item.inProgressCount, 0), wrong: numberValue(rowsFrom(wrongRows[0])[0]?.wrong_count) };
  }

  async function continueFor(courseId: string, subjectId: string | null): Promise<ReviewWorkspaceContinue | null> {
    const cards = await readLastCards();
    const cardIds = Object.values(cards).filter(Boolean);
    const cardValues: unknown[] = [courseId];
    const subjectClause = subjectId ? ' AND m.subject_id = ?' : '';
    if (subjectId) cardValues.push(subjectId);
    let flashcard: Row | undefined;
    if (cardIds.length) {
      const [rows] = await database.execute(`
        SELECT m.id AS material_id, m.subject_id, m.name AS material_name, c.id AS card_id, c.title AS card_title, rr.last_viewed_at
        FROM cards AS c
        INNER JOIN sections AS se ON se.id = c.section_id AND se.deleted_at IS NULL
        INNER JOIN chapters AS ch ON ch.id = se.chapter_id AND ch.deleted_at IS NULL
        INNER JOIN materials AS m ON m.id = ch.material_id AND m.deleted_at IS NULL
        INNER JOIN subjects AS s ON s.id = m.subject_id AND s.course_id = ? AND s.deleted_at IS NULL
        LEFT JOIN review_records AS rr ON rr.card_id = c.id
        WHERE c.id IN (${placeholders(cardIds.length)})${subjectClause}
        ORDER BY rr.last_viewed_at DESC, c.id DESC
        LIMIT 1
      `, [courseId, ...cardIds, ...(subjectId ? [subjectId] : [])]);
      flashcard = rowsFrom(rows)[0];
    }
    const practiceValues: unknown[] = [courseId];
    if (subjectId) practiceValues.push(subjectId);
    const [sessionRows] = await database.execute(`
      SELECT ps.id AS session_id, ps.mode, ps.source, ps.updated_at, b.id AS bank_id,
        COALESCE(b.name, '收藏题') AS bank_name, s.id AS subject_id
      FROM practice_sessions AS ps
      LEFT JOIN question_banks AS b ON b.id = ps.question_bank_id AND b.deleted_at IS NULL
      INNER JOIN subjects AS s ON s.id = COALESCE(b.subject_id, ps.subject_id) AND s.course_id = ? AND s.deleted_at IS NULL
      WHERE ps.status = 'in_progress' AND (ps.question_bank_id IS NULL OR b.id IS NOT NULL)${subjectId ? ' AND s.id = ?' : ''}
      ORDER BY ps.updated_at DESC, ps.id DESC
      LIMIT 1
    `, practiceValues);
    const practice = rowsFrom(sessionRows)[0];
    const flashcardAt = dateValue(flashcard?.last_viewed_at);
    const practiceAt = dateValue(practice?.updated_at);
    if (!flashcard && !practice) return null;
    if (practice && (!flashcardAt || (practiceAt && practiceAt >= flashcardAt))) {
      return { kind: 'practice', courseId, subjectId: textValue(practice.subject_id), questionBankId: practice.bank_id === null || practice.bank_id === undefined ? null : textValue(practice.bank_id), questionBankName: textValue(practice.bank_name), sessionId: textValue(practice.session_id), mode: textValue(practice.mode) as PracticeMode, source: textValue(practice.source) as PracticeSource, updatedAt: practiceAt! };
    }
    return { kind: 'flashcard', courseId, subjectId: textValue(flashcard!.subject_id), materialId: textValue(flashcard!.material_id), cardId: textValue(flashcard!.card_id), materialName: textValue(flashcard!.material_name), cardTitle: textValue(flashcard!.card_title), updatedAt: flashcardAt! };
  }

  async function workspaceFor(context: ReviewWorkspaceContext): Promise<ReviewWorkspaceResponse> {
    const [courses, subjects, materials, bankResult, continuation] = await Promise.all([
      courseSummaries(), subjectSummaries(context.courseId), materialsFor(context.courseId, context.subjectId), bankSummaries(context.courseId, context.subjectId), continueFor(context.courseId, context.subjectId),
    ]);
    const currentCourse = courses.find((item) => item.id === context.courseId);
    if (!currentCourse) throw new ReviewApiError(404, '当前课程不存在或已删除。');
    return {
      context, courses, currentCourse, subjects,
      flashcards: { materialCount: materials.length, cardCount: materials.reduce((sum, item) => sum + item.cardCount, 0), unassessedCount: materials.reduce((sum, item) => sum + item.unassessedCount, 0), effortCount: materials.reduce((sum, item) => sum + item.effortCount, 0), materials },
      questions: { questionBankCount: bankResult.banks.length, questionCount: bankResult.banks.reduce((sum, item) => sum + item.questionCount, 0), inProgressCount: bankResult.inProgress, aggregateWrongCount: bankResult.wrong, banks: bankResult.banks, favorites: bankResult.favorites },
      continue: continuation,
    };
  }

  async function getWorkspace(options: { courseId?: string; subjectId?: string | null } = {}): Promise<ReviewWorkspaceResponse> {
    const stored = await readSetting();
    const course = await resolveCourse(stored, options.courseId);
    const courseId = textValue(course.id);
    const requestedSubject = options.subjectId === undefined ? stored.subjectsByCourse?.[courseId] ?? null : options.subjectId;
    const subjectId: string | null = requestedSubject ? textValue((await activeSubject(requiredId(requestedSubject, '科目标识'), courseId)).id) : null;
    const mode = stored.modesByCourse?.[courseId] === 'questions' ? 'questions' : 'flashcards';
    const expanded: string | null = stored.expandedMaterialsByCourse?.[courseId] ?? null;
    const context: ReviewWorkspaceContext = { courseId, subjectId, mode, expandedMaterialId: expanded };
    if (stored.courseId !== courseId || stored.subjectsByCourse?.[courseId] !== subjectId) {
      await writeSetting({ courseId, subjectsByCourse: { ...(stored.subjectsByCourse ?? {}), [courseId]: subjectId }, modesByCourse: { ...(stored.modesByCourse ?? {}), [courseId]: mode }, expandedMaterialsByCourse: { ...(stored.expandedMaterialsByCourse ?? {}), [courseId]: expanded } });
    }
    return workspaceFor(context);
  }

  async function updateContext(request: ReviewWorkspaceContextUpdateRequest): Promise<ReviewWorkspaceResponse> {
    const stored = await readSetting();
    const courseId = requiredId(request.courseId, '课程标识');
    await activeCourse(courseId);
    const subjectId: string | null = request.subjectId === null ? null : textValue((await activeSubject(requiredId(request.subjectId, '科目标识'), courseId)).id);
    const expandedMaterialId = request.expandedMaterialId === null ? null : requiredId(request.expandedMaterialId, '展开资料标识');
    if (expandedMaterialId) {
      const [rows] = await database.execute('SELECT m.id FROM materials AS m INNER JOIN subjects AS s ON s.id = m.subject_id AND s.course_id = ? AND s.deleted_at IS NULL WHERE m.id = ? AND m.deleted_at IS NULL LIMIT 1', [courseId, expandedMaterialId]);
      if (!rowsFrom(rows).length) throw new ReviewApiError(400, '展开资料不属于当前课程。');
    }
    const mode = readMode(request.mode);
    await writeSetting({
      courseId,
      subjectsByCourse: { ...(stored.subjectsByCourse ?? {}), [courseId]: subjectId },
      modesByCourse: { ...(stored.modesByCourse ?? {}), [courseId]: mode },
      expandedMaterialsByCourse: { ...(stored.expandedMaterialsByCourse ?? {}), [courseId]: expandedMaterialId },
    });
    return workspaceFor({ courseId, subjectId, mode, expandedMaterialId });
  }

  return { getWorkspace, updateContext };
}
