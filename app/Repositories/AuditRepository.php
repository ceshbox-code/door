<?php
declare(strict_types=1);

namespace App\Repositories;

use App\Core\Database;

final class AuditRepository
{
    private static function json(?array $v): ?string
    {
        return $v === null ? null : json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    public function insert(
        ?int $userId, string $action, string $entityType, ?int $entityId,
        ?array $old, ?array $new, ?string $reason, ?string $ip
    ): void {
        Database::pdo()->prepare(
            'INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_values, new_values, reason, ip_address)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$userId, $action, $entityType, $entityId, self::json($old), self::json($new), $reason, $ip]);
    }

    /**
     * Журнал только читается (запись — через insert; редактирования и удаления нет).
     * @param array{user_id?:int,action?:string,entity_type?:string,entity_id?:int,from_utc?:?string,to_utc?:?string} $f
     * @return array{0:array,1:int}
     */
    public function search(array $f, int $limit, int $offset): array
    {
        $where = [];
        $args = [];
        if (isset($f['user_id'])) {
            $where[] = 'a.user_id = ?';
            $args[] = (int) $f['user_id'];
        }
        if (!empty($f['action'])) {
            $where[] = 'a.action = ?';
            $args[] = $f['action'];
        }
        if (!empty($f['entity_type'])) {
            $where[] = 'a.entity_type = ?';
            $args[] = $f['entity_type'];
        }
        if (isset($f['entity_id'])) {
            $where[] = 'a.entity_id = ?';
            $args[] = (int) $f['entity_id'];
        }
        if (!empty($f['from_utc'])) {
            $where[] = 'a.created_at >= ?';
            $args[] = $f['from_utc'];
        }
        if (!empty($f['to_utc'])) {
            $where[] = 'a.created_at < ?';
            $args[] = $f['to_utc'];
        }
        $w = $where ? ' WHERE ' . implode(' AND ', $where) : '';
        $pdo = Database::pdo();
        $st = $pdo->prepare('SELECT COUNT(*) FROM audit_log a' . $w);
        $st->execute($args);
        $total = (int) $st->fetchColumn();
        $limit = max(1, $limit);
        $offset = max(0, $offset);
        $st = $pdo->prepare(
            'SELECT a.*, u.full_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id'
            . "{$w} ORDER BY a.created_at DESC, a.id DESC LIMIT {$limit} OFFSET {$offset}"
        );
        $st->execute($args);
        return [$st->fetchAll(), $total];
    }
}
