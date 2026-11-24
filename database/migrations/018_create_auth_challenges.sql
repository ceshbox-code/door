-- Одноразовые вызовы для входа: капча и challenge WebAuthn (биометрия).
-- Строка удаляется при первой проверке (single use) и по истечении срока. Без внешних ключей:
-- вход выполняется до авторизации, user_id заполняется только при регистрации биометрии.
CREATE TABLE auth_challenges (
    id         CHAR(32) NOT NULL,
    kind       VARCHAR(30) NOT NULL,
    user_id    BIGINT UNSIGNED NULL,
    payload    VARCHAR(255) NOT NULL,
    ip         VARCHAR(45) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    KEY idx_ac_ip (ip, created_at),
    KEY idx_ac_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
