<?php
declare(strict_types=1);

namespace App\Repositories;

use App\Core\Database;

/** Изменение работы, которая ещё ждёт приёмки (запись строго под блокировкой строки, см. WorkRecordEditService). */
final class WorkRecordEditRepository
{
    /**
     * Меняет количество, сумму и комментарий. Тариф (unit_price, rate_id) не трогается: сумма пересчитывается
     * по цене, зафиксированной при регистрации (ТЗ 5.3). Условие в WHERE — вторая линия защиты от гонки с приёмкой.
     */
    public function updatePending(int $id, string $quantity, string $total, ?string $comment): bool
    {
        $st = Database::pdo()->prepare(
            "UPDATE work_records SET quantity = ?, total_amount = ?, comment = ?
              WHERE id = ? AND review_status = 'pending' AND voided_at IS NULL"
        );
        $st->execute([$quantity, $total, $comment, $id]);
        return $st->rowCount() === 1;
    }
}
