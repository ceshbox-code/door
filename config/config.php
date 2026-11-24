<?php
declare(strict_types=1);

$env = static fn(string $key, ?string $default = null): ?string =>
    ($v = getenv($key)) !== false && $v !== '' ? $v : $default;

return [
    'app' => [
        'env'      => $env('APP_ENV', 'production'),
        'debug'    => $env('APP_DEBUG', '0') === '1',
        'timezone' => $env('APP_TIMEZONE', 'Europe/Kaliningrad'), // отображение; в БД всё в UTC
        'org_name' => $env('APP_ORG_NAME', 'Организация'),
        'currency' => $env('APP_CURRENCY', '₽'),
    ],
    'session' => [
        // Secure-cookie: 1 в рабочей среде (HTTPS). 0 только для проверки по голому http в локальной сети.
        'cookie_secure' => $env('SESSION_SECURE', '1') === '1',
        'idle_minutes'  => (int) $env('SESSION_IDLE_MINUTES', '720'),
    ],
    'auth' => [
        // Капча при входе по паролю: always (по умолчанию) | after_failures | off
        'captcha_mode'    => $env('CAPTCHA_MODE', 'always'),
        // Вход по биометрии (WebAuthn): домен и адрес сайта, как их видит браузер. Пусто — функция выключена.
        'webauthn_rp_id'  => $env('WEBAUTHN_RP_ID', ''),
        'webauthn_origin' => $env('WEBAUTHN_ORIGIN', ''),
    ],
    'db' => [
        'host'     => $env('DB_HOST', 'door-db'),
        'port'     => (int) $env('DB_PORT', '3306'),
        'name'     => $env('DB_NAME', 'door_accounting'),
        'user'     => $env('DB_USER', 'door'),
        'password' => $env('DB_PASSWORD', ''),
    ],
    'paths' => [
        'root'    => dirname(__DIR__),
        'storage' => dirname(__DIR__) . '/storage',
        'logs'    => dirname(__DIR__) . '/storage/logs',
    ],
];
