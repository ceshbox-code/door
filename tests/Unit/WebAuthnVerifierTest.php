<?php
declare(strict_types=1);

namespace Tests\Unit;

use App\Helpers\Base64Url;
use App\Services\WebAuthnVerifier;
use InvalidArgumentException;
use PHPUnit\Framework\TestCase;

/**
 * Проверка WebAuthn на НАСТОЯЩИХ данных: регистрация и два входа, полученные в Chromium с виртуальным
 * биометрическим аутентификатором (внутренний, с проверкой пользователя). Домен localhost, пользователь №7.
 */
final class WebAuthnVerifierTest extends TestCase
{
    private const ORIGIN = 'http://localhost:8765';
    private const RP_ID = 'localhost';
    private const USER_ID = 7;

    private const REG_CHALLENGE = 'za12sAgoe6GM-1fcY_6lXTEc3iN_OsDTHiv-Ho0Mik8';
    private const REG_ID = '0_tCxhUd3cURfP503TXaVziO3Ua6KSzgb2npkOGoeuo';
    private const REG_CLIENT_DATA = 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiemExMnNBZ29lNkdNLTFmY1lfNmxYVEVjM2lOX09zRFRIaXYtSG8wTWlrOCIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODc2NSIsImNyb3NzT3JpZ2luIjpmYWxzZX0';
    private const REG_ATTESTATION = 'o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVikSZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAAQECAwQFBgcIAQIDBAUGBwgAINP7QsYVHd3FEXz-dN012lc4jt1Guiks4G9p6ZDhqHrqpQECAyYgASFYIDLiJvnRRp3ZcayvIigWZwSA13itYHib8IGVP_P3wQVRIlggu-yRN0e6hSKRX0noso1PSx6KXvaKTupfsCzztr7LHRA';

    private const GET1_CHALLENGE = 'HMolSwqrV0Z1xdAHsxSG97Zp2xNDU2YUVqwoWvpZPOo';
    private const GET1_CLIENT_DATA = 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiSE1vbFN3cXJWMFoxeGRBSHN4U0c5N1pwMnhORFUyWVVWcXdvV3ZwWlBPbyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODc2NSIsImNyb3NzT3JpZ2luIjpmYWxzZX0';
    private const GET1_AUTH_DATA = 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAg';
    private const GET1_SIGNATURE = 'MEUCIQCVblRKFTu0Fp7whriFOsGAW9cNlzG9DmRM7upK6xT-WQIgeIqnB2XhSsi1vSs0-9YB5O4vdMUhGm6Di-o3ddpSVbs';
    private const GET1_USER_HANDLE = 'YqF-0neclhttjo4jTqghV4bEtyoaSpR3pXQBMrjeUZ4';

    private const GET2_CHALLENGE = 'dvharRzv-stcp0cKbYnRh0yHmf_8SDuFvJpf3e1YsaI';
    private const GET2_CLIENT_DATA = 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiZHZoYXJSenYtc3RjcDBjS2JZblJoMHlIbWZfOFNEdUZ2SnBmM2UxWXNhSSIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODc2NSIsImNyb3NzT3JpZ2luIjpmYWxzZX0';
    private const GET2_AUTH_DATA = 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAw';
    private const GET2_SIGNATURE = 'MEUCIDZd59JkK529JxY2me-ByOgF49xzfmjLwXBH3YJdkWsPAiEA_QWWoz0nYJSfvGC3x9K4UVx_j91XO-B-VwIdBuyr9t4';

    private function bin(string $b64u): string
    {
        $b = Base64Url::decode($b64u);
        $this->assertNotNull($b);
        return $b;
    }

    private function registeredPem(): string
    {
        $parsed = WebAuthnVerifier::parseAuthData(WebAuthnVerifier::authDataFromAttestation($this->bin(self::REG_ATTESTATION)));
        return WebAuthnVerifier::coseToPem($parsed['cosePublicKey']);
    }

    public function testRegistrationIsAccepted(): void
    {
        WebAuthnVerifier::checkClientData($this->bin(self::REG_CLIENT_DATA), 'webauthn.create', self::REG_CHALLENGE, self::ORIGIN);
        $parsed = WebAuthnVerifier::parseAuthData(WebAuthnVerifier::authDataFromAttestation($this->bin(self::REG_ATTESTATION)));
        WebAuthnVerifier::checkAuthData($parsed, self::RP_ID, true);

        $this->assertSame(0x45, $parsed['flags'], 'UP + UV + AT');
        $this->assertSame(1, $parsed['signCount']);
        $this->assertSame(self::REG_ID, Base64Url::encode($parsed['credentialId']));
        $this->assertStringStartsWith("-----BEGIN PUBLIC KEY-----\n", WebAuthnVerifier::coseToPem($parsed['cosePublicKey']));
    }

