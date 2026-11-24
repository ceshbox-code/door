<?php
declare(strict_types=1);

namespace Tests\Unit;

use App\Helpers\Base64Url;
use PHPUnit\Framework\TestCase;

final class Base64UrlTest extends TestCase
{
    public function testEncodeUsesUrlAlphabetWithoutPadding(): void
    {
        $this->assertSame('-_8', Base64Url::encode("\xfb\xff"));
        $this->assertSame('QQ', Base64Url::encode('A'));
        $this->assertSame('', Base64Url::encode(''));
    }

    public function testDecodeRoundTrip(): void
    {
        foreach (['', 'A', 'AB', 'ABC', "\x00\x01\xfe\xff", random_bytes(33)] as $bin) {
            if ($bin === '') {
                $this->assertNull(Base64Url::decode(Base64Url::encode($bin)), 'пустая строка не декодируется');
                continue;
            }
            $this->assertSame($bin, Base64Url::decode(Base64Url::encode($bin)));
        }
        $this->assertSame("\xfb\xff", Base64Url::decode('-_8'));
    }

    /** @dataProvider invalid */
    public function testDecodeIsStrict(string $text): void
    {
        $this->assertNull(Base64Url::decode($text));
    }

    public function invalid(): array
    {
        return [
            'пусто'                 => [''],
            'знак заполнения'       => ['QQ=='],
            'алфавит base64 (+ /)'  => ['ab+/'],
            'пробел'                => ['ab cd'],
            'длина 4n+1'            => ['abcde'],
            'кириллица'             => ['абвг'],
        ];
    }
}
