<?php
declare(strict_types=1);

namespace App\Repositories;

use App\Core\Database;

final class WorkRecordRepository
{
    private const SELECT = 'SELECT wr.id, wr.work_type_id, wr.door_id, wr.user_id, wr.rate_id, wr.quantity, wr.unit,
                                   wr.unit_price, wr.total_amount, wr.completed_at, wr.created_at, wr.created_by,
                                   wr.comment, wr.voided_at, wr.voided_by, wr.void_reason,
                                   wr.review_status, wr.reviewed_by, wr.reviewed_at, wr.reject_reason, wr.can_fix, wr.resubmit_count,
                                   (SELECT COUNT(*) FROM photos ph WHERE ph.work_record_id = wr.id AND ph.deleted_at IS NULL) AS photos_count,
                                   wt.name AS work_type_name, d.number AS door_number,
                                   u.full_name AS user_name, cb.full_name AS created_by_name, vb.full_name AS voided_by_name, rb.full_name AS reviewed_by_name
                            FROM work_records wr
                            JOIN work_types wt ON wt.id = wr.work_type_id
                            LEFT JOIN doors d ON d.id = wr.door_id
                            JOIN users u ON u.id = wr.user_id
                            JOIN users cb ON cb.id = wr.created_by
                            LEFT JOIN users vb ON vb.id = wr.voided_by
                            LEFT JOIN users rb ON rb.id = wr.reviewed_by';

