<?php
declare(strict_types=1);

namespace App\Validators;

use App\Helpers\Dates;
use App\Helpers\Input;

final class AuditValidator
{
    /**
     * Фильтры журнала действий. Период задаётся локальными датами (как в остальных отчётах) и переводится в UTC.
     * @return array{user_id?:int,action?:string,entity_type?:string,entity_id?:int,from_utc?:?string,to_utc?:?string}
     */
    public static function filters(array $q, string $timezone): array
    {
        $e = [];
        $f = [];

        if (isset($q['user_id']) && $q['user_id'] !== '') {
            $id = Input::id($q['user_id']);
            if ($id === null) {
                $e['user_id'] = 'Некорректный пользователь';
            } else {
                $f['user_id'] = $id;
            }
        }
        foreach (['action' => 'Действие', 'entity_type' => 'Тип объекта'] as $k => $label) {
            if (isset($q[$k]) && $q[$k] !== '') {
                if (!is_string($q[$k]) || !preg_match('/^[a-z0-9_.]{1,100}$/', $q[$k])) {
                    $e[$k] = $label . ': до 100 символов, строчная латиница, цифры, точка, подчёркивание';
                } else {
                    $f[$k] = $q[$k];
                }
            }
        }
        if (isset($q['entity_id']) && $q['entity_id'] !== '') {
            $id = Input::id($q['entity_id']);
            if ($id === null) {
                $e['entity_id'] = 'Некорректный номер объекта';
            } else {
                $f['entity_id'] = $id;
            }
        }

        $period = ['from' => null, 'to' => null];
        try {
            $period = FinanceValidator::period($q);
        } catch (\App\Core\ApiException $ex) {
            $e += $ex->details ?? ['date_from' => 'Некорректный период'];
        }
        if ($e) {
            Validation::fail($e);
        }
        $f['from_utc'] = $period['from'] === null ? null : Dates::localDayToUtc($period['from'], $timezone);
        $f['to_utc'] = $period['to'] === null ? null : Dates::localDayToUtc($period['to'], $timezone, true);
        return $f;
    }
}
