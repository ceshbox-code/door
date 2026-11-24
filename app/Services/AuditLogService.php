<?php
declare(strict_types=1);

namespace App\Services;

use App\Core\Config;
use App\Helpers\Input;
use App\Models\AuditEntry;
use App\Repositories\AuditRepository;
use App\Validators\AuditValidator;

/** Просмотр журнала действий (ТЗ 11.11). Только чтение; доступ — право audit.view (проверяется в маршруте). */
final class AuditLogService
{
    private AuditRepository $repo;

    public function __construct(?AuditRepository $repo = null)
    {
        $this->repo = $repo ?? new AuditRepository();
    }

    public function list(array $query): array
    {
        $f = AuditValidator::filters($query, (string) Config::get('app.timezone', 'UTC'));
        [$page, $per] = Input::paging($query, 50);
        [$rows, $total] = $this->repo->search($f, $per, ($page - 1) * $per);
        return ['items' => array_map([AuditEntry::class, 'present'], $rows), 'page' => $page, 'per_page' => $per, 'total' => $total];
    }
}
