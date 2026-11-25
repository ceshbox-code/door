<?php
declare(strict_types=1);

namespace App\Repositories;

use App\Core\Database;

/** Очередь приёмки работ (ТЗ 2.1): только чтение, ничего не изменяет. */
final class ReviewQueueRepository
{
    /**
     * Сколько действующих (не аннулированных) работ ждёт решения директора.
     * Условие совпадает со списком «Выполненные работы» при status=active и review_status=pending;
     * использует индекс idx_wr_review (review_status, completed_at).
     */
    public function countPending(): int
    {
        $st = Database::pdo()->query(
            "SELECT COUNT(*) FROM work_records WHERE review_status = 'pending' AND voided_at IS NULL"
        );
        return (int) $st->fetchColumn();
    }
}
