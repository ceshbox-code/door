<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Core\Request;
use App\Core\Response;
use App\Services\AuthService;
use App\Services\CaptchaService;
use App\Services\WebAuthnService;

final class AuthController
{
    private AuthService $auth;

    public function __construct()
    {
        $this->auth = new AuthService();
    }

    public function login(Request $request): Response
    {
        $b = $request->json();
        $data = $this->auth->login(
            (string) ($b['username'] ?? ''),
            (string) ($b['password'] ?? ''),
            $request->ip,
            isset($b['captcha_id']) ? (string) $b['captcha_id'] : null,
            isset($b['captcha_answer']) ? (string) $b['captcha_answer'] : null
        );
        return Response::ok($data);
    }

    /** Публично: что нужно показать на странице входа (капча, вход по биометрии). */
    public function config(Request $request): Response
    {
        $captcha = new CaptchaService();
        return Response::ok([
            'captcha'  => ['mode' => CaptchaService::mode(), 'required' => $captcha->required($request->ip)],
            'webauthn' => ['enabled' => WebAuthnService::enabled()],
        ]);
    }

    /** Публично: новая одноразовая капча (картинка data:image/png). */
    public function captcha(Request $request): Response
    {
        return Response::ok((new CaptchaService())->create($request->ip));
    }

    public function logout(Request $request): Response
    {
        $this->auth->logout($request->user, $request->ip);
        return Response::ok(null);
    }

    public function me(Request $request): Response
    {
        return Response::ok($this->auth->payload($request->user));
    }
}