    public function insert(array $d): int
    {
        $pdo = Database::pdo();
        $pdo->prepare(
            'INSERT INTO work_records
                (work_type_id, door_id, user_id, rate_id, quantity, unit, unit_price, total_amount,
                 allow_unique_per_door, completed_at, created_by, comment, review_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\')'
        )->execute([
            $d['work_type_id'], $d['door_id'], $d['user_id'], $d['rate_id'], $d['quantity'], $d['unit'],
            $d['unit_price'], $d['total_amount'], $d['allow_unique_per_door'], $d['completed_at'],
            $d['created_by'], $d['comment'],
        ]);
        return (int) $pdo->lastInsertId();
    }

    public function findDetailed(int $id, bool $forUpdate = false): ?array
    {
        // FOR UPDATE блокирует строки всех join-таблиц; блокируем только запись работы отдельно
        if ($forUpdate) {
            $st = Database::pdo()->prepare('SELECT id FROM work_records WHERE id = ? FOR UPDATE');
            $st->execute([$id]);
            if (!$st->fetch()) {
                return null;
            }
        }
        $st = Database::pdo()->prepare(self::SELECT . ' WHERE wr.id = ?');
        $st->execute([$id]);
        return $st->fetch() ?: null;
    }

    /** Действующая (не аннулированная) запись того же вида для той же двери. */
    public function findActiveDuplicate(int $typeId, int $doorId): ?array
    {
        $st = Database::pdo()->prepare(
            'SELECT id, completed_at FROM work_records WHERE work_type_id = ? AND door_id = ? AND voided_at IS NULL LIMIT 1'
        );
        $st->execute([$typeId, $doorId]);
        return $st->fetch() ?: null;
    }

    /**
     * Условия отбора. $withReview = false — без фильтра по статусу приёмки (для счётчиков трёх списков).
     *
     * @return array{0:string,1:array}
     */
    private function buildWhere(array $f, bool $withReview): array
    {
        $where = [];
        $args = [];
        foreach (['user_id' => 'wr.user_id', 'work_type_id' => 'wr.work_type_id', 'door_id' => 'wr.door_id'] as $key => $col) {
            if (isset($f[$key])) {
                $where[] = "{$col} = ?";
                $args[] = (int) $f[$key];
            }
        }
        if (!empty($f['from_utc'])) {
            $where[] = 'wr.completed_at >= ?';
            $args[] = $f['from_utc'];
        }
        if (!empty($f['to_utc'])) {
            $where[] = 'wr.completed_at < ?';
            $args[] = $f['to_utc'];
        }
        $status = $f['status'] ?? 'active';
        if ($status === 'active') {
            $where[] = 'wr.voided_at IS NULL';
        } elseif ($status === 'voided') {
            $where[] = 'wr.voided_at IS NOT NULL';
        }
        $review = $f['review_status'] ?? 'all';
        if ($withReview && in_array($review, ['pending', 'accepted', 'rejected'], true)) {
            $where[] = 'wr.review_status = ?';
            $args[] = $review;
        }
        return [$where ? ' WHERE ' . implode(' AND ', $where) : '', $args];
    }

    /** @return array{0:array,1:int} */
    public function search(array $f, int $limit, int $offset): array
    {
        [$w, $args] = $this->buildWhere($f, true);

        $pdo = Database::pdo();
        $st = $pdo->prepare('SELECT COUNT(*) FROM work_records wr' . $w);
        $st->execute($args);
        $total = (int) $st->fetchColumn();
        $limit = max(1, $limit);
        $offset = max(0, $offset);
        $order = ($f['order'] ?? 'desc') === 'asc' ? 'ASC' : 'DESC';
        $st = $pdo->prepare(self::SELECT . "{$w} ORDER BY wr.completed_at {$order}, wr.id {$order} LIMIT {$limit} OFFSET {$offset}");
        $st->execute($args);
        return [$st->fetchAll(), $total];
    }

    /** Сколько работ в каждом статусе приёмки при тех же прочих фильтрах. @return array{pending:int,accepted:int,rejected:int} */
    public function reviewCounts(array $f): array
    {
        [$w, $args] = $this->buildWhere($f, false);
        $st = Database::pdo()->prepare('SELECT wr.review_status AS s, COUNT(*) AS c FROM work_records wr' . $w . ' GROUP BY wr.review_status');
        $st->execute($args);
        $out = ['pending' => 0, 'accepted' => 0, 'rejected' => 0];
        foreach ($st->fetchAll() as $r) {
            $out[$r['s']] = (int) $r['c'];
        }
        return $out;
    }

    /** Блокирует запись работы и возвращает её сырые поля (для приёмки/исправления). */
    public function lockRaw(int $id): ?array
    {
        $st = Database::pdo()->prepare('SELECT * FROM work_records WHERE id = ? FOR UPDATE');
        $st->execute([$id]);
        return $st->fetch() ?: null;
    }

    public function markAccepted(int $id, int $by, string $atUtc): void
    {
        Database::pdo()->prepare(
            "UPDATE work_records SET review_status = 'accepted', reviewed_by = ?, reviewed_at = ?, reject_reason = NULL, can_fix = NULL WHERE id = ?"
        )->execute([$by, $atUtc, $id]);
    }

    public function markRejected(int $id, int $by, string $atUtc, string $reason, bool $canFix): void
    {
        Database::pdo()->prepare(
            "UPDATE work_records SET review_status = 'rejected', reviewed_by = ?, reviewed_at = ?, reject_reason = ?, can_fix = ? WHERE id = ?"
        )->execute([$by, $atUtc, $reason, $canFix ? 1 : 0, $id]);
    }

    /** Исправленная работа снова ждёт приёмки. Прежняя причина сохраняется в журнале решений. */
    public function markResubmitted(int $id, string $quantity, string $total, ?string $comment): void
    {
        Database::pdo()->prepare(
            "UPDATE work_records SET review_status = 'pending', reviewed_by = NULL, reviewed_at = NULL, reject_reason = NULL, can_fix = NULL,
                    quantity = ?, total_amount = ?, comment = ?, resubmit_count = resubmit_count + 1 WHERE id = ?"
        )->execute([$quantity, $total, $comment, $id]);
    }

    public function insertReview(int $recordId, string $action, int $actorId, ?string $reason, ?bool $canFix, string $atUtc): void
    {
        Database::pdo()->prepare(
            'INSERT INTO work_record_reviews (work_record_id, action, actor_id, reason, can_fix, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([$recordId, $action, $actorId, $reason, $canFix === null ? null : ($canFix ? 1 : 0), $atUtc]);
    }

    /** История решений по работе, от раннего к позднему. */
    public function reviews(int $recordId): array
    {
        $st = Database::pdo()->prepare(
            'SELECT r.id, r.action, r.reason, r.can_fix, r.created_at, r.actor_id, u.full_name AS actor_name
             FROM work_record_reviews r JOIN users u ON u.id = r.actor_id WHERE r.work_record_id = ? ORDER BY r.id'
        );
        $st->execute([$recordId]);
        return $st->fetchAll();
    }

    public function markVoided(int $id, int $by, string $reason, string $atUtc): void
    {
        Database::pdo()->prepare('UPDATE work_records SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?')
            ->execute([$atUtc, $by, $reason, $id]);
    }

    /** Работа входит в действующий расчётный период? */
    public function inActivePayroll(int $id): bool
    {
        $st = Database::pdo()->prepare('SELECT 1 FROM payroll_run_items WHERE work_record_id = ? AND is_active = 1 LIMIT 1');
        $st->execute([$id]);
        return (bool) $st->fetchColumn();
    }

    /** По работе есть распределения выплат (кроме отменённых выплат)? */
    public function hasPostedAllocation(int $id): bool
    {
        $st = Database::pdo()->prepare(
            "SELECT 1 FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
             WHERE pa.work_record_id = ? AND p.status <> 'cancelled' LIMIT 1"
        );
        $st->execute([$id]);
        return (bool) $st->fetchColumn();
    }
}
