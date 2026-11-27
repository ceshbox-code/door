<?php
declare(strict_types=1);

namespace App\Services;

use App\Core\ApiException;
use App\Core\Tx;
use App\Helpers\Money;
use App\Models\WorkRecord;
use App\Repositories\PhotoRepository;
use App\Repositories\WorkRecordEditRepository;
use App\Repositories\WorkRecordRepository;
use App\Validators\WorkRecordValidator;
use Throwable;

/**
 * Изменение мастером собственной работы, пока директор её не принял.
 * Можно менять количество и комментарий и добавлять фото; вид работы, дверь, исполнитель, время выполнения
 * и тариф не меняются. Принятые, отклонённые (для них есть «исправление») и аннулированные работы не редактируются.
 */
final class WorkRecordEditService
{
    private WorkRecordRepository $records;
    private WorkRecordEditRepository $edit;
    private PhotoRepository $photoRepo;
    private PhotoStorage $storage;
    private PhotoService $photos;
    private AuditService $audit;

    public function __construct()
    {
        $this->records   = new WorkRecordRepository();
        $this->edit      = new WorkRecordEditRepository();
        $this->photoRepo = new PhotoRepository();
        $this->storage   = new PhotoStorage();
        $this->photos    = new PhotoService($this->storage);
        $this->audit     = new AuditService();
    }

    /**
     * @param array<int,array{name:string,tmp_name:string,size:int,error:int}> $uploads
     */
    public function edit(array $actor, int $id, array $input, array $uploads, string $ip): array
    {
        $d = WorkRecordValidator::resubmit($input);   // quantity и comment необязательны, правила те же
        $prepared = $uploads ? $this->storage->prepare($uploads) : [];
        $staged = $prepared ? $this->storage->stage($prepared) : [];
        $placed = [];
        try {
            return Tx::run(function () use ($actor, $id, $d, $ip, $prepared, $staged, &$placed) {
                $this->storage->discard($placed);          // следы прошлой попытки при повторе после взаимной блокировки
                $placed = [];

                $row = $id > 0 ? $this->records->lockRaw($id) : null;
                // Чужую работу не раскрываем даже фактом существования
                if ($row === null || (int) $row['user_id'] !== (int) $actor['id']) {
                    throw new ApiException('NOT_FOUND', 'Запись о работе не найдена', 404);
                }
                if ($row['voided_at'] !== null) {
                    throw new ApiException('ALREADY_VOIDED', 'Работа аннулирована', 409);
                }
                if ($row['review_status'] !== 'pending') {
                    $msg = $row['review_status'] === 'accepted'
                        ? 'Работа уже принята директором, изменить её нельзя.'
                        : 'Работа отклонена: используйте «Исправить и отправить».';
                    throw new ApiException('NOT_EDITABLE', $msg, 409, ['review_status' => $row['review_status']]);
                }

                $quantity = $d['quantity'] ?? (string) $row['quantity'];
                $comment = $d['has_comment'] ? $d['comment'] : $row['comment'];
                $changed = $staged !== [] || bccomp($quantity, (string) $row['quantity'], 3) !== 0 || $comment !== $row['comment'];
                if (!$changed) {
                    throw new ApiException('NOTHING_CHANGED', 'Измените количество или комментарий либо добавьте фото', 422);
                }

                if ($staged) {
                    if ($this->photoRepo->countByRecord($id) + count($staged) > PhotoStorage::MAX_PER_RECORD) {
                        throw new ApiException('TOO_MANY_PHOTOS', 'К одной работе можно приложить не более ' . PhotoStorage::MAX_PER_RECORD . ' фотографий', 422);
                    }
                    if ($this->photoRepo->existingShas($id, array_column($prepared, 'sha256'))) {
                        throw new ApiException('DUPLICATE_PHOTO', 'Такая фотография уже приложена к этой работе', 409);
                    }
                }

                $total = Money::multiply($quantity, (string) $row['unit_price']);
                if (!$this->edit->updatePending($id, $quantity, $total, $comment)) {
                    throw new ApiException('NOT_EDITABLE', 'Работу уже нельзя изменить: решение по ней принято.', 409);
                }
                if ($staged) {
                    $this->photos->attach($id, $staged, $placed);
                }
                $this->audit->log((int) $actor['id'], 'work_record.edit', 'work_record', $id,
                    ['quantity' => $row['quantity'], 'total_amount' => $row['total_amount'], 'comment' => $row['comment']],
                    ['quantity' => $quantity, 'total_amount' => $total, 'comment' => $comment, 'new_photos' => count($staged)], null, $ip);

                return WorkRecord::present($this->records->findDetailed($id)) + ['photos' => $this->photos->forRecordId($id)];
            });
        } catch (Throwable $e) {
            $this->storage->discard($placed);
            throw $e;
        } finally {
            $this->storage->discardStaged($staged);
        }
    }
}
