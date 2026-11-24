<?php
declare(strict_types=1);

namespace App\Core;

/**
 * Матрица прав по ролям (ТЗ, раздел 9). Единственный источник истины:
 * проверка выполняется на сервере в Guard при каждом запросе.
 * Права «_own» дополнительно требуют проверки владельца записи в самом сервисе.
 */
final class Permissions
{
    public const ALL = [
        'users.manage', 'work_types.manage', 'work_types.view', 'work_types.view_all', 'rates.manage', 'rates.view',
        'work.register', 'work.register_for_others', 'work.view_own', 'work.view_all', 'work.void', 'work.review',
        'doors.lookup', 'doors.view', 'doors.create',
        'photos.view', 'photos.delete',
        'finance.view_own', 'finance.view_all', 'finance.manage',
        'stats.view', 'reports.export', 'audit.view', 'settings.manage',
    ];

    /**
     * Решение заказчика: виды работ, расценки и финансовые операции (расчёты, выплаты, корректировки)
     * создаёт и изменяет только директор. Администратор их видит (work_types.view_all, rates.view,
     * finance.view_all), но не изменяет.
     * Приёмку выполненных работ (work.review, ТЗ 2.1) выполняет только директор.
     */
    public const OWNER_EXCLUDED = ['work_types.manage', 'rates.manage', 'finance.manage', 'work.review'];

    private const MATRIX = [
        'master' => [
            'work.register', 'work.view_own', 'work_types.view', 'doors.lookup', 'finance.view_own',
        ],
        'director' => [
            'work.view_all', 'work.review', 'work_types.view', 'work_types.view_all', 'work_types.manage', 'rates.view', 'rates.manage', 'doors.view', 'doors.lookup', 'photos.view',
            'finance.view_all', 'finance.manage', 'stats.view', 'reports.export',
        ],
    ];

    /** @return string[] */
    public static function forRole(string $role): array
    {
        if ($role === 'owner') {
            return array_values(array_diff(self::ALL, self::OWNER_EXCLUDED));
        }
        return self::MATRIX[$role] ?? [];
    }

    public static function can(string $role, string $permission): bool
    {
        return in_array($permission, self::forRole($role), true);
    }
}
