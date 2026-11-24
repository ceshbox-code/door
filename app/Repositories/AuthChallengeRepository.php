<?php
declare(strict_types=1);

namespace App\Repositories;

use App\Core\Database;

/** Одноразовые вызовы входа (капча, challenge WebAuthn). Время — UTC базы данных. */
final class AuthChallengeRepository
{
    public function create(string $id, string $kind, ?int $userId, string $payload, string $ip, int $ttlSeconds): void
    {
        $ttl = max(1, $ttlSeconds);
        Database::pdo()->prepare(
            "INSERT INTO auth_challenges (id, kind, user_id, payload, ip, expires_at)
             VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL {$ttl} SECOND)"
        )->execute([$id, $kind, $userId, $payload, mb_substr($ip, 0, 45)]);
    }

    /** Сколько вызовов создал этот IP за последние секунды (защита от засорения таблицы). */
    public function countRecentByIp(string $ip, int $seconds): int
    {
        $s = max(1, $seconds);
        $st = Database::pdo()->prepare(
            "SELECT COUNT(*) FROM auth_challenges WHERE ip = ? AND created_at >= UTC_TIMESTAMP() - INTERVAL {$s} SECOND"
        );
        $st->execute([mb_substr($ip, 0, 45)]);
        return (int) $st->fetchColumn();
    }

    /**
     * Забирает вызов: возвращает строку и удаляет её. Одноразовость гарантирует DELETE:
     * при гонке двух запросов rowCount() = 1 получит только один.
     */
    public function consume(string $id, string $kind): ?array
    {
        if (!preg_match('/^[0-9a-f]{32}$/', $id)) {
            return null;
        }
        $pdo = Database::pdo();
        $st = $pdo->prepare('SELECT * FROM auth_challenges WHERE id = ? AND kind = ? AND expires_at > UTC_TIMESTAMP()');
        $st->execute([$id, $kind]);
        $row = $st->fetch();
        if (!$row) {
            return null;
        }
        $del = $pdo->prepare('DELETE FROM auth_challenges WHERE id = ?');
        $del->execute([$id]);
        return $del->rowCount() === 1 ? $row : null;
    }

    public function purgeExpired(): void
    {
        Database::pdo()->exec('DELETE FROM auth_challenges WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 HOUR');
    }
}
