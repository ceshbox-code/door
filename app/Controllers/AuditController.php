<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Core\Request;
use App\Core\Response;
use App\Services\AuditLogService;

final class AuditController extends BaseController
{
    private AuditLogService $log;

    public function __construct()
    {
        $this->log = new AuditLogService();
    }

    public function index(Request $r): Response
    {
        return Response::ok($this->log->list($r->query));
    }
}
