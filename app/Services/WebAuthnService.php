<?php
declare(strict_types=1);

namespace App\Services;

use App\Core\ApiException;
use App\Core\Config;
use App\Helpers\Base64Url;
use App\Repositories\AuthChallengeRepository;
use App\Repositories\LoginAttemptRepository;
use App\Repositories\UserRepository;
use App\Repositories\WebAuthnCredentialRepository;
use InvalidArgumentException;
use PDOException;

/**
 * Вход по биометрии (отпечаток, лицо) через WebAuthn/passkey. Биометрия остаётся на устройстве пользователя;
 * сервер хранит только открытый ключ. Включается заданием WEBAUTHN_RP_ID и WEBAUTHN_ORIGIN в .env.
 */
final class WebAuthnService
{
    private const CHALLENGE_TTL = 300;
    private const MAX_CREDENTIALS_PER_USER = 5;
    private const MAX_CHALLENGES_PER_IP_PER_MINUTE = 20;

    private AuthChallengeRepository $challenges;
    private WebAuthnCredentialRepository $credentials;
    private UserRepository $users;
    private LoginAttemptRepository $attempts;
    private AuditService $audit;
    private ?AuthService $auth;

    public function __construct(
        ?AuthChallengeRepository $challenges = null,
        ?WebAuthnCredentialRepository $credentials = null,
        ?UserRepository $users = null,
        ?LoginAttemptRepository $attempts = null,
        ?AuditService $audit = null,
        ?AuthService $auth = null
    ) {
        $this->challenges  = $challenges ?? new AuthChallengeRepository();
        $this->credentials = $credentials ?? new WebAuthnCredentialRepository();
        $this->users       = $users ?? new UserRepository();
        $this->attempts    = $attempts ?? new LoginAttemptRepository();
        $this->audit       = $audit ?? new AuditService();
        $this->auth        = $auth;
    }

    public static function rpId(): string
    {
        return strtolower(trim((string) Config::get('auth.webauthn_rp_id', '')));
    }

    public static function origin(): string
    {
        return rtrim(trim((string) Config::get('auth.webauthn_origin', '')), '/');
    }

    /** Включено ли: заданы домен и адрес, адрес защищённый (https; http допустим только для localhost) и домен ему соответствует. */
    public static function enabled(): bool
    {
        $rp = self::rpId();
        $origin = self::origin();
        if ($rp === '' || $origin === '') {
            return false;
        }
        $parts = parse_url($origin);
        $host = strtolower((string) ($parts['host'] ?? ''));
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        if ($host === '' || !($scheme === 'https' || ($scheme === 'http' && $host === 'localhost'))) {
            return false;
        }
        return $host === $rp || str_ends_with($host, '.' . $rp);
    }

    private function requireEnabled(): void
    {
        if (!self::enabled()) {
            throw new ApiException('WEBAUTHN_DISABLED', 'Вход по биометрии не настроен на сервере', 503);
        }
    }

    private function authService(): AuthService
    {
        return $this->auth ??= new AuthService();
    }

    private function limitChallenges(string $ip): void
    {
        if ($this->challenges->countRecentByIp($ip, 60) >= self::MAX_CHALLENGES_PER_IP_PER_MINUTE) {
            throw new ApiException('TOO_MANY_REQUESTS', 'Слишком много запросов. Подождите минуту.', 429);
        }
    }

    // ------------------------------------------------------------------ регистрация биометрии (вошедший пользователь)

    public function registerOptions(array $user, string $ip): array
    {
        $this->requireEnabled();
        $this->limitChallenges($ip);
        $uid = (int) $user['id'];
        $existing = $this->credentials->listActive($uid);
        if (count($existing) >= self::MAX_CREDENTIALS_PER_USER) {
            throw new ApiException('WEBAUTHN_LIMIT', 'Достигнут предел: не более ' . self::MAX_CREDENTIALS_PER_USER . ' устройств. Отключите ненужное.', 409);
        }
        $challenge = Base64Url::encode(random_bytes(32));
        $id = bin2hex(random_bytes(16));
        $this->challenges->create($id, 'webauthn_register', $uid, $challenge, $ip, self::CHALLENGE_TTL);

        return [
            'challenge_id' => $id,
            'publicKey' => [
                'challenge' => $challenge,
                'rp'        => ['id' => self::rpId(), 'name' => (string) Config::get('app.org_name', 'Учёт дверей')],
                'user'      => [
                    'id'          => Base64Url::encode(WebAuthnVerifier::userHandle($uid)),
                    'name'        => (string) $user['username'],
                    'displayName' => (string) $user['full_name'],
                ],
                'pubKeyCredParams'       => [['type' => 'public-key', 'alg' => -7]],
                'timeout'                => 60000,
                'attestation'            => 'none',
                'authenticatorSelection' => [
                    'authenticatorAttachment' => 'platform',
                    'residentKey'             => 'required',
                    'requireResidentKey'      => true,
                    'userVerification'        => 'required',
                ],
                'excludeCredentials' => array_map(
                    static fn(array $c): array => ['type' => 'public-key', 'id' => $c['credential_id']],
                    $existing
                ),
            ],
        ];
    }

