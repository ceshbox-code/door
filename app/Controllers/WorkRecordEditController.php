<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Core\ApiException;
use App\Core\Request;
use App\Core\Response;
use App\Services\WorkRecordEditService;

/** POST /api/v1/work-records/{id}/edit — изменение собственной работы до приёмки (multipart: quantity, comment, photos[]). */
final class WorkRecordEditController extends BaseController
{
    private WorkRecordEditService $service;

    public function __construct()
    {
        $this->service = new WorkRecordEditService();
    }

    public function edit(Request $r): Response
    {
        if ($r->bodyTooLarge) {
            throw new ApiException('PAYLOAD_TOO_LARGE', 'Размер запроса превышает допустимый (64 МБ)', 413);
        }
        return Response::ok($this->service->edit($r->user, self::id($r, 'Запись о работе не найдена'), $r->input(), $r->files, $r->ip));
    }
}
