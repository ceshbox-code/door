<?php
declare(strict_types=1);

namespace App\Helpers;

/** Base64url без заполнения (RFC 4648 §5) — формат WebAuthn. */
final class Base64Url
{
    public static function encode(string $binary): string
    {
        return rtrim(strtr(base64_encode($binary), '+/', '-_'), '=');
    }

    /** Строгое декодирование: только алфавит base64url, без «=», иначе null. */
    public static function decode(string $text): ?string
    {
        if ($text === '' || !preg_match('/^[A-Za-z0-9_-]+$/', $text) || strlen($text) % 4 === 1) {
            return null;
        }
        $padded = strtr($text, '-_', '+/') . str_repeat('=', (4 - strlen($text) % 4) % 4);
        $binary = base64_decode($padded, true);
        return $binary === false ? null : $binary;
    }
}