    public function registerVerify(array $user, array $in, string $ip): array
    {
        $this->requireEnabled();
        $uid = (int) $user['id'];

        $row = $this->challenges->consume((string) ($in['challenge_id'] ?? ''), 'webauthn_register');
        if ($row === null || (int) $row['user_id'] !== $uid) {
            throw new ApiException('CHALLENGE_EXPIRED', 'Время подтверждения истекло. Повторите попытку.', 400);
        }
        $resp = $in['response'] ?? null;
        $idB64 = $in['id'] ?? null;
        if (!is_array($resp) || !is_string($idB64)) {
            throw new ApiException('VALIDATION_ERROR', 'Некорректный ответ устройства', 422);
        }
        $clientData = Base64Url::decode((string) ($resp['clientDataJSON'] ?? ''));
        $attestation = Base64Url::decode((string) ($resp['attestationObject'] ?? ''));
        if ($clientData === null || $attestation === null) {
            throw new ApiException('VALIDATION_ERROR', 'Некорректный ответ устройства', 422);
        }

        try {
            WebAuthnVerifier::checkClientData($clientData, 'webauthn.create', (string) $row['payload'], self::origin());
            $authBin = WebAuthnVerifier::authDataFromAttestation($attestation);
            $parsed = WebAuthnVerifier::parseAuthData($authBin);
            WebAuthnVerifier::checkAuthData($parsed, self::rpId(), true);
            $credId = (string) $parsed['credentialId'];
            if (strlen($credId) > 255) {
                throw new InvalidArgumentException('идентификатор ключа длиннее 255 байт');
            }
            if (!hash_equals(Base64Url::encode($credId), $idB64)) {
                throw new InvalidArgumentException('идентификатор ключа не совпадает с ответом');
            }
            $pem = WebAuthnVerifier::coseToPem($parsed['cosePublicKey']);
        } catch (InvalidArgumentException $e) {
            $this->audit->log($uid, 'auth.webauthn_register_failed', 'user', $uid, null, ['reason' => $e->getMessage()], null, $ip);
            throw new ApiException('WEBAUTHN_FAILED', 'Не удалось включить вход по биометрии. Повторите попытку.', 422, ['reason' => $e->getMessage()]);
        }

        $credIdB64 = Base64Url::encode($credId);
        if ($this->credentials->exists($credIdB64)) {
            throw new ApiException('WEBAUTHN_DUPLICATE', 'Это устройство уже зарегистрировано.', 409);
        }
        $label = mb_substr(trim((string) ($in['label'] ?? '')), 0, 100);
        if ($label === '') {
            $label = 'Устройство';
        }
        try {
            $newId = $this->credentials->insert($uid, $credIdB64, $pem, (int) $parsed['signCount'], $label);
        } catch (PDOException $e) {
            throw new ApiException('WEBAUTHN_DUPLICATE', 'Это устройство уже зарегистрировано.', 409);
        }
        $this->audit->log($uid, 'auth.webauthn_register', 'user', $uid, null, ['credential_id' => $newId, 'label' => $label], null, $ip);

        $created = $this->credentials->find($newId);
        return self::present($created);
    }

    public function listCredentials(int $userId): array
    {
        return array_map([self::class, 'present'], $this->credentials->listActive($userId));
    }

    public function revoke(array $user, int $credentialId, string $ip): void
    {
        $uid = (int) $user['id'];
        if (!$this->credentials->revoke($credentialId, $uid)) {
            throw new ApiException('NOT_FOUND', 'Ключ не найден', 404);
        }
        $this->audit->log($uid, 'auth.webauthn_revoke', 'user', $uid, null, ['credential_id' => $credentialId], null, $ip);
    }

    // ------------------------------------------------------------------ вход по биометрии (без пароля)

