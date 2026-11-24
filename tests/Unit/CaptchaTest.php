<?php
declare(strict_types=1);

namespace Tests\Unit;

use App\Helpers\CaptchaImage;
use App\Services\CaptchaService;
use PHPUnit\Framework\TestCase;

final class CaptchaTest extends TestCase
{
    public function testRandomTextUsesUnambiguousAlphabet(): void
    {
        for ($i = 0; $i < 200; $i++) {
            $t = CaptchaService::randomText();
            $this->assertSame(CaptchaService::LENGTH, strlen($t));
            $this->assertMatchesRegularExpression('/^[ABCDEFGHJKLMNPRSTUVXYZ2-9]+$/', $t);
        }
        $this->assertStringNotContainsString('O', CaptchaService::ALPHABET);
        $this->assertStringNotContainsString('0', CaptchaService::ALPHABET);
        $this->assertStringNotContainsString('I', CaptchaService::ALPHABET);
        $this->assertStringNotContainsString('1', CaptchaService::ALPHABET);
    }

    /** @dataProvider answers */
    public function testNormalizeAnswer(string $typed, string $expected): void
    {
        $this->assertSame($expected, CaptchaService::normalize($typed));
    }

    public function answers(): array
    {
        return [
            'строчные буквы'                => ['ab3xk', 'AB3XK'],
            'пробелы по краям и внутри'     => ['  a b3 xk ', 'AB3XK'],
            'кириллические двойники'        => ['АВ3ХК', 'AB3XK'],
            'смешанная раскладка'           => ['аB3хК', 'AB3XK'],
            'цифры без изменений'           => ['23456', '23456'],
            'пусто'                         => ['', ''],
        ];
    }

    public function testImageIsPngOfExpectedSize(): void
    {
        if (!function_exists('imagecreatetruecolor')) {
            $this->markTestSkipped('Расширение GD не установлено');
        }
        $png = CaptchaImage::render('AB3XK');
        $this->assertStringStartsWith("\x89PNG\r\n\x1a\n", $png);
        $info = getimagesizefromstring($png);
        $this->assertSame([CaptchaImage::WIDTH, CaptchaImage::HEIGHT], [$info[0], $info[1]]);
        $this->assertNotSame($png, CaptchaImage::render('AB3XK'), 'каждая картинка уникальна (шум и искажение)');
    }
}
