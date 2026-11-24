<?php
declare(strict_types=1);

namespace Tests\Unit;

use App\Models\AuditEntry;
use PHPUnit\Framework\TestCase;

final class AuditEntryTest extends TestCase
{
    private function row(array $over = []): array
    {
        return $over + [
            'id' => '7', 'user_id' => '3', 'user_name' => 'Иванов И.', 'action' => 'payment.post', 'entity_type' => 'payment',
            'entity_id' => '12', 'old_values' => null, 'new_values' => '{"amount":"1500.00","allocations":2}',
            'reason' => null, 'ip_address' => '192.168.1.5', 'created_at' => '2026-11-20 10:15:00',
        ];
    }

    public function testPresentsEntryWithDecodedJson(): void
    {
        $p = AuditEntry::present($this->row());
        $this->assertSame(7, $p['id']);
        $this->assertSame(['id' => 3, 'full_name' => 'Иванов И.'], $p['user']);
        $this->assertSame(12, $p['entity_id']);
        $this->assertNull($p['old_values']);
        $this->assertSame(['amount' => '1500.00', 'allocations' => 2], $p['new_values']);
        $this->assertSame('2026-11-20T10:15:00Z', $p['created_at']);
    }

    public function testEntryWithoutUserAndEntity(): void
    {
        $p = AuditEntry::present($this->row(['user_id' => null, 'user_name' => null, 'entity_id' => null, 'action' => 'auth.login_failed']));
        $this->assertNull($p['user']);
        $this->assertNull($p['entity_id']);
    }

    public function testBrokenJsonDoesNotBreakTheList(): void
    {
        $p = AuditEntry::present($this->row(['new_values' => '{oops', 'old_values' => '']));
        $this->assertNull($p['new_values']);
        $this->assertNull($p['old_values']);
    }
}
