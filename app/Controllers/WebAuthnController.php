<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Core\Request;
use App\Core\Response;
use App\Helpers\Input;
use App\Core\ApiException;
use App\Services\WebAuthnService;

final class WebAuthnController
{
    private WebAuthnService $svc;

    public function __construct()
    {
        $this->svc = new WebAuthnService();
    }

    // --- вошедший пользователь (Guard::auth) ---
    public function registerOptions(Request $r): Response
    {
        return Response::ok($this->svc->registerOptions($r->user, $r->ip));
    }

    public function registerVerify(Request $r): Response
    {
        return Response::ok($this->svc->registerVerify($r->user, $r->json(), $r->ip), 201);
    }

    public function credentials(Request $r): Response
    {
        return Response::ok(['items' => $this->svc->listCredentials((int) $r->user['id'])]);
    }

    public function revoke(Request $r): Response
    {
        $id = Input::id($r->params['id'] ?? null);
        if ($id === null) {
            throw new ApiException('VALIDATION_ERROR', 'Некорректный идентификатор', 422);
        }
        $this->svc->revoke($r->user, $id, $r->ip);
        return Response::ok(null);
    }

    // --- без входа ---
    public function loginOptions(Request $r): Response
    {
        return Response::ok($this->svc->loginOptions($r->ip));
    }

    public function loginVerify(Request $r): Response
    {
        return Response::ok($this->svc->loginVerify($r->json(), $r->ip));
    }
}
