<?php
declare(strict_types=1);

namespace Tests\Unit;

use App\Core\ApiException;
use App\Validators\AuditValidator;
use PHPUnit\Framework\TestCase;

final class AuditValidatorTest extends TestCase
{
    private function errors(array $q): array
    {
        try {
            AuditValidator::filters($q, 'Europe/Kaliningrad');
        } catch (ApiException $e) {
            $this->assertSame(422, $e->httpStatus);
            return $e->details;
        }
        $this->fail('Ожидалась ApiException');
    }

    public function testEmptyQueryMeansNoFilters(): void
    {
        $this->assertSame(['from_utc' => null, 'to_utc' => null], AuditValidator::filters([], 'UTC'));
    }

    public function testAllFilters(): void
    {
        $f = AuditValidator::filters([
            'user_id' => '5', 'action' => 'payment.post', 'entity_type' => 'payment', 'entity_id' => '12',
            'date_from' => '2026-11-01', 'date_to' => '2026-11-30',
        ], 'Europe/Kaliningrad');
        $this->assertSame(5, $f['user_id']);
        $this->assertSame('payment.post', $f['action']);
        $this->assertSame('payment', $f['entity_type']);
        $this->assertSame(12, $f['entity_id']);
        // Калининград = UTC+2: локальные сутки начинаются в 22:00 UTC предыдущего дня; верхняя граница — начало следующих суток
        $this->assertSame('2026-10-31 22:00:00', $f['from_utc']);
        $this->assertSame('2026-11-30 22:00:00', $f['to_utc']);
    }

    public function testRejectsBadValuesAndInjectionLikeStrings(): void
    {
        $e = $this->errors(['user_id' => 'abc', 'action' => "x'; DROP TABLE audit_log;--", 'entity_type' => 'Payment', 'entity_id' => '0']);
        foreach (['user_id', 'action', 'entity_type', 'entity_id'] as $k) {
            $this->assertArrayHasKey($k, $e, $k);
        }
    }

    public function testRejectsBadPeriod(): void
    {
        $this->assertArrayHasKey('date_to', $this->errors(['date_from' => '2026-11-30', 'date_to' => '2026-11-01']));
        $this->assertArrayHasKey('date_from', $this->errors(['date_from' => '30.11.2026']));
    }
}
