<?php
declare(strict_types=1);

namespace Tests\Unit;

use App\Helpers\Cbor;
use InvalidArgumentException;
use PHPUnit\Framework\TestCase;

/** Эталонные примеры из RFC 8949, приложение A, и защита от некорректных данных. */
final class CborTest extends TestCase
{
    /** @dataProvider valid */
    public function testDecodesRfcVectors(string $hex, $expected): void
    {
        $this->assertSame($expected, Cbor::decodeAll(hex2bin($hex)));
    }

    public function valid(): array
    {
        return [
            '0'                  => ['00', 0],
            '23'                 => ['17', 23],
            '24'                 => ['1818', 24],
            '1000'               => ['1903e8', 1000],
            '1000000'            => ['1a000f4240', 1000000],
            '4294967296'         => ['1b0000000100000000', 4294967296],
            '-1'                 => ['20', -1],
            '-7 (ES256)'         => ['26', -7],
            '-1000'              => ['3903e7', -1000],
            'пустые байты'       => ['40', ''],
            'байты 01020304'     => ['4401020304', "\x01\x02\x03\x04"],
            'текст "IETF"'       => ['6449455446', 'IETF'],
            'пустой текст'       => ['60', ''],
            '[]'                 => ['80', []],
            '[1,2,3]'            => ['83010203', [1, 2, 3]],
            '{"a":1,"b":[2,3]}'  => ['a26161016162820203', ['a' => 1, 'b' => [2, 3]]],
            'false'              => ['f4', false],
            'true'               => ['f5', true],
            'null'               => ['f6', null],
            'ключ COSE'          => ['a3010203262001', [1 => 2, 3 => -7, -1 => 1]],
        ];
    }

    public function testDecodeWithOffsetStopsAfterItem(): void
    {
        $data = hex2bin('83010203') . 'tail';
        $offset = 0;
        $this->assertSame([1, 2, 3], Cbor::decode($data, $offset));
        $this->assertSame(4, $offset);
        $this->assertSame('tail', substr($data, $offset));
    }

    /** @dataProvider invalid */
    public function testRejectsUnsupportedOrBrokenData(string $hex): void
    {
        $this->expectException(InvalidArgumentException::class);
        Cbor::decodeAll(hex2bin($hex));
    }

    public function invalid(): array
    {
        return [
            'пусто'                         => [''],
            'обрезанные байты'              => ['440102'],
            'обрезанное число'              => ['19'],
            'неопределённая длина массива'  => ['9fff'],
            'тег'                           => ['c074323031332d30332d32315432303a30343a30305a'],
            'число с плавающей точкой'      => ['f93c00'],
            'simple 16'                     => ['f0'],
            'ключ словаря — массив'         => ['a18001'],
            'длина больше данных'           => ['5b00000000ffffffff'],
            'число больше PHP_INT_MAX'      => ['1bffffffffffffffff'],
            'массив из тысяч элементов'     => ['990fa0'],
            'лишние данные после элемента'  => ['0000'],
            'слишком глубокая вложенность'  => [str_repeat('81', 20) . '00'],
        ];
    }
}
