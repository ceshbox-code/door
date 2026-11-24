-- Ключи входа по биометрии (WebAuthn / passkey). Биометрические данные на сервер не передаются:
-- хранится только открытый ключ. Отзыв ключа — мягкий (revoked_at), история сохраняется.
CREATE TABLE webauthn_credentials (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id       BIGINT UNSIGNED NOT NULL,
    credential_id VARCHAR(344) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    public_key    TEXT NOT NULL,
    sign_count    INT UNSIGNED NOT NULL DEFAULT 0,
    label         VARCHAR(100) NOT NULL DEFAULT '',
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at  DATETIME NULL,
    revoked_at    DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_wc_credential (credential_id),
    KEY idx_wc_user (user_id, revoked_at),
    CONSTRAINT fk_wc_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
