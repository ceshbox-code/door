<?php
declare(strict_types=1);

namespace App\Services;

use App\Core\ApiException;
use App\Core\Config;
use App\Helpers\CaptchaImage;
use App\Repositories\AuthChallengeRepository;
use App\Repositories\LoginAttemptRepository;
use Throwable;

/**
 * Капча при входе по паролю. Режим задаётся CAPTCHA_MODE в .env:
 *   always         — всегда (по умолчанию);
 *   after_failures — после неудачных попыток входа с этого IP;
 *   off            — выключена.
 * Ответ хранится только в виде хэша с солью, каждая капча одноразовая и живёт 5 минут.
 */
final class CaptchaService
{
    public const ALPHABET = 'ABCDEFGHJKLMNPRSTUVXYZ23456789';   // без похожих I, O, Q, 0, 1
    public const LENGTH = 5;
    public const TTL_SECONDS = 300;
    public const FAILURES_BEFORE_REQUIRED = 2;
    private const MAX_NEW_PER_IP_PER_MINUTE = 30;

    private AuthChallengeRepository $challenges;
    private LoginAttemptRepository $attempts;

    public function __construct(?AuthChallengeRepository $challenges = null, ?LoginAttemptRepository $attempts = null)
    {
        $this->challenges = $challenges ?? new AuthChallengeRepository();
        $this->attempts = $attempts ?? new LoginAttemptRepository();
    }

    public static function mode(): string
    {
        $m = strtolower(trim((string) Config::get('auth.captcha_mode', 'always')));
        return in_array($m, ['off', 'after_failures', 'always'], true) ? $m : 'always';
    }

    /** Нужна ли капча для входа с этого IP прямо сейчас. */
    public function required(string $ip): bool
    {
        switch (self::mode()) {
            case 'off':
                return false;
            case 'after_failures':
                return $this->attempts->failuresByIp($ip, LoginThrottle::WINDOW_MINUTES) >= self::FAILURES_BEFORE_REQUIRED;
            default:
                return true;
        }
    }

    /** @return array{captcha_id:string,image:string,expires_in:int} */
    public function create(string $ip): array
    {
        if ($this->challenges->countRecentByIp($ip, 60) >= self::MAX_NEW_PER_IP_PER_MINUTE) {
            throw new ApiException('TOO_MANY_REQUESTS', 'Слишком много запросов. Подождите минуту.', 429);
        }
        $text = self::randomText();
        try {
            $png = CaptchaImage::render($text);
        } catch (Throwable $e) {
            throw new ApiException('CAPTCHA_UNAVAILABLE', 'Не удалось сформировать проверочную картинку. Обратитесь к администратору.', 503);
        }
        $salt = bin2hex(random_bytes(8));
        $id = bin2hex(random_bytes(16));
        $this->challenges->create($id, 'captcha', null, $salt . ':' . hash('sha256', $salt . $text), $ip, self::TTL_SECONDS);
        if (random_int(1, 25) === 1) {
            $this->challenges->purgeExpired();
        }
        return ['captcha_id' => $id, 'image' => 'data:image/png;base64,' . base64_encode($png), 'expires_in' => self::TTL_SECONDS];
    }

    /** Проверяет ответ и в любом случае «сжигает» капчу: повторно использовать её нельзя. */
    public function verify(?string $id, ?string $answer): bool
    {
        if ($id === null || $answer === null) {
            return false;
        }
        $row = $this->challenges->consume($id, 'captcha');
        if ($row === null) {
            return false;
        }
        [$salt, $hash] = array_pad(explode(':', (string) $row['payload'], 2), 2, '');
        return hash_equals($hash, hash('sha256', $salt . self::normalize($answer)));
    }

    /** Верхний регистр, без пробелов; похожие кириллические буквы приводятся к латинским (клавиатура телефона). */
    public static function normalize(string $answer): string
    {
        $s = mb_strtoupper(preg_replace('/\s+/u', '', $answer) ?? '', 'UTF-8');
        return strtr($s, [
            'А' => 'A', 'В' => 'B', 'С' => 'C', 'Е' => 'E', 'Н' => 'H', 'К' => 'K', 'М' => 'M', 'Р' => 'P', 'Т' => 'T', 'Х' => 'X',
        ]);
    }

    public static function randomText(): string
    {
        $max = strlen(self::ALPHABET) - 1;
        $t = '';
        for ($i = 0; $i < self::LENGTH; $i++) {
            $t .= self::ALPHABET[random_int(0, $max)];
        }
        return $t;
    }
}
