<?php
declare(strict_types=1);

namespace App\Services;

use App\Helpers\Cbor;
use InvalidArgumentException;

/**
 * Проверка данных WebAuthn (https://www.w3.org/TR/webauthn-2/). Чистые функции без доступа к БД и сессии.
 * Поддерживается один алгоритм — ES256 (ECDSA P-256 + SHA-256): его используют встроенные сенсоры телефонов
 * (Android, iOS) и компьютеров. Аттестация не проверяется: аутентификатор запрашивается с attestation="none",
 * доверие обеспечивается обязательной проверкой пользователя (отпечаток/лицо — флаг UV) и привязкой к домену.
 * Все ошибки — InvalidArgumentException с понятным описанием причины (для журнала аудита).
 */
final class WebAuthnVerifier
{
    public const FLAG_UP = 0x01;   // присутствие пользователя
    public const FLAG_UV = 0x04;   // пользователь проверен (биометрия или PIN)
    public const FLAG_AT = 0x40;   // есть данные ключа (при регистрации)

    /** Префикс DER SubjectPublicKeyInfo для открытого ключа P-256 в несжатом виде (0x04 || X || Y). */
    private const SPKI_P256_PREFIX_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

    /** Проверяет clientDataJSON: тип операции, challenge, источник (origin). */
    public static function checkClientData(string $json, string $expectedType, string $expectedChallenge, string $expectedOrigin): void
    {
        $data = json_decode($json, true);
        if (!is_array($data)) {
            throw new InvalidArgumentException('clientDataJSON не является JSON');
        }
        if (($data['type'] ?? null) !== $expectedType) {
            throw new InvalidArgumentException('неверный тип операции в clientDataJSON');
        }
        $challenge = $data['challenge'] ?? null;
        if (!is_string($challenge) || !hash_equals($expectedChallenge, $challenge)) {
            throw new InvalidArgumentException('challenge не совпадает');
        }
        $origin = $data['origin'] ?? null;
        if (!is_string($origin) || !hash_equals(rtrim($expectedOrigin, '/'), $origin)) {
            throw new InvalidArgumentException('origin не совпадает');
        }
        if (($data['crossOrigin'] ?? false) === true) {
            throw new InvalidArgumentException('запрос из чужого фрейма (crossOrigin)');
        }
    }

    /**
     * Разбор authenticatorData.
     * @return array{rpIdHash:string,flags:int,signCount:int,credentialId:?string,cosePublicKey:?array}
     */
    public static function parseAuthData(string $bin): array
    {
        if (strlen($bin) < 37) {
            throw new InvalidArgumentException('authenticatorData слишком короткая');
        }
        $out = [
            'rpIdHash'      => substr($bin, 0, 32),
            'flags'         => ord($bin[32]),
            'signCount'     => unpack('N', substr($bin, 33, 4))[1],
            'credentialId'  => null,
            'cosePublicKey' => null,
        ];
        if (($out['flags'] & self::FLAG_AT) !== 0) {
            $offset = 37;
            if (strlen($bin) < $offset + 18) {
                throw new InvalidArgumentException('данные ключа обрезаны');
            }
            $offset += 16;                                   // AAGUID
            $idLen = unpack('n', substr($bin, $offset, 2))[1];
            $offset += 2;
            if ($idLen < 1 || $idLen > 1023 || strlen($bin) < $offset + $idLen) {
                throw new InvalidArgumentException('некорректная длина идентификатора ключа');
            }
            $out['credentialId'] = substr($bin, $offset, $idLen);
            $offset += $idLen;
            $cose = Cbor::decode($bin, $offset);
            if (!is_array($cose)) {
                throw new InvalidArgumentException('открытый ключ (COSE) имеет неверный формат');
            }
            $out['cosePublicKey'] = $cose;
        }
        return $out;
    }

    /** Домен и флаги: rpIdHash, присутствие (UP) и проверка пользователя (UV) обязательны. */
    public static function checkAuthData(array $parsed, string $rpId, bool $attestedDataRequired): void
    {
        if (!hash_equals(hash('sha256', $rpId, true), $parsed['rpIdHash'])) {
            throw new InvalidArgumentException('rpIdHash не соответствует домену');
        }
        if (($parsed['flags'] & self::FLAG_UP) === 0) {
            throw new InvalidArgumentException('нет подтверждения присутствия пользователя');
        }
        if (($parsed['flags'] & self::FLAG_UV) === 0) {
            throw new InvalidArgumentException('пользователь не подтверждён биометрией или PIN');
        }
        if ($attestedDataRequired && ($parsed['flags'] & self::FLAG_AT) === 0) {
            throw new InvalidArgumentException('в ответе нет данных ключа');
        }
    }

    /** Открытый ключ COSE (EC2, ES256, P-256) -> PEM. Проверяет, что точка лежит на кривой. */
    public static function coseToPem(array $cose): string
    {
        if (($cose[1] ?? null) !== 2 || ($cose[3] ?? null) !== -7 || ($cose[-1] ?? null) !== 1) {
            throw new InvalidArgumentException('поддерживается только ключ ES256 (P-256)');
        }
        $x = $cose[-2] ?? null;
        $y = $cose[-3] ?? null;
        if (!is_string($x) || !is_string($y) || strlen($x) !== 32 || strlen($y) !== 32) {
            throw new InvalidArgumentException('некорректные координаты ключа');
        }
        $der = hex2bin(self::SPKI_P256_PREFIX_HEX) . "\x04" . $x . $y;
        $pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
        if (openssl_pkey_get_public($pem) === false) {
            throw new InvalidArgumentException('точка не лежит на кривой P-256');
        }
        return $pem;
    }

    /** Подпись над authenticatorData || SHA-256(clientDataJSON); подпись WebAuthn для ES256 — ASN.1 DER. */
    public static function verifySignature(string $authDataBin, string $clientDataJson, string $signature, string $pem): bool
    {
        $key = openssl_pkey_get_public($pem);
        if ($key === false) {
            return false;
        }
        $signed = $authDataBin . hash('sha256', $clientDataJson, true);
        return openssl_verify($signed, $signature, $key, OPENSSL_ALGO_SHA256) === 1;
    }

    /**
     * Счётчик подписей: если он используется (значение ненулевое), он обязан расти — иначе ключ мог быть
     * склонирован. Многие платформенные аутентификаторы всегда возвращают 0 — это допустимо.
     */
    public static function counterIsValid(int $stored, int $received): bool
    {
        if ($stored === 0 && $received === 0) {
            return true;
        }
        return $received > $stored;
    }

    /** Непрозрачный идентификатор пользователя для аутентификатора (не содержит личных данных). */
    public static function userHandle(int $userId): string
    {
        return hash('sha256', 'door-webauthn-user:' . $userId, true);
    }

    /** Разбор attestationObject регистрации (CBOR) -> байты authData. */
    public static function authDataFromAttestation(string $attestationObject): string
    {
        $obj = Cbor::decodeAll($attestationObject);
        if (!is_array($obj) || !isset($obj['authData']) || !is_string($obj['authData'])) {
            throw new InvalidArgumentException('attestationObject не содержит authData');
        }
        return $obj['authData'];
    }
}
