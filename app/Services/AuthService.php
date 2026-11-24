<?php
declare(strict_types=1);

namespace App\Services;

use App\Core\ApiException;
use App\Core\Csrf;
use App\Core\Permissions;
use App\Core\Session;
use App\Helpers\PasswordHasher;
use App\Models\User;
use App\Repositories\LoginAttemptRepository;
use App\Repositories\UserRepository;

final class AuthService
{
    private static bool $resolved = false;
    private static ?array $current = null;

    private UserRepository $users;
    private LoginAttemptRepository $attempts;
    private AuditService $audit;

    public function __construct()
    {
        $this->users    = new UserRepository();
        $this->attempts = new LoginAttemptRepository();
        $this->audit    = new AuditService();
    }

    /** Ответ для /auth/login и /auth/me. */
    public function payload(array $userRow): array
    {
        return [
            'user'        => User::present($userRow),
            'permissions' => Permissions::forRole($userRow['role']),
            'csrf_token'  => Csrf::token(),
        ];
    }

    public function login(string $username, string $password, string $ip, ?string $captchaId = null, ?string $captchaAnswer = null): array
    {
        $username = trim($username);
        if ($username === '' || $password === '') {
            throw new ApiException('VALIDATION_ERROR', 'Укажите логин и пароль', 422);
        }

        // Капча проверяется до любых обращений к пользователям и паролям: без неё перебор невозможен.
        $captcha = new CaptchaService();
        if ($captcha->required($ip)) {
            if ($captchaId === null || $captchaId === '' || $captchaAnswer === null || trim($captchaAnswer) === '') {
                throw new ApiException('CAPTCHA_REQUIRED', 'Введите символы с картинки', 422);
            }
            if (!$captcha->verify($captchaId, $captchaAnswer)) {
                $this->audit->log(null, 'auth.captcha_failed', 'user', null, null, ['username' => $username], null, $ip);
                throw new ApiException('CAPTCHA_INVALID', 'Неверные символы с картинки. Попробуйте ещё раз.', 422);
            }
        }

        $byUser = $this->attempts->failuresByUsername($username, LoginThrottle::WINDOW_MINUTES);
        $byIp   = $this->attempts->failuresByIp($ip, LoginThrottle::WINDOW_MINUTES);
        if (LoginThrottle::isBlocked($byUser, $byIp)) {
            $this->audit->log(null, 'auth.login_blocked', 'user', null, null, ['username' => $username], null, $ip);
            throw new ApiException('TOO_MANY_ATTEMPTS', 'Слишком много неудачных попыток входа. Повторите через 15 минут.', 429);
        }

        $row = $this->users->findByUsername($username);
        $reason = null;
        if ($row === null) {
            PasswordHasher::burn($password);
            $reason = 'unknown_user';
        } elseif (!PasswordHasher::verify($password, $row['password_hash'])) {
            $reason = 'bad_password';
        } elseif (!(int) $row['is_active']) {
            $reason = 'inactive';
        }

        $this->attempts->record($username, $ip, $reason === null);
        if ($reason !== null) {
            $this->audit->log(
                $row ? (int) $row['id'] : null, 'auth.login_failed', 'user', $row ? (int) $row['id'] : null,
                null, ['username' => $username, 'reason' => $reason], null, $ip
            );
            // Одинаковый ответ для всех причин: нельзя выяснить, существует ли логин.
            throw new ApiException('INVALID_CREDENTIALS', 'Неверный логин или пароль', 401);
        }

        $this->attempts->clearFailures($username);
        if (random_int(1, 50) === 1) {
            $this->attempts->purgeOld();
        }
        if (PasswordHasher::needsRehash($row['password_hash'])) {
            $this->users->update((int) $row['id'], ['password_hash' => PasswordHasher::hash($password)]);
        }

        return $this->startSession($row, $ip, null);
    }

    /**
     * Открывает сессию пользователя (общий шаг для входа по паролю и по биометрии):
     * новый идентификатор сессии против фиксации, новый CSRF-токен, запись в аудит.
     * @param array|null $auditDetails дополнительные сведения для журнала (например, способ входа)
     */
    public function startSession(array $row, string $ip, ?array $auditDetails): array
    {
        Session::start();
        session_regenerate_id(true);               // защита от фиксации сессии
        $_SESSION['user_id'] = (int) $row['id'];
        $_SESSION['login_at'] = time();
        Csrf::rotate();
        self::$resolved = false;

        $this->audit->log((int) $row['id'], 'auth.login', 'user', (int) $row['id'], null, $auditDetails, null, $ip);
        return $this->payload($row);
    }

    public function logout(array $user, string $ip): void
    {
        $this->audit->log((int) $user['id'], 'auth.logout', 'user', (int) $user['id'], null, null, null, $ip);
        Session::destroy();
        self::$resolved = true;
        self::$current = null;
    }

    /**
     * Пользователь текущей сессии. Каждый раз перечитывается из БД, поэтому деактивация
     * и смена роли действуют немедленно. Хэш пароля наружу не отдаётся.
     */
    public function currentUser(): ?array
    {
        if (self::$resolved) {
            return self::$current;
        }
        self::$resolved = true;
        self::$current = null;

        if (!Session::hasCookie()) {
            return null;
        }
        Session::start();
        $id = (int) ($_SESSION['user_id'] ?? 0);
        if ($id <= 0) {
            return null;
        }
        $row = $this->users->find($id);
        if ($row === null || !(int) $row['is_active']) {
            Session::destroy();
            return null;
        }
        unset($row['password_hash']);
        return self::$current = $row;
    }
}