    public function loginOptions(string $ip): array
    {
        $this->requireEnabled();
        $this->limitChallenges($ip);
        $challenge = Base64Url::encode(random_bytes(32));
        $id = bin2hex(random_bytes(16));
        $this->challenges->create($id, 'webauthn_login', null, $challenge, $ip, self::CHALLENGE_TTL);
        return [
            'challenge_id' => $id,
            'publicKey' => [
                'challenge'        => $challenge,
                'rpId'             => self::rpId(),
                'timeout'          => 60000,
                'userVerification' => 'required',
                'allowCredentials' => [],          // «ключи входа» на устройстве; логин вводить не нужно
            ],
        ];
    }

    public function loginVerify(array $in, string $ip): array
    {
        $this->requireEnabled();
        if ($this->attempts->failuresByIp($ip, LoginThrottle::WINDOW_MINUTES) >= LoginThrottle::MAX_PER_IP) {
            $this->audit->log(null, 'auth.login_blocked', 'user', null, null, ['method' => 'webauthn'], null, $ip);
            throw new ApiException('TOO_MANY_ATTEMPTS', 'Слишком много неудачных попыток входа. Повторите через 15 минут.', 429);
        }
        $row = $this->challenges->consume((string) ($in['challenge_id'] ?? ''), 'webauthn_login');
        if ($row === null) {
            throw new ApiException('CHALLENGE_EXPIRED', 'Время подтверждения истекло. Повторите попытку.', 400);
        }
        $resp = $in['response'] ?? null;
        $idB64 = $in['id'] ?? null;
        if (!is_array($resp) || !is_string($idB64)) {
            throw $this->failure('malformed', null, $ip);
        }
        $clientData = Base64Url::decode((string) ($resp['clientDataJSON'] ?? ''));
        $authBin = Base64Url::decode((string) ($resp['authenticatorData'] ?? ''));
        $signature = Base64Url::decode((string) ($resp['signature'] ?? ''));
        if ($clientData === null || $authBin === null || $signature === null) {
            throw $this->failure('malformed', null, $ip);
        }

        $cred = $this->credentials->findActiveByCredentialId($idB64);
        if ($cred === null) {
            throw $this->failure('unknown_credential', null, $ip);
        }
        $uid = (int) $cred['user_id'];
        $user = $this->users->find($uid);
        if ($user === null || !(int) $user['is_active']) {
            throw $this->failure('inactive', $uid, $ip);
        }

        try {
            WebAuthnVerifier::checkClientData($clientData, 'webauthn.get', (string) $row['payload'], self::origin());
            $parsed = WebAuthnVerifier::parseAuthData($authBin);
            WebAuthnVerifier::checkAuthData($parsed, self::rpId(), false);
            $handle = (string) ($resp['userHandle'] ?? '');
            if ($handle !== '') {
                $bin = Base64Url::decode($handle);
                if ($bin === null || !hash_equals(WebAuthnVerifier::userHandle($uid), $bin)) {
                    throw new InvalidArgumentException('идентификатор пользователя не совпадает');
                }
            }
            if (!WebAuthnVerifier::verifySignature($authBin, $clientData, $signature, (string) $cred['public_key'])) {
                throw new InvalidArgumentException('подпись недействительна');
            }
            if (!WebAuthnVerifier::counterIsValid((int) $cred['sign_count'], (int) $parsed['signCount'])) {
                throw new InvalidArgumentException('счётчик подписей не вырос (возможное клонирование ключа)');
            }
        } catch (InvalidArgumentException $e) {
            throw $this->failure($e->getMessage(), $uid, $ip);
        }

        $this->credentials->touch((int) $cred['id'], (int) $parsed['signCount']);
        return $this->authService()->startSession($user, $ip, ['method' => 'webauthn']);
    }

    /** Неудачный вход: журнал попыток, аудит, единый обезличенный ответ. */
    private function failure(string $reason, ?int $userId, string $ip): ApiException
    {
        $this->attempts->record('(webauthn)', $ip, false);
        $this->audit->log($userId, 'auth.login_failed', 'user', $userId, null, ['method' => 'webauthn', 'reason' => $reason], null, $ip);
        return new ApiException('INVALID_CREDENTIALS', 'Не удалось подтвердить вход по биометрии. Войдите по паролю.', 401);
    }

    public static function present(array $c): array
    {
        return [
            'id'           => (int) $c['id'],
            'label'        => (string) $c['label'],
            'created_at'   => \App\Helpers\Dates::toIso($c['created_at']),
            'last_used_at' => \App\Helpers\Dates::toIso($c['last_used_at'] ?? null),
        ];
    }
}