    public function testBothAssertionsVerifyWithRegisteredKey(): void
    {
        $pem = $this->registeredPem();
        foreach ([
            [self::GET1_CHALLENGE, self::GET1_CLIENT_DATA, self::GET1_AUTH_DATA, self::GET1_SIGNATURE],
            [self::GET2_CHALLENGE, self::GET2_CLIENT_DATA, self::GET2_AUTH_DATA, self::GET2_SIGNATURE],
        ] as [$challenge, $cd, $ad, $sig]) {
            WebAuthnVerifier::checkClientData($this->bin($cd), 'webauthn.get', $challenge, self::ORIGIN);
            $parsed = WebAuthnVerifier::parseAuthData($this->bin($ad));
            WebAuthnVerifier::checkAuthData($parsed, self::RP_ID, false);
            $this->assertTrue(WebAuthnVerifier::verifySignature($this->bin($ad), $this->bin($cd), $this->bin($sig), $pem));
        }
    }

    public function testSignCountGrowsAcrossRealAuthentications(): void
    {
        $reg = WebAuthnVerifier::parseAuthData(WebAuthnVerifier::authDataFromAttestation($this->bin(self::REG_ATTESTATION)));
        $g1 = WebAuthnVerifier::parseAuthData($this->bin(self::GET1_AUTH_DATA));
        $g2 = WebAuthnVerifier::parseAuthData($this->bin(self::GET2_AUTH_DATA));
        $this->assertTrue(WebAuthnVerifier::counterIsValid($reg['signCount'], $g1['signCount']));
        $this->assertTrue(WebAuthnVerifier::counterIsValid($g1['signCount'], $g2['signCount']));
        $this->assertFalse(WebAuthnVerifier::counterIsValid($g2['signCount'], $g1['signCount']), 'повтор более старого ответа');
    }

    public function testUserHandleMatchesDerivedHandle(): void
    {
        $this->assertSame($this->bin(self::GET1_USER_HANDLE), WebAuthnVerifier::userHandle(self::USER_ID));
        $this->assertNotSame($this->bin(self::GET1_USER_HANDLE), WebAuthnVerifier::userHandle(self::USER_ID + 1));
        $this->assertSame(32, strlen(WebAuthnVerifier::userHandle(1)));
    }

    public function testTamperedDataFailsSignature(): void
    {
        $pem = $this->registeredPem();
        $cd = $this->bin(self::GET1_CLIENT_DATA);
        $ad = $this->bin(self::GET1_AUTH_DATA);
        $sig = $this->bin(self::GET1_SIGNATURE);

        $this->assertTrue(WebAuthnVerifier::verifySignature($ad, $cd, $sig, $pem));
        $this->assertFalse(WebAuthnVerifier::verifySignature($ad, $cd . ' ', $sig, $pem), 'изменён clientDataJSON');
        $this->assertFalse(WebAuthnVerifier::verifySignature($ad . "\x00", $cd, $sig, $pem), 'изменена authenticatorData');
        $this->assertFalse(WebAuthnVerifier::verifySignature($ad, $cd, substr($sig, 0, -1) . chr(ord($sig[strlen($sig) - 1]) ^ 1), $pem), 'изменена подпись');
        $this->assertFalse(WebAuthnVerifier::verifySignature($ad, $cd, $this->bin(self::GET2_SIGNATURE), $pem), 'подпись от другого входа');
        $this->assertFalse(WebAuthnVerifier::verifySignature($ad, $cd, $sig, 'не ключ'), 'некорректный ключ');
    }

    public function testSignatureFromAnotherKeyIsRejected(): void
    {
        $other = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
        $this->assertNotFalse($other, 'OpenSSL не смог создать ключ P-256');
        $pem = openssl_pkey_get_details($other)['key'];
        $this->assertFalse(WebAuthnVerifier::verifySignature(
            $this->bin(self::GET1_AUTH_DATA), $this->bin(self::GET1_CLIENT_DATA), $this->bin(self::GET1_SIGNATURE), $pem
        ));
    }

    public function testSignatureProducedByPhpOpensslIsAccepted(): void
    {
        // Независимая от браузера проверка пути подписи: PHP сам подписывает и проверяет ES256 (DER).
        $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
        $d = openssl_pkey_get_details($key);
        $authData = str_repeat("\x01", 37);
        $client = '{"type":"webauthn.get"}';
        $signature = '';
        openssl_sign($authData . hash('sha256', $client, true), $signature, $key, OPENSSL_ALGO_SHA256);
        $this->assertTrue(WebAuthnVerifier::verifySignature($authData, $client, $signature, $d['key']));

        // и сборка PEM из координат COSE даёт тот же рабочий ключ
        $cose = [1 => 2, 3 => -7, -1 => 1, -2 => $d['ec']['x'], -3 => $d['ec']['y']];
        $this->assertTrue(WebAuthnVerifier::verifySignature($authData, $client, $signature, WebAuthnVerifier::coseToPem($cose)));
    }

    /** @dataProvider badClientData */
    public function testClientDataRejections(string $json, string $type, string $challenge, string $origin): void
    {
        $this->expectException(InvalidArgumentException::class);
        WebAuthnVerifier::checkClientData($json, $type, $challenge, $origin);
    }

