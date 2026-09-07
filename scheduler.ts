/**
 * Scheduler — компонент 2 из 3.
 *
 * Решает, какая задача считается сейчас, сколько всего можно занимать поток
 * и когда спать. Алгоритм — round robin: каждая задача получает один шаг и
 * уезжает в конец очереди.
 *
 * Планировщик — стратегия. Можно написать свой (например, с приоритетами,
 * как lanes в React Fiber) и подставить в taskBuilder, не трогая остальное.
 *
 * Про имена: интерфейс называется IScheduler, а не Scheduler, потому что
 * глобальный `Scheduler` уже занят DOM lib (Prioritized Task Scheduling API).
 * Иначе TypeScript начинает требовать реализацию чужих postTask и yield.
 */

import type { TDataResult, TErrorResult } from "./event-emitter.ts";

export class TaskCancelledError extends Error {
  constructor(message = "Task cancelled") {
    super(message);
    this.name = "TaskCancelledError";
  }
}

export type IJobResult = TDataResult | TErrorResult;

export interface ISchedulerOptions {
  /**
   * Сколько миллисекунд за один такт можно занимать поток — на все задачи
   * вместе, а не на каждую. Это максимальная задержка, которую планировщик
   * навязывает всему остальному в потоке.
   *
   * Реальный блок получается длиннее: проверка идёт ПОСЛЕ шага задачи,
   * поэтому блок ≈ quota + длина последнего шага ≈ quota * 1.25.
   */
  quota: number;

  /**
   * Сколько миллисекунд спать между тактами. Отвечает не за отзывчивость,
   * а за долю CPU: задача получает примерно quota / (quota + delay).
   */
  delay: number;
}

export interface IScheduler {
  get quota(): number;
  get delay(): number;
  isRunning(): boolean;
  push(
    job: IterableIterator<unknown>,
    handler: (result: IJobResult) => void,
  ): number;
  clear(): void;
  run(): void;
}

/** Элемент очереди. Внутренний тип, наружу не отдаётся. */
interface IJobEntry {
  job: IterableIterator<unknown>;
  handler: (result: IJobResult) => void;
  settled: boolean;
}

export class RoundRobinScheduler implements IScheduler {
  #running = false;

  /**
   * Дек: берём с начала (shift), кладём в конец (push). Массив для этого не
   * лучшая структура — shift это O(n), правильнее кольцевой буфер. Оставлено
   * для читаемости.
   */
  readonly #queue: IJobEntry[] = [];

  /**
   * Ещё не завершённые задачи. Нужны для отмены: задача, которую исполняют
   * прямо сейчас, из очереди уже вынута, и по очереди её не найти.
   */
  readonly #live = new Set<IJobEntry>();

  #timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Счётчик поколений цикла. Отменить уже поставленный queueMicrotask нельзя,
   * поэтому цикл при старте запоминает номер поколения, а clear() его
   * инкрементит. Проснувшийся старый цикл видит расхождение и умирает — иначе
   * после clear() + push() на одной очереди поехали бы два цикла сразу.
   */
  #epoch = 0;

  readonly #quota: number;
  readonly #delay: number;

  get quota() {
    return this.#quota;
  }

  get delay() {
    return this.#delay;
  }

  constructor(opts: ISchedulerOptions) {
    this.#quota = opts.quota;
    this.#delay = opts.delay;
  }

  isRunning() {
    return this.#running;
  }

  /** Отменяет все задачи: закрывает генераторы и сеттлит их промисы. */
  clear() {
    this.#running = false;
    this.#epoch++;

    if (this.#timer != null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    const entries = [...this.#live];

    this.#live.clear();
    // splice, а не новый массив: чистим содержимое, но сохраняем уже
    // выделенную ёмкость, чтобы не перевыделять память при следующих push.
    this.#queue.splice(0, this.#queue.length);

    for (const entry of entries) {
      if (entry.settled) {
        continue;
      }

      entry.settled = true;

      // Закрываем генератор — внутри отработают finally-блоки.
      try {
        entry.job.return?.(undefined);
      } catch {
        // отмена одной задачи не должна ломать отмену остальных
      }

      // Без этого промис отменённой задачи не зарезолвился бы никогда.
      entry.handler({
        done: true,
        error: new TaskCancelledError(),
        value: undefined,
      });
    }
  }

  push(job: IterableIterator<unknown>, handler: (result: IJobResult) => void) {
    const entry: IJobEntry = { job, handler, settled: false };

    this.#queue.push(entry);
    this.#live.add(entry);

    this.run();

    return this.#queue.length;
  }

  run() {
    // run() зовётся из каждого push(), но цикл должен быть один
    if (this.#running) {
      return;
    }

    this.#running = true;

    const epoch = this.#epoch;

    let now = 0;

    // Осознанное упрощение: рекурсия, а не while. Читается нагляднее, но при
    // большой quota и очень коротких шагах может уехать в переполнение стека.
    const run = () => {
      if (!this.#running || epoch !== this.#epoch) {
        return;
      }

      const entry = this.#queue.shift();

      if (entry == null) {
        this.#running = false;
        return;
      }

      // 0 ложный, поэтому ||= присвоит только на первом проходе такта
      now ||= performance.now();
      this.#exec(entry);

      if (performance.now() - now >= this.#quota) {
        now = 0;
        // Единственная настоящая точка уступки потока
        this.#timer = setTimeout(() => {
          this.#timer = null;
          run();
        }, this.#delay);
      } else {
        run();
      }
    };

    // Старт откладывается на микрозадачу, чтобы вызывающий код успел повесить
    // обработчики и подписаться на итерацию до первых данных.
    //
    // Важно: queueMicrotask здесь НЕ механизм уступки. Микрозадачи дренируются
    // до того, как event loop продолжит цикл, — поток они не отдают.
    queueMicrotask(run);
  }

  /** Один шаг одной задачи. */
  #exec(entry: IJobEntry) {
    // Известный долг: handler стоит внутри try, поэтому бросивший
    // пользовательский обработчик приведёт ко второму вызову handler.
    try {
      const result = entry.job.next() as IJobResult;

      if (result.done) {
        this.#settle(entry);
      } else {
        // round robin: незавершённая задача уезжает в конец очереди
        this.#queue.push(entry);
      }

      entry.handler(result);
    } catch (error) {
      this.#settle(entry);
      entry.handler({ done: true, error, value: undefined });
    }
  }

  #settle(entry: IJobEntry) {
    entry.settled = true;
    this.#live.delete(entry);
  }
}
