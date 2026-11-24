<?php
declare(strict_types=1);

namespace App\Validators;

use App\Helpers\Input;
use App\Helpers\Money;
use App\Models\Door;

final class WorkRecordValidator
{
    /**
     * @return array{work_type_id:int,door_number:?string,new_door:bool,quantity:string,comment:?string,user_id:?int}
     */
    public static function register(array $in): array
    {
        $e = [];
        $typeId = Input::id($in['work_type_id'] ?? null);
        if ($typeId === null) {
            $e['work_type_id'] = 'Выберите вид работы';
        }

        $doorNumber = null;
        if (isset($in['door_number']) && $in['door_number'] !== '') {
            $doorNumber = is_string($in['door_number']) ? Door::normalizeNumber($in['door_number']) : null;
            if ($doorNumber === null) {
                $e['door_number'] = 'Номер двери вида D-000123';
            }
        }

        $newDoor = false;
        if (array_key_exists('new_door', $in)) {
            $b = Input::bool($in['new_door']);
            if ($b === null) {
                $e['new_door'] = 'Допустимо true или false';
            } else {
                $newDoor = $b;
            }
        }
        if ($doorNumber !== null && $newDoor) {
            $e['door_number'] = 'Укажите либо номер существующей двери, либо new_door=true, но не оба';
        }

        $quantity = array_key_exists('quantity', $in) ? Money::quantity($in['quantity']) : '1.000';
        if ($quantity === null || !Money::isPositive($quantity)) {
            $e['quantity'] = 'Количество: положительное число, до 3 знаков после запятой, до 99999.999';
            $quantity = '1.000';
        }

        $comment = null;
        if (isset($in['comment'])) {
            $c = Input::str($in['comment']);
            if ($c === null || mb_strlen($c) > 2000) {
                $e['comment'] = 'Комментарий: до 2000 символов';
            } else {
                $comment = $c === '' ? null : $c;
            }
        }

        $userId = null;
        if (isset($in['user_id'])) {
            $userId = Input::id($in['user_id']);
            if ($userId === null) {
                $e['user_id'] = 'Некорректный исполнитель';
            }
        }

        if ($e) {
            Validation::fail($e);
        }
        return [
            'work_type_id' => $typeId, 'door_number' => $doorNumber, 'new_door' => $newDoor,
            'quantity' => $quantity, 'comment' => $comment, 'user_id' => $userId,
        ];
    }

    public static function reason(array $in): string
    {
        $r = Input::str($in['reason'] ?? null);
        if ($r === null || mb_strlen($r) < 3 || mb_strlen($r) > 1000) {
            Validation::fail(['reason' => 'Причина: от 3 до 1000 символов']);
        }
        return $r;
    }

    /** Отклонение работы: причина обязательна, решение «можно ли исправить» принимается явно (без значения по умолчанию). */
    public static function reject(array $in): array
    {
        $reason = Input::str($in['reason'] ?? null);
        $e = [];
        if ($reason === null || mb_strlen($reason) < 3 || mb_strlen($reason) > 1000) {
            $e['reason'] = 'Причина: от 3 до 1000 символов';
        }
        $canFix = array_key_exists('can_fix', $in) ? Input::bool($in['can_fix']) : null;
        if ($canFix === null) {
            $e['can_fix'] = 'Укажите, можно ли исправить работу: true или false';
        }
        if ($e) {
            Validation::fail($e);
        }
        return ['reason' => $reason, 'can_fix' => $canFix];
    }

    /** Исправление отклонённой работы: количество и комментарий необязательны (меняется только переданное). */
    public static function resubmit(array $in): array
    {
        $e = [];
        $quantity = null;
        if (array_key_exists('quantity', $in) && $in['quantity'] !== '') {
            $quantity = Money::quantity($in['quantity']);
            if ($quantity === null || !Money::isPositive($quantity)) {
                $e['quantity'] = 'Количество: положительное число, до 3 знаков после запятой, до 99999.999';
            }
        }
        $comment = null;
        $hasComment = array_key_exists('comment', $in);
        if ($hasComment) {
            $c = Input::str($in['comment']);
            if ($c === null || mb_strlen($c) > 2000) {
                $e['comment'] = 'Комментарий: до 2000 символов';
            } else {
                $comment = $c === '' ? null : $c;
            }
        }
        if ($e) {
            Validation::fail($e);
        }
        return ['quantity' => $quantity, 'comment' => $comment, 'has_comment' => $hasComment];
    }
}
