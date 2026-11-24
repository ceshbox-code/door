<?php
declare(strict_types=1);

namespace Tests\Unit;

use App\Core\Permissions;
use PHPUnit\Framework\TestCase;

final class PermissionsTest extends TestCase
{
    public function testOwnerHasEverythingExceptDirectorOnlyManagement(): void
    {
        foreach (Permissions::ALL as $p) {
            $this->assertSame(!in_array($p, Permissions::OWNER_EXCLUDED, true), Permissions::can('owner', $p), $p);
        }
        $this->assertSame(['work_types.manage', 'rates.manage', 'finance.manage'], Permissions::OWNER_EXCLUDED);
    }

    public function testMasterCanRegisterButNotManageFinanceOrUsers(): void
    {
        $this->assertTrue(Permissions::can('master', 'work.register'));
        $this->assertTrue(Permissions::can('master', 'finance.view_own'));
        foreach (['users.manage', 'rates.manage', 'finance.manage', 'finance.view_all', 'work.view_all', 'work.void'] as $p) {
            $this->assertFalse(Permissions::can('master', $p), $p);
        }
    }

    public function testDirectorViewsAndExportsButChangesNothing(): void
    {
        foreach (['stats.view', 'reports.export', 'finance.view_all', 'photos.view', 'work.view_all'] as $p) {
            $this->assertTrue(Permissions::can('director', $p), $p);
        }
        foreach (['work.register', 'users.manage', 'work.void'] as $p) {
            $this->assertFalse(Permissions::can('director', $p), $p);
        }
    }

    public function testUnknownRoleHasNothing(): void
    {
        $this->assertSame([], Permissions::forRole('hacker'));
    }

    public function testMatrixOnlyUsesKnownPermissions(): void
    {
        foreach (['master', 'director'] as $role) {
            foreach (Permissions::forRole($role) as $p) {
                $this->assertContains($p, Permissions::ALL, "{$role}: {$p}");
            }
        }
    }

    public function testWorkTypeVisibilityAndProxyRegistration(): void
    {
        $this->assertTrue(Permissions::can('master', 'work_types.view'));
        $this->assertFalse(Permissions::can('master', 'work_types.view_all'));
        $this->assertFalse(Permissions::can('master', 'work_types.manage'));
        $this->assertTrue(Permissions::can('director', 'work_types.view_all'));
        $this->assertTrue(Permissions::can('owner', 'work.register_for_others'));
        $this->assertFalse(Permissions::can('master', 'work.register_for_others'));
        $this->assertFalse(Permissions::can('director', 'work.register'));
    }

    public function testPhotoPermissions(): void
    {
        $this->assertTrue(Permissions::can('owner', 'photos.delete'));
        $this->assertFalse(Permissions::can('director', 'photos.delete'));
        $this->assertFalse(Permissions::can('master', 'photos.delete'));
        $this->assertTrue(Permissions::can('director', 'photos.view'));
        $this->assertFalse(Permissions::can('master', 'photos.view'));       // мастер видит только свои — по владельцу записи
    }

    public function testFinanceMatrix(): void
    {
        // финансовые операции создаёт и изменяет только директор; администратор и мастер — нет
        $this->assertTrue(Permissions::can('director', 'finance.manage'));
        $this->assertTrue(Permissions::can('director', 'finance.view_all'));
        $this->assertTrue(Permissions::can('owner', 'finance.view_all'));
        $this->assertFalse(Permissions::can('owner', 'finance.manage'));
        $this->assertTrue(Permissions::can('master', 'finance.view_own'));
        $this->assertFalse(Permissions::can('master', 'finance.view_all'));
        $this->assertFalse(Permissions::can('master', 'finance.manage'));
    }

    public function testStatsAndReportsAccess(): void
    {
        foreach (['owner', 'director'] as $role) {
            $this->assertTrue(Permissions::can($role, 'stats.view'), $role);
            $this->assertTrue(Permissions::can($role, 'reports.export'), $role);
        }
        $this->assertFalse(Permissions::can('master', 'stats.view'));
        $this->assertFalse(Permissions::can('master', 'reports.export'));
    }

    public function testAuditLogIsOwnerOnly(): void
    {
        $this->assertTrue(Permissions::can('owner', 'audit.view'));
        $this->assertFalse(Permissions::can('director', 'audit.view'));
        $this->assertFalse(Permissions::can('master', 'audit.view'));
    }

    public function testOnlyDirectorSetsRatesAndWorkTypes(): void
    {
        // директор устанавливает и видит
        foreach (['rates.manage', 'rates.view', 'work_types.manage', 'work_types.view_all'] as $p) {
            $this->assertTrue(Permissions::can('director', $p), $p);
        }
        // администратор только просматривает
        foreach (['rates.view', 'work_types.view_all'] as $p) {
            $this->assertTrue(Permissions::can('owner', $p), $p);
        }
        foreach (['rates.manage', 'work_types.manage'] as $p) {
            $this->assertFalse(Permissions::can('owner', $p), $p);
            $this->assertFalse(Permissions::can('master', $p), $p);
        }
        $this->assertFalse(Permissions::can('master', 'rates.view'));
    }
}
