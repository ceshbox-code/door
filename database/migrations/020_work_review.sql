-- Приёмка выполненных работ директором (ТЗ 2.1).
-- review_status: pending — ждёт приёмки, accepted — принята (только она даёт начисление), rejected — не принята.
-- can_fix (для rejected): 1 — директор разрешил исправление, 0 — отказ окончательный.
-- Все уже существующие работы получают accepted: расчёты и выплаты, сделанные до введения приёмки, не меняются
-- (reviewed_by/reviewed_at у них остаются пустыми — признак автоматической миграции).
ALTER TABLE work_records
    ADD COLUMN review_status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'accepted' AFTER void_reason,
    ADD COLUMN reviewed_by BIGINT UNSIGNED NULL AFTER review_status,
    ADD COLUMN reviewed_at DATETIME NULL AFTER reviewed_by,
    ADD COLUMN reject_reason TEXT NULL AFTER reviewed_at,
    ADD COLUMN can_fix TINYINT(1) NULL AFTER reject_reason,
    ADD COLUMN resubmit_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER can_fix,
    ADD KEY idx_wr_review (review_status, completed_at),
    ADD KEY idx_wr_user_review (user_id, review_status),
    ADD CONSTRAINT fk_wr_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users (id),
    ADD CONSTRAINT chk_wr_can_fix CHECK (can_fix IS NULL OR review_status = 'rejected');

ALTER TABLE work_records ALTER COLUMN review_status SET DEFAULT 'pending';

-- Ключ «одна действующая работа вида на дверь»: окончательно отклонённая работа (rejected и can_fix = 0)
-- ключ освобождает, чтобы работу можно было зарегистрировать заново. Отклонённая с правом исправления ключ удерживает.
ALTER TABLE work_records DROP INDEX uq_work_type_active_door;

ALTER TABLE work_records DROP COLUMN active_unique_door_id;

ALTER TABLE work_records ADD COLUMN active_unique_door_id BIGINT UNSIGNED GENERATED ALWAYS AS (
        CASE
            WHEN voided_at IS NULL AND allow_unique_per_door = 1 AND door_id IS NOT NULL
                 AND NOT (review_status = 'rejected' AND can_fix = 0)
            THEN door_id
            ELSE NULL
        END
    ) STORED;

ALTER TABLE work_records ADD UNIQUE KEY uq_work_type_active_door (work_type_id, active_unique_door_id);

-- Журнал решений: только добавление записей, ничего не редактируется и не удаляется.
CREATE TABLE work_record_reviews (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    work_record_id BIGINT UNSIGNED NOT NULL,
    action         ENUM('accepted','rejected','resubmitted') NOT NULL,
    actor_id       BIGINT UNSIGNED NOT NULL,
    reason         TEXT NULL,
    can_fix        TINYINT(1) NULL,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_wrr_record (work_record_id, id),
    CONSTRAINT fk_wrr_record FOREIGN KEY (work_record_id) REFERENCES work_records (id),
    CONSTRAINT fk_wrr_actor FOREIGN KEY (actor_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
