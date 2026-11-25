<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Core\Request;
use App\Core\Response;
use App\Repositories\ReviewQueueRepository;

/**
 * Счётчик работ, ожидающих приёмки (значок у пункта меню «Приёмка работ»).
 * Право work.review проверяет Guard в routes.php (только директор).
 */
final class ReviewCountController extends BaseController
{
    private ReviewQueueRepository $queue;

    public function __construct()
    {
        $this->queue = new ReviewQueueRepository();
    }

    public function pendingCount(Request $r): Response
    {
        // Сессия здесь только читается: снимаем блокировку файла сессии, чтобы частый опрос
        // не задерживал другие запросы этого же пользователя.
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        return Response::ok(['count' => $this->queue->countPending()]);
    }
}
