<?php
declare(strict_types=1);

namespace App\Helpers;

use InvalidArgumentException;

/**
 * Минимальный декодер CBOR (RFC 8949) для WebAuthn: целые числа, байтовые и текстовые строки, массивы, словари,
 * false/true/null. Только определённой длины (так кодируют CTAP2-аутентификаторы). Теги, числа с плавающей
 * точкой и неопределённая длина не поддерживаются — это ошибка. Ограничения глубины и размера защищают от
 * намеренно «раздутых» данных.
 */
final class Cbor
{
    private const MAX_DEPTH = 8;
    private const MAX_ITEMS = 1024;

    /** Декодирует ровно один элемент и требует, чтобы данные закончились. */
    public static function decodeAll(string $data): mixed
    {
        $offset = 0;
        $value = self::decode($data, $offset);
        if ($offset !== strlen($data)) {
            throw new InvalidArgumentException('CBOR: лишние данные после элемента');
        }
        return $value;
    }

    /** Декодирует элемент с позиции $offset и сдвигает её за его конец. */
    public static function decode(string $data, int &$offset, int $depth = 0): mixed
    {
        if ($depth > self::MAX_DEPTH) {
            throw new InvalidArgumentException('CBOR: слишком глубокая вложенность');
        }
        $len = strlen($data);
        if ($offset >= $len) {
            throw new InvalidArgumentException('CBOR: неожиданный конец данных');
        }
        $initial = ord($data[$offset++]);
        $major = $initial >> 5;
        $info = $initial & 0x1f;

        if ($major === 7) {
            return match ($info) {
                20 => false,
                21 => true,
                22 => null,
                default => throw new InvalidArgumentException('CBOR: неподдерживаемое простое значение'),
            };
        }
        if ($major === 6) {
            throw new InvalidArgumentException('CBOR: теги не поддерживаются');
        }

        $arg = self::argument($data, $offset, $info);

        switch ($major) {
            case 0:
                return $arg;
            case 1:
                return -1 - $arg;
            case 2:
            case 3:
                if ($arg > $len - $offset) {
                    throw new InvalidArgumentException('CBOR: длина строки больше оставшихся данных');
                }
                $s = substr($data, $offset, $arg);
                $offset += $arg;
                return $s;
            case 4:
                if ($arg > self::MAX_ITEMS || $arg > $len - $offset) {
                    throw new InvalidArgumentException('CBOR: слишком большой массив');
                }
                $out = [];
                for ($i = 0; $i < $arg; $i++) {
                    $out[] = self::decode($data, $offset, $depth + 1);
                }
                return $out;
            case 5:
                if ($arg > self::MAX_ITEMS || $arg * 2 > $len - $offset) {
                    throw new InvalidArgumentException('CBOR: слишком большой словарь');
                }
                $out = [];
                for ($i = 0; $i < $arg; $i++) {
                    $key = self::decode($data, $offset, $depth + 1);
                    if (!is_int($key) && !is_string($key)) {
                        throw new InvalidArgumentException('CBOR: ключ словаря должен быть числом или строкой');
                    }
                    $out[$key] = self::decode($data, $offset, $depth + 1);
                }
                return $out;
        }
        throw new InvalidArgumentException('CBOR: неизвестный тип');
    }

    private static function argument(string $data, int &$offset, int $info): int
    {
        if ($info < 24) {
            return $info;
        }
        $size = match ($info) {
            24 => 1,
            25 => 2,
            26 => 4,
            27 => 8,
            default => throw new InvalidArgumentException('CBOR: неопределённая длина не поддерживается'),
        };
        if ($size > strlen($data) - $offset) {
            throw new InvalidArgumentException('CBOR: неожиданный конец данных');
        }
        $raw = substr($data, $offset, $size);
        $offset += $size;
        $value = match ($size) {
            1 => ord($raw),
            2 => unpack('n', $raw)[1],
            4 => unpack('N', $raw)[1],
            8 => unpack('J', $raw)[1],
        };
        if ($value < 0) {                       // 64-битное значение за пределами PHP_INT_MAX
            throw new InvalidArgumentException('CBOR: число слишком велико');
        }
        return $value;
    }
}