    public function badClientData(): array
    {
        $good = base64_decode(strtr(self::GET1_CLIENT_DATA, '-_', '+/') . '=');
        return [
            'не JSON'          => ['{oops', 'webauthn.get', self::GET1_CHALLENGE, self::ORIGIN],
            'чужой тип'        => [$good, 'webauthn.create', self::GET1_CHALLENGE, self::ORIGIN],
            'чужой challenge'  => [$good, 'webauthn.get', self::GET2_CHALLENGE, self::ORIGIN],
            'чужой origin'     => [$good, 'webauthn.get', self::GET1_CHALLENGE, 'https://evil.example'],
            'origin с портом'  => [$good, 'webauthn.get', self::GET1_CHALLENGE, 'http://localhost'],
            'crossOrigin'      => [json_encode(['type' => 'webauthn.get', 'challenge' => self::GET1_CHALLENGE, 'origin' => self::ORIGIN, 'crossOrigin' => true]), 'webauthn.get', self::GET1_CHALLENGE, self::ORIGIN],
        ];
    }

    public function testAuthDataDomainAndFlagRejections(): void
    {
        $parsed = WebAuthnVerifier::parseAuthData($this->bin(self::GET1_AUTH_DATA));
        $reject = function (array $p, string $rp, bool $needAt): bool {
            try {
                WebAuthnVerifier::checkAuthData($p, $rp, $needAt);
                return false;
            } catch (InvalidArgumentException $e) {
                return true;
            }
        };
        $this->assertFalse($reject($parsed, self::RP_ID, false));
        $this->assertTrue($reject($parsed, 'evil.example', false), 'чужой домен');
        $this->assertTrue($reject($parsed, self::RP_ID, true), 'при регистрации обязателен флаг AT');
        $this->assertTrue($reject(['flags' => $parsed['flags'] & ~WebAuthnVerifier::FLAG_UV] + $parsed, self::RP_ID, false), 'без проверки пользователя (UV)');
        $this->assertTrue($reject(['flags' => $parsed['flags'] & ~WebAuthnVerifier::FLAG_UP] + $parsed, self::RP_ID, false), 'без присутствия (UP)');
    }

    public function testParseAuthDataRejectsBrokenInput(): void
    {
        $cases = [
            'короткая'                  => str_repeat("\x00", 36),
            'AT без данных'             => str_repeat("\x00", 32) . "\x40" . "\x00\x00\x00\x01",
            'AT, длина id больше данных' => str_repeat("\x00", 32) . "\x40" . "\x00\x00\x00\x01" . str_repeat("\x00", 16) . "\x00\x40" . 'ab',
            'AT, нулевая длина id'      => str_repeat("\x00", 32) . "\x40" . "\x00\x00\x00\x01" . str_repeat("\x00", 16) . "\x00\x00" . "\xa0",
        ];
        foreach ($cases as $name => $bin) {
            try {
                WebAuthnVerifier::parseAuthData($bin);
                $this->fail('Ожидалось отклонение: ' . $name);
            } catch (InvalidArgumentException $e) {
                $this->addToAssertionCount(1);
            }
        }
    }

    /** @dataProvider badCoseKeys */
    public function testCoseRejections(array $cose): void
    {
        $this->expectException(InvalidArgumentException::class);
        WebAuthnVerifier::coseToPem($cose);
    }

    public function badCoseKeys(): array
    {
        $x = str_repeat("\x01", 32);
        return [
            'RS256 вместо ES256' => [[1 => 3, 3 => -257, -1 => $x, -2 => $x]],
            'другая кривая'      => [[1 => 2, 3 => -7, -1 => 2, -2 => $x, -3 => $x]],
            'короткая X'         => [[1 => 2, 3 => -7, -1 => 1, -2 => 'abc', -3 => $x]],
            'нет Y'              => [[1 => 2, 3 => -7, -1 => 1, -2 => $x]],
            'точка не на кривой' => [[1 => 2, 3 => -7, -1 => 1, -2 => str_repeat("\x00", 32), -3 => str_repeat("\x00", 32)]],
        ];
    }

    public function testCounterRules(): void
    {
        $this->assertTrue(WebAuthnVerifier::counterIsValid(0, 0), 'аутентификатор без счётчика');
        $this->assertTrue(WebAuthnVerifier::counterIsValid(0, 1));
        $this->assertTrue(WebAuthnVerifier::counterIsValid(5, 6));
        $this->assertFalse(WebAuthnVerifier::counterIsValid(5, 5), 'повтор');
        $this->assertFalse(WebAuthnVerifier::counterIsValid(5, 4), 'откат');
        $this->assertFalse(WebAuthnVerifier::counterIsValid(5, 0), 'сброс в ноль');
    }

    public function testAttestationWithoutAuthDataIsRejected(): void
    {
        $this->expectException(InvalidArgumentException::class);
        WebAuthnVerifier::authDataFromAttestation("\xa1\x63fmt\x64none");   // {"fmt":"none"}
    }
}
