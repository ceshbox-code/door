<?php
declare(strict_types=1);

namespace App\Helpers;

/**
 * Единое определение «начисления» (ТЗ 2.1): работа действует и принята директором.
 * Все денежные запросы (остатки, расчёты, итоги, статистика сумм) используют только этот фрагмент,
 * чтобы правило не дублировалось. Псевдоним таблицы — wr.
 */
final class Accrual
{
    public const SQL = "wr.voided_at IS NULL AND wr.review_status = 'accepted'";
}
