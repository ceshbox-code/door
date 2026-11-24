<?php
declare(strict_types=1);

namespace App\Repositories;

use App\Core\Database;

final class WebAuthnCredentialRepository
{
    /** @return array[] действующие (не отозванные) ключи пользователя */
    public function listActive(int $userId): array
    {
        $st = Database::pdo()->prepare(
            'SELECT id, credential_id, label, sign_count, created_at, last_used_at
             FROM webauthn_credentials WHERE user_id = ? AND revoked_at IS NULL ORDER BY id'
        );
        $st->execute([$userId]);
        return $st->fetchAll();
    }

    public function findActiveByCredentialId(string $credentialId): ?array
    {
        $st = Database::pdo()->prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ? AND revoked_at IS NULL');
        $st->execute([$credentialId]);
        return $st->fetch() ?: null;
    }

    /** Существует ли такой идентификатор вообще (в том числе отозванный): повторно его регистрировать нельзя. */
    public function exists(string $credentialId): bool
    {
        $st = Database::pdo()->prepare('SELECT 1 FROM webauthn_credentials WHERE credential_id = ?');
        $st->execute([$credentialId]);
        return (bool) $st->fetchColumn();
    }

    public function insert(int $userId, string $credentialId, string $publicKeyPem, int $signCount, string $label): int
    {
        $pdo = Database::pdo();
        $pdo->prepare('INSERT INTO webauthn_credentials (user_id, credential_id, public_key, sign_count, label) VALUES (?, ?, ?, ?, ?)')
            ->execute([$userId, $credentialId, $publicKeyPem, $signCount, $label]);
        return (int) $pdo->lastInsertId();
    }

    public function find(int $id): ?array
    {
        $st = Database::pdo()->prepare('SELECT id, credential_id, label, sign_count, created_at, last_used_at, revoked_at, user_id FROM webauthn_credentials WHERE id = ?');
        $st->execute([$id]);
        return $st->fetch() ?: null;
    }

    public function touch(int $id, int $signCount): void
    {
        Database::pdo()->prepare('UPDATE webauthn_credentials SET sign_count = ?, last_used_at = UTC_TIMESTAMP() WHERE id = ?')
            ->execute([$signCount, $id]);
    }

    /** Мягкий отзыв ключа владельцем; возвращает false, если такого действующего ключа у пользователя нет. */
    public function revoke(int $id, int $userId): bool
    {
        $st = Database::pdo()->prepare('UPDATE webauthn_credentials SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ? AND revoked_at IS NULL');
        $st->execute([$id, $userId]);
        return $st->rowCount() === 1;
    }
}
