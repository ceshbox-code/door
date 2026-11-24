<?php
declare(strict_types=1);

namespace App\Models;

use App\Helpers\Dates;

final class AuditEntry
{
    private static function decode($json): ?array
    {
        if ($json === null || $json === '') {
            return null;
        }
        $v = json_decode((string) $json, true);
        return is_array($v) ? $v : null;
    }

    /** Строка audit_log (+ user_name из LEFT JOIN) -> представление для API. Пользователя может не быть (неудачный вход, системные события). */
    public static function present(array $r): array
    {
        return [
            'id'          => (int) $r['id'],
            'user'        => $r['user_id'] === null ? null : ['id' => (int) $r['user_id'], 'full_name' => $r['user_name'] ?? null],
            'action'      => $r['action'],
            'entity_type' => $r['entity_type'],
            'entity_id'   => $r['entity_id'] === null ? null : (int) $r['entity_id'],
            'old_values'  => self::decode($r['old_values'] ?? null),
            'new_values'  => self::decode($r['new_values'] ?? null),
            'reason'      => $r['reason'],
            'ip_address'  => $r['ip_address'],
            'created_at'  => Dates::toIso($r['created_at']),
        ];
    }
}
