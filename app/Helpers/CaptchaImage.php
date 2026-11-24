<?php
declare(strict_types=1);

namespace App\Helpers;

use RuntimeException;

/**
 * Рисует картинку капчи (PNG) средствами GD: шум, линии, наклон и волновое искажение символов.
 * Внешних сервисов нет, данные никуда не передаются.
 */
final class CaptchaImage
{
    public const WIDTH = 220;
    public const HEIGHT = 80;

    public static function render(string $text): string
    {
        if (!function_exists('imagecreatetruecolor')) {
            throw new RuntimeException('Расширение GD недоступно');
        }
        $w = self::WIDTH;
        $h = self::HEIGHT;

        $src = imagecreatetruecolor($w, $h);
        $bg = imagecolorallocate($src, random_int(236, 255), random_int(236, 255), random_int(236, 255));
        imagefilledrectangle($src, 0, 0, $w, $h, $bg);

        for ($i = 0; $i < 700; $i++) {                       // шум
            $c = imagecolorallocate($src, random_int(150, 225), random_int(150, 225), random_int(150, 225));
            imagesetpixel($src, random_int(0, $w - 1), random_int(0, $h - 1), $c);
        }
        for ($i = 0; $i < 4; $i++) {                         // линии под текстом
            $c = imagecolorallocate($src, random_int(160, 210), random_int(160, 210), random_int(160, 210));
            imageline($src, random_int(0, 30), random_int(0, $h), random_int($w - 30, $w), random_int(0, $h), $c);
        }

        self::drawText($src, $text, $w, $h);

        // волновое искажение по вертикали
        $dst = imagecreatetruecolor($w, $h);
        imagefilledrectangle($dst, 0, 0, $w, $h, $bg);
        $amp = random_int(3, 5);
        $phase = random_int(0, 628) / 100;
        $freq = random_int(35, 55) / 1000;
        for ($x = 0; $x < $w; $x++) {
            $dy = (int) round(sin($x * $freq + $phase) * $amp);
            imagecopy($dst, $src, $x, $dy, $x, 0, 1, $h);
        }
        for ($i = 0; $i < 3; $i++) {                         // линии поверх текста
            $c = imagecolorallocate($dst, random_int(90, 170), random_int(90, 170), random_int(90, 170));
            imageline($dst, random_int(0, 40), random_int(10, $h - 10), random_int($w - 40, $w), random_int(10, $h - 10), $c);
        }

        ob_start();
        imagepng($dst);
        $png = (string) ob_get_clean();
        if ($png === '') {
            throw new RuntimeException('Не удалось сформировать PNG');
        }
        return $png;
    }

    private static function drawText($im, string $text, int $w, int $h): void
    {
        $font = self::fontPath();
        $n = max(1, strlen($text));
        $slot = intdiv($w - 24, $n);
        for ($i = 0; $i < $n; $i++) {
            $color = imagecolorallocate($im, random_int(15, 110), random_int(15, 110), random_int(15, 110));
            $x = 14 + $i * $slot + random_int(0, 6);
            if ($font !== null) {
                imagettftext($im, random_int(30, 38), random_int(-18, 18), $x, random_int(52, 66), $color, $font, $text[$i]);
            } else {
                // запасной вариант без TTF: встроенный шрифт GD, увеличенный в 3 раза
                $glyph = imagecreatetruecolor(12, 16);
                $gb = imagecolorallocate($glyph, 255, 255, 255);
                imagefilledrectangle($glyph, 0, 0, 12, 16, $gb);
                imagestring($glyph, 5, 2, 0, $text[$i], imagecolorallocate($glyph, 0, 0, 0));
                imagecopyresized($im, $glyph, $x, random_int(14, 24), 0, 0, 36, 48, 12, 16);
            }
        }
    }

    /** Шрифт DejaVu из поставки mPDF (уже нужен для PDF); при отсутствии — системный. */
    private static function fontPath(): ?string
    {
        $root = dirname(__DIR__, 2);
        foreach ([
            $root . '/vendor/mpdf/mpdf/ttfonts/DejaVuSans-Bold.ttf',
            $root . '/vendor/mpdf/mpdf/ttfonts/DejaVuSans.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        ] as $f) {
            if (is_readable($f) && function_exists('imagettftext')) {
                return $f;
            }
        }
        return null;
    }
}
